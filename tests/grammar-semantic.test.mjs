import test from 'node:test';
import assert from 'node:assert/strict';
import {createSemanticTranslator} from '../server/semantic-translator.mjs';
import {needsContinuation,needsParticleContinuation} from '../server/source-boundary.mjs';
const response=source=>new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify({source})}}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\n`);

test('Observed idioms, conditions and number units wait for their heard continuation',()=>{
  for(const [source,next] of [["Let's get the ball",'rolling'],['This is a game','changer'],["You do not have to start",'from scratch'],['We can begin','if everyone is ready'],['It is fifty','percent']])assert.equal(needsContinuation(source,next),true);
  assert.equal(needsContinuation('This update works well','another topic'),false);
});

test('Experimental particle guard preserves completed statements and waits for heard verb particles',()=>{
  for(const [source,next] of [['When you get','to the next screen'],['If you wake','up early'],['When he woke','up this morning']])assert.equal(needsParticleContinuation(source,next),true);
  for(const [source,next] of [['They held a wake','yesterday'],['I wake up early','another topic'],['This is what you get','another topic']])assert.equal(needsParticleContinuation(source,next),false);
});

test('Experimental particle guard vetoes an unfinished get-to phrase without translating future words',async()=>{
  let translated=0,checked=0;const source='Thank you when you get';
  const translate=createSemanticTranslator({continuationCheck:needsParticleContinuation,fetchImpl:async()=>response(source),
    grammarCheck:async()=>{checked++;return{allow:true};},translator:async()=>{translated++;return{text:'should not publish'};}});
  const result=await translate({words:source.split(' '),lookahead:'to this point',signal:AbortSignal.timeout(1000)});
  assert.equal(result.consume,0);assert.equal(checked,0);assert.equal(translated,0);
});

test('Bounded resegmentation expands only through stable heard words and excludes private lookahead',async()=>{
 const initial='When you get',complete='When you get to the station',requests=[],jobs=[];
 const translate=createSemanticTranslator({continuationCheck:needsParticleContinuation,repairContinuation:true,
  fetchImpl:async(_,options)=>{requests.push(JSON.parse(options.body));return response(requests.length===1?initial:complete);},
  grammarCheck:async()=>({allow:true}),translator:async job=>{jobs.push(job);return{text:'\u5f53\u4f60\u5230\u8f66\u7ad9\u65f6。',durationMs:1};}});
 const result=await translate({words:(complete+' another topic').split(' '),lookahead:'private tentative continuation',signal:AbortSignal.timeout(1000)});
 assert.equal(result.source,complete);assert.equal(result.consume,6);assert.equal(requests.length,2);assert.equal(jobs[0].text,complete);
 assert.ok(!JSON.stringify(requests).includes('private tentative'));assert.ok(!JSON.stringify(jobs).includes('another topic'));
 const data=JSON.parse(requests[1].messages[1].content.replace(/\n\/no_think$/,''));assert.equal(data.minimum_words,5);assert.equal(data.rejected_prefix,initial);
});

test('A boundary repair cannot invent a destination that is only tentative or exceed its retry bound',async()=>{
 let calls=0;
 const translate=createSemanticTranslator({continuationCheck:needsParticleContinuation,repairContinuation:true,fetchImpl:async()=>{calls++;return response('When you get');},grammarCheck:async()=>({allow:true}),translator:async()=>{throw new Error('Must wait');}});
 const result=await translate({words:'When you get'.split(' '),lookahead:'to the station',signal:AbortSignal.timeout(1000)});
 assert.equal(result.consume,0);assert.equal(calls,0);
 const longer=await translate({words:'When you get to the station'.split(' '),signal:AbortSignal.timeout(1000)});
 assert.equal(longer.consume,0);assert.equal(calls,2);
});

test('Complete thank-you objects can be repaired with their heard condition instead of being rejected as a subject tail',async()=>{
 let calls=0;const prefix='We thank you',source='We thank you when the work is finished';
 const translate=createSemanticTranslator({repairContinuation:true,fetchImpl:async()=>response(++calls===1?prefix:source),grammarCheck:async()=>({allow:true}),translator:async()=>({text:'\u5de5\u4f5c\u5b8c\u6210\u65f6\u6211\u4eec\u611f\u8c22\u4f60。',durationMs:1})});
 const result=await translate({words:source.split(' '),signal:AbortSignal.timeout(1000)});
 assert.equal(result.source,source);assert.equal(calls,2);
});
test('Short complete statements can pass after syntax validation without adding future words',async()=>{
  let calls=0;const source="Man that's insane";
  const translate=createSemanticTranslator({minBoundaryWords:4,minSelectedWords:2,grammarCheck:async()=>({allow:true}),fetchImpl:async()=>{
    if(++calls===1)return response(source);
    return new Response(`data: ${JSON.stringify({choices:[{delta:{content:'\u592a\u5938\u5f20\u4e86。'}}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\n`);
  }});
  const result=await translate({words:"Man that's insane that is incredible".split(' '),previous:[],signal:AbortSignal.timeout(1000)});
  assert.equal(result.source,source);assert.equal(result.consume,3);assert.equal(calls,2);
});
test('The syntax gate sees only the exact selected prefix and rejects it before Chinese inference',async()=>{
  const calls=[],syntax=[];
  const translate=createSemanticTranslator({fetchImpl:async(_,options)=>{calls.push(JSON.parse(options.body));return response('All of this work');},grammarCheck:async job=>{syntax.push(job.text);return{allow:false,reason:'noun-only'};}});
  const result=await translate({words:'All of this work requires the whole team'.split(' '),lookahead:'additional private tail',signal:AbortSignal.timeout(1000)});
  assert.equal(result.consume,0);assert.deepEqual(syntax,['All of this work']);assert.equal(calls.length,1);
  assert.ok(!JSON.stringify(calls).includes('additional private tail'));
});
test('A live without continuation vetoes a premature impossible claim without entering either model',async()=>{
  const source='All of this work is not possible',calls=[];let checked=0;
  const translate=createSemanticTranslator({fetchImpl:async(_,options)=>{calls.push(JSON.parse(options.body));return response(source);},grammarCheck:async()=>{checked++;return{allow:true};}});
  const result=await translate({words:source.split(' '),lookahead:'without a team',signal:AbortSignal.timeout(1000)});
  assert.equal(result.consume,0);assert.equal(checked,0);assert.equal(calls.length,1);
  assert.ok(!JSON.stringify(calls).includes('without a team'));
});

test('Captured with qualification cannot commit an unqualified negative or enter the model',async()=>{
  const source='And of course all of this work is not possible',calls=[];let checked=0;
  const translate=createSemanticTranslator({fetchImpl:async(_,options)=>{calls.push(JSON.parse(options.body));return response(source);},grammarCheck:async()=>{checked++;return{allow:true};}});
  const result=await translate({words:source.split(' '),lookahead:'with',signal:AbortSignal.timeout(1000)});
  assert.equal(result.consume,0);assert.equal(result.zh,'');assert.equal(checked,0);assert.equal(calls.length,1);
  assert.ok(!JSON.stringify(calls).includes('"with"'));
});

test('Candidate MT receives only the validated prefix, never tentative or unconsumed speech',async()=>{
  const selected='These results look very good',jobs=[];
  const translate=createSemanticTranslator({fetchImpl:async()=>response(selected),grammarCheck:async()=>({allow:true}),translator:async job=>{
    jobs.push(job);return{text:'\u8fd9\u4e9b\u7ed3\u679c\u770b\u8d77\u6765\u5f88\u597d。',firstMs:1,durationMs:2};
  }});
  const result=await translate({words:(selected+' another topic starts now').split(' '),lookahead:'private tentative tail',previous:[],signal:AbortSignal.timeout(1000)});
  assert.equal(result.source,selected);assert.equal(result.consume,5);
  assert.equal(jobs[0].text,selected);assert.equal(result.zh,'\u8fd9\u4e9b\u7ed3\u679c\u770b\u8d77\u6765\u5f88\u597d。');
  assert.ok(!JSON.stringify(jobs).includes('private tentative tail'));assert.ok(!JSON.stringify(jobs).includes('another topic'));
});
