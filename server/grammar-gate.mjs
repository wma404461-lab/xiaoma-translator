import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stopChild} from './process.mjs';

// One supervised CPU parser shared by the app, with no retained speech history.
export function createGrammarGate({python=process.env.FLOWSUB_GRAMMAR_PYTHON||resolve(process.env.FLOWSUB_CACHE||resolve(homedir(),'.cache','flowsub'),'grammar-venv','Scripts','python.exe'),spawnWorker=spawn,startupMs=8000,queryMs=2000,retryMs=1000,maxRestarts=3}={}){
  let worker,closed=false,sequence=0,restarts=0,ready=false,bootPromise,bootReject,startup,startedAt=0;
  const pending=new Map(),inflight=new Map();
  const clearInflight=()=>{for(const timer of inflight.values())clearTimeout(timer);inflight.clear();};
  const unavailable=()=>new Error('Syntax checking temporarily unavailable, waiting for recovery.');
  const boot=()=>{
    if(closed)throw new Error('Syntax checking has been disabled.');
    ready=false;startedAt=Date.now();
    bootPromise=new Promise((resolveReady,rejectReady)=>{
      bootReject=rejectReady;
      const current=worker=spawnWorker(python,['-u',fileURLToPath(new URL('../asr/grammar-worker.py',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1',BLIS_NUM_THREADS:'1'}});
      let ended=false;
      const fail=()=>{
        if(ended)return;ended=true;clearTimeout(startup);ready=false;rejectReady(unavailable());
        for(const query of pending.values())query.reject(unavailable());pending.clear();clearInflight();
        if(worker===current)worker=null;
        if(!closed){if(Date.now()-startedAt>60000)restarts=0;restarts++;}
      };
      current.fail=fail;
      current.stderr.on('data',()=>{});current.stdin.on('error',()=>{});
      current.on('error',fail);current.on('exit',fail);
      startup=setTimeout(()=>{fail();stopChild(current);},startupMs);startup.unref();
      createInterface({input:current.stdout}).on('line',line=>{
        if(current!==worker)return;let value;try{value=JSON.parse(line);}catch{return;}
        if(value.type==='ready'){ready=true;clearTimeout(startup);resolveReady();return;}
        clearTimeout(inflight.get(value.id));inflight.delete(value.id);const query=pending.get(value.id);if(!query)return;
        if(value.error||typeof value.allow!=='boolean')query.reject(unavailable());else query.resolve(value);
      });
    });
    bootPromise.catch(()=>{});return bootPromise;
  };
  const check=async({text,previous,signal})=>{
    if(closed)throw new Error('Syntax checking has been disabled.');signal?.throwIfAborted();
    if(!worker){
      if(restarts>maxRestarts)throw unavailable();
      if(restarts&&Date.now()-startedAt<retryMs)throw unavailable();
      boot();
    }
    if(!ready){
      if(signal){let abort;await Promise.race([bootPromise,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]).finally(()=>signal.removeEventListener('abort',abort));}
      else await bootPromise;
    }
    signal?.throwIfAborted();
    if(closed||!worker||!ready)throw unavailable();
    if(typeof text!=='string'||!text||text.length>4000)throw new Error('Syntax checking input is too long or empty.');
    if(inflight.size>=2)throw new Error('Syntax checking is currently busy.');
    const id=++sequence,current=worker;
    return new Promise((resolveQuery,rejectQuery)=>{
      // A source cancellation stops its consumer, not work already queued in
      // the parser. Keep that work bounded until a real reply or owned failure.
      const cleanup=()=>{signal?.removeEventListener('abort',abort);pending.delete(id);};
      const abort=()=>{cleanup();rejectQuery(signal.reason);};
      const timer=setTimeout(()=>{
        if(closed||worker!==current)return;
        pending.get(id)?.reject(new Error('Syntax checking timed out.'));current.fail();stopChild(current);
      },queryMs);timer.unref();
      pending.set(id,{resolve:value=>{cleanup();resolveQuery(value);},reject:error=>{cleanup();rejectQuery(error);}});
      signal?.addEventListener('abort',abort,{once:true});
      inflight.set(id,timer);current.stdin.write(JSON.stringify({id,text,previous:Boolean(previous?.length)})+'\n',error=>{if(error)pending.get(id)?.reject(unavailable());});
    });
  };
  // Warm at startup so the first spoken phrase doesn't load the parser.
  boot();
  return {check,close(){if(closed)return;closed=true;clearTimeout(startup);bootReject?.(unavailable());for(const query of pending.values())query.reject(unavailable());pending.clear();clearInflight();const current=worker;worker=null;stopChild(current);}};
}
