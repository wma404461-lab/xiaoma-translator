// English stays live. Chinese is published once per validated source prefix.
import {needsContinuation} from './source-boundary.mjs';
const tokens = text => String(text || '').trim().split(/\s+/).filter(Boolean);
const key = word => word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const prefixMatches = (prefix, words) => prefix.length <= words.length && prefix.every((word, index) => key(word) === key(words[index]));

export class PhrasePipeline {
  constructor({translate, emit, stableMs = 450, tailWords = 1, maxPending = 24, finalReviewMs = 1000, finalLoadingReviewMs = 60000, queuedReviewMs = 15000, processingReviewMs = 5000, retryMs = 700, maxRetries = 2, now = Date.now, continuationCheck = needsContinuation}) {
    Object.assign(this, {translate, emit, stableMs, tailWords, maxPending, finalReviewMs, finalLoadingReviewMs, queuedReviewMs, processingReviewMs, retryMs, maxRetries, now, continuationCheck});
    this.items = new Map(); this.context = []; this.sequence = 0; this.commitSequence = 0;
    this.closed = false; this.active = null; this.timer = null; this.glossary = []; this.topic = '';
  }
  configure({topic = '', glossary = []} = {}) {
    this.topic = String(topic).slice(0, 500);
    this.glossary = Array.isArray(glossary) ? glossary.slice(0, 40) : [];
  }
  transcript({id, text, final = false, sourceEnded = false, streamText, endReason, reviewLoading = false, reviewQueued = false, sourceSequence, startedClientAt = null}) {
    if (this.closed || !id || !String(text || '').trim()) return;
    let item = this.items.get(id);
    if (item?.final) return;
    if (!item) {
      const sequence = Number.isSafeInteger(sourceSequence) ? sourceSequence : this.sequence;
      this.sequence = Math.max(this.sequence, sequence + 1);
      item = {id, sequence, startedClientAt, sourceStartedClientAt: startedClientAt, revision: 0, words: [], consumed: [], carry: [], samples: [], ended: false, final: false, invalid: false, moved: false, attemptKey: '', commits: 0};
      const previous = [...this.items.values()].find(other => other.sequence === sequence - 1);
      if (previous?.ended && previous.endReason === 'limit' && !previous.invalid) {
        item.carry = previous.words.slice(previous.consumed.length);
        if (item.carry.length) item.startedClientAt = previous.startedClientAt;
        previous.moved = true;
        if (this.active?.item === previous) this.active.controller.abort();
        previous.consumed = [...previous.words];
      }
      this.items.set(id, item);
    }
    item.final = final; item.revision++;
    this.emit({type: 'transcript', id, text, final, sequence: item.sequence, revision: item.revision, startedClientAt: item.sourceStartedClientAt});
    if(item.ended && final && !item.moved && item.endReason!=='limit'){
      const corrected=[...item.carry,...tokens(text)];
      // Only an exact committed prefix authorizes replacing unseen words.
      // A correction to already displayed speech cannot replay that speech.
      if(prefixMatches(item.consumed,corrected))item.words=corrected;
      item.reviewPending=false;
    }
    // Whisper may improve English after the stream has ended. It cannot rewrite
    // the English source of Chinese phrases already committed from that stream.
    if (!item.ended) {
      item.words = [...item.carry, ...tokens(final && typeof streamText === 'string' && streamText.trim() ? streamText : text)];
      item.samples.push({at: this.now(), words: item.words});
      item.samples = item.samples.slice(-40);
      item.ended = sourceEnded || final;
      if (item.ended) {
        item.endReason = endReason || 'silence'; item.flushAt = this.now() + 2000;
        item.reviewPending=!final&&item.endReason!=='limit'&&this.finalReviewMs>0;
        // A short first utterance can end before the final model finishes loading.
        // Preserve its unseen tail for correction within the startup deadline.
        item.reviewQueued=reviewQueued;
        item.reviewUntil=this.now()+(reviewLoading?this.finalLoadingReviewMs:reviewQueued?this.queuedReviewMs:this.finalReviewMs);
      }
      if (item.consumed.length && !prefixMatches(item.consumed, item.words)) {
        item.invalid = true;
        this.emit({type: 'segment_warning', id, message: '识别修改了已显示的原文；保留字幕，此段剩余内容暂缓。'});
      }
    }
    this.pump(); this.prune();
  }
  candidate(item) {
    if (item.invalid) return [];
    if (item.ended) return item.words.slice(item.consumed.length);
    const target = this.now() - this.stableMs;
    let index = -1;
    for (let n = 0; n < item.samples.length; n++) if (item.samples[n].at <= target) index = n;
    if (index < 0) return [];
    let limit = item.samples[index].words.length;
    for (const sample of item.samples.slice(index)) {
      let n = 0;
      while (n < limit && n < sample.words.length && key(sample.words[n]) === key(item.words[n])) n++;
      limit = n;
    }
    limit = Math.min(limit, Math.max(0, item.words.length - this.tailWords));
    return item.words.slice(item.consumed.length, Math.max(item.consumed.length, limit));
  }
  pump() {
    if (this.closed || this.active) return;
    clearTimeout(this.timer); this.timer = null;
    const ordered = [...this.items.values()].sort((a, b) => a.sequence - b.sequence);
    for (const item of ordered) {
      if (item.invalid || (item.ended && item.consumed.length >= item.words.length)) continue;
      if(item.retryAt>this.now()){
        this.timer=setTimeout(()=>this.pump(),Math.max(1,item.retryAt-this.now()));this.timer.unref?.();return;
      }
      if(item.reviewPending&&this.now()<item.reviewUntil){
        this.timer=setTimeout(()=>this.pump(),Math.max(1,item.reviewUntil-this.now()));
        this.timer.unref?.();return;
      }
      if(item.reviewPending)item.reviewPending=false;
      if (item.endReason === 'limit' && this.now() >= item.flushAt) item.endReason = 'timeout';
      const words = this.candidate(item);
      const canFinish = item.ended && item.endReason !== 'limit';
      const attemptKey = `${canFinish}:${item.consumed.length}:${words.join(' ')}`;
      if (words.length && attemptKey !== item.attemptKey) {
        if(item.failedKey!==attemptKey)item.failures=0;
        item.attemptKey = attemptKey;
        this.run(item, words); return;
      }
      // Do not let a newer segment overtake an older unfinished translation.
      if (!canFinish) {
        this.timer = setTimeout(() => this.pump(), this.stableMs);
        this.timer.unref?.(); return;
      }
    }
  }
  run(item, words) {
    const job = {item, words, offset: item.consumed.length, final: item.ended && item.endReason !== 'limit', controller: new AbortController()};
    this.active = job;
    const watchdog = setTimeout(() => {
      const error=new Error('本地分句翻译超时。');error.code='FLOWSUB_TRANSLATION_TIMEOUT';job.controller.abort(error);
    }, 12000);
    const valid = () => !this.closed && this.active === job && !job.controller.signal.aborted && !item.invalid && !item.moved;
    Promise.resolve().then(() => this.translate({words, lookahead: item.words.slice(job.offset + words.length).join(' '), previous: this.context.slice(-3), final: job.final, signal: job.controller.signal})).then(result => {
      if (!valid() || !result.consume) return;
      if (!Number.isSafeInteger(result.consume) || result.consume < 1 || result.consume > words.length || !String(result.zh || '').trim()) throw new Error('本地分句翻译无效。');
      const selected = words.slice(0, result.consume);
      if (item.consumed.length !== job.offset || !prefixMatches([...item.consumed, ...selected], item.words)) return; // Recognition changed while the request was in flight.
      if(!job.final&&this.continuationCheck(selected.join(' '),item.words.slice(job.offset+selected.length).join(' ')))return;
      item.consumed.push(...selected);
      item.failures=0;item.retryAt=0;item.failedKey='';
      const sourceText = selected.join(' '), text = result.zh.trim();
      const id = `${item.id}:phrase:${++item.commits}`;
      this.context.push({en: sourceText, zh: text}); this.context = this.context.slice(-6);
      this.emit({type: 'translation', id, sourceId: item.id, text, final: true, complete: true, sourceFinal: job.final, sourceText, sequence: this.commitSequence++, revision: 1, firstMs: result.firstMs, durationMs: result.durationMs, startedClientAt: item.startedClientAt});
    }).catch(error => {
      if (!this.closed && this.active === job && !item.moved && !item.invalid){
        item.failedKey=item.attemptKey;item.failures=(item.failures||0)+1;
        const retrying=item.failures<=this.maxRetries;
        if(retrying){item.attemptKey='';item.retryAt=this.now()+this.retryMs*item.failures;}
        this.emit({type:'segment_warning',id:item.id,retrying,message:retrying?'翻译暂时失败，正在自动重试。':'此句未能翻译，继续接收后续语音；可点刷新重新连接。'});
      }
    }).finally(() => {
      clearTimeout(watchdog);
      if (this.active === job) this.active = null;
      this.prune(); this.pump();
    });
  }
  reviewStarted(id) {
    const item=this.items.get(id);
    if(this.closed || !item?.reviewPending || !item.reviewQueued || item.invalid || item.moved || item.final)return;
    item.reviewQueued=false;item.reviewUntil=this.now()+this.processingReviewMs;this.pump();
  }
  fail(id) {const item = this.items.get(id); if (item) item.invalid = true; this.pump();}
  retry(id) {const item = this.items.get(id); if (item && !item.invalid) {item.attemptKey = '';item.failures=0;item.retryAt=0;this.pump();}}
  prune() {
    const pending = [...this.items.values()].filter(item => !item.invalid && item.consumed.length < item.words.length);
    let excess = pending.length - this.maxPending;
    for (const item of pending) {
      if (excess <= 0) break;
      if (this.active?.item === item) continue;
      item.invalid = true; excess--;
      this.emit({type: 'segment_warning', id: item.id, message: '本地模型积压，跳过较早片段，继续接收当前语音。'});
    }
    if (this.items.size <= 160) return;
    for (const [id, item] of this.items) {
      if (this.items.size <= 160) break;
      if (this.active?.item !== item && (item.invalid || item.ended)) this.items.delete(id);
    }
  }
  close() {this.closed = true; clearTimeout(this.timer); this.active?.controller.abort(); this.active = null; this.items.clear(); this.context = [];}
}
