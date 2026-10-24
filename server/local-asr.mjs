import './env.mjs';
import {stopChild} from './process.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const cacheRoot = process.env.FLOWSUB_CACHE || resolve(homedir(), '.cache', 'flowsub');
export const pythonPath = process.env.FLOWSUB_PYTHON || resolve(cacheRoot, 'venv', 'Scripts', 'python.exe');
export function createLocalAsr(onEvent, {spawnWorker=spawn, python=pythonPath, progressMs=15000, finalProgressMs=progressMs, startupMs=60000, pollMs=1000, retryMs=1000, now=Date.now} = {}) {
  let worker, ready = false, streamReady = false, closed = false, restartCount = 0, bootAt=0, progressAt=0, healthyAt=0, retryTimer;
  const retained = new Map(), pending = new Map(), finalProcessing = new Map();
  const boot = () => {
    if (closed) return;
    bootAt=progressAt=now();healthyAt=0;ready=streamReady=false;finalProcessing.clear();
    if (!existsSync(python)) { onEvent({ type: 'fatal', message: 'Local recognition not installed. Please run it setup-local.ps1.' }); return; }
    let failed=false;
    const current=worker=spawnWorker(python, ['-u', fileURLToPath(new URL('../asr/streaming-worker.py', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_SYMLINKS_WARNING: '1', FLOWSUB_CACHE: cacheRoot } });
    const failure=(timedOut=false)=>{
      if(closed||failed||worker!==current)return;failed=true;ready=streamReady=false;worker=null;finalProcessing.clear();
      stopChild(current);
      if(++restartCount<=3){
        onEvent({type:'recovering',message:timedOut?'Local recognition timeout, recovering; unfinished audio will be re-recognized.':'Recovering local recognition; unfinished audio will be re-recognized.'});
        retryTimer=setTimeout(boot,restartCount*retryMs);retryTimer.unref();
      }else onEvent({type:'fatal',message:'Recognition program failed to start consecutively or is unresponsive. Please restart translation.'});
    };
    current.fail=failure;
    const lines = createInterface({ input: current.stdout });
    lines.on('line', line => {
      if(closed||failed||worker!==current)return;
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'ready') { ready = true; healthyAt=progressAt=now(); }
      if ((event.type === 'stream_ready' || event.type === 'ready') && !streamReady) {
        streamReady = true;progressAt=now();
        for (const value of retained.values()) current.stdin.write(JSON.stringify(value) + '\n');
      }
      const request=pending.get(event.id);
      if(event.type==='final_started' && request?.final && event.revision>=request.revision){
        const previous=finalProcessing.get(event.id);
        if(!previous || event.revision>previous.revision)finalProcessing.set(event.id,{revision:event.revision,at:now()});
      }
      if(request&&(event.type==='transcript'||event.type==='asr_error')){
        progressAt=now();if(healthyAt&&now()-healthyAt>60000)restartCount=0;
        if(event.type==='asr_error'||event.revision>=request.revision&&(event.final||!request.final)){
          pending.delete(event.id);finalProcessing.delete(event.id);
        }
      }
      if (event.final || event.type === 'asr_error') retained.delete(event.id);
      onEvent(event);
    });
    current.stderr.on('data', () => {}); // Never expose environment/paths/upstream payloads in captions.
    current.stdin.on('error', () => {});
    current.on('error',()=>failure());current.on('exit',()=>failure());
  };
  boot();
  // A live PID is insufficient: native inference can hang without exiting.
  // Idle silence has no retained work and must never trigger this recovery.
  const watchdog=setInterval(()=>{
    if(closed||!worker)return;
    // A responsive streaming thread cannot authorize a stalled final worker.
    const finalStalled=ready && [...finalProcessing.values()].some(job=>now()-job.at>=finalProgressMs);
    if((!ready&&now()-bootAt>=startupMs)||(ready&&pending.size&&now()-progressAt>=progressMs)||finalStalled)worker.fail(true);
  },pollMs);watchdog.unref();
  return {
    reset() {retained.clear();pending.clear();finalProcessing.clear();progressAt=now();if(worker?.stdin?.writable)worker.stdin.write(JSON.stringify({type:'reset'})+'\n');},
    transcribe(segment, terms = '') {
      if(closed)return;
      const value = { type: 'transcribe', ...segment, audio: segment.audio.toString('base64'), terms };
      if (retained.size >= 24 && !retained.has(value.id)) { onEvent({ type: 'asr_error', id: value.id }); return; }
      if(!pending.size)progressAt=now();
      pending.set(value.id,{revision:value.revision,final:!!value.final});
      retained.set(value.id, value);
      if (streamReady && worker.stdin.writableLength < 4_000_000) worker.stdin.write(JSON.stringify(value) + '\n');
    },
    close() { closed = true; clearTimeout(retryTimer);clearInterval(watchdog);retained.clear();pending.clear();finalProcessing.clear();stopChild(worker); }
  };
}
