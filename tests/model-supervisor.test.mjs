import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createModelSupervisor} from '../server/model-supervisor.mjs';
const until=async condition=>{const start=Date.now();while(!condition()){if(Date.now()-start>12000)throw new Error('Model supervision timeout');await delay(10);}};
function fixture(options={}){
  const children=[],readyPids=new Set(),blocked=new Set(),events=[];
  const supervisor=createModelSupervisor({pollMs:20,unhealthyMs:150,startupMs:5000,retryMs:20,...options,
    spawnWorker(){
      const child=spawn(process.execPath,[fileURLToPath(new URL('./helpers/model-worker-fixture.mjs',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(child);
      child.stdout.on('data',()=>readyPids.add(child.pid));child.stderr.on('data',()=>{});return child;
    },health:options.health||((child)=>Promise.resolve(readyPids.has(child.pid)&&!blocked.has(child.pid))),onEvent:event=>events.push(event)});
  return {supervisor,children,blocked,events};
}

test('Manual refresh can restart an exhausted owned model and await fresh readiness',async()=>{
  let healthy=false;const f=fixture({startupMs:40,maxRestarts:0,health:async()=>healthy});
  try{
    await assert.rejects(f.supervisor.ready);assert.equal(f.supervisor.isReady(),false);
    healthy=true;await f.supervisor.restart();
    assert.equal(f.children.length,2);assert.equal(f.supervisor.isReady(),true);
  }finally{f.supervisor.close();}
});
test('An owned live model with unresponsive health is replaced and becomes ready again',async()=>{
  const {supervisor,children,blocked,events}=fixture();
  try{
    await supervisor.ready;blocked.add(children[0].pid);
    await until(()=>events.filter(e=>e.type==='ready').length===2);
    assert.equal(children.length,2);assert.equal(events.filter(e=>e.type==='recovering').length,1);
    assert.ok(!events.some(e=>e.type==='fatal'));
  }finally{supervisor.close();}
});
test('Model loading has startup grace and a bounded failure count',async()=>{
  const {supervisor,children,events}=fixture({startupMs:100,health:async()=>false});
  try{
    await assert.rejects(supervisor.ready,/无法恢复/);await delay(200);
    assert.equal(children.length,4);assert.equal(events.filter(e=>e.type==='recovering').length,3);
    assert.equal(events.filter(e=>e.type==='fatal').length,1);
  }finally{supervisor.close();}
});
test('Health checks never overlap and closing cancels retries and late failure results',async()=>{
  let active=0,maximum=0,checks=0;
  const {supervisor,children,events}=fixture({health:async()=>{checks++;maximum=Math.max(maximum,++active);await delay(120);active--;return false;}});
  await delay(300);supervisor.close();const count=events.length;await delay(250);
  assert.ok(checks>=2);assert.equal(maximum,1);assert.equal(children.length,1);assert.equal(events.length,count);
});
test('A healthy model does not reload during idle monitoring',async()=>{
  const {supervisor,children,events}=fixture();
  try{
    await supervisor.ready;await delay(350);assert.equal(children.length,1);
    assert.equal(events.filter(e=>e.type==='ready').length,1);assert.ok(!events.some(e=>e.type==='recovering'));
  }finally{supervisor.close();}
});

const phraseTimeout=()=>Object.assign(new Error('Phrase job deadline'),{code:'FLOWSUB_TRANSLATION_TIMEOUT'});
test('A phrase deadline with no inference progress replaces the owned model even while health is responsive',async()=>{
  let clock=100;
  const {supervisor,children,events}=fixture({now:()=>clock});
  try{
    await supervisor.ready;const controller=new AbortController();
    supervisor.observeInference({signal:controller.signal});clock+=12000;controller.abort(phraseTimeout());
    await until(()=>events.filter(e=>e.type==='ready').length===2);
    assert.equal(children.length,2);assert.equal(events.filter(e=>e.type==='recovering').length,1);
  }finally{supervisor.close();}
});
test('Productive streams, short requests and user/source cancellation do not authorize a model restart',async()=>{
  let clock=100;
  const {supervisor,children,events}=fixture({now:()=>clock});
  try{
    await supervisor.ready;
    const productive=new AbortController(),watch=supervisor.observeInference({signal:productive.signal});
    clock+=11000;watch.progress();clock+=1000;productive.abort(phraseTimeout());
    const short=new AbortController();supervisor.observeInference({signal:short.signal});clock+=100;short.abort(phraseTimeout());
    const user=new AbortController();supervisor.observeInference({signal:user.signal});clock+=15000;user.abort();
    await delay(80);assert.equal(children.length,1);assert.ok(!events.some(e=>e.type==='recovering'));
  }finally{supervisor.close();}
});
test('Completed, loading, closed and stale-generation observations cannot replace a worker',async()=>{
  let clock=100;
  const {supervisor,children,blocked,events}=fixture({now:()=>clock});
  const loading=new AbortController();supervisor.observeInference({signal:loading.signal});
  try{
    await supervisor.ready;clock+=15000;loading.abort(phraseTimeout());
    const complete=new AbortController(),done=supervisor.observeInference({signal:complete.signal});done.finish();clock+=15000;complete.abort(phraseTimeout());
    const old=new AbortController();supervisor.observeInference({signal:old.signal});blocked.add(children[0].pid);clock+=1000;
    await until(()=>events.filter(e=>e.type==='ready').length===2);
    clock+=15000;old.abort(phraseTimeout());await delay(80);assert.equal(children.length,2);
    const closed=new AbortController();supervisor.observeInference({signal:closed.signal});supervisor.close();clock+=15000;closed.abort(phraseTimeout());
    await delay(80);assert.equal(children.length,2);assert.equal(events.filter(e=>e.type==='recovering').length,1);
  }finally{supervisor.close();}
});
