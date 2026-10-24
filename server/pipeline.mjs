export class CaptionPipeline {
  constructor({ translate, emit, draftDelay = 700, concurrency = 2, translateDrafts = true }) {
    this.translate = translate;
    this.emit = emit;
    this.draftDelay = draftDelay;
    this.concurrency = concurrency;
    this.translateDrafts = translateDrafts;
    this.items = new Map();
    this.queue = [];
    this.activeCount = 0;
    this.closed = false;
    this.topic = '';
    this.glossary = [];
    this.sequence = 0;
  }
  configure({ topic = '', glossary = [] } = {}) {
    this.topic = String(topic).slice(0, 500);
    this.glossary = (Array.isArray(glossary) ? glossary : []).filter(pair => pair && typeof pair.en === 'string' && typeof pair.zh === 'string').slice(0, 40).map(pair => ({ en: pair.en.slice(0, 100), zh: pair.zh.slice(0, 100) }));
  }
  transcript({ id, text, final = false, startedClientAt = null, sourceSequence = null }) {
    if (this.closed || !id || typeof text !== 'string' || !text.trim()) return;
    let item = this.items.get(id);
    if (item?.final) return; // Late recognition deltas must not reopen a finalized source.
    if (!item) {
      const sequence = Number.isSafeInteger(sourceSequence) && sourceSequence >= 0 ? sourceSequence : this.sequence;
      this.sequence = Math.max(this.sequence, sequence + 1);
      item = { id, text: '', final: false, revision: 0, zh: '', translatedRevision: 0, sequence, startedClientAt, timer: null, active: null };
      this.items.set(id, item);
    }
    item.text = text.slice(0, 6000);
    item.final = final;
    item.revision++;
    this.emit({ type: 'transcript', id, text: item.text, final, revision:item.revision, sequence: item.sequence, startedClientAt: item.startedClientAt });
    if (final) {
      clearTimeout(item.timer);
      item.timer = null;
      if (item.active) { item.active.controller.abort(); item.active = null; }
      this.enqueue(item);
    } else if (this.translateDrafts && !item.timer && !item.active) {
      item.timer = setTimeout(() => {
        item.timer = null;
        if (item.text.trim().split(/\s+/).length >= 3) this.enqueue(item);
      }, this.draftDelay);
    }
    this.prune();
  }
  enqueue(item) {
    if (this.closed || item.active || item.translatedRevision === item.revision) return;
    this.queue = this.queue.filter(existing => existing.id !== item.id);
    this.queue.push(item);
    this.queue.sort((a, b) => Number(b.final) - Number(a.final) || a.sequence - b.sequence);
    if (this.queue.length > 24) {
      const skipped = this.queue.shift();
      skipped.translatedRevision = skipped.revision;
      this.emit({ type: 'segment_error', id: skipped.id, startedClientAt:skipped.startedClientAt, message: 'Model backlog; retry this segment manually; continue receiving subsequent speech.' });
    }
    this.pump();
  }
  pump() {
    while (!this.closed && this.activeCount < this.concurrency && this.queue.length) {
      const item = this.queue.shift();
      if (item.active || item.translatedRevision === item.revision) continue;
      const job = { revision: item.revision, text: item.text, final: item.final, controller: new AbortController() };
      item.active = job;
      this.activeCount++;
      const watchdog = setTimeout(() => job.controller.abort(new Error('Translation timeout—check local model.')), 30000);
      const context = [...this.items.values()].filter(other => other.sequence < item.sequence && other.text && (other.final || other.text.trim().split(/\s+/).length>=3)).sort((a,b)=>a.sequence-b.sequence).slice(-6).map(other => ({ en: other.text, zh: other.zh }));
      const valid = () => !this.closed && item.active === job && !job.controller.signal.aborted;
      Promise.resolve().then(() => this.translate({ text: job.text, final: job.final, context, glossary: this.glossary, topic: this.topic,
        signal: job.controller.signal,
        onDelta: (text, firstMs) => {
          if (valid()) this.emit({ type: 'translation', id: item.id, text, final: false, complete:false, sourceFinal: job.final, revision: job.revision, firstMs, startedClientAt: item.startedClientAt });
        }
      })).then(result => {
        if (!valid()) return;
        item.zh = result.text;
        item.translatedRevision = job.revision;
        this.emit({ type: 'translation', id: item.id, text: result.text, final: job.final, complete:true, sourceText:job.text, sequence:item.sequence, revision: job.revision, firstMs: result.firstMs, durationMs: result.durationMs, startedClientAt: item.startedClientAt });
      }).catch(error => {
        if (!this.closed && item.active === job) {
          this.emit({ type: 'segment_error', id: item.id, startedClientAt:item.startedClientAt, message: error.message || 'This segment failed to translate.' });
          item.translatedRevision = job.revision; // Do not create an infinite paid retry loop.
        }
      }).finally(() => {
        clearTimeout(watchdog);
        this.activeCount--;
        if (item.active === job) {
          item.active = null;
          if (item.revision > job.revision) this.enqueue(item);
        }
        this.prune();
        this.pump();
      });
    }
  }
  prune() {
    if (this.items.size <= 160) return;
    for (const [id, item] of this.items) {
      if (this.items.size <= 160) break;
      if (!item.active && !item.timer && !this.queue.includes(item) && (item.final || item.sequence<this.sequence-30)) this.items.delete(id);
    }
  }
  retry(id) {
    const item = this.items.get(id);
    if (!item || item.active || this.closed) return;
    item.translatedRevision = -1;
    this.enqueue(item);
  }
  close() {
    this.closed = true;
    this.queue = [];
    for (const item of this.items.values()) {
      clearTimeout(item.timer);
      item.active?.controller.abort();
      item.active = null;
    }
  }
}
