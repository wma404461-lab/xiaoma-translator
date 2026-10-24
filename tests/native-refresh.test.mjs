import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server/index.mjs';

async function until(predicate){const started=Date.now();while(!predicate()){if(Date.now()-started>3000)throw new Error('Native recovery timed out');await delay(10);}}
async function fixture(options={}){
  const workers=[],captures=[],packets=[];
  const app=createApp({port:0,checkModel:false,nativeRetryMs:20,
    asrFactory:emit=>{const worker={emit,closed:0,transcribe(){},close(){this.closed++;}};workers.push(worker);queueMicrotask(()=>emit({type:'ready'}));return worker;},
    captureFactory:()=>{const capture={closed:0,close(){this.closed++;}};captures.push(capture);return capture;},
    phraseTranslate:async job=>({consume:job.words.length,zh:'\u5df2\u6062\u590d'}),...options});
  const port=await app.listen(),overlay=new WebSocket(`ws://127.0.0.1:${port}/api/overlay?token=${app.token}`);
  overlay.on('message',raw=>packets.push(JSON.parse(raw)));
  await new Promise(done=>overlay.once('open',done));overlay.send(JSON.stringify({type:'native-ready'}));overlay.send(JSON.stringify({type:'native-control',action:'start'}));
  await until(()=>workers.length===1&&app.sessions.size===1);
  return{app,workers,captures,packets,overlay,control:action=>overlay.send(JSON.stringify({type:'native-control',action})),close:async()=>{overlay.terminate();await app.close();}};
}
test('Refresh replaces stuck capture and recognition once, clears old captions and resumes',async()=>{
  let refreshCalls=0;const f=await fixture({onRefresh:async()=>{refreshCalls++;}});
  try{
    const oldKey=[...f.app.sessions.keys()][0];f.control('refresh');
    await until(()=>f.workers.length===2&&f.app.sessions.size===1);
    assert.equal(f.workers[0].closed,1);assert.equal(f.captures[0].closed,1);assert.equal(refreshCalls,1);
    assert.notEqual([...f.app.sessions.keys()][0],oldKey);
    assert.ok(f.packets.some(packet=>packet.state==='Refreshing'));
    assert.ok(f.packets.some(packet=>packet.type==='engine-state'&&packet.running));
  }finally{await f.close();}
});
test('Exhausted recognition recovers automatically, stays bounded, and manual refresh works afterward',async()=>{
  const f=await fixture();
  try{
    for(let index=0;index<4;index++){
      f.workers[index].emit({type:'fatal',message:'Fixture recognition failure'});
      if(index<3)await until(()=>f.workers.length===index+2);
    }
    await until(()=>f.packets.some(packet=>packet.state==='Waiting for refresh'));
    await delay(100);assert.equal(f.workers.length,4);
    f.control('refresh');await until(()=>f.workers.length===5);
    assert.equal(f.app.sessions.size,1);
  }finally{await f.close();}
});
test('Repeated refresh is serialized and stopping during model recovery prevents a new session',async()=>{
  let finish;const f=await fixture({onRefresh:()=>new Promise(done=>finish=done)});
  try{
    f.control('refresh');await until(()=>finish);f.control('refresh');f.control('stop');await delay(20);finish();await delay(60);
    assert.equal(f.workers.length,1);assert.equal(f.app.sessions.size,0);
  }finally{await f.close();}
});
