import http from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { CaptionPipeline } from './pipeline.mjs';
import { PhrasePipeline } from './phrase-pipeline.mjs';
import { createSemanticTranslator } from './semantic-translator.mjs';
import { CaptionDisplay } from './caption-display.mjs';
import { LiveEnglish } from './live-english.mjs';
import { Segmenter } from './vad.mjs';
import { createLocalAsr, pythonPath } from './local-asr.mjs';
import { createLocalTranslator } from './local-translator.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createSystemCapture } from './system-capture.mjs';
import { startLocalRuntime } from './local-runtime.mjs';
import {createGrammarGate} from './grammar-gate.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {stopChild} from './process.mjs';
import {createReleaseUpdater} from './release-updater.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
try { process.loadEnvFile(resolve(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
export function createApp({ port = Number(process.env.PORT || 4317), translate = createLocalTranslator(), phraseTranslate = createSemanticTranslator(), asrFactory = createLocalAsr, captureFactory=createSystemCapture, checkModel = true, idleMs = 180000, updater=createReleaseUpdater({version}), onUpdateApply=()=>{}, onRefresh=async()=>{}, nativeRetryMs=1000, captionOptions={}, phraseOptions={} } = {}) {
  const token = randomBytes(24).toString('hex'), sessions = new Map(), overlayClients = new Set(), nativeClients=new Set();
  let overlayProcess,nativeOwner,currentSession,lastSubtitleSequence=-1, lastAudioSource={type:'audio-source',name:'',scope:'process',active:false}, lastSubtitle = {type:'subtitle',zh:'等待英文语音…',en:'Waiting for English audio...',state:'等待语音',fontSize:28,bilingual:true};
  let nativeWanted=false,nativeRecoveryTimer,nativeRecoveries=0,refreshing=false;
  const activity={audioAt:null,recognitionAt:null,translationAt:null,errorAt:null};
  const overlayBroadcast = value => {for(const client of overlayClients)if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify(value));};
  const englishDisplay=new LiveEnglish({display:value=>{lastSubtitle={...lastSubtitle,en:value.en};overlayBroadcast(value);}});
  const captionDisplay=new CaptionDisplay({pageOptions:{zhLimit:44,enLimit:160},coalesce:true,...captionOptions,display:value=>{lastSubtitleSequence=value.sequence;lastSubtitle={...lastSubtitle,zh:value.zh,state:value.state,page:value.page,pageCount:value.pageCount,translationReadyAt:value.translationReadyAt??null};overlayBroadcast(lastSubtitle);}});
  const origins = () => [`http://127.0.0.1:${server.address()?.port || port}`, `http://localhost:${server.address()?.port || port}`];
  const allowed = req => origins().some(origin => origin.slice(7) === req.headers.host) && (!req.headers.origin || origins().includes(req.headers.origin));
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer');
    if (!allowed(req)) { res.writeHead(403); res.end('Forbidden'); return; }
    const url = new URL(req.url,'http://127.0.0.1');
    if(url.pathname.startsWith('/api/update/')){
      if(req.headers['x-flowsub-token']!==token){res.writeHead(403);res.end();return;}
      try{
        let result;
        if(req.method==='GET'&&url.pathname==='/api/update/status')result=updater.status();
        else if(req.method==='POST'&&url.pathname==='/api/update/check')result=await updater.check();
        else if(req.method==='POST'&&url.pathname==='/api/update/download')result=updater.download();
        else if(req.method==='POST'&&url.pathname==='/api/update/apply'){result=await updater.apply();setTimeout(onUpdateApply,1000);}
        else{res.writeHead(404);res.end();return;}
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
      }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({state:'error',message:error.message}));}return;
    }
    if (req.method === 'POST' && url.pathname === '/api/overlay/open') {
      if (req.headers['x-flowsub-token'] !== token) {res.writeHead(403);res.end();return;}
      if (!nativeClients.size && (!overlayProcess || overlayProcess.exitCode !== null)) {
        overlayProcess = spawn(pythonPath,['-u',resolve(root,'desktop','overlay.py'),'--url',`ws://127.0.0.1:${server.address().port}/api/overlay?token=${token}`],{windowsHide:true,stdio:['ignore','ignore','pipe']});
        overlayProcess.stderr.on('data',()=>{}); overlayProcess.on('error',()=>{overlayProcess=null;});overlayProcess.on('exit',()=>{overlayProcess=null;});
      } else overlayBroadcast({type:'show'});
      for(let count=0;count<20&&!nativeClients.size;count++)await delay(500);
      res.setHeader('Content-Type','application/json');if(!nativeClients.size)res.writeHead(503);res.end(JSON.stringify({opened:Boolean(nativeClients.size)}));return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (url.pathname === '/api/config') {
      let translationReady = !checkModel;
      if (checkModel) try { translationReady = (await fetch('http://127.0.0.1:4318/health', {signal: AbortSignal.timeout(2000)})).ok; } catch {}
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ token, version, configured: existsSync(pythonPath) && translationReady, translationReady, transcriptionModel:'Zipformer 流式 + Whisper 定稿 · 本机', translationModel:'Qwen3 4B · 本机', bufferSeconds:30,activity:{...activity,running:nativeWanted,refreshing}})); return;
    }
    res.writeHead(404);res.end('Not found');
  });
  const wss = new WebSocketServer({ noServer:true, maxPayload:16000 });
  server.on('upgrade',(req,socket,head) => {
    const url = new URL(req.url,'http://127.0.0.1');
    if (!allowed(req) || !['/api/live','/api/overlay'].includes(url.pathname) || url.searchParams.get('token') !== token) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req,socket,head,ws => {
      if(url.pathname==='/api/overlay'){
        ws.on('error',()=>{}); // A rejected oversized/protocol-invalid frame must not crash the gateway.
        overlayClients.add(ws);ws.send(JSON.stringify(lastSubtitle));ws.on('close',()=>{overlayClients.delete(ws);nativeClients.delete(ws);if(!nativeClients.size){nativeWanted=false;clearTimeout(nativeRecoveryTimer);if(nativeOwner?.readyState===WebSocket.OPEN)nativeOwner.send(JSON.stringify({type:'stop'}));nativeOwner?.close();nativeOwner=null;for(const session of sessions.values())if(session.source==='system'&&!session.browser)dispose(session);}});ws.on('message',raw=>{
          let value;try{value=JSON.parse(raw.toString());}catch{return;}
          if(value.type==='overlay-preference'){
            const preference={type:'overlay-preference'};
            if(Number.isFinite(value.fontSize))preference.fontSize=lastSubtitle.fontSize=Math.round(Math.max(22,Math.min(48,value.fontSize)));
            for(const field of ['bilingual','transparent'])if(typeof value[field]==='boolean')preference[field]=lastSubtitle[field]=value[field];
            overlayBroadcast(preference);overlayBroadcast(lastSubtitle);
          }
          else if(value.type==='native-ready'){nativeClients.add(ws);ws.send(JSON.stringify(lastAudioSource));ws.send(JSON.stringify(lastSubtitle));ws.send(JSON.stringify({type:'engine-state',running:[...sessions.values()].some(s=>s.source==='system'&&!s.stopped)}));}
          else if(value.type==='native-state'){ws.send(JSON.stringify({type:'engine-state',running:[...sessions.values()].some(s=>s.source==='system'&&!s.stopped)}));}
          else if(value.type==='native-control'){
            if(value.action==='stop'){nativeWanted=false;clearTimeout(nativeRecoveryTimer);const session=[...sessions.values()].find(s=>s.source==='system'&&!s.stopped);if(session){const ownerAtStop=nativeOwner;session.stopped=true;session.capture?.close();session.vad.finish();session.emit({type:'draining'});session.drain=setTimeout(()=>{session.emit({type:'stopped'});dispose(session);if(nativeOwner===ownerAtStop){nativeOwner=null;ownerAtStop?.close();}overlayBroadcast({type:'engine-state',running:false});},8000);}}
            else if(value.action==='start'){nativeWanted=true;nativeRecoveries=0;startNative();}
            else if(value.action==='refresh'){nativeWanted=true;nativeRecoveries=0;void refreshNative();}
          }
        });
      }else wss.emit('connection',ws);
    });
  });
  const dispose = session => { session.failed=true;clearTimeout(session.expiry); clearTimeout(session.drain); session.capture?.close(); session.asr.close(); session.pipeline.close(); sessions.delete(session.key); };
  const startNative=()=>{
    if(!nativeWanted||[...sessions.values()].some(s=>s.source==='system')||(nativeOwner&&nativeOwner.readyState!==WebSocket.CLOSED))return;
    const owner=nativeOwner=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live?token=${token}`);
    owner.on('open',()=>owner.send(JSON.stringify({type:'start',source:'system',pace:'fast'})));
    owner.on('close',()=>{if(nativeOwner===owner)nativeOwner=null;});owner.on('error',()=>{});
    owner.on('message',raw=>{try{
      const event=JSON.parse(raw);
      if(event.type==='error'&&nativeWanted&&nativeClients.size){
        if(++nativeRecoveries<=3){
          lastSubtitle={...lastSubtitle,zh:'正在恢复识别和翻译…',en:'Reconnecting…',state:'自动恢复中'};overlayBroadcast(lastSubtitle);
          clearTimeout(nativeRecoveryTimer);nativeRecoveryTimer=setTimeout(()=>void refreshNative(),nativeRetryMs*nativeRecoveries);nativeRecoveryTimer.unref?.();
        }else{nativeWanted=false;lastSubtitle={...lastSubtitle,zh:'暂时未能恢复，请点刷新。',en:'',state:'等待刷新'};overlayBroadcast(lastSubtitle);}
      }
    }catch{}});
  };
  const refreshNative=async()=>{
    if(refreshing)return;
    refreshing=true;clearTimeout(nativeRecoveryTimer);
    const owner=nativeOwner;nativeOwner=null;owner?.terminate();
    for(const session of [...sessions.values()])if(session.source==='system'){session.stopped=true;dispose(session);}
    captionDisplay.reset();englishDisplay.reset();
    lastSubtitle={...lastSubtitle,zh:'正在重新连接翻译…',en:'Reconnecting…',state:'刷新中',page:1,pageCount:1};overlayBroadcast(lastSubtitle);overlayBroadcast({type:'engine-state',running:false});
    try{await onRefresh();if(nativeWanted&&nativeClients.size)startNative();}
    catch{nativeWanted=false;lastSubtitle={...lastSubtitle,zh:'刷新未完成，请稍后再点刷新。',en:'',state:'等待刷新'};overlayBroadcast(lastSubtitle);}
    finally{refreshing=false;}
  };
  wss.on('connection', browser => {
    let session, alive = true;
    const sendDirect = value => { if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(value)); };
    browser.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) return browser.terminate(); alive = false; browser.ping(); sendDirect({type:'heartbeat',at:Date.now()}); },10000);
    browser.on('message',(raw,binary) => {
      if (binary) return browser.close(1003,'Use framed audio');
      let value; try { value = JSON.parse(raw.toString()); } catch { return browser.close(1007,'Invalid JSON'); }
      if (value.type === 'start') {
        if (session) return;
        if(!value.resumeKey && value.source==='system')value.resumeKey=[...sessions.values()].find(s=>s.source==='system'&&!s.stopped)?.key;
        if (value.resumeKey) {
          session = sessions.get(value.resumeKey);
          if (!session || session.stopped) { sendDirect({type:'expired',message:'会话已结束，请重新接入。'}); browser.close(); return; }
          clearTimeout(session.expiry);
          session.browser?.close(1000,'Session resumed'); session.browser = browser;
          sendDirect({type:'session',resumeKey:session.key,lastSeq:session.lastSeq,ready:session.ready,history:[...session.history.values()]}); return;
        }
        if (sessions.size >= 2) { sendDirect({type:'error',message:'已有字幕会话占用模型，请先停止旧会话。'}); browser.close(); return; }
        session = {key:randomBytes(24).toString('hex'),source:value.source,browser,lastSeq:0,ready:false,history:new Map(),starts:new Map(),sourceRevisions:new Map(),stopped:false,createdAt:Date.now()}; sessions.set(session.key,session);currentSession=session.key;lastSubtitleSequence=-1;captionDisplay.reset();englishDisplay.reset();
        lastSubtitle={...lastSubtitle,zh:'等待英文语音…',en:'Waiting for English audio...',state:'等待语音'};overlayBroadcast(lastSubtitle);
        if(session.source==='system')overlayBroadcast({type:'engine-state',running:true});
        const emit = event => {
          if(session.failed)return;
          if(event.type==='transcript'){activity.recognitionAt=Date.now();if(Date.now()-session.createdAt>60000)nativeRecoveries=0;}
          if(event.type==='translation'&&event.complete)activity.translationAt=Date.now();
          if(['error','segment_error','segment_warning'].includes(event.type))activity.errorAt=Date.now();
          if(currentSession===session.key&&(event.type==='recovering'||event.type==='segment_warning')){
            lastSubtitle={...lastSubtitle,state:event.type==='recovering'?'识别恢复中':event.retrying===true?'翻译自动重试中':'继续接收语音 · 可刷新'};overlayBroadcast(lastSubtitle);
          }
          if (['transcript','translation','segment_error'].includes(event.type)) {
            const old = session.history.get(event.id) || {id:event.id};
            if (event.type === 'transcript') {
              Object.assign(old,{en:event.text,sourceFinal:event.final,sequence:event.sequence,startedClientAt:event.startedClientAt});
              if(currentSession===session.key)englishDisplay.offer({id:event.id,text:event.text,sequence:event.sequence,revision:event.revision,final:event.final,startedClientAt:event.startedClientAt});
            }
            if (event.type === 'translation' && event.complete) Object.assign(old,{zh:event.text,final:event.final,firstMs:event.firstMs,durationMs:event.durationMs,error:'',captionEn:event.sourceText,revision:event.revision,sequence:event.sequence,startedClientAt:event.startedClientAt,translationReadyAt:Date.now()});
            if (event.type === 'segment_error') {old.error = event.message;if(Number.isFinite(event.startedClientAt))old.startedClientAt=event.startedClientAt;}
            session.history.set(event.id,old); if (session.history.size > 160) session.history.delete(session.history.keys().next().value);
            if(currentSession===session.key && (event.type==='segment_error' || (event.type==='translation' && event.complete)) && (old.zh || old.error))captionDisplay.offer({id:old.id,sourceId:event.sourceId,sequence:old.sequence??0,revision:old.revision??0,zh:old.error?'此段待重试':old.zh,en:'',state:old.error?'此段待重试':'已定稿',final:Boolean(old.error||old.final),translationReadyAt:old.translationReadyAt});
          }
          if (session.browser?.readyState === WebSocket.OPEN) session.browser.send(JSON.stringify(event));
          if(event.type==='error'){
            session.failed=true;session.stopped=true;
            if(currentSession===session.key){captionDisplay.reset();englishDisplay.reset();lastSubtitle={...lastSubtitle,zh:event.message,en:'',state:'已停止 · 请重新接入'};overlayBroadcast(lastSubtitle);overlayBroadcast({type:'engine-state',running:false});}
            queueMicrotask(()=>{dispose(session);session.browser?.close();});
          }
        };
        session.emit = emit;
        session.sourceEpoch=0;
        const newPipeline=()=>{const pipeline=session.source==='system'?new PhrasePipeline({...phraseOptions,translate:phraseTranslate,emit}):new CaptionPipeline({translate,emit,concurrency:1,translateDrafts:true,draftDelay:value.pace === 'steady' ? 20000 : 150});pipeline.configure(value);return pipeline;};
        session.pipeline = newPipeline();
        session.asr = asrFactory(event => {
          if(session.failed)return;
          if (event.type === 'ready') {session.ready = true; emit({type:'ready',device:event.device,model:event.model});}
          else if (event.type === 'transcript') {
            if(!session.starts.has(event.id))return; // A late result from a previous audio application.
            const revision = session.sourceRevisions.get(event.id) || 0; if (event.revision < revision) return;
            session.sourceRevisions.set(event.id,event.revision);
            session.pipeline.transcript({id:event.id,text:event.text,final:event.final,sourceEnded:event.sourceEnded,streamText:event.streamText,endReason:event.endReason,reviewLoading:event.reviewLoading,reviewQueued:event.reviewQueued,sourceSequence:event.sourceSequence,startedClientAt:session.starts.get(event.id)});
            if (event.final) {session.starts.delete(event.id); session.sourceRevisions.delete(event.id);}
          } else if (event.type === 'final_started') {
            if(!session.starts.has(event.id) || event.revision<(session.sourceRevisions.get(event.id)||0))return;
            session.pipeline.reviewStarted?.(event.id);emit(event);
          } else if (event.type === 'fatal') emit({type:'error',message:event.message});
          else if (event.type === 'asr_error') {if(!session.starts.has(event.id))return;const startedClientAt=session.starts.get(event.id);session.starts.delete(event.id);session.sourceRevisions.delete(event.id);session.pipeline.fail?.(event.id);emit({type:'segment_error',id:event.id,startedClientAt,message:'该片段识别失败。后续语音继续接收。'});}
          else emit(event);
        });
        const newSegmenter=()=>new Segmenter({onSegment:segment=>{segment.id=`${session.sourceEpoch}:${segment.id}`;session.starts.set(segment.id,segment.startedClientAt);session.asr.transcribe(segment,session.pipeline.glossary.map(pair=>pair.en).join(', '));},onActivity:emit});
        session.vad = newSegmenter();
        if(value.source==='system'&&!session.stopped)session.capture=captureFactory(event=>{
          if(session.failed)return;
          if(event.type==='audio'){activity.audioAt=Date.now();session.vad.push(Buffer.from(event.pcm,'base64'),activity.audioAt);}
          else if(event.type==='capture_target'){
            session.sourceEpoch++;session.asr.reset?.();session.pipeline.close();session.pipeline=newPipeline();session.starts.clear();session.sourceRevisions.clear();session.vad=newSegmenter();
            if(currentSession===session.key){captionDisplay.reset();englishDisplay.reset();lastSubtitle={...lastSubtitle,zh:event.pid?'等待中文定稿…':'播放英文视频即可',en:event.pid?'Waiting for English audio...':'Start an English video to translate.',state:event.pid?'英文实时 · 中文定稿':'等待前台视频',page:1,pageCount:1};lastAudioSource={type:'audio-source',name:event.device||'',scope:'process',active:Boolean(event.pid)};overlayBroadcast(lastAudioSource);overlayBroadcast(lastSubtitle);}
            emit(event);
          }
          else if(event.type==='capture_ready')emit({type:'capture_ready',device:event.device,recovered:event.recovered});
          else if(event.type==='capture_recovering'){emit({type:'recovering',scope:'audio',message:event.message});if(currentSession===session.key){lastSubtitle={...lastSubtitle,state:'系统音频恢复中'};overlayBroadcast(lastSubtitle);}}
          else if(event.type==='capture_error')emit({type:'error',message:'应用音频多次接入失败，已停止。请重新开始翻译。'});
        });
        sendDirect({type:'session',resumeKey:session.key,lastSeq:0,ready:session.ready,history:[]});
      } else if (value.type === 'audio' && session && !session.stopped) {
        if (!Number.isSafeInteger(value.seq) || value.seq <= 0 || typeof value.pcm !== 'string' || value.pcm.length > 3300 || !Number.isFinite(value.clientAt)) return;
        if (value.seq <= session.lastSeq) {sendDirect({type:'ack',seq:session.lastSeq}); return;}
        if (value.seq !== session.lastSeq + 1) {sendDirect({type:'resend',seq:session.lastSeq + 1}); return;}
        const pcm = Buffer.from(value.pcm,'base64'); if (pcm.length !== 2400) return browser.close(1007,'Invalid PCM');
        session.lastSeq = value.seq; session.vad.push(pcm,value.clientAt); if (value.seq % 5 === 0) sendDirect({type:'ack',seq:value.seq});
      } else if (value.type === 'configure' && session) {session.pipeline.configure(value); session.pipeline.draftDelay = value.pace === 'steady' ? 20000 : 150;}
      else if (value.type === 'retry' && session) session.pipeline.retry(value.id);
      else if (value.type === 'flush' && session) session.vad.finish();
      else if (value.type === 'stop' && session) {
        session.stopped = true; session.capture?.close(); session.vad.finish(); sendDirect({type:'draining'});
        session.drain = setTimeout(() => {sendDirect({type:'stopped'}); dispose(session);if(session.source==='system')overlayBroadcast({type:'engine-state',running:false}); browser.close();},8000);
      }
    });
    const detach = () => { clearInterval(heartbeat); if (session && session.browser === browser && sessions.has(session.key)) { session.browser = null;if(session.source==='system'&&nativeClients.size)return;session.expiry = setTimeout(()=>dispose(session),idleMs); session.expiry.unref(); } };
    browser.on('close',detach); browser.on('error',detach);
  });
  return {server,wss,token,sessions,listen:()=>new Promise(done=>server.listen(port,'127.0.0.1',()=>done(server.address().port))),close:()=>new Promise(done=>{nativeWanted=false;clearTimeout(nativeRecoveryTimer);captionDisplay.close();nativeOwner?.terminate();stopChild(overlayProcess);for(const client of overlayClients)client.terminate();for(const session of sessions.values()) dispose(session); for(const client of wss.clients)client.terminate(); wss.close(); server.close(done);})};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime=await startLocalRuntime();
  const grammar=createGrammarGate();
  let app;const shutdown=async()=>{await app.close();grammar.close();runtime.close();process.exit(0);};
  app = createApp({phraseTranslate:createSemanticTranslator({grammarCheck:grammar.check,observeInference:runtime.observeInference}),captionOptions:{minHoldMs:1800,maxHoldMs:3600},onUpdateApply:shutdown,onRefresh:async()=>runtime.refresh?.()}); console.log(`小马翻译：桌面服务已启动（127.0.0.1:${await app.listen()}）`);
  if(process.argv.includes('--desktop'))await fetch(`http://127.0.0.1:${app.server.address().port}/api/overlay/open`,{method:'POST',headers:{'X-FlowSub-Token':app.token}});
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}

