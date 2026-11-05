// Read-only HTTP checks against the already-running packaged BenchGo host.
import { writeFile } from 'node:fs/promises';
const base = process.env.BENCHGO_EVAL_HOST || 'http://127.0.0.1:53965';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw Error('This probe is local-only');
const cases = [
  ['未认证读取助手状态', '/api/commander/assistant', 401, { method: 'POST', body: '{"action":"state"}' }],
  ['跨站 Origin 调用助手', '/api/commander/assistant', 403, { method: 'POST', body: '{"action":"state"}', headers: { origin: 'https://evil.invalid' } }],
  ['未认证读取产物', '/api/commander/assistant/artifact?file=missing.txt', 401, {}],
  ['未认证读取人格文档', '/api/commander/assistant/system-file?file=AGENTS.md', 401, {}],
  ['未认证读取语音 worklet', '/api/commander/assistant/voice/worklet', 401, {}],
];
const report = { base, date: new Date().toISOString(), limitation: '仅验证正在运行的打包实例 HTTP 边界；不证明该实例完整业务或 UI 可用。', cases: [] };
for (const [title, path, expected, options] of cases) {
  const start = performance.now(); let row = { title, path, expected };
  try { const response = await fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(10000) }); row.statusCode = response.status; row.pass = response.status === expected; await response.body?.cancel(); }
  catch (error) { row.pass = false; row.error = error.message; }
  row.durationMs = Math.round(performance.now() - start); report.cases.push(row);
}
await writeFile(new URL('./superagent-20261103/installed-security.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
