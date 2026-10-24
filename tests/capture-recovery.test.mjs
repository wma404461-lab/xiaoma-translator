import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createSystemCapture} from '../server/system-capture.mjs';
const until=async predicate=>{const start=Date.now();while(!predicate()){if(Date.now()-start>12000)throw new Error('Capture recovery timeout');await delay(10);}};
function fixture(events,modes,options={}){
  const children=[];
  const capture=createSystemCapture(event=>events.push(event),{python:process.execPath,progressMs:1000,startupMs:5000,pollMs:20,retryMs:20,...options,
    spawnWorker(_python,_args,opts){
      const child=spawn(process.execPath,[fileURLToPath(new URL('./helpers/capture-worker-fixture.mjs',import.meta.url)),modes[children.length]??'healthy'],opts);children.push(child);return child;
    }});
  return {capture,children};
}
test('A capture process that stays alive without events recovers with one replacement',async()=>{
  const events=[],{capture,children}=fixture(events,['hang','healthy']);
  try{
    await until(()=>events.some(e=>e.type==='capture_ready'&&e.recovered));
    assert.equal(children.length,2);assert.equal(events.filter(e=>e.type==='capture_recovering').length,1);
    assert.ok(!events.some(e=>e.type==='capture_error'));
    assert.ok(!events.some(e=>e.type==='capture_health'));
  }finally{capture.close();}
});
test('Healthy capture waiting without a selected application does not restart or leak health events',async()=>{
  const events=[],{capture,children}=fixture(events,['healthy'],{progressMs:500});
  try{
    await until(()=>events.some(e=>e.type==='capture_ready'));await delay(1200);
    assert.equal(children.length,1);assert.equal(events.filter(e=>e.type==='capture_ready').length,1);
    assert.ok(!events.some(e=>['capture_recovering','capture_health','audio'].includes(e.type)));
  }finally{capture.close();}
});
test('An unresponsive capture startup has three retries and one terminal error',async()=>{
  const events=[],{capture,children}=fixture(events,Array(4).fill('startup-hang'),{startupMs:100});
  try{
    await until(()=>events.some(e=>e.type==='capture_error'));await delay(200);
    assert.equal(children.length,4);assert.equal(events.filter(e=>e.type==='capture_recovering').length,3);
    assert.equal(events.filter(e=>e.type==='capture_error').length,1);
  }finally{capture.close();}
});
test('Closing a recovering capture cancels the retry and ignores old-process output',async()=>{
  const events=[],{capture,children}=fixture(events,['hang','healthy'],{retryMs:400});
  await until(()=>events.some(e=>e.type==='capture_recovering'));
  capture.close();const count=events.length;await delay(500);
  assert.equal(children.length,1);assert.equal(events.length,count);
});
