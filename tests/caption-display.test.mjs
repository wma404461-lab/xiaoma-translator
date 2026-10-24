import test from 'node:test';
import assert from 'node:assert/strict';
import {CaptionDisplay,captionPages} from '../server/caption-display.mjs';
import {CaptionPipeline} from '../server/pipeline.mjs';
import {createApp} from '../server/index.mjs';
import WebSocket from 'ws';

function clock(){let at=0,next=0;const timers=new Map();return{now:()=>at,schedule:(fn,delay)=>{const id=++next;timers.set(id,{fn,at:at+delay});return id;},cancel:id=>timers.delete(id),advance:delta=>{at+=delta;for(const [id,value] of [...timers])if(value.at<=at){timers.delete(id);value.fn();}}};}
const phrase=(id,sequence,zh,revision=1)=>({id,sequence,zh,en:'Original English',state:'\u5df2\u5b9a\u7a3f',revision,final:true});

test('Short fast-mode captions keep up with two-second clauses without rewriting the current page',()=>{
  const time=clock(),shown=[];const display=new CaptionDisplay({...time,minHoldMs:1800,maxHoldMs:3600,display:value=>shown.push(value)});
  for(let index=0;index<10;index++){
    display.offer({...phrase(String(index),index,'\u73b0\u5728\u5f00\u59cb。'),en:''});
    assert.equal(shown.length,index+1);assert.equal(display.queue.length,0);time.advance(2000);
  }
  display.close();
});

test('Changing meanings in repeated drafts never rewrite the visible final caption',()=>{
  const time=clock(),shown=[];const display=new CaptionDisplay({...time,display:value=>shown.push(value)});
  display.offer(phrase('one',0,'\u4e0a\u4e00\u53e5\u4fdd\u6301\u53ef\u8bfb。'));
  for(let revision=1;revision<=30;revision++){time.advance(20);display.offer({...phrase('two',1,'\u4e0b\u4e00\u53e5\u610f\u601d\u4e0d\u65ad\u53d8\u5316 '+revision,revision),final:false});}
  assert.deepEqual(shown.map(x=>x.zh),['\u4e0a\u4e00\u53e5\u4fdd\u6301\u53ef\u8bfb。']);
  time.advance(5000);assert.equal(shown.length,1);
  display.offer(phrase('two',1,'\u8bf4\u5b8c\u540e，\u663e\u793a\u6700\u7ec8\u610f\u601d。',31));assert.equal(shown.at(-1).zh,'\u8bf4\u5b8c\u540e，\u663e\u793a\u6700\u7ec8\u610f\u601d。');
  display.offer(phrase('two',1,'\u540c\u6bb5\u540e\u7eed\u6539\u5199\u4e0d\u5e72\u6270\u9605\u8bfb。',32));time.advance(5000);assert.equal(shown.length,2);
  display.close();
});

test('Long finalized captions page automatically with bounded text and at least three seconds to read',()=>{
  const time=clock(),shown=[];const display=new CaptionDisplay({...time,display:value=>shown.push({at:time.now(),...value})});
  const original=phrase('long',0,'\u8fd9\u662f\u4e00\u6bb5\u6ca1\u6709\u63d0\u524d\u65ad\u53e5\u7684\u8f83\u957f\u8bb2\u8bdd，\u9700\u8981\u5206\u6210\u51e0\u4e2a\u77ed\u5b57\u5e55\u9875，\u8bfb\u5b8c\u4e00\u9875\u4ee5\u540e\u624d\u663e\u793a\u4e0b\u4e00\u9875，\u4e0d\u80fd\u5728\u4e00\u4e2a\u7a97\u53e3\u91cc\u5806\u6210\u4e00\u6574\u6bb5\u6587\u7ae0。');original.en='This is a long statement that needs several short caption pages. Read one page before the next page appears, rather than filling the screen with a paragraph.';
  const pages=captionPages(original);assert.ok(pages.length>1);
  assert.ok(pages.every(page=>Array.from(page.zh).length<=28 && Array.from(page.en).length<=84));
  display.offer(original);assert.equal(shown.length,1);time.advance(2999);assert.equal(shown.length,1);
  for(let page=1;page<pages.length;page++)time.advance(5000);
  assert.equal(shown.length,pages.length);assert.ok(shown.slice(1).every((page,index)=>page.at-shown[index].at>=3000));
  // Consecutive identical short-language pages are held while its paired language finishes.
  const uniqueRuns=shown.filter((page,index)=>!index||page.zh!==shown[index-1].zh).map(page=>page.zh).join('');
  assert.equal(uniqueRuns,original.zh);display.close();
});

test('Recovery backlogs stay bounded and no queued page survives a new session',()=>{
  const time=clock(),shown=[];const display=new CaptionDisplay({...time,display:value=>shown.push(value)});
  for(let sequence=0;sequence<100;sequence++)display.offer(phrase(String(sequence),sequence,'\u5b57\u5e55'+sequence));
  assert.ok(display.queue.length<=6);assert.equal(shown.length,1);
  display.reset();time.advance(10000);assert.equal(shown.length,1);display.offer(phrase('new',0,'\u65b0\u4f1a\u8bdd。'));assert.equal(shown.at(-1).zh,'\u65b0\u4f1a\u8bdd。');display.close();
});

test('Confirmed short phrases merge only while unread, never into the visible page',()=>{
  const time=clock(),shown=[];const display=new CaptionDisplay({...time,coalesce:true,pageOptions:{zhLimit:44},display:x=>shown.push(x)});
  const offer=(id,sequence,zh)=>display.offer({...phrase(id,sequence,zh),sourceId:'speech',en:''});
  offer('one',0,'\u5c4f\u5e55\u4e0a\u8fd9\u53e5\u4e0d\u52a8。');offer('two',1,'\u4e0b\u4e00\u53e5\u7684\u524d\u534a\u6bb5，');offer('three',2,'\u63a5\u4e0a\u540e\u534a\u6bb5。');
  assert.equal(shown.length,1);assert.equal(shown[0].zh,'\u5c4f\u5e55\u4e0a\u8fd9\u53e5\u4e0d\u52a8。');assert.equal(display.queue.length,1);
  time.advance(3000);assert.equal(shown[1].zh,'\u4e0b\u4e00\u53e5\u7684\u524d\u534a\u6bb5，\u63a5\u4e0a\u540e\u534a\u6bb5。');display.close();
});

test('Late final corrections cannot replace a newer phrase and reset cancels stale updates',()=>{
  const time=clock(),shown=[];const display=new CaptionDisplay({...time,display:value=>shown.push(value)});
  display.offer(phrase('one',0,'\u7b2c\u4e00\u53e5。'));display.offer(phrase('two',1,'\u7b2c\u4e8c\u53e5。'));
  display.offer({...phrase('one',0,'\u8fdf\u5230\u7684\u7b2c\u4e00\u53e5\u5b9a\u7a3f。',9),state:'\u5df2\u5b9a\u7a3f'});time.advance(3000);
  assert.equal(shown.at(-1).zh,'\u7b2c\u4e8c\u53e5。');
  display.offer(phrase('three',2,'\u4e0d\u5e94\u51fa\u73b0\u7684\u65e7\u4f1a\u8bdd。'));display.reset();time.advance(3000);
  assert.equal(shown.length,2);display.offer(phrase('fresh',0,'\u65b0\u4f1a\u8bdd\u7b2c\u4e00\u53e5。'));assert.equal(shown.at(-1).zh,'\u65b0\u4f1a\u8bdd\u7b2c\u4e00\u53e5。');display.close();
});

test('Model token streams are distinct from completed drafts and retain the paired English source',async()=>{
  const events=[];const pipeline=new CaptionPipeline({emit:value=>events.push(value),translate:async job=>{job.onDelta('\u5e76',1);job.onDelta('\u5e76\u4e0d\u662f',2);return{text:'\u5e76\u4e0d\u662f\u56e0\u4e3a\u5bb9\u6613，\u800c\u662f\u56e0\u4e3a\u8270\u96be。',firstMs:1};}});
  pipeline.transcript({id:'negation',text:'Not because they are easy, but because they are hard.',final:true});
  await new Promise(done=>setTimeout(done,30));
  const partials=events.filter(x=>x.type==='translation' && !x.complete),complete=events.filter(x=>x.complete);
  assert.deepEqual(partials.map(x=>x.text),['\u5e76','\u5e76\u4e0d\u662f']);assert.equal(complete.length,1);assert.equal(complete[0].sourceText,'Not because they are easy, but because they are hard.');assert.equal(complete[0].final,true);pipeline.close();
});

test('Native-only preferences survive later speech while token fragments never reach the overlay',async()=>{
  const app=createApp({port:0,checkModel:false,asrFactory:emit=>{queueMicrotask(()=>emit({type:'ready'}));return{close(){},transcribe(){}};},translate:async job=>{job.onDelta('\u4e00',1);job.onDelta('\u4e00\u6574',2);return{text:'\u4e00\u6574\u53e5\u53ef\u8bfb\u7684\u5b57\u5e55。',firstMs:1};}});
  const port=await app.listen(),packets=[];
  const overlay=new WebSocket(`ws://127.0.0.1:${port}/api/overlay?token=${app.token}`);
  overlay.on('message',raw=>packets.push(JSON.parse(raw)));
  await new Promise(done=>overlay.once('open',done));
  overlay.send(JSON.stringify({type:'overlay-preference',fontSize:48,bilingual:false,transparent:true}));
  const live=new WebSocket(`ws://127.0.0.1:${port}/api/live?token=${app.token}`);
  await new Promise(done=>live.once('open',done));live.send(JSON.stringify({type:'start',source:'browser'}));
  const until=async predicate=>{const began=Date.now();while(!predicate()){if(Date.now()-began>3000)throw new Error('Native caption timeout');await new Promise(done=>setTimeout(done,10));}};
  try{
    await until(()=>app.sessions.size>0);[...app.sessions.values()][0].pipeline.transcript({id:'complete',text:'One whole readable subtitle.',final:true});
    await until(()=>packets.some(x=>x.zh==='\u4e00\u6574\u53e5\u53ef\u8bfb\u7684\u5b57\u5e55。'));
    const caption=packets.find(x=>x.zh==='\u4e00\u6574\u53e5\u53ef\u8bfb\u7684\u5b57\u5e55。');
    assert.equal(caption.fontSize,48);assert.equal(caption.bilingual,false);assert.equal(caption.transparent,true);
    assert.equal(packets.some(x=>['\u4e00','\u4e00\u6574'].includes(x.zh)),false);
  }finally{live.terminate();overlay.terminate();await app.close();}
});

test('Rapid unstable system drafts update English without changing Chinese',async()=>{
  const packets=[],events=[];
  let translationCalls=0;
  const app=createApp({port:0,checkModel:false,captureFactory:()=>({close(){}}),asrFactory:emit=>{queueMicrotask(()=>emit({type:'ready'}));return{close(){},transcribe(){}};},phraseTranslate:async job=>{translationCalls++;return{consume:job.words.length,zh:'\u4e0d\u662f\u56e0\u4e3a\u5bb9\u6613，\u800c\u662f\u56e0\u4e3a\u8270\u96be。',firstMs:1};}});
  const port=await app.listen(),overlay=new WebSocket(`ws://127.0.0.1:${port}/api/overlay?token=${app.token}`),live=new WebSocket(`ws://127.0.0.1:${port}/api/live?token=${app.token}`);
  overlay.on('message',raw=>packets.push(JSON.parse(raw)));live.on('message',raw=>events.push(JSON.parse(raw)));
  const until=async predicate=>{const began=Date.now();while(!predicate()){if(Date.now()-began>3000)throw new Error('Caption gate timeout');await new Promise(done=>setTimeout(done,10));}};
  try{
    await Promise.all([new Promise(done=>overlay.once('open',done)),new Promise(done=>live.once('open',done))]);
    overlay.send(JSON.stringify({type:'native-ready'}));live.send(JSON.stringify({type:'start',source:'system'}));await until(()=>app.sessions.size>0);
    const pipeline=[...app.sessions.values()][0].pipeline;pipeline.draftDelay=0;
    for(let revision=1;revision<=8;revision++){
      pipeline.transcript({id:'changing',text:`Not because they are easy ${revision}`,final:false});
      await until(()=>packets.filter(event=>event.type==='english').length===revision);
    }
    assert.equal(packets.some(packet=>packet.zh?.startsWith('\u5c1a\u672a\u8bf4\u5b8c')),false);
    assert.equal(translationCalls,0);
    assert.equal(packets.filter(packet=>packet.type==='english').at(-1).en,'Not because they are easy 8');
    overlay.send(JSON.stringify({type:'publish',subtitle:{zh:'\u65e7\u5de5\u4f5c\u53f0\u4e2d\u7684\u53e6\u4e00\u79cd\u610f\u601d',en:'stale',state:'\u6682\u8bd1',fontSize:28,bilingual:true}}));
    pipeline.transcript({id:'changing',text:'Not because they are easy, but because they are hard.',final:true});
    await until(()=>packets.some(packet=>packet.zh==='\u4e0d\u662f\u56e0\u4e3a\u5bb9\u6613，\u800c\u662f\u56e0\u4e3a\u8270\u96be。'));
    assert.equal(packets.some(packet=>packet.zh==='\u65e7\u5de5\u4f5c\u53f0\u4e2d\u7684\u53e6\u4e00\u79cd\u610f\u601d'),false);
    assert.equal(translationCalls,1);
    assert.deepEqual([...new Set(packets.filter(packet=>packet.zh?.includes('\u56e0\u4e3a')).map(packet=>packet.zh))],['\u4e0d\u662f\u56e0\u4e3a\u5bb9\u6613，\u800c\u662f\u56e0\u4e3a\u8270\u96be。']);
  }finally{live.terminate();overlay.terminate();await app.close();}
});
