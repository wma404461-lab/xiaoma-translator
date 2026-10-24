import test from 'node:test';
import assert from 'node:assert/strict';
import {createSemanticTranslator} from '../server/semantic-translator.mjs';
import {createLocalTranslator} from '../server/local-translator.mjs';
const sse=content=>new Response(`data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\n`);
test('Boundary and Chinese requests report only actual SSE content/completion and clean up each observation',async()=>{
  const watches=[],bodies=[],endpoint='http://127.0.0.1:4318/v1/chat/completions';
  const translator=createSemanticTranslator({endpoint,observeInference:job=>{
    const watch={endpoint:job.endpoint,signal:job.signal,progressCount:0,finished:0,progress(){this.progressCount++;},finish(){this.finished++;}};watches.push(watch);return watch;
  },fetchImpl:async(_,options)=>{const body=JSON.parse(options.body);bodies.push(body);return body.id_slot===0?sse(JSON.stringify({source:'We will reconnect automatically if the connection fails'})):sse('\u8fde\u63a5\u4e2d\u65ad\u65f6，\u6211\u4eec\u4f1a\u81ea\u52a8\u91cd\u8fde。');}});
  const controller=new AbortController();
  const result=await translator({words:'We will reconnect automatically if the connection fails'.split(' '),signal:controller.signal});
  assert.equal(result.zh,'\u8fde\u63a5\u4e2d\u65ad\u65f6，\u6211\u4eec\u4f1a\u81ea\u52a8\u91cd\u8fde。');assert.deepEqual(bodies.map(b=>b.id_slot),[0,1]);assert.equal(watches.length,2);
  for(const watch of watches){assert.equal(watch.endpoint,endpoint);assert.equal(watch.signal,controller.signal);assert.equal(watch.progressCount,2);assert.equal(watch.finished,1);}
});
test('Aborted or rejected model requests always release their observer without recording headers as inference',async()=>{
  let progress=0,finishes=0;
  const translator=createLocalTranslator({observeInference:()=>{let ended=false;return{progress(){progress++;},finish(){if(!ended){ended=true;finishes++;}}};},fetchImpl:async()=>new Response('',{status:400})});
  await assert.rejects(translator({text:'The price is five dollars',signal:new AbortController().signal,onDelta(){}}),/400/);
  assert.equal(progress,0);assert.equal(finishes,1);
});

test('HTTP success and SSE keepalives alone are not inference progress',async()=>{
  let progress=0,finishes=0;
  const translator=createLocalTranslator({observeInference:()=>{let ended=false;return{progress(){progress++;},finish(){if(!ended){ended=true;finishes++;}}};},fetchImpl:async()=>new Response(': keepalive\n\ndata: {"choices":[]}\n\n')});
  await assert.rejects(translator({text:'The price is five dollars',signal:new AbortController().signal,onDelta(){}}),/not fully completed/);
  assert.equal(progress,0);assert.equal(finishes,1);
});
