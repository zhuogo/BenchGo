// Real configured model, actual assessment function; HTTP bridge, not full Harness delivery.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { reviewTicketResult } from '../plugins/superagent/src/ticket-review.mjs';
import { createReviewEvidenceReader } from '../plugins/superagent/src/review-evidence-reader.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readdir } from 'node:fs/promises';
import { scanZstdFrames, decompressZstdFrame } from '../deepseek-harness/packages/session/session-persistence-jsonl/src/zstd.ts';
import { SessionLogScanner } from '../deepseek-harness/packages/session/session-persistence-jsonl/src/format.ts';
const require = createRequire(new URL('../deepseek-harness/packages/credentials/credentials-local/package.json', import.meta.url));
const { parse } = require('yaml');
const home = join(homedir(), '.dsh');
const patch = parse(await readFile(join(home, 'profiles/desktop/cordis.patch.yml'), 'utf8'));
const config = JSON.parse(await readFile(join(homedir(), '.benchgo/assistant/config.json'), 'utf8'));
const selected = { provider: config.models[0]?.providerId, model: config.models[0]?.modelId };
const rules = await readFile(join(homedir(), '.benchgo/assistant/AGENTS.md'), 'utf8');
const provider = patch.find(row => row.id === 'llm-pi-ai')?.config.providers[selected?.provider];
if (!selected?.model || provider?.api !== 'openai-completions') throw new Error('Configured main model unsupported by this read-only eval');
const credentials = parse(await readFile(join(home, '.credentials.yaml'), 'utf8'));
const entry = credentials.refs?.[provider.apiKeyEnv];
const secret = typeof entry === 'string' ? entry : entry?.value;
if (!secret) throw new Error('Credential unavailable');
let rawDecision; const decisions = [];
const llm = { async *stream(options) {
  const response = await fetch(provider.baseURL.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', signal: options.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: options.model, stream: false, max_tokens: options.maxTokens,
      messages: options.messages.map(message => ({ role: message.role, content: message.content.map(part => part.text).join('\n') })) }),
  });
  if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
  const result = await response.json();
  rawDecision = result.choices?.[0]?.message?.content || '';
  decisions.push(JSON.parse(rawDecision)); yield { type: 'text-delta', text: rawDecision };
  yield { type: 'finish', reason: { kind: result.choices?.[0]?.finish_reason === 'stop' ? 'stop' : 'incomplete' } };
} };
const db = new DatabaseSync(join(homedir(), '.benchgo/assistant/assistant.db'), { readOnly: true });
db.exec('PRAGMA busy_timeout=5000');
const ticketId = process.env.REVIEW_TICKET || '6e95cee9-42bf-48b4-96ab-5f5cdbf13db8';
const row = db.prepare('SELECT * FROM sa_tickets WHERE id=?').get(ticketId);
const committed = db.prepare('SELECT payload FROM sa_results WHERE ticket_id=? ORDER BY version DESC LIMIT 1').get(ticketId);
const saved = committed ? JSON.parse(committed.payload) : JSON.parse(db.prepare('SELECT payload FROM sa_runs WHERE assignment_id IN (SELECT id FROM sa_assignments WHERE ticket_id=?) ORDER BY updated_at DESC LIMIT 1').get(ticketId).payload).evidence;
db.close();
const ticket = { id: row.id, target: row.target, mandate: JSON.parse(row.mandate), acceptance: row.acceptance, createdAt: row.created_at, instructionRevision: row.instruction_revision };
const { review: oldReview, delivery, ...result } = saved;
const sessions = join(home, 'sessions');
let bytes;
for (const directory of await readdir(sessions, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  try { bytes = await readFile(join(sessions, directory.name, result.sessionId, 'session.v4.jsonl.zstd')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (!bytes) throw new Error('Original session not found');
const plain = Buffer.concat(await Promise.all(scanZstdFrames(bytes).frames.map(({ start, end }) => decompressZstdFrame(bytes.subarray(start, end)))));
const boundary = plain.indexOf(10) + 1;
const scanner = new SessionLogScanner(plain.subarray(0, boundary), 'strict');
scanner.write(plain.subarray(boundary));
const decoded = scanner.finish();
const log = { session: decoded.meta, events: decoded.events };
const reader = createReviewEvidenceReader({ ctx: { sessionQuery: { readSession: async () => log } }, result });
const index = await reader.index();
const pages = [];
const readEvidence = async page => { const value = await reader(page); pages.push({ seq: value.seq, name: value.name, offset: value.offset, length: value.text.length }); return value; };
readEvidence.index = reader.index;
const startedAt = new Date().toISOString();
let verdict;
try { verdict = await reviewTicketResult({ llm, model: { providerId: selected.provider, modelId: selected.model }, ticket, result, rules, readEvidence, signal: AbortSignal.timeout(180000) }); }
catch (error) { verdict = { error: error.message, cause: error.cause?.message }; }
const report = { startedAt, finishedAt: new Date().toISOString(), scope: 'Read-only original Feishu evidence re-review with configured real model; no DB mutation, no external send, not a new Worker run.', ticketId, originalStatus: row.status, originalReview: oldReview?.verdict, index: { total: index.total, omitted: index.omitted }, pages, decisions, verdict };
await writeFile(new URL(process.env.REVIEW_REPORT || './review-real-result.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ verdict: verdict.verdict, evidencePages: pages.length, reason: verdict.reason }));
