import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mediaModelResult, mediaResultFile, mediaResultItems } from '../../media/shared/generation-result.mjs';

export const delegationSchema = { type: 'object', properties: {
  provider: { type: 'string', enum: ['codex', 'claude', 'pi', 'opencode', 'gemini', 'grok', 'mcode'] },
  providerId: { type: 'string' },
  model: { type: 'string' }, text: { type: 'string' },
  requestId: { type: 'string' },
  operation: { type: 'string', enum: ['delegate', 'result'] }, sessionId: { type: 'string' },
}, required: [], additionalProperties: false };

/** Per-process, per-session capability endpoint for native MCP/extension tools. No public listener. */
export class DelegationBridge {
  constructor(commander, { serverFactory = createServer } = {}) { this.commander = commander; this.tokens = new Map(); this.serverFactory = serverFactory; }
  async open() {
    this.server = this.serverFactory(async (req, res) => {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      const id = this.tokens.get(token);
      const mediaTools = req.method === 'GET' && req.url === '/media/tools';
      const mediaCall = req.method === 'POST' && req.url === '/media/call';
      const delegation = req.method === 'POST' && req.url === '/delegate';
      res.setHeader('Content-Type', 'application/json');
      if (!id || !(delegation || mediaTools || mediaCall)) { res.writeHead(403); res.end('{}'); return; }
      const controller = new AbortController();
      req.once('aborted', () => controller.abort(new Error('Delegation request was cancelled')));
      res.once('close', () => { if (!res.writableEnded) controller.abort(new Error('Delegation connection was closed')); });
      try {
        const media = !delegation && this.commander.getMediaGeneration?.();
        if (mediaTools) { res.end(JSON.stringify(await media?.nativeTools?.() ?? [])); return; }
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 65536) throw new Error(delegation ? 'Delegation request too large' : 'Native media request too large');
          chunks.push(chunk);
        }
        const args = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const value = delegation ? await this.commander.delegate(id, args, { signal: controller.signal })
          : await this.callMedia(id, token, media, args, controller);
        res.end(JSON.stringify(value));
      } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    });
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { this.server.removeListener('listening', ready); this.server.removeListener('error', failed); reject(error); };
        const ready = () => { this.server.removeListener('error', failed); resolve(); };
        this.server.once('error', failed);
        this.server.once('listening', ready);
        try { this.server.listen(0, '127.0.0.1'); } catch (error) { failed(error); }
      });
    } catch (error) { await this.close(); throw error; }
    this.url = `http://127.0.0.1:${this.server.address().port}/delegate`;
    return this;
  }
  forSession(id) {
    const token = randomBytes(32).toString('hex'); this.tokens.set(token, id);
    return { url: this.url, token, command: process.execPath, script: fileURLToPath(new URL('./mcp.mjs', import.meta.url)), schema: delegationSchema, media: !!this.commander.getMediaGeneration?.() };
  }
  async callMedia(id, token, media, { name, callId, args } = {}, controller) {
    if (!media?.executeNative) throw new Error('Media tools are unavailable');
    if (typeof name !== 'string' || typeof callId !== 'string' || !callId || callId.length > 512) throw new Error('Invalid media tool call');
    const session = this.commander.get(id);
    const turnId = session.turnId;
    const live = () => !controller.signal.aborted && this.tokens.get(token) === id && !session.archived && !session.executionId && turnId
      && session.turnId === turnId && ['running', 'waiting'].includes(session.status) && this.commander.interruptedTurns.get(id) !== turnId;
    if (!live()) throw new Error('Media tools require an active native chat turn');
    const listener = event => { if (event.sessionId === id && !live()) controller.abort(); };
    this.commander.on('event', listener);
    try {
      const userText = session.parentId ? undefined : Object.values(session.receipts ?? {})
        .find(input => input.receipt.turnId === turnId && (input.kind ?? 'prompt') === 'prompt')?.text;
      const result = await media.executeNative({ sessionId: id, callId: turnId + ':' + callId, name, args, signal: controller.signal, userText });
      for (const item of mediaResultItems(result)) {
        if (live() && mediaResultFile(item)) this.commander.event(id, 'media.result', item);
      }
      return mediaModelResult(result);
    } finally {
      this.commander.off('event', listener);
    }
  }
  revoke(id) { for (const [token, owner] of this.tokens) if (owner === id) this.tokens.delete(token); }
  async close() {
    this.tokens.clear();
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise(resolve => this.server.close(resolve));
  }
}
