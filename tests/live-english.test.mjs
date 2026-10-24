import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {LiveEnglish,formatEnglish} from '../server/live-english.mjs';
import {Segmenter} from '../server/vad.mjs';
import {createApp} from '../server/index.mjs';
const wait=ms=>new Promise(done=>setTimeout(done,ms));
test('Uppercase streaming speech uses sentence case, I, names and standard acronyms',()=>{
  assert.equal(formatEnglish("I'M WATCHING NASA VIDEOS ON YOUTUBE IN NEW YORK",{final:true}),"I'm watching NASA videos on YouTube in New York.");
  assert.equal(formatEnglish('I MAY GO. DO YOU USE THE API?'),'I may go. Do you use the API?');
  assert.equal(formatEnglish('Dr. McDonald works at OpenAI.',{final:true}),'Dr. McDonald works at OpenAI.');
  assert.equal(formatEnglish('HELLO WORLD',{final:false}),'Hello world');
});
async function until(predicate){const begin=Date.now();while(!predicate()){if(Date.now()-begin>2500)throw new Error('Live English timeout');await wait(10);}}

test('Live English rejects older segments, stale revisions and repeated unchanged hypotheses',()=>{
  const shown=[],display=new LiveEnglish({display:value=>shown.push(value)});
  display.offer({id:'a',sequence:1,revision:1,text:'One'});
  display.offer({id:'a',sequence:1,revision:2,text:'One'});
  display.offer({id:'a',sequence:1,revision:1,text:'Stale'});
  display.offer({id:'b',sequence:2,revision:1,text:'Next live sentence'});
  display.offer({id:'a',sequence:1,revision:99,text:'Late Whisper correction',final:true});
  assert.deepEqual(shown.map(x=>x.en),['One','Next live sentence']);
  display.offer({id:'b',sequence:2,revision:2,text:'Next live sentence.',final:true});
  display.offer({id:'b',sequence:2,revision:3,text:'Late non-final change'});
  assert.equal(shown.at(-1).en,'Next live sentence.');
  display.reset();display.offer({id:'fresh',sequence:0,text:'New audio source'});assert.equal(shown.at(-1).en,'New audio source');
});

test('English fills fixed bounded pages rather than building an entire speech paragraph',()=>{
  const shown=[],display=new LiveEnglish({maxChars:40,display:value=>shown.push(value)});
  const words=Array.from({length:100},(_,index)=>`word${index}`);
  for(let index=1;index<=words.length;index++)display.offer({id:'a',sequence:0,revision:index,text:words.slice(0,index).join(' ')});
  assert.ok(shown.every(x=>x.en.length<=40));
  assert.equal(shown[2].en,'word0 word1 word2');
  display.offer({id:'a',sequence:0,revision:101,text:'Short corrected sentence.',final:true});
  assert.equal(shown.at(-1).en,'Short corrected sentence.');
});

test('First streaming audio batch arrives at 300 ms then every 200 ms',()=>{
  const jobs=[],segmenter=new Segmenter({onSegment:job=>jobs.push(job)}),voice=Buffer.alloc(2400);
  for(let index=0;index<2400;index+=2)voice.writeInt16LE(5000,index);
  for(let index=0;index<5;index++)segmenter.push(voice,index*50);
  assert.equal(jobs.length,0);segmenter.push(voice,250);assert.equal(jobs.length,1);assert.equal(jobs[0].audio.length,6*2400);
  for(let index=6;index<10;index++)segmenter.push(voice,index*50);
  assert.equal(jobs.length,2);assert.equal(jobs[1].audio.length,10*2400);assert.ok(jobs.every(job=>!job.final));
});

test('Slow Chinese translation cannot delay English, roll it back or corrupt reconnect snapshots',async()=>{
  const packets=[];let finish;
  const app=createApp({port:0,checkModel:false,captureFactory:()=>({close(){}}),asrFactory:()=>({close(){},transcribe(){}}),phraseTranslate:job=>new Promise(done=>{finish=()=>done({consume:job.words.length,zh:'上一段的中文定稿。',firstMs:1});})});
  const port=await app.listen(),url=`ws://127.0.0.1:${port}/api/overlay?token=${app.token}`;
  const overlay=new WebSocket(url),live=new WebSocket(`ws://127.0.0.1:${port}/api/live?token=${app.token}`);let replay;
  overlay.on('message',raw=>packets.push(JSON.parse(raw)));
  try{
    await Promise.all([new Promise(done=>overlay.once('open',done)),new Promise(done=>live.once('open',done))]);
    live.send(JSON.stringify({type:'start',source:'system'}));await until(()=>app.sessions.size===1);
    const pipeline=[...app.sessions.values()][0].pipeline;
    pipeline.transcript({id:'first',sourceSequence:1,text:'Earlier finished source.',final:true});await until(()=>finish);
    pipeline.transcript({id:'next',sourceSequence:2,text:'Current English arrives now',final:false});
    await until(()=>packets.some(x=>x.type==='english' && x.en==='Current English arrives now'));
    assert.ok(!packets.some(x=>x.zh==='上一段的中文定稿。'));
    finish();await until(()=>packets.some(x=>x.zh==='上一段的中文定稿。'));
    assert.equal(packets.find(x=>x.zh==='上一段的中文定稿。').en,'Current English arrives now');
    overlay.send(JSON.stringify({type:'overlay-preference',fontSize:32}));
    await until(()=>packets.some(x=>x.type==='subtitle' && x.fontSize===32));
    assert.equal(packets.filter(x=>x.type==='subtitle').at(-1).en,'Current English arrives now');
    const snapshots=[];replay=new WebSocket(url);replay.on('message',raw=>snapshots.push(JSON.parse(raw)));
    await until(()=>snapshots.length);assert.equal(snapshots[0].en,'Current English arrives now');
  }finally{replay?.terminate();live.terminate();overlay.terminate();await app.close();}
});
