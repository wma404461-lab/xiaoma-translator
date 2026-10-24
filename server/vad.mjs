// Bounded rolling segments: independent of socket lifetime, so reconnects preserve audio.
export class Segmenter {
  constructor({ onSegment, onActivity = () => {}, maxFrames = 200, maxExtraFrames = 40, threshold = .0025 } = {}) {
    Object.assign(this, { onSegment, onActivity, maxFrames, threshold });
    this.hardFrames = maxFrames + Math.min(maxExtraFrames, Math.max(0, 240 - maxFrames));
    this.pre = []; this.frames = []; this.counter = 0; this.silent = 0; this.revision = 0; this.lastDraft = 0; this.id = null;
  }
  push(pcm, clientAt) {
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 2) sum += (pcm.readInt16LE(i) / 32768) ** 2;
    // Quiet real recordings need a lower onset threshold and hysteresis through consonants.
    const rms = Math.sqrt(sum / (pcm.length / 2));
    const voiced = rms > this.threshold * (this.id ? .4 : 1);
    if (!this.id) {
      this.pre.push(pcm); if (this.pre.length > 6) this.pre.shift();
      if (!voiced) return;
      this.id = `seg-${++this.counter}`; this.startedClientAt = clientAt; this.frames = [...this.pre]; this.pre = []; this.silent = 0; this.revision = 0; this.lastDraft = 0; this.energy = []; this.boundaryQuiet = 0;
      this.onActivity({ type: 'activity', active: true });
    } else this.frames.push(pcm);
    this.silent = voiced ? 0 : this.silent + 1;
    // A time limit inside a spoken word harms both recognizers. Once the soft
    // limit is reached, prefer a 100-ms energy valley relative to recent speech.
    // The hard limit still bounds every PCM request to the ASR's 12 seconds.
    this.energy.push(rms);if(this.energy.length>20)this.energy.shift();
    const quiet = rms <= Math.max(this.threshold * .4, Math.max(...this.energy) * .12);
    this.boundaryQuiet = quiet ? this.boundaryQuiet + 1 : 0;
    if (this.silent >= 13 || this.frames.length >= this.hardFrames || (this.frames.length >= this.maxFrames && this.boundaryQuiet >= 2)) this.finish(this.silent >= 13 ? 'silence' : 'limit');
    // Feed streaming recognition at 300 ms, then every 200 ms. Its own acoustic
    // lookahead still applies; finalization remains separate from live English.
    else if (this.frames.length >= 6 && this.frames.length - this.lastDraft >= 4) { this.lastDraft = this.frames.length; this.snapshot(false); }
  }
  snapshot(final) {
    if (this.frames.length < 5) return;
    this.onSegment({ id: this.id, sourceSequence: this.counter, audio: Buffer.concat(this.frames), final, endReason: final ? this.endReason : undefined, revision: ++this.revision, startedClientAt: this.startedClientAt });
  }
  finish(reason = 'manual') {
    if (!this.id) return;
    this.endReason = reason; this.snapshot(true); this.id = null; this.frames = []; this.pre = []; this.onActivity({ type: 'activity', active: false });
  }
}
