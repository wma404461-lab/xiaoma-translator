import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {pythonPath} from './local-asr.mjs';
import {stopChild} from './process.mjs';
export function createSystemCapture(onEvent,{spawnWorker=spawn,python=pythonPath,progressMs=5000,startupMs=20000,pollMs=1000,retryMs=1000,now=Date.now}={}){
  let child,closed=false,restarts=0,lastBoot=0,lastEvent=0,ready=false,timer;
  const boot=()=>{
    if(closed)return;
    lastBoot=lastEvent=now();ready=false;let failed=false,current;
    const failure=()=>{
      if(closed||failed||child!==current)return;failed=true;child=null;stopChild(current);
      if(now()-lastBoot>60000)restarts=0;
      if(++restarts<=3){onEvent({type:'capture_recovering',message:'系统音频接入中断，正在恢复。中断期间的声音可能漏句。'});timer=setTimeout(boot,restarts*retryMs);timer.unref();}
      else onEvent({type:'capture_error'});
    };
    // Capture only mixes short buffers. BLAS thread pools reserve large unused
    // workspaces here; keep this child isolated from the inference processes.
    current=child=spawnWorker(python,['-u',fileURLToPath(new URL('../desktop/capture.py',import.meta.url)),'--ignore-tree',String(process.pid)],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1',BLIS_NUM_THREADS:'1'},stdio:['pipe','pipe','pipe']});
    current.fail=failure;
    const lines=createInterface({input:current.stdout});lines.on('line',line=>{
      if(closed||failed||child!==current)return;
      let value;try{value=JSON.parse(line);}catch{return;}
      lastEvent=now();if(value.type==='capture_ready')ready=true;
      if(value.type==='capture_error')failure();
      else if(value.type!=='capture_health')onEvent({...value,...value.type==='capture_ready'?{recovered:restarts>0}:{}});
    });current.stderr.on('data',()=>{});current.on('error',failure);current.on('exit',failure);current.stdin.on('error',()=>{});
  };
  boot();
  const watchdog=setInterval(()=>{
    if(closed||!child)return;
    if((!ready&&now()-lastBoot>=startupMs)||(ready&&now()-lastEvent>=progressMs))child.fail();
  },pollMs);watchdog.unref();
  return {close(){closed=true;clearTimeout(timer);clearInterval(watchdog);stopChild(child);}};
}
