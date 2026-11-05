import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const folder = new URL('./superagent-20261103/', import.meta.url);
const text = async name => {
  const data = await readFile(new URL(name, folder));
  return data.subarray(0, 2).equals(Buffer.from([255, 254])) ? data.subarray(2).toString('utf16le') : data.toString('utf8');
};
const tests = [];
for (const file of ['optimization-routing.tap', 'optimization-core.tap', 'optimization-ticket-ui.tap', 'optimization-gates.tap']) {
  const output = await text(file);
  const number = key => Number(output.match(new RegExp(`(?:ℹ |# )${key} (\\d+)`))?.[1]);
  const row = { file, total: number('tests'), pass: number('pass'), fail: number('fail'), cancelled: number('cancelled') };
  if (!Number.isFinite(row.total)) throw new Error(`Incomplete test output: ${file}`);
  tests.push(row);
}
const sourceFiles = [
  'plugins/superagent/src/execution-evidence.mjs', 'plugins/superagent/src/assignment-executor.mjs',
  'plugins/superagent/src/review-input.mjs', 'plugins/superagent/src/review-continuation.mjs',
  'plugins/superagent/src/ticket-review.mjs', 'plugins/superagent/src/service.mjs',
  'plugins/superagent/client/model-settings.jsx', 'plugins/superagent/client/model-settings.mjs',
  'plugins/superagent/client/model-settings.css', 'plugins/superagent/client/index.jsx',
  'plugins/superagent/client/tickets.jsx', 'plugins/benchgo/openapi.json',
];
const sources = [];
for (const file of sourceFiles) sources.push({ file, sha256: createHash('sha256').update(await readFile(new URL('../' + file, import.meta.url))).digest('hex') });
const report = {
  generatedAt: new Date().toISOString(),
  description: '真实工具证据进入结果包；历史结果可锁定补证；相同输入不重复验收；主辅模型同页配置及用途勾选；过期测试修正；既有权限、准入与订阅机制保持。',
  testsPassed: tests.reduce((n, row) => n + row.pass, 0), tests,
  limitations: '未做视觉验收、外部聊天渠道端到端或生产压力测试。证据投影有界，超长证据未实现模型主动分页读取；缺证据仍保持待确认。没有新增 Worker 显式报告工具或通用成果证明器，不承诺任意任务自动成功。',
  sources,
};
await writeFile(new URL('optimization-verification.json', folder), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ testsPassed: report.testsPassed, tests }));
