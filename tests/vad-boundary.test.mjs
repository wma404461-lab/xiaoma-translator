import test from 'node:test';
import assert from 'node:assert/strict';
import {Segmenter} from '../server/vad.mjs';
const frame=amplitude=>{const pcm=Buffer.alloc(2400);for(let n=0;n<pcm.length;n+=2)pcm.writeInt16LE(amplitude,n);return pcm;};
test('The soft time limit keeps streaming drafts during uninterrupted voiced audio',()=>{
  const jobs=[],vad=new Segmenter({onSegment:job=>jobs.push(job)});
  for(let n=0;n<210;n++)vad.push(frame(5000),n*50);
  assert.ok(jobs.some(job=>!job.final&&job.audio.length>200*2400));assert.ok(!jobs.some(job=>job.final));
  for(let n=210;n<240;n++)vad.push(frame(5000),n*50);
  assert.equal(jobs.filter(job=>job.final).length,1);assert.equal(jobs.at(-1).audio.length,240*2400);assert.equal(jobs.at(-1).endReason,'limit');
});
test('A short post-limit energy valley can end a segment without a full silence',()=>{
  const jobs=[],vad=new Segmenter({onSegment:job=>jobs.push(job)});
  for(let n=0;n<205;n++)vad.push(frame(5000),n*50);
  vad.push(frame(400),205*50);assert.ok(!jobs.some(job=>job.final));
  vad.push(frame(400),206*50);assert.equal(jobs.at(-1).endReason,'limit');assert.equal(jobs.at(-1).audio.length,207*2400);
  for(let n=207;n<213;n++)vad.push(frame(5000),n*50);vad.finish();
  const finals=jobs.filter(job=>job.final);assert.equal(finals.at(-1).id,'seg-2');
  const original=Buffer.concat([...Array(205).fill(frame(5000)),frame(400),frame(400),...Array(6).fill(frame(5000))]);
  assert.deepEqual(Buffer.concat(finals.map(job=>job.audio)),original);
});
test('Early natural silence retains its original finalization and next-source sequence',()=>{
  const jobs=[],vad=new Segmenter({onSegment:job=>jobs.push(job)});
  for(let n=0;n<25;n++)vad.push(frame(5000),n*50);
  for(let n=25;n<38;n++)vad.push(frame(0),n*50);
  assert.equal(jobs.at(-1).endReason,'silence');assert.equal(jobs.at(-1).audio.length,38*2400);
  for(let n=38;n<44;n++)vad.push(frame(5000),n*50);
  assert.equal(jobs.at(-1).id,'seg-2');assert.equal(jobs.at(-1).sourceSequence,2);vad.finish();
});
