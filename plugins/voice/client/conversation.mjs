/** Call-only channel. The host owns model calls, execution and durable records. */
export class VoiceConversation {
  constructor({ request = globalThis.fetch.bind(globalThis), endpoint, identity, onEvent, onError, connectTimeoutMs = 12000 } = {}) {
    Object.assign(this, { request, endpoint, identity, onEvent, onError, connectTimeoutMs });
    this.controller = new AbortController();
    this.closed = false;
    this.messages = new Set();
    this.interrupted = new Set();
    this.interrupting = null;
  }
  async post(action, values = {}, signal = this.controller.signal) {
    if (action !== 'events') signal = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
    const response = await this.request(this.endpoint, {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...values, ...this.identity, action }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw Error(data.error || '语音交互请求失败');
    }
    return response;
  }
  async start() {
    // Bound only opening the stream; an established call may remain quiet for
    // much longer than this deadline and must retain its lifetime signal.
    const timer = setTimeout(() => this.controller.abort(new Error('语音交互连接超时，请重新开始通话')), this.connectTimeoutMs);
    let response;
    try { response = await this.post('events'); }
    finally { clearTimeout(timer); }
    if (this.closed) { void response.body?.cancel(); return; }
    if (!response.body?.getReader || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw Error('语音交互没有返回事件流');
    this.reader = response.body.getReader();
    this.running = this.read().catch(error => { if (!this.closed && !this.controller.signal.aborted) this.onError?.(error); });
  }
  async read() {
    const decoder = new TextDecoder(); let pending = '';
    const accept = line => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'ready') return;
      if (event.type === 'start' && event.messageId) this.messages.add(event.messageId);
      if (event.messageId && this.interrupted.has(event.messageId)) return;
      this.onEvent?.(event);
      if (event.type === 'end' && event.messageId) this.messages.delete(event.messageId);
    };
    try {
      while (!this.closed) {
        const { value, done } = await this.reader.read();
        if (done) {
          pending += decoder.decode();
          if (pending.trim()) accept(pending);
          if (!this.closed) throw Error('语音交互连接已断开，请重新开始通话；已接收的工作不会重复提交');
          return;
        }
        pending += decoder.decode(value, { stream: true });
        let end;
        while ((end = pending.indexOf('\n')) >= 0) { if (end > 65536) throw Error('语音交互事件超出限制'); accept(pending.slice(0, end)); pending = pending.slice(end + 1); }
        if (pending.length > 65536) throw Error('语音交互事件超出限制');
      }
    } finally { this.reader.releaseLock(); }
  }
  async send(text, requestId) {
    if (this.closed) throw Error('通话已结束');
    if (this.interrupting) await this.interrupting;
    if (this.closed) throw Error('通话已结束');
    const response = await this.post('turn', { text, requestId });
    return response.json();
  }
  interrupt() {
    if (this.closed) return Promise.resolve();
    for (const id of this.messages) this.interrupted.add(id);
    this.messages.clear();
    if (this.interrupted.size > 256) this.interrupted = new Set([...this.interrupted].slice(-128));
    const run = this.post('interrupt').then(response => response.json());
    this.interrupting = run;
    void run.finally(() => { if (this.interrupting === run) this.interrupting = null; }).catch(() => {});
    return run;
  }
  async dispose() {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    void this.reader?.cancel().catch(() => {});
    await this.running;
    // Close the dialogue before the media lease is released, without cancelling execution.
    try { const response = await this.post('close', {}, AbortSignal.timeout(3000)); await response.body?.cancel(); } catch {}
  }
}
