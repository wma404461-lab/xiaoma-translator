import test from 'node:test';
import assert from 'node:assert/strict';
import {CaptionDisplay,captionPages} from '../server/caption-display.mjs';
import {CaptionPipeline} from '../server/pipeline.mjs';
import {createApp} from '../server/index.mjs';
import WebSocket from 'ws';

function clock(){let at=0,next=0;const timers=new Map();return{now:()=>at,schedule:(fn,delay)=>{const id=++next;timers.set(id,{fn,at:at+delay});return id;},cancel:id=>timers.delete(id),advance:delta=>{at+=delta;for(const [id,value] of [...timers])if(value.at<=at){timers.delete(id);value.fn();}}};}
const phrase=(id,sequence,zh,revision=1)=>({id,sequence,zh,en:'Original English',state:'已定稿',revision,final:true});

test('Short fast-mode captions keep up with two-second clauses without rewriting the current page',()=>{
  const time=clock(),shown=[];const display=new CaptionDisplay({...time,minHoldMs:1800,maxHoldMs:3600,display:value=>shown.push(value)});
  for(let index=0;index<10;index++){
    display.offer({...phrase(String(index),index,'现在开始。'),en:''});
    assert.equal(shown.length,index+1);assert.equal(display.queue.length,0);time.advance(2000);
  }
  display.close();
});

test('Changing meanings in repeated drafts never rewrite the visible final caption',()=>{
  const time=clock(),shown=[];const display=new CaptionDisplay({...time,display:value=>shown.push(value)});
  display.offer(phrase('one',0,'上一句保持可读。'));
  for(let revision=1;revision<=30;revision++){time.advance(20);display.offer({...phrase('two',1,'下一句意思不断变化 '+revision,revision),final:false});}
  assert.deepEqual(shown.map(x=>x.zh),['上一句保持可读。']);
  time.advance(5000);assert.equal(shown.length,1);
  display.offer(phrase('two',1,'说完后，显示最终意思。',31));assert.equal(shown.at(-1).zh,'说完后，显示最终意思。');
  display.offer(phrase('two',1,'同段后续改写不干扰阅读。',32));time.advance(5000);assert.equal(shown.length,2);
  display.close();
});

test('Long finalized captions page automatically with bounded text and at least three seconds to read',()=>{
  const time=clock(),shown=[];const display=new CaptionDisplay({...time,display:value=>shown.push({at:time.now(),...value})});
  const original=phrase('long',0,'这是一段没有提前断句的较长讲话，需要分成几个短字幕页，读完一页以后才显示下一页，不能在一个窗口里堆成一整段文章。');original.en='This is a long statement that needs several short caption pages. Read one page before the next page appears, rather than filling the screen with a paragraph.';
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
  for(let sequence=0;sequence<100;sequence++)display.offer(phrase(String(sequence),sequence,'字幕'+sequence));
  assert.ok(display.queue.length<=6);assert.equal(shown.length,1);
  display.reset();time.advance(10000);assert.equal(shown.length,1);display.offer(phrase('new',0,'新会话。'));assert.equal(shown.at(-1).zh,'新会话。');display.close();
});

test('Confirmed short phrases merge only while unread, never into the visible page',()=>{
  const time=clock(),shown=[];const display=new CaptionDisplay({...time,coalesce:true,pageOptions:{zhLimit:44},display:x=>shown.push(x)});
  const offer=(id,sequence,zh)=>display.offer({...phrase(id,sequence,zh),sourceId:'speech',en:''});
  offer('one',0,'屏幕上这句不动。');offer('two',1,'下一句的前半段，');offer('three',2,'接上后半段。');
  assert.equal(shown.length,1);assert.equal(shown[0].zh,'屏幕上这句不动。');assert.equal(display.queue.length,1);
  time.advance(3000);assert.equal(shown[1].zh,'下一句的前半段，接上后半段。');display.close();
});

test('Late final corrections cannot replace a newer phrase and reset cancels stale updates',()=>{
  const time=clock(),shown=[];const display=new CaptionDisplay({...time,display:value=>shown.push(value)});
  display.offer(phrase('one',0,'第一句。'));display.offer(phrase('two',1,'第二句。'));
  display.offer({...phrase('one',0,'迟到的第一句定稿。',9),state:'已定稿'});time.advance(3000);
  assert.equal(shown.at(-1).zh,'第二句。');
  display.offer(phrase('three',2,'不应出现的旧会话。'));display.reset();time.advance(3000);
  assert.equal(shown.length,2);display.offer(phrase('fresh',0,'新会话第一句。'));assert.equal(shown.at(-1).zh,'新会话第一句。');display.close();
});

test('Model token streams are distinct from completed drafts and retain the paired English source',async()=>{
  const events=[];const pipeline=new CaptionPipeline({emit:value=>events.push(value),translate:async job=>{job.onDelta('并',1);job.onDelta('并不是',2);return{text:'并不是因为容易，而是因为艰难。',firstMs:1};}});
  pipeline.transcript({id:'negation',text:'Not because they are easy, but because they are hard.',final:true});
  await new Promise(done=>setTimeout(done,30));
  const partials=events.filter(x=>x.type==='translation' && !x.complete),complete=events.filter(x=>x.complete);
  assert.deepEqual(partials.map(x=>x.text),['并','并不是']);assert.equal(complete.length,1);assert.equal(complete[0].sourceText,'Not because they are easy, but because they are hard.');assert.equal(complete[0].final,true);pipeline.close();
});

test('Native-only preferences survive later speech while token fragments never reach the overlay',async()=>{
  const app=createApp({port:0,checkModel:false,asrFactory:emit=>{queueMicrotask(()=>emit({type:'ready'}));return{close(){},transcribe(){}};},translate:async job=>{job.onDelta('一',1);job.onDelta('一整',2);return{text:'一整句可读的字幕。',firstMs:1};}});
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
    await until(()=>packets.some(x=>x.zh==='一整句可读的字幕。'));
    const caption=packets.find(x=>x.zh==='一整句可读的字幕。');
    assert.equal(caption.fontSize,48);assert.equal(caption.bilingual,false);assert.equal(caption.transparent,true);
    assert.equal(packets.some(x=>['一','一整'].includes(x.zh)),false);
  }finally{live.terminate();overlay.terminate();await app.close();}
});

test('Rapid unstable system drafts update English without changing Chinese',async()=>{
  const packets=[],events=[];
  let translationCalls=0;
  const app=createApp({port:0,checkModel:false,captureFactory:()=>({close(){}}),asrFactory:emit=>{queueMicrotask(()=>emit({type:'ready'}));return{close(){},transcribe(){}};},phraseTranslate:async job=>{translationCalls++;return{consume:job.words.length,zh:'不是因为容易，而是因为艰难。',firstMs:1};}});
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
    assert.equal(packets.some(packet=>packet.zh?.startsWith('尚未说完')),false);
    assert.equal(translationCalls,0);
    assert.equal(packets.filter(packet=>packet.type==='english').at(-1).en,'Not because they are easy 8');
    overlay.send(JSON.stringify({type:'publish',subtitle:{zh:'旧工作台中的另一种意思',en:'stale',state:'暂译',fontSize:28,bilingual:true}}));
    pipeline.transcript({id:'changing',text:'Not because they are easy, but because they are hard.',final:true});
    await until(()=>packets.some(packet=>packet.zh==='不是因为容易，而是因为艰难。'));
    assert.equal(packets.some(packet=>packet.zh==='旧工作台中的另一种意思'),false);
    assert.equal(translationCalls,1);
    assert.deepEqual([...new Set(packets.filter(packet=>packet.zh?.includes('因为')).map(packet=>packet.zh))],['不是因为容易，而是因为艰难。']);
  }finally{live.terminate();overlay.terminate();await app.close();}
});
