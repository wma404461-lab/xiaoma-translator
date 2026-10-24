import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as wait} from 'node:timers/promises';
import {CaptionPipeline} from '../server/pipeline.mjs';
import {parseSse} from '../server/sse.mjs';
import {Segmenter} from '../server/vad.mjs';
import {createApp} from '../server/index.mjs';
import {LiveSession} from './helpers/live-session-client.mjs';
import WebSocket from 'ws';
import {createLocalTranslator} from '../server/local-translator.mjs';
async function until(predicate,timeout=5000){const begin=Date.now();while(!predicate()){if(Date.now()-begin>timeout)throw new Error('Timed out');await wait(10);}}

test('A contextual biography replay is retried without previous speech',async()=>{
  const requests=[],deltas=[];
  const translate=createLocalTranslator({fetchImpl:async(_,options)=>{
    const request=JSON.parse(options.body),input=JSON.parse(request.messages[1].content.replace(/\n\/no_think$/,''));requests.push(input);
    const text=input.previous_English.length?'\u6b64\u524d\u90a3\u4e2a\u4eba\u7684\u5168\u90e8\u7ecf\u5386。'.repeat(10):'\u5728\u804a\u5929\u533a\u63d0\u95ee。';
    return new Response(`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\n`);
  }});
  const result=await translate({text:'questions in the chat.',context:[{en:'An older biography.'},{en:'Go ahead and ask your'}],topic:'',glossary:[],signal:AbortSignal.timeout(1000),onDelta:x=>deltas.push(x)});
  assert.deepEqual(requests[0].previous_English,['Go ahead and ask your']);assert.deepEqual(requests[1].previous_English,[]);
  assert.equal(result.text,'\u5728\u804a\u5929\u533a\u63d0\u95ee。');assert.deepEqual(deltas,['\u5728\u804a\u5929\u533a\u63d0\u95ee。']);
});
test('UTF-8 SSE split across arbitrary bytes and CRLF boundaries',async()=>{
  const encoded=new TextEncoder().encode('data: {"delta":"\u4e2d\u6587"}\r\n\r\ndata: [DONE]\n\n');
  const body=new ReadableStream({start(controller){for(const byte of encoded)controller.enqueue(Uint8Array.of(byte));controller.close();}});
  const values=[];for await(const value of parseSse(body))values.push(value);assert.deepEqual(values,[{delta:'\u4e2d\u6587'}]);
});
test('Late speculative translation cannot overwrite final correction',async()=>{
  const events=[];let stale;
  const pipeline=new CaptionPipeline({draftDelay:0,concurrency:2,emit:value=>events.push(value),translate:async job=>{if(!job.final){stale=job.onDelta;await wait(90);job.onDelta('\u8fc7\u671f\u6682\u8bd1',90);return{text:'\u8fc7\u671f\u6682\u8bd1'};}job.onDelta('\u662f\u5341\u4e94，\u4e0d\u662f\u4e94\u5341',1);return{text:'\u662f\u5341\u4e94，\u4e0d\u662f\u4e94\u5341',firstMs:1};}});
  pipeline.transcript({id:'one',text:'fifty percent maybe'});await until(()=>stale);pipeline.transcript({id:'one',text:'fifteen, not fifty percent',final:true});await wait(120);
  assert.ok(events.some(x=>x.type==='translation' && x.final && x.text==='\u662f\u5341\u4e94，\u4e0d\u662f\u4e94\u5341'));assert.ok(!events.some(x=>x.text==='\u8fc7\u671f\u6682\u8bd1'));pipeline.close();
});
test('A failed segment can be retried and later speech continues',async()=>{
  let calls=0;const events=[];const pipeline=new CaptionPipeline({emit:x=>events.push(x),translate:async()=>{if(++calls===1)throw new Error('temporary');return{text:'\u91cd\u8bd5\u6210\u529f'};}});
  pipeline.transcript({id:'first',text:'original source',final:true});await until(()=>events.some(x=>x.type==='segment_error'));pipeline.retry('first');await until(()=>events.some(x=>x.final));assert.equal(pipeline.closed,false);pipeline.close();
});
test('Silence creates no recognition calls and a long utterance remains bounded',()=>{
  const items=[];const segmenter=new Segmenter({onSegment:x=>items.push(x)});const quiet=Buffer.alloc(2400),voice=Buffer.alloc(2400);for(let i=0;i<voice.length;i+=2)voice.writeInt16LE(8000,i);
  for(let i=0;i<2000;i++)segmenter.push(quiet,i*50);assert.equal(items.length,0);for(let i=0;i<400;i++)segmenter.push(voice,i*50);segmenter.finish();assert.ok(items.every(x=>x.audio.length<=240*2400));assert.ok(items.filter(x=>x.final).length>=2);
});
test('Reconnect replays unacknowledged frames without duplicate segments',async()=>{
  const recognized=[];let boots=0;
  const app=createApp({port:0,checkModel:false,idleMs:2000,translate:async job=>({text:job.text,firstMs:1}),asrFactory:emit=>{boots++;setTimeout(()=>emit({type:'ready'}),10);return{transcribe:job=>{recognized.push(job);emit({type:'transcript',id:job.id,text:'a valid English phrase',revision:job.revision,final:job.final});},close(){}};}});
  const port=await app.listen();const events=[],statuses=[];let fatal;
  const session=new LiveSession({token:app.token,baseUrl:`ws://127.0.0.1:${port}/api/live`,WebSocketImpl:WebSocket,onEvent:x=>events.push(x),onStatus:x=>statuses.push(x),onFatal:x=>fatal=x});session.connect();await until(()=>session.ready);
  const voice=Buffer.alloc(2400);for(let i=0;i<voice.length;i+=2)voice.writeInt16LE(5000,i);
  for(let i=0;i<30;i++)session.audio(voice);await until(()=>session.ack>=30);const key=session.resumeKey;
  const connection=[...app.wss.clients][0];connection.terminate();await until(()=>!session.ready);
  for(let i=0;i<30;i++)session.audio(i<17?voice:Buffer.alloc(2400));await until(()=>session.ready);await until(()=>session.ack>=60);
  assert.equal(session.resumeKey,key);assert.equal(boots,1);assert.equal(app.sessions.get(key).lastSeq,60);assert.equal(recognized.filter(x=>x.final).length,1);assert.equal(fatal,undefined);assert.ok(statuses.some(x=>x.includes('\u6062\u590d')));session.close();await app.close();
});
test('Local endpoints reject cross-site access and unknown files',async()=>{
  const app=createApp({port:0,checkModel:false});const port=await app.listen();
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/config`,{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/../.env`)).status,404);
  for(const path of ['/','/index.html','/app.js','/style.css','/audio-worklet.js','/demo.js'])assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status,404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/overlay/open`,{method:'POST'})).status,403);await app.close();
});
test('Audio buffer exhaustion stops explicitly instead of silently dropping input',()=>{
  let message='';const session=new LiveSession({token:'test',baseUrl:'ws://127.0.0.1:1',onEvent(){},onStatus(){},onFatal:value=>message=value});for(let i=0;i<601;i++)session.audio(new ArrayBuffer(2400));assert.equal(session.closed,true);assert.match(message,/30 \u79d2/);
});

test('Native controls run a system session and captions survive an observer disconnect',async()=>{
  let capture,closed=false;const values=[];
  const app=createApp({port:0,checkModel:false,idleMs:30,phraseTranslate:async job=>({consume:job.words.length,zh:'\u72ec\u7acb\u5b57\u5e55\u4ecd\u5728\u5de5\u4f5c',firstMs:1}),captureFactory:emit=>{capture=emit;return{close(){closed=true;}};},asrFactory:emit=>{setTimeout(()=>emit({type:'ready'}),5);return{transcribe:job=>emit({type:'transcript',id:job.id,text:'a complete English sentence',revision:job.revision,final:job.final}),close(){}};}});
  const port=await app.listen(),native=new WebSocket(`ws://127.0.0.1:${port}/api/overlay?token=${app.token}`);
  native.on('message',raw=>values.push(JSON.parse(raw)));await new Promise(done=>native.on('open',done));native.send(JSON.stringify({type:'native-ready'}));native.send(JSON.stringify({type:'native-control',action:'start'}));await until(()=>app.sessions.size===1&&[...app.sessions.values()][0].ready);
  const key=[...app.sessions.keys()][0];const workbench=new WebSocket(`ws://127.0.0.1:${port}/api/live?token=${app.token}`);
  await new Promise(done=>workbench.on('open',done));workbench.send(JSON.stringify({type:'start',source:'system'}));await wait(20);workbench.close();await wait(80);assert.equal(app.sessions.size,1);
  const voice=Buffer.alloc(2400);for(let i=0;i<voice.length;i+=2)voice.writeInt16LE(5000,i);
  for(let i=0;i<30;i++)capture({type:'audio',pcm:voice.toString('base64')});for(let i=0;i<13;i++)capture({type:'audio',pcm:Buffer.alloc(2400).toString('base64')});
  await until(()=>values.some(x=>x.type==='subtitle'&&x.zh==='\u72ec\u7acb\u5b57\u5e55\u4ecd\u5728\u5de5\u4f5c'));assert.ok(app.sessions.has(key));native.close();await until(()=>app.sessions.size===0);assert.ok(closed);await app.close();
});

test('Read-only native state observers see a running engine without retaining its ownership',async()=>{
  const app=createApp({port:0,checkModel:false,idleMs:30,captureFactory:()=>({close(){}}),asrFactory:emit=>{queueMicrotask(()=>emit({type:'ready'}));return{transcribe(){},close(){}};}});
  const port=await app.listen(),url=`ws://127.0.0.1:${port}/api/overlay?token=${app.token}`;
  const native=new WebSocket(url),observer=new WebSocket(url),states=[];
  observer.on('message',raw=>{const value=JSON.parse(raw);if(value.type==='engine-state')states.push(value.running);});
  try{
    await Promise.all([new Promise(done=>native.once('open',done)),new Promise(done=>observer.once('open',done))]);
    native.send(JSON.stringify({type:'native-ready'}));native.send(JSON.stringify({type:'native-control',action:'start'}));await until(()=>app.sessions.size===1);
    observer.send(JSON.stringify({type:'native-state'}));await until(()=>states.includes(true));
    native.close();await until(()=>app.sessions.size===0);
    observer.send(JSON.stringify({type:'native-state'}));await until(()=>states.at(-1)===false);
  }finally{native.terminate();observer.terminate();await app.close();}
});

test('Native stop drains and releases its old internal owner so manual start captures again',async()=>{
  let boots=0,closed=0;
  const app=createApp({port:0,checkModel:false,captureFactory:()=>{boots++;return{close(){closed++;}};},asrFactory:emit=>{queueMicrotask(()=>emit({type:'ready'}));return{transcribe(){},close(){}};}});
  const port=await app.listen(),native=new WebSocket(`ws://127.0.0.1:${port}/api/overlay?token=${app.token}`);
  try{
    await new Promise(done=>native.once('open',done));native.send(JSON.stringify({type:'native-ready'}));native.send(JSON.stringify({type:'native-control',action:'start'}));await until(()=>boots===1);
    const old=[...app.sessions.keys()][0];native.send(JSON.stringify({type:'native-control',action:'stop'}));await until(()=>app.sessions.size===0,12000);
    native.send(JSON.stringify({type:'native-control',action:'start'}));await until(()=>boots===2);
    assert.ok(closed>=1);assert.equal(app.sessions.size,1);assert.notEqual([...app.sessions.keys()][0],old);
  }finally{native.terminate();await app.close();}
});

test('Automatic application switches cancel old pages and reject late speech from the previous source',async()=>{
  let captureEmit,asrEmit,resets=0;const jobs=[],packets=[];
  const app=createApp({port:0,checkModel:false,phraseTranslate:async job=>({consume:job.words.length,zh:'\u53ea\u663e\u793a\u65b0\u89c6\u9891\u7684\u7ffb\u8bd1。',firstMs:1}),asrFactory:emit=>{asrEmit=emit;queueMicrotask(()=>emit({type:'ready'}));return{transcribe:job=>jobs.push(job),reset(){resets++;},close(){}};},captureFactory:emit=>{captureEmit=emit;return{close(){}};}});
  const port=await app.listen(),overlay=new WebSocket(`ws://127.0.0.1:${port}/api/overlay?token=${app.token}`);
  overlay.on('message',raw=>packets.push(JSON.parse(raw)));
  try{
    await new Promise(done=>overlay.once('open',done));overlay.send(JSON.stringify({type:'native-ready'}));overlay.send(JSON.stringify({type:'native-control',action:'start'}));await until(()=>captureEmit&&app.sessions.size===1);
    const voice=Buffer.alloc(2400);for(let index=0;index<2400;index+=2)voice.writeInt16LE(5000,index);
    const utterance=()=>{for(let index=0;index<30;index++)captureEmit({type:'audio',pcm:voice.toString('base64')});for(let index=0;index<13;index++)captureEmit({type:'audio',pcm:Buffer.alloc(2400).toString('base64')});};
    captureEmit({type:'capture_target',pid:111,device:'PlayerA.exe'});utterance();const old=jobs.find(job=>job.final);assert.ok(old);
    captureEmit({type:'capture_target',pid:222,device:'PlayerB.exe'});
    asrEmit({type:'transcript',id:old.id,text:'This old source must not reach the new display.',revision:old.revision,final:true});
    asrEmit({type:'asr_error',id:old.id});
    assert.equal([...app.sessions.values()][0].pipeline.items.size,0);
    jobs.length=0;utterance();const fresh=jobs.find(job=>job.final);assert.ok(fresh);assert.notEqual(fresh.id,old.id);
    asrEmit({type:'transcript',id:fresh.id,text:'Only translate the new video.',revision:fresh.revision,final:true});
    await until(()=>packets.some(packet=>packet.zh==='\u53ea\u663e\u793a\u65b0\u89c6\u9891\u7684\u7ffb\u8bd1。'));
    assert.equal(resets,2);const sources=packets.filter(packet=>packet.type==='audio-source');assert.deepEqual(sources.map(packet=>packet.name),['','PlayerA.exe','PlayerB.exe']);assert.deepEqual(sources.map(packet=>packet.active),[false,true,true]);
    assert.ok(!packets.some(packet=>packet.zh==='\u6b64\u6bb5\u5f85\u91cd\u8bd5'));
  }finally{overlay.terminate();await app.close();}
});

test('Oversized native-channel traffic closes its sender and leaves the gateway alive',async()=>{
  const app=createApp({port:0,checkModel:false});const port=await app.listen();
  const socket=new WebSocket(`ws://127.0.0.1:${port}/api/overlay?token=${app.token}`);socket.on('error',()=>{});
  await new Promise(done=>socket.once('open',done));const closed=new Promise(done=>socket.once('close',code=>done(code)));
  socket.send(Buffer.alloc(20000));assert.equal(await closed,1009);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/config`)).status,200);await app.close();
});

test('A flood of final segments has bounded storage and explicit overflow errors',async()=>{
  const errors=[];const pipeline=new CaptionPipeline({concurrency:1,emit:event=>{if(event.type==='segment_error')errors.push(event);},translate:job=>new Promise((_,reject)=>job.signal.addEventListener('abort',()=>reject(job.signal.reason),{once:true}))});
  for(let i=0;i<1000;i++)pipeline.transcript({id:String(i),text:'An ordinary English sentence.',final:true});
  assert.ok(pipeline.queue.length<=24);assert.ok(pipeline.items.size<=160);assert.ok(errors.length>900);pipeline.close();
});

test('Quiet consonants do not split a low-volume utterance into tiny fragments',()=>{
  const items=[];const segmenter=new Segmenter({onSegment:item=>items.push(item)}),loud=Buffer.alloc(2400),soft=Buffer.alloc(2400);
  for(let i=0;i<2400;i+=2){loud.writeInt16LE(130,i);soft.writeInt16LE(50,i);}
  for(let i=0;i<70;i++)segmenter.push(i%10===0?loud:soft,i*50);for(let i=0;i<13;i++)segmenter.push(Buffer.alloc(2400),(70+i)*50);
  assert.equal(items.filter(item=>item.final).length,1);assert.ok(items.find(item=>item.final).audio.length>=70*2400);
});

test('Late recognition after recovery retains original audio order',async()=>{
  const events=[],contexts=[];
  const pipeline=new CaptionPipeline({emit:x=>events.push(x),translate:async job=>{contexts.push(job.context);return{text:'\u5b57\u5e55'};}});
  pipeline.transcript({id:'newer',text:'newer speech was recognized first',sourceSequence:9,final:true});
  pipeline.transcript({id:'older',text:'older speech recovered late',sourceSequence:8,final:true});
  await until(()=>events.filter(x=>x.type==='translation'&&x.final).length===2);
  assert.equal(events.find(x=>x.type==='transcript'&&x.id==='older').sequence,8);
  assert.equal(events.find(x=>x.type==='transcript'&&x.id==='newer').sequence,9);
  assert.ok(contexts[1].every(x=>x.en!=='newer speech was recognized first'));
  pipeline.close();
});

test('Exhausted system capture recovery releases the session and shows a stopped native state',async()=>{
  let captureEmit,asrClosed=false,captureClosed=false;
  const app=createApp({port:0,checkModel:false,translate:async()=>({text:'unused'}),asrFactory:emit=>{setTimeout(()=>emit({type:'ready'}),5);return{transcribe(){},close(){asrClosed=true;}};},captureFactory:emit=>{captureEmit=emit;return{close(){captureClosed=true;}};}});
  const port=await app.listen(),states=[];
  const native=new WebSocket(`ws://127.0.0.1:${port}/api/overlay?token=${app.token}`);
  native.on('message',raw=>states.push(JSON.parse(raw)));await new Promise(done=>native.once('open',done));native.send(JSON.stringify({type:'native-ready'}));
  const session=new LiveSession({token:app.token,options:{source:'system'},baseUrl:`ws://127.0.0.1:${port}/api/live`,WebSocketImpl:WebSocket,onStatus(){},onEvent(){},onFatal(){}});
  session.connect();await until(()=>session.ready);captureEmit({type:'capture_error'});
  await until(()=>app.sessions.size===0&&session.closed);
  assert.ok(asrClosed&&captureClosed);assert.ok(states.some(x=>x.type==='engine-state'&&x.running===false));
  assert.ok(states.some(x=>x.type==='subtitle'&&x.state==='Stopped · Please re-connect'));
  native.close();await app.close();
});
