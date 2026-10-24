import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeExplicitRank} from '../server/rank-consistency.mjs';
import {createLocalTranslator} from '../server/local-translator.mjs';

test('One explicit grade repairs a mismatched rank while keeping the rest of the statement',()=>{
  for(const [en,zh,expected] of [
    ['OF WHAT COLONEL DEMINGS ARE SO','\u6234\u660e\u5c06\u519b\u5230\u5e95\u662f\u4ec0\u4e48？','\u6234\u660e\u4e0a\u6821\u5230\u5e95\u662f\u4ec0\u4e48？'],
    ['The lieutenant colonel arrives at 15:00.','\u8fd9\u4f4d\u5c06\u519b15:00\u5230\u8fbe。','\u8fd9\u4f4d\u4e2d\u682115:00\u5230\u8fbe。'],
    ['Brigadier General Lee answered the question.','\u674e\u4e0a\u6821\u56de\u7b54\u4e86\u95ee\u9898。','\u674e\u51c6\u5c06\u56de\u7b54\u4e86\u95ee\u9898。'],
    ['Major General Smith confirmed the decision.','\u53f2\u5bc6\u65af\u4e0a\u6821\u786e\u8ba4\u4e86\u51b3\u5b9a。','\u53f2\u5bc6\u65af\u5c11\u5c06\u786e\u8ba4\u4e86\u51b3\u5b9a。'],
    ['Lieutenant General Brown spoke to the audience.','\u5e03\u6717\u4e0a\u6821\u5411\u542c\u4f17\u8bb2\u8bdd。','\u5e03\u6717\u4e2d\u5c06\u5411\u542c\u4f17\u8bb2\u8bdd。'],
    ['Lt. Col. Jones has not arrived.','\u743c\u65af\u5c06\u519b\u8fd8\u6ca1\u5230。','\u743c\u65af\u4e2d\u6821\u8fd8\u6ca1\u5230。'],
  ])assert.equal(normalizeExplicitRank(en,zh),expected);
});

test('Ambiguous or multiple roles do not authorize changing names or existing titles',()=>{
  for(const [en,zh] of [
    ['Colonel Smith gave a general explanation.','\u53f2\u5bc6\u65af\u5c06\u519b\u7ed9\u51fa\u4e86\u6982\u8ff0。'],
    ['The colonel spoke to General Smith.','\u4e0a\u6821\u4e0e\u53f2\u5bc6\u65af\u5c06\u519b\u4ea4\u8c08。'],
    ['Colonel A greeted Colonel B.','A\u5c06\u519b\u5411B\u5c06\u519b\u95ee\u597d。'],
    ['Colonel Jones arrived.','\u743c\u65af\u4e0a\u6821\u5230\u4e86。'],
    ['Colonel Jones arrived.','\u743c\u65af\u5230\u4e86。'],
    ['Colonel Jones arrived.','\u743c\u65af\u4e0a\u6821\u53bb\u5c06\u519b\u8def。'],
    ['CORONER DEMINGS ARRIVES TODAY.','\u6234\u660e\u5c06\u519b\u4eca\u5929\u5230\u8fbe。'],
  ])assert.equal(normalizeExplicitRank(en,zh),zh);
});

test('Embedded ordinary-language characters cannot be treated as military nouns',()=>{
  for(const [en,zh] of [
    ['Colonel Jones will save the file this evening.','\u743c\u65af\u665a\u4e0a\u5c06\u6587\u4ef6\u4fdd\u5b58。'],
    ['Lt. Col. Jones validates the data online.','\u743c\u65af\u5728\u7f51\u4e0a\u6821\u9a8c\u6570\u636e。'],
    ['Lt. Col. Jones returned home in the evening.','\u743c\u65af\u665a\u4e0a\u5c06\u8fd4\u56de\u5bb6\u4e2d。'],
    ['Major General Jones has a file that will be included.','\u5176\u4e2d\u5c06\u5305\u542b\u4e00\u4efd\u6587\u4ef6。'],
    ['Colonel Jones described the situation.','\u8fd9\u91cc\u9762\u5c06\u519b\u8bad\u7684\u4e8b\u60c5\u8bb2\u6e05\u695a\u4e86。'],
  ])assert.equal(normalizeExplicitRank(en,zh),zh);
});

test('Chess, place names and military idioms remain intact',()=>{
  for(const [en,zh] of [
    ['Colonel Jones said checkmate.','\u743c\u65af\u8bf4，\u5c06\u519b！'],
    ['Colonel Jones put the opponent in check.','\u743c\u65af\u628a\u5bf9\u624b\u5c06\u519b\u4e86。'],
    ['Colonel Jones lives on Jiangjun Road.','\u743c\u65af\u4f4f\u5728\u5c06\u519b\u8def。'],
    ['Colonel Jones has a pot belly.','\u743c\u65af\u957f\u51fa\u4e86\u5c06\u519b\u809a。'],
    ['Colonel Jones played a piece called Jiangjun Ling.','\u743c\u65af\u6f14\u594f\u4e86\u5c06\u519b\u4ee4。'],
  ])assert.equal(normalizeExplicitRank(en,zh),zh);
});

test('Rank consistency uses current speech and performs no extra inference',async()=>{
  let calls=0;const drafts=[];
  const translator=createLocalTranslator({fetchImpl:async()=>{
    calls++;return new Response('data: {"choices":[{"delta":{"content":"\u6234\u660e\u5c06\u519b\u5230\u5e95\u662f\u4ec0\u4e48？"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  }});
  const result=await translator({text:'OF WHAT COLONEL DEMINGS ARE SO',context:[],topic:'',glossary:[],signal:AbortSignal.timeout(1000),onDelta:value=>drafts.push(value)});
  assert.equal(result.text,'\u6234\u660e\u4e0a\u6821\u5230\u5e95\u662f\u4ec0\u4e48？');assert.equal(calls,1);
  // Raw token drafts remain internal; system Chinese publishes this completed
  // result once. Existing gateway tests enforce that display invariant.
  assert.deepEqual(drafts,['\u6234\u660e\u5c06\u519b\u5230\u5e95\u662f\u4ec0\u4e48？']);
  assert.equal(normalizeExplicitRank('He returned this morning.',result.text),result.text);
});
