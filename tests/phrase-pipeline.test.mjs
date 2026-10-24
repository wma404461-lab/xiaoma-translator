import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {PhrasePipeline} from '../server/phrase-pipeline.mjs';
import {createSemanticTranslator} from '../server/semantic-translator.mjs';
import {needsParticleContinuation} from '../server/source-boundary.mjs';
const until = async predicate => {const start=Date.now();while(!predicate()){if(Date.now()-start>3000)throw new Error('Timed out');await delay(5);}};
const done = value => new Response(`data: ${JSON.stringify({choices:[{delta:{content:value}}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\n`);

test('A heard wake-up particle arriving during inference vetoes stale Chinese and later commits once',async()=>{
  const events=[];let answer;
  const p=new PhrasePipeline({stableMs:0,tailWords:0,continuationCheck:needsParticleContinuation,emit:event=>events.push(event),translate:job=>{
    if(!answer)return new Promise(done=>answer=done);
    if(!job.final)return{consume:0};
    return{consume:job.words.length,zh:'如果你早起。'};
  }});
  try{
    p.transcript({id:'late-particle',text:'If you wake'});await until(()=>answer);
    p.transcript({id:'late-particle',text:'If you wake up early'});
    answer({consume:3,zh:'如果你醒来的话'});await delay(20);
    assert.ok(!events.some(event=>event.type==='translation'));
    p.transcript({id:'late-particle',text:'If you wake up early',final:true});
    await until(()=>events.some(event=>event.type==='translation'));
    assert.equal(events.filter(event=>event.type==='translation').length,1);
    assert.equal(events.find(event=>event.type==='translation').sourceText,'If you wake up early');
  }finally{p.close();}
});

test('A qualification arriving during inference vetoes the stale unqualified Chinese',async()=>{
  const events=[];let answer;const p=new PhrasePipeline({stableMs:0,tailWords:0,emit:event=>events.push(event),translate:()=>new Promise(done=>answer=done)});
  try{
    p.transcript({id:'late',text:'We can begin'});await until(()=>answer);
    p.transcript({id:'late',text:'We can begin if everyone is ready'});
    answer({consume:3,zh:'我们可以开始。'});await delay(20);
    assert.ok(!events.some(event=>event.type==='translation'&&event.text==='我们可以开始。'));
  }finally{p.close();}
});

test('A failed final phrase retries automatically without new recognition and commits once',async()=>{
  let calls=0;const events=[];
  const p=new PhrasePipeline({retryMs:10,emit:event=>events.push(event),translate:async job=>{
    if(++calls===1)throw new Error('Transient inference failure');return{consume:job.words.length,zh:'字幕恢复了。'};
  }});
  try{
    p.transcript({id:'failed',text:'These captions can resume.',final:true});
    await until(()=>events.some(event=>event.type==='translation'));
    assert.equal(calls,2);assert.equal(events.filter(event=>event.type==='translation').length,1);
    assert.ok(events.some(event=>event.retrying===true));
  }finally{p.close();}
});
test('Permanent phrase failures retry only twice and later speech keeps translating',async()=>{
  let failures=0;const events=[];
  const p=new PhrasePipeline({retryMs:10,emit:event=>events.push(event),translate:async job=>{
    if(job.words[0]==='Fail'){failures++;throw new Error('Persistent failure');}
    return{consume:job.words.length,zh:'后续字幕正常。'};
  }});
  try{
    p.transcript({id:'failed',text:'Fail this source.',final:true});await until(()=>events.some(event=>event.retrying===false));
    p.transcript({id:'later',text:'Continue normally now.',final:true});await until(()=>events.some(event=>event.type==='translation'));
    assert.equal(failures,3);assert.equal(events.find(event=>event.type==='translation').sourceId,'later');
  }finally{p.close();}
});

test('An ended first utterance waits for a still-loading final model and keeps live English',async()=>{
  const events=[],jobs=[];const p=new PhrasePipeline({emit:x=>events.push(x),finalReviewMs:20,finalLoadingReviewMs:300,translate:async job=>{jobs.push(job);return{consume:job.words.length,zh:job.words.join(' ')};}});
  try{
    p.transcript({id:'early',text:'extreme motor violet',sourceEnded:true,reviewLoading:true,endReason:'silence'});
    await delay(60);assert.equal(jobs.length,0);assert.ok(events.some(e=>e.type==='transcript'));
    p.transcript({id:'early',text:'extreme ultraviolet',streamText:'extreme motor violet',final:true,endReason:'silence'});
    await until(()=>events.some(e=>e.type==='translation'));
    assert.equal(jobs[0].words.join(' '),'extreme ultraviolet');assert.equal(events.filter(e=>e.type==='translation').length,1);
  }finally{p.close();}
});

test('Loading review remains bounded when a final result never arrives',async()=>{
  const events=[];const p=new PhrasePipeline({emit:x=>events.push(x),finalReviewMs:20,finalLoadingReviewMs:80,translate:async job=>({consume:job.words.length,zh:'bounded fallback'})});
  try{
    p.transcript({id:'missing',text:'A complete original sentence',sourceEnded:true,reviewLoading:true});
    await delay(40);assert.ok(!events.some(e=>e.type==='translation'));
    await until(()=>events.some(e=>e.type==='translation'));assert.equal(events.filter(e=>e.type==='translation').length,1);
  }finally{p.close();}
});

test('A queued final review does not expire before processing begins or replay displayed words',async()=>{
  const events=[],jobs=[];const p=new PhrasePipeline({emit:x=>events.push(x),finalReviewMs:20,queuedReviewMs:400,processingReviewMs:120,translate:async job=>{jobs.push(job);return{consume:job.words.length,zh:job.words.join(' ')};}});
  try{
    p.transcript({id:'queued',text:'formed during an interruption',sourceEnded:true,reviewQueued:true});
    await delay(80);assert.equal(jobs.length,0);
    p.reviewStarted('queued');await delay(40);assert.equal(jobs.length,0);
    p.transcript({id:'queued',text:'formed during an eruption',final:true});
    await until(()=>events.some(e=>e.type==='translation'));assert.equal(jobs[0].words.join(' '),'formed during an eruption');
    p.reviewStarted('queued');await delay(150);assert.equal(events.filter(e=>e.type==='translation').length,1);
  }finally{p.close();}
});

test('Missing queued or processing review notifications both have bounded fallback',async()=>{
  for(const started of [false,true]){
    const events=[];const p=new PhrasePipeline({emit:x=>events.push(x),finalReviewMs:10,queuedReviewMs:60,processingReviewMs:70,translate:async job=>({consume:job.words.length,zh:'bounded original fallback'})});
    try{
      p.transcript({id:'missing',text:'A complete original sentence',sourceEnded:true,reviewQueued:true});
      if(started)p.reviewStarted('missing');
      await until(()=>events.some(e=>e.type==='translation'));assert.equal(events.filter(e=>e.type==='translation').length,1);
    }finally{p.close();}
  }
});

test('A semantic decision cannot translate tentative lookahead or change source words',async()=>{
  const requests=[];
  const translate=createSemanticTranslator({fetchImpl:async(_,options)=>{const r=JSON.parse(options.body);requests.push(r);return done(requests.length===1?'{"source":"We choose to go to the moon"}':'我们选择登月。');}});
  const result=await translate({words:'We choose to go to the moon in this decade'.split(' '),lookahead:'Secret unconfirmed words',signal:new AbortController().signal});
  assert.equal(result.consume,7);assert.equal(result.zh,'我们选择登月。');
  assert.deepEqual(requests.map(r=>r.id_slot),[0,1]);assert.ok(requests.every(r=>r.cache_prompt===true));
  assert.ok(requests.every(r=>!JSON.stringify(r).includes('Secret')));
  const speech=JSON.parse(requests[1].messages[1].content.replace(/\n\/no_think$/,''));assert.equal(speech.speech,'We choose to go to the moon');
  const invalid=createSemanticTranslator({fetchImpl:async()=>done('{"source":"We choose to win the moon"}')});
  await assert.rejects(invalid({words:'We choose to go to the moon'.split(' '),signal:new AbortController().signal}),/改写/);
});

test('Incomplete endings wait without requesting a translation',async()=>{
  let calls=0;const translate=createSemanticTranslator({fetchImpl:async()=>{calls++;throw new Error('Unexpected request');}});
  for(const text of ['We choose to','I went to visit the','The person who'])assert.equal((await translate({words:text.split(' '),signal:new AbortController().signal})).consume,0);
  assert.equal(calls,0);
});

test('Observed unfinished contractions and adjective complements cannot become Chinese',async()=>{
  for(const text of ["AND SKILLS BECAUSE THAT CHALLENGE IS ONE THAT WE'RE",'WILLING TO ACCEPT ONE WE ARE UNWILLING','WE ARE READY TO GO BUT THEY ARE']){
    let calls=0;const translate=createSemanticTranslator({fetchImpl:async()=>{calls++;return done(JSON.stringify({source:text}));}});
    assert.equal((await translate({words:text.split(' '),signal:new AbortController().signal})).consume,0);
    assert.equal(calls,1);
  }
});

test('Stable phrases appear before ASR finalization, and Whisper cannot repeat Chinese',async()=>{
  let time=0;const calls=[],events=[];
  const p=new PhrasePipeline({now:()=>time,stableMs:100,emit:x=>events.push(x),translate:async job=>{calls.push(job);return{consume:job.words.length,zh:job.words.join(' ')};}});
  p.transcript({id:'a',text:'We choose to go to the moon today',sourceSequence:0});
  time=120;p.pump();await until(()=>events.some(x=>x.type==='translation'));
  assert.equal(calls[0].words.join(' '),'We choose to go to the moon');assert.equal(calls[0].final,false);
  assert.equal(calls[0].lookahead,'today');
  p.transcript({id:'a',text:'We choose to go to the moon today',sourceEnded:true,sourceSequence:0});
  await delay(10);assert.equal(events.filter(x=>x.type==='translation').length,1);
  p.transcript({id:'a',text:'We chose to go to the moon today.',streamText:'We choose to go to the moon today',final:true,sourceSequence:0});
  await until(()=>events.filter(x=>x.type==='translation').length===2);
  p.transcript({id:'a',text:'We chose to go to the moon today.',streamText:'We choose to go to the moon today',final:true,sourceSequence:0});
  await delay(10);assert.equal(events.filter(x=>x.type==='translation').length,2);
  assert.deepEqual(events.filter(x=>x.type==='translation').map(x=>x.sequence),[0,1]);
  assert.equal(events.findLast(x=>x.type==='transcript').text,'We chose to go to the moon today.');p.close();
});
test('Final recognition repairs unseen words after an unchanged committed prefix, with a bounded fallback',async()=>{
  let time=0;const jobs=[],events=[];
  const p=new PhrasePipeline({now:()=>time,stableMs:0,tailWords:0,finalReviewMs:1000,emit:x=>events.push(x),translate:async job=>{jobs.push(job);return{consume:job.words.length,zh:job.words.join(' ')};}});
  p.transcript({id:'a',text:'AND ONE WE INTEND TO WIN'});await until(()=>events.some(x=>x.type==='translation'));
  p.transcript({id:'a',text:'AND ONE WE INTEND TO WIN AND THE OTHERS TO',sourceEnded:true});await delay(10);
  assert.equal(jobs.length,1);
  p.transcript({id:'a',text:'And one we intend to win, and the others too.',final:true});
  await until(()=>jobs.length===2);assert.equal(jobs[1].words.join(' '),'and the others too.');
  assert.equal(events.filter(x=>x.type==='translation')[0].sourceText,'AND ONE WE INTEND TO WIN');
  p.transcript({id:'b',text:'Still streaming the next original utterance',sourceEnded:true});await delay(10);assert.equal(jobs.length,2);
  time=1001;p.pump();await until(()=>jobs.length===3);assert.equal(jobs[2].words.join(' '),'Still streaming the next original utterance');p.close();
});
test('A final correction that changes committed words cannot replace them or replay the sentence',async()=>{
  const events=[],jobs=[];const p=new PhrasePipeline({stableMs:0,tailWords:0,emit:x=>events.push(x),translate:async job=>{jobs.push(job);return{consume:job.words.length,zh:job.words.join(' ')};}});
  p.transcript({id:'a',text:'The number is fifty'});await until(()=>events.some(x=>x.type==='translation'));
  p.transcript({id:'a',text:'The number is fifty percent',sourceEnded:true});
  p.transcript({id:'a',text:'The number is fifteen percent.',final:true});await until(()=>jobs.length===2);
  assert.equal(jobs[1].words.join(' '),'percent');assert.ok(!events.some(x=>x.sourceText?.includes('fifteen')));assert.equal(events.filter(x=>x.type==='translation').length,2);p.close();
});

test('Recognition rollback during a request discards stale Chinese; committed pages never rewrite',async()=>{
  const events=[];let resolve;const p=new PhrasePipeline({stableMs:0,tailWords:0,emit:x=>events.push(x),translate:()=>new Promise(done=>{resolve=done;})});
  p.transcript({id:'a',text:'The number is fifty percent'});await until(()=>resolve);
  p.transcript({id:'a',text:'The number is fifteen percent'});
  const stale=resolve;resolve=null;stale({consume:5,zh:'百分之五十'});await until(()=>resolve);
  resolve({consume:5,zh:'百分之十五'});await until(()=>events.some(x=>x.type==='translation'));
  assert.ok(!events.some(x=>x.text==='百分之五十'));
  p.transcript({id:'a',text:'The number is sixteen percent',sourceEnded:true});await delay(10);
  assert.equal(events.filter(x=>x.type==='translation').length,1);assert.ok(events.some(x=>x.type==='segment_warning'));p.close();
});

test('Closing for an application switch cancels a delayed local answer',async()=>{
  const events=[];let resolve,signal;const p=new PhrasePipeline({emit:x=>events.push(x),translate:job=>{signal=job.signal;return new Promise(done=>resolve=done);}});
  p.transcript({id:'old',text:'Only translate the old application',sourceEnded:true});await until(()=>resolve);p.close();
  assert.equal(signal.aborted,true);resolve({consume:5,zh:'旧应用'});await delay(10);assert.ok(!events.some(x=>x.type==='translation'));
});

test('A ten-second audio cut carries an unfinished clause into the next segment',async()=>{
  const events=[],jobs=[];
  const p=new PhrasePipeline({stableMs:0,tailWords:0,emit:x=>events.push(x),translate:async job=>{jobs.push(job);return job.words.at(-1)==='goal'?{consume:0,zh:''}:{consume:job.words.length,zh:'这个目标将激发我们的潜能。'};}});
  p.transcript({id:'a',text:'Because that goal',sourceEnded:true,endReason:'limit',sourceSequence:1,startedClientAt:100});await until(()=>jobs.length===1);assert.equal(jobs[0].final,false);
  p.transcript({id:'b',text:'will serve to organize our efforts',sourceSequence:2,startedClientAt:10100});await until(()=>events.some(x=>x.type==='translation'));
  assert.equal(jobs[1].words.join(' '),'Because that goal will serve to organize our efforts');
  assert.equal(events.filter(x=>x.type==='translation').length,1);p.close();
  assert.equal(events.find(x=>x.type==='transcript'&&x.id==='b').startedClientAt,10100);
});

test('Single local model keeps phrase order and carries only earlier committed context',async()=>{
  const events=[],jobs=[];let active=0,maxActive=0;
  const p=new PhrasePipeline({emit:x=>events.push(x),translate:async job=>{jobs.push(job);maxActive=Math.max(maxActive,++active);await delay(8);active--;return{consume:job.words.length,zh:job.words.join(' ')};}});
  for(let n=0;n<20;n++)p.transcript({id:String(n),text:`This is sentence number ${n}`,sourceEnded:true,sourceSequence:n});
  await until(()=>events.filter(x=>x.type==='translation').length===20);
  assert.equal(maxActive,1);assert.deepEqual(events.filter(x=>x.type==='translation').map(x=>x.sourceId),Array.from({length:20},(_,n)=>String(n)));
  assert.equal(jobs[0].previous.length,0);assert.equal(jobs[1].previous[0].en,'This is sentence number 0');p.close();
});

test('Blocked local inference under a thousand-segment flood stays bounded and reports skipped speech',async()=>{
  const events=[];let calls=0;
  const p=new PhrasePipeline({emit:x=>events.push(x),translate:job=>{calls++;return new Promise((_,reject)=>job.signal.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true}));}});
  p.transcript({id:'0',text:'This is the first pending sentence',sourceEnded:true,sourceSequence:0});await delay(0);
  for(let n=1;n<1000;n++)p.transcript({id:String(n),text:'This is another pending sentence',sourceEnded:true,sourceSequence:n});
  await until(()=>calls===1);
  assert.equal(calls,1);assert.ok(p.items.size<=160);assert.ok([...p.items.values()].filter(x=>!x.invalid&&x.consumed.length<x.words.length).length<=24);
  assert.ok(events.some(x=>x.type==='segment_warning'&&x.message.includes('积压')));p.close();await delay(0);
});
