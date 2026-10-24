import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeExplicitRank} from '../server/rank-consistency.mjs';
import {createLocalTranslator} from '../server/local-translator.mjs';

test('One explicit grade repairs a mismatched rank while keeping the rest of the statement',()=>{
  for(const [en,zh,expected] of [
    ['OF WHAT COLONEL DEMINGS ARE SO','戴明将军到底是什么？','戴明上校到底是什么？'],
    ['The lieutenant colonel arrives at 15:00.','这位将军15:00到达。','这位中校15:00到达。'],
    ['Brigadier General Lee answered the question.','李上校回答了问题。','李准将回答了问题。'],
    ['Major General Smith confirmed the decision.','史密斯上校确认了决定。','史密斯少将确认了决定。'],
    ['Lieutenant General Brown spoke to the audience.','布朗上校向听众讲话。','布朗中将向听众讲话。'],
    ['Lt. Col. Jones has not arrived.','琼斯将军还没到。','琼斯中校还没到。'],
  ])assert.equal(normalizeExplicitRank(en,zh),expected);
});

test('Ambiguous or multiple roles do not authorize changing names or existing titles',()=>{
  for(const [en,zh] of [
    ['Colonel Smith gave a general explanation.','史密斯将军给出了概述。'],
    ['The colonel spoke to General Smith.','上校与史密斯将军交谈。'],
    ['Colonel A greeted Colonel B.','A将军向B将军问好。'],
    ['Colonel Jones arrived.','琼斯上校到了。'],
    ['Colonel Jones arrived.','琼斯到了。'],
    ['Colonel Jones arrived.','琼斯上校去将军路。'],
    ['CORONER DEMINGS ARRIVES TODAY.','戴明将军今天到达。'],
  ])assert.equal(normalizeExplicitRank(en,zh),zh);
});

test('Embedded ordinary-language characters cannot be treated as military nouns',()=>{
  for(const [en,zh] of [
    ['Colonel Jones will save the file this evening.','琼斯晚上将文件保存。'],
    ['Lt. Col. Jones validates the data online.','琼斯在网上校验数据。'],
    ['Lt. Col. Jones returned home in the evening.','琼斯晚上将返回家中。'],
    ['Major General Jones has a file that will be included.','其中将包含一份文件。'],
    ['Colonel Jones described the situation.','这里面将军训的事情讲清楚了。'],
  ])assert.equal(normalizeExplicitRank(en,zh),zh);
});

test('Chess, place names and military idioms remain intact',()=>{
  for(const [en,zh] of [
    ['Colonel Jones said checkmate.','琼斯说，将军！'],
    ['Colonel Jones put the opponent in check.','琼斯把对手将军了。'],
    ['Colonel Jones lives on Jiangjun Road.','琼斯住在将军路。'],
    ['Colonel Jones has a pot belly.','琼斯长出了将军肚。'],
    ['Colonel Jones played a piece called Jiangjun Ling.','琼斯演奏了将军令。'],
  ])assert.equal(normalizeExplicitRank(en,zh),zh);
});

test('Rank consistency uses current speech and performs no extra inference',async()=>{
  let calls=0;const drafts=[];
  const translator=createLocalTranslator({fetchImpl:async()=>{
    calls++;return new Response('data: {"choices":[{"delta":{"content":"戴明将军到底是什么？"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  }});
  const result=await translator({text:'OF WHAT COLONEL DEMINGS ARE SO',context:[],topic:'',glossary:[],signal:AbortSignal.timeout(1000),onDelta:value=>drafts.push(value)});
  assert.equal(result.text,'戴明上校到底是什么？');assert.equal(calls,1);
  // Raw token drafts remain internal; system Chinese publishes this completed
  // result once. Existing gateway tests enforce that display invariant.
  assert.deepEqual(drafts,['戴明将军到底是什么？']);
  assert.equal(normalizeExplicitRank('He returned this morning.',result.text),result.text);
});
