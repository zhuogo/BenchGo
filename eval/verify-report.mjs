import assert from 'node:assert/strict';
import { readFile, access, writeFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
const root = new URL('./', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const rows = JSON.parse(await readFile(new URL('superagent-20261103/scenarios.json', root), 'utf8'));
const summary = JSON.parse(await readFile(new URL('superagent-20261103/summary.json', root), 'utf8'));
assert.equal(rows.filter(x => /^S\d+$/.test(x.id)).length, 30);
assert.equal(new Set(rows.map(x => x.id)).size, rows.length);
assert.equal(rows.filter(x => x.status === 'pass').length, summary.stats.pass);
assert.equal(summary.stats.total, rows.length);
assert.equal(summary.stats.pass + summary.stats.fail + summary.stats.blocked + summary.stats.pending, rows.length);
const links = [...html.matchAll(/href="([^"]+)"/g)].map(x => x[1]);
for (const link of links) {
  if (link.startsWith('#')) assert.ok(html.includes(`id="${link.slice(1)}"`));
  else { assert.ok(!/^https?:/.test(link)); await access(new URL(link, root)); }
}
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
assert.equal(scripts.length, 1);
const nodes = new Map(['search', 'status', 'mode', 'visible', 'empty', 'print'].map(id => [id, { value: '', style: {}, addEventListener() {} }]));
const tableRows = rows.map(x => ({ dataset: { status: x.status, mode: x.layer.startsWith('真实模型') ? 'real' : 'controlled', search: x.id + x.title + x.expected }, hidden: false }));
const context = createContext({ document: { getElementById: id => nodes.get(id), querySelectorAll: () => tableRows }, window: { print() {} } });
new Script(scripts[0]).runInContext(context);
nodes.get('status').value = 'fail'; new Script('filter()').runInContext(context);
assert.equal(tableRows.filter(x => !x.hidden).length, summary.stats.fail);
nodes.get('status').value = ''; nodes.get('mode').value = 'real'; new Script('filter()').runInContext(context);
assert.equal(tableRows.filter(x => !x.hidden).length, summary.real.total);
nodes.get('mode').value = ''; nodes.get('search').value = 'R06'; new Script('filter()').runInContext(context);
assert.equal(tableRows.filter(x => !x.hidden).length, 1);
nodes.get('search').value = 'NO_MATCH_EXPECTED'; new Script('filter()').runInContext(context);
assert.equal(tableRows.filter(x => !x.hidden).length, 0);
assert.equal(nodes.get('empty').style.display, 'block');
let optimizationChecks = [];
try {
  const update = JSON.parse(await readFile(new URL('superagent-20261103/optimization-verification.json', root), 'utf8'));
  assert.equal(update.testsPassed, update.tests.reduce((total, run) => total + run.pass, 0));
  assert(update.tests.every(run => run.fail === 0 && run.cancelled === 0 && run.total === run.pass));
  const after = await Promise.all(['controlled-results.json', 'real-extra-results.json'].map(async file => JSON.parse(await readFile(new URL('superagent-20261103/after/' + file, root), 'utf8'))));
  const results = after.flatMap(run => run.scenarios);
  assert.equal(results.length, 32);
  assert.equal(results.filter(row => row.status === 'pass').length, 32);
  assert(html.includes('32/32'));
  optimizationChecks = ['优化后132项定向回归统计', '优化后32场景与报告一致'];
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const result = { at: new Date().toISOString(), scenarios: rows.length, links: links.length, checks: ['30主场景且编号唯一', '统计与数据一致', '证据链接存在', '内联脚本语法', '失败筛选', '真实模型筛选', '搜索', '空状态', ...optimizationChecks], visualInspection: false };
await writeFile(new URL('superagent-20261103/report-verification.json', root), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
