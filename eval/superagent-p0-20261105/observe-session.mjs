// Optional read-only progress statistics for an isolated compressed official session.
// Does not print message content, reasoning, tool arguments or page bodies.
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function observeSession(inputDirectory, sessionId, { prefixEvents } = {}) {
const directory = resolve(inputDirectory || '');
const eveningBase = fileURLToPath(new URL('../superagent-evening-20261105/', import.meta.url));
assert.ok((directory.startsWith(resolve(tmpdir())) && directory.includes('benchgo-p0-real-'))
  || ((directory.startsWith(resolve(eveningBase) + '\\') || directory.startsWith(resolve(eveningBase) + '/')) && directory.endsWith('isolated-state')));
assert.match(sessionId || '', /^[a-f0-9-]{36}$/u);
const base = join(directory, 'user/.dsh/sessions');
const file = (await readdir(base, { recursive: true })).find(path => path.includes(sessionId) && path.endsWith('.zstd'));
assert.ok(file, 'Isolated session not yet persisted');
const path = join(base, file), bytes = await readFile(path);
let offset = 0, events = [];
while (offset < bytes.length) {
  try {
    const decoded = zstdDecompressSync(bytes.subarray(offset), { info: true });
    if (!decoded.engine.bytesWritten) break;
    offset += decoded.engine.bytesWritten;
    events.push(...decoded.buffer.toString().trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } }));
  } catch { break; } // A concurrently appended incomplete final frame is not evidence loss.
}
const counts = {};
for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;
const tools = events.flatMap(event => event.type === 'assistant/message' ? (event.data?.message?.content || []).filter(block => block.type === 'tool-call') : [])
  .map(block => ({ name: block.name, hosts: [...String(typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments)).matchAll(/https?:\/\/([^\s/\\"]+)/gu)].map(match => match[1]) }));
const toolResults = events.filter(event => event.type === 'tool/result');
const errors = toolResults.filter(event => event.data?.message?.isError || event.data?.error).length;
return { sessionId, updatedAt: (await stat(path)).mtime.toISOString(), compressedBytes: bytes.length, decodedBytes: offset, counts, tools,
  eventCount: events.length, transcriptHash: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
  ...(prefixEvents ? { prefixHash: createHash('sha256').update(JSON.stringify(events.slice(0, prefixEvents))).digest('hex') } : {}),
  toolResultStats: { total: toolResults.length, markedError: errors, notMarkedError: toolResults.length - errors },
  lastEvents: events.slice(-6).map(event => ({ type: event.type, seq: event.seq, time: event.time })) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await observeSession(process.argv[2], process.argv[3]), null, 2));
