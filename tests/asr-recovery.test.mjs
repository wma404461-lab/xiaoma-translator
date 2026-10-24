import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createLocalAsr} from '../server/local-asr.mjs';

const until=async condition=>{const start=Date.now();while(!condition()){if(Date.now()-start>12000)throw new Error('ASR recovery timeout');await delay(10);}};
const segment=id=>({id,audio:Buffer.alloc(2400),revision:1,final:true});
function fixture(events,modes,options={}){
  const children=[];
  const asr=createLocalAsr(event=>events.push(event),{
    python:process.execPath,progressMs:1000,startupMs:5000,pollMs:20,retryMs:20,...options,
    spawnWorker(_python,_args,opts){
      const child=spawn(process.execPath,[fileURLToPath(new URL('./helpers/asr-worker-fixture.mjs',import.meta.url)),modes[children.length]??'working'],opts);children.push(child);return child;
    }
  });
  return {asr,children};
}
test('A live but stalled recognition worker is replaced and pending original requests replay in order',async()=>{
  const events=[],{asr,children}=fixture(events,['hang','working']);
  try{
    await until(()=>events.some(e=>e.type==='ready'));
    asr.transcribe(segment('first'));asr.transcribe(segment('second'));
    await until(()=>events.filter(e=>e.type==='transcript').length===2);
    assert.equal(children.length,2);
    assert.match(events.find(e=>e.type==='recovering').message,/recognition timeout/);
    assert.deepEqual(events.filter(e=>e.type==='transcript').map(e=>e.id),['first','second']);
    assert.ok(!events.some(e=>e.type==='fatal'));
    await until(()=>children[0].exitCode!==null);
  }finally{asr.close();}
});
test('Idle silence and reset work do not cause false recognition timeout restarts',async()=>{
  const events=[],{asr,children}=fixture(events,['hang'],{progressMs:150});
  try{
    await until(()=>events.some(e=>e.type==='ready'));
    await delay(300);assert.equal(children.length,1);
    asr.transcribe(segment('discarded'));asr.reset();
    await delay(300);assert.equal(children.length,1);
    assert.ok(!events.some(e=>e.type==='recovering'));
  }finally{asr.close();}
});
test('A recognized unfinished utterance stays cached without a false timeout, then new stalled work still recovers',async()=>{
  const events=[],{asr,children}=fixture(events,['work-then-hang','working'],{progressMs:200});
  try{
    await until(()=>events.some(e=>e.type==='ready'));
    asr.transcribe({...segment('utterance'),final:false});
    await until(()=>events.some(e=>e.type==='transcript'));
    await delay(350);assert.equal(children.length,1);assert.ok(!events.some(e=>e.type==='recovering'));
    asr.transcribe({...segment('utterance'),revision:2});
    await until(()=>events.some(e=>e.type==='transcript'&&e.final));
    assert.equal(children.length,2);assert.equal(events.findLast(e=>e.type==='transcript').revision,2);
  }finally{asr.close();}
});
test('An unresponsive startup retries at most three times and reports exhaustion once',async()=>{
  const events=[],{asr,children}=fixture(events,Array(4).fill('startup-hang'),{startupMs:100});
  try{
    asr.transcribe(segment('pending'));
    await until(()=>events.some(e=>e.type==='fatal'));
    await delay(200);
    assert.equal(children.length,4);assert.equal(events.filter(e=>e.type==='recovering').length,3);
    assert.equal(events.filter(e=>e.type==='fatal').length,1);
  }finally{asr.close();}
});
test('Closing during recognition recovery cancels its retry and later audio cannot spawn a worker',async()=>{
  const events=[],{asr,children}=fixture(events,['hang','working'],{retryMs:250});
  await until(()=>events.some(e=>e.type==='ready'));
  asr.transcribe(segment('pending'));await until(()=>events.some(e=>e.type==='recovering'));
  asr.close();asr.transcribe(segment('after-close'));await delay(350);
  assert.equal(children.length,1);assert.ok(!events.some(e=>e.type==='transcript'));
});

test('Stream readiness starts queued speech before final readiness without replaying it twice',async()=>{
  const events=[],{asr,children}=fixture(events,['staged']);
  try{
    asr.transcribe({...segment('early'),final:false});
    await until(()=>events.some(e=>e.type==='transcript'));
    assert.ok(!events.some(e=>e.type==='ready'));
    await until(()=>events.some(e=>e.type==='ready'));await delay(150);
    assert.equal(events.filter(e=>e.type==='transcript'&&e.id==='early').length,1);
    asr.transcribe({...segment('early'),revision:2});
    await until(()=>events.some(e=>e.type==='transcript'&&e.final));
    assert.equal(children.length,1);assert.equal(events.filter(e=>e.type==='transcript').length,2);
  }finally{asr.close();}
});

test('Partial stream readiness retains the full-model startup deadline and bounded recovery',async()=>{
  const events=[],{asr,children}=fixture(events,['stream-startup-hang','working'],{startupMs:500,progressMs:100});
  try{
    asr.transcribe(segment('queued-final'));
    await until(()=>events.some(e=>e.type==='stream_ready'));
    await delay(150);assert.equal(children.length,1);assert.ok(!events.some(e=>e.type==='recovering'));
    await until(()=>events.some(e=>e.type==='transcript'&&e.final));
    assert.equal(children.length,2);assert.ok(!events.some(e=>e.type==='fatal'));
  }finally{asr.close();}
});

test('Continuous streaming cannot hide a final worker hang, and unfinished finals replay once',async()=>{
  const events=[],{asr,children}=fixture(events,['final-hang','working'],{progressMs:1000,finalProgressMs:300});
  let drafts;
  try{
    await until(()=>events.some(e=>e.type==='ready'));
    asr.transcribe(segment('stalled-final'));
    await until(()=>events.some(e=>e.type==='final_started'));
    let revision=0;drafts=setInterval(()=>asr.transcribe({...segment('live-draft'),revision:++revision,final:false}),30);
    await until(()=>events.some(e=>e.type==='transcript'&&e.id==='stalled-final'&&e.final));
    assert.ok(events.filter(e=>e.type==='transcript'&&!e.final).length>=3);
    assert.equal(children.length,2);assert.equal(events.filter(e=>e.type==='recovering').length,1);
    assert.equal(events.filter(e=>e.id==='stalled-final'&&e.type==='transcript'&&e.final).length,1);
  }finally{clearInterval(drafts);asr.close();}
});

test('Completing, failing or resetting a final review cancels its independent deadline',async()=>{
  for(const mode of ['final-slow','final-error','final-hang']){
    const events=[],{asr,children}=fixture(events,[mode],{progressMs:1000,finalProgressMs:300});
    try{
      await until(()=>events.some(e=>e.type==='ready'));
      asr.transcribe(segment('final'));
      await until(()=>events.some(e=>e.type==='final_started'));
      if(mode==='final-hang')asr.reset();
      else await until(()=>events.some(e=>e.type==='asr_error'||e.type==='transcript'&&e.final));
      await delay(450);assert.equal(children.length,1);assert.ok(!events.some(e=>e.type==='recovering'));
    }finally{asr.close();}
  }
});
