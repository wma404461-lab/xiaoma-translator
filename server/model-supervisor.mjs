import {stopChild} from './process.mjs';

// /health proves HTTP readiness/liveness, not a generation's own progress.
// Only the child created by this supervisor may be terminated.
export function createModelSupervisor({spawnWorker,health,onEvent=()=>{},unhealthyMs=5000,startupMs=90000,inferenceSilenceMs=10000,pollMs=1000,retryMs=1000,maxRestarts=3,now=Date.now}){
  let worker,closed=false,restarts=0,bootAt=0,lastHealthy=0,healthyAt=0,loaded=false,checking=false,retryTimer,resolveReady,rejectReady;
  let ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});
  const unavailable=()=>new Error('本地翻译模型无法恢复，请重新启动。');
  const boot=()=>{
    if(closed)return;
    bootAt=lastHealthy=now();healthyAt=0;loaded=false;
    let failed=false;
    const current=worker=spawnWorker();
    const failure=()=>{
      if(closed||failed||worker!==current)return;failed=true;worker=null;loaded=false;
      stopChild(current);
      if(++restarts<=maxRestarts){onEvent({type:'recovering'});retryTimer=setTimeout(boot,restarts*retryMs);retryTimer.unref();}
      else{onEvent({type:'fatal'});rejectReady(unavailable());}
    };
    current.fail=failure;current.on('error',failure);current.on('exit',failure);
  };
  const probe=async()=>{
    if(closed||!worker||checking)return;
    checking=true;const current=worker;
    try{
      let ok=false;try{ok=await health(current);}catch{}
      if(closed||worker!==current)return;
      if(ok){
        lastHealthy=now();
        if(!loaded){loaded=true;healthyAt=now();resolveReady();onEvent({type:'ready'});}
        if(healthyAt&&now()-healthyAt>=60000)restarts=0;
      }else if((loaded&&now()-lastHealthy>=unhealthyMs)||(!loaded&&now()-bootAt>=startupMs))current.fail();
    }finally{checking=false;}
  };
  boot();const watchdog=setInterval(probe,pollMs);watchdog.unref();probe();
  const observations=new Set();
  const observeInference=({signal}={})=>{
    const current=worker;
    if(closed||!loaded||!current||!signal||signal.aborted)return {progress(){},finish(){}};
    let lastProgress=now(),finished=false;
    const finish=()=>{if(finished)return;finished=true;signal.removeEventListener('abort',aborted);observations.delete(finish);};
    const aborted=()=>{
      // Only our existing phrase-job deadline can diagnose a stalled request.
      // Stop/source switches, late results and a slow but productive stream do
      // not authorize replacing the model. Headers/keepalives are not progress.
      const stalled=signal.reason?.code==='FLOWSUB_TRANSLATION_TIMEOUT'&&now()-lastProgress>=inferenceSilenceMs;
      finish();
      if(stalled&&!closed&&worker===current&&loaded)current.fail();
    };
    observations.add(finish);signal.addEventListener('abort',aborted,{once:true});
    return {progress(){if(!finished&&worker===current)lastProgress=now();},finish};
  };
  return {get ready(){return ready;},isReady:()=>!closed&&loaded&&Boolean(worker),observeInference,
    restart(){
      if(closed)return Promise.reject(unavailable());
      const previous=worker;worker=null;loaded=false;clearTimeout(retryTimer);restarts=0;
      for(const finish of observations)finish();stopChild(previous);
      ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});boot();return ready;
    },
    close(){if(closed)return;closed=true;for(const finish of observations)finish();clearTimeout(retryTimer);clearInterval(watchdog);rejectReady(unavailable());stopChild(worker);worker=null;}};
}
