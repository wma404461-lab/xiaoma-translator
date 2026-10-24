import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {createGrammarGate} from '../server/grammar-gate.mjs';
const fixture=fileURLToPath(new URL('./helpers/grammar-worker-fixture.mjs',import.meta.url));
const options={startupMs:2000,queryMs:500,retryMs:0,spawnWorker:(_,__,settings)=>spawn(process.execPath,[fixture],settings)};
test('Aborted syntax queries cannot fill the worker input with unlimited queued speech',async()=>{
  let boots=0;const gate=createGrammarGate({...options,spawnWorker:(_,__,settings)=>{boots++;return spawn(process.execPath,[fixture],settings);}});
  try{
    assert.equal((await gate.check({text:'NOUN'})).allow,false);
    for(let n=0;n<2;n++){
      const abort=new AbortController(),query=gate.check({text:'HOLD',signal:abort.signal});
      await wait(10);abort.abort();await assert.rejects(query,{name:'AbortError'});
    }
    for(let n=0;n<100;n++)await assert.rejects(gate.check({text:'SAFE'}),/busy/);
    // The canceled requests must still expire; otherwise this queue stays full
    // forever while the worker remains alive but cannot produce a response.
    await wait(650);assert.equal((await gate.check({text:'SAFE'})).allow,true);assert.equal(boots,2);
  }finally{gate.close();}
});
test('A hung syntax query terminates its owned worker and a new query recovers',async()=>{
  let boots=0;const gate=createGrammarGate({...options,queryMs:100,spawnWorker:(_,__,settings)=>{boots++;return spawn(process.execPath,[fixture],settings);}});
  try{
    await assert.rejects(gate.check({text:'HOLD'}),/timed out/);await wait(70);
    assert.equal((await gate.check({text:'SAFE'})).allow,true);assert.equal(boots,2);
  }finally{gate.close();}
});
test('Syntax worker crashes reject pending speech and bounded recovery never bypasses the check',async()=>{
  let boots=0;const gate=createGrammarGate({...options,maxRestarts:1,spawnWorker:(_,__,settings)=>{boots++;return spawn(process.execPath,[fixture],settings);}});
  try{
    await assert.rejects(gate.check({text:'CRASH'}),/unavailable/);
    assert.equal((await gate.check({text:'NOUN'})).allow,false);
    await assert.rejects(gate.check({text:'CRASH'}),/unavailable/);
    await assert.rejects(gate.check({text:'SAFE'}),/unavailable/);assert.equal(boots,2);
  }finally{gate.close();}
});

test('A real reply to a canceled query clears its deadline without restarting a healthy parser',async()=>{
  let boots=0;const gate=createGrammarGate({...options,queryMs:400,spawnWorker:(_,__,settings)=>{boots++;return spawn(process.execPath,[fixture],settings);}});
  try{
    await gate.check({text:'SAFE'});
    const controller=new AbortController(),query=gate.check({text:'LATE',signal:controller.signal});
    await wait(10);controller.abort();await assert.rejects(query,{name:'AbortError'});
    await wait(500);assert.equal((await gate.check({text:'SAFE'})).allow,true);assert.equal(boots,1);
  }finally{gate.close();}
});
