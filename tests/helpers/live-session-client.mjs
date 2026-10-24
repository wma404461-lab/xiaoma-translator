// Replay unacknowledged frames by sequence. Server survives transient socket loss.
import WebSocket from 'ws';
export class LiveSession {
  constructor({ token, options = {}, onEvent, onStatus, onFatal, WebSocketImpl = WebSocket, baseUrl = 'ws://127.0.0.1:4317/api/live' }) {
    Object.assign(this, { token, options, onEvent, onStatus, onFatal, WebSocketImpl, baseUrl });
    this.seq = 0; this.ack = 0; this.frames = new Map(); this.attempt = 0; this.closed = false; this.ready = false; this.resumeKey = null; this.sent = 0;
  }
  connect() {
    if (this.closed) return;
    this.onStatus(this.resumeKey ? '正在重连 · 保留音频' : '正在加载本机模型');
    const ws = this.ws = new this.WebSocketImpl(`${this.baseUrl}?token=${this.token}`);
    this.lastMessage = Date.now();
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type:'start', ...this.options, resumeKey:this.resumeKey })));
    ws.addEventListener('message', ({data}) => {
      let event; try { event = JSON.parse(data); } catch { return; }
      this.lastMessage = Date.now();
      if (event.type === 'session') {
        this.resumeKey = event.resumeKey; this.sent = event.lastSeq; this.confirm(event.lastSeq); this.ready = event.ready; this.attempt = 0;
        if (event.ready) this.onStatus('翻译中 · 本机运行'); this.flush();
      } else if (event.type === 'ready') {this.ready = true; this.attempt = 0; this.onStatus('翻译中 · 本机运行'); this.flush();}
      else if (event.type === 'ack') this.confirm(event.seq);
      else if (event.type === 'resend') {this.sent = event.seq - 1; this.flush();}
      else if (event.type === 'expired' || event.type === 'error') {this.onFatal(event.message); this.close();}
      else if (event.type === 'stopped') this.close();
      this.onEvent(event);
    });
    ws.addEventListener('error', () => {});
    ws.addEventListener('close', () => {
      if (ws !== this.ws || this.closed) return;
      this.ready = false; this.onStatus('连接中断 · 自动恢复中');
      clearTimeout(this.retryTimer); this.retryTimer = setTimeout(() => this.connect(), Math.min(500 * 2 ** this.attempt++, 5000));
    });
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {if (!this.closed && Date.now() - this.lastMessage > 35000) this.ws?.close();},5000);
  }
  confirm(seq) {this.ack = Math.max(this.ack,seq); for (const key of this.frames.keys()) if (key <= this.ack) this.frames.delete(key);}
  audio(pcm, clientAt = Date.now()) {
    if (this.closed || this.stopping) return;
    if (this.frames.size >= 600) {this.onFatal('音频缓冲超过 30 秒，已停止采集，避免静默丢失。请检查本机服务后重新接入。'); this.close(); return;}
    const bytes = new Uint8Array(pcm);
    const frame = {type:'audio',seq:++this.seq,clientAt,pcm:btoa(String.fromCharCode(...bytes))}; this.frames.set(frame.seq,frame); this.flush();
  }
  flush() {
    if (!this.ready || this.closed || this.ws?.readyState !== 1) return;
    for (const [seq,frame] of this.frames) {
      if (seq <= this.sent) continue;
      if (this.ws.bufferedAmount > 128000) {clearTimeout(this.flushTimer);this.flushTimer = setTimeout(()=>this.flush(),20);return;}
      this.ws.send(JSON.stringify(frame)); this.sent = seq;
    }
  }
  send(value) {if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(value));}
  stop() {this.stopping = true; this.flush(); this.send({type:'stop'}); this.stopTimer = setTimeout(()=>this.close(),10000);}
  close() {this.closed = true; clearTimeout(this.retryTimer); clearTimeout(this.flushTimer); clearTimeout(this.stopTimer); clearInterval(this.watchdog); this.ws?.close(); this.frames.clear();}
}
