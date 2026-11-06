// Repeats the real main-path scenarios and reports per-scenario success rates.
// Usage: node eval/mainpath-rate.mjs [--runs 3] [--output-dir artifacts/p0-mainpath-rate]
// Real model requests are made using the explicitly selected local default model (see eval/README.md).
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; };
const runs = Number(arg('--runs', '3'));
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) throw new Error('--runs must be 1..20');
const out = resolve(root, arg('--output-dir', 'artifacts/p0-mainpath-rate'));
// R05: Goal form -> Ticket -> Worker -> review -> delivery. R03: chat -> auto delegation -> delivery to the same chat.
// R06: Worker writes a verified artifact. Each runs in a fresh isolated Harness profile.
const cases = [['R05', []], ['R03', []], ['R06', ['--extra']]];
const rows = [];
await mkdir(out, { recursive: true });
for (let run = 1; run <= runs; run++) {
  for (const [id, flags] of cases) {
    const dir = join(out, `${id}-${run}`);
    const started = Date.now();
    const child = spawnSync(process.execPath, [join(root, 'eval/run-superagent.mjs'), '--real', ...flags, '--case', id, '--output-dir', dir], { cwd: root, encoding: 'utf8', timeout: 900000, windowsHide: true });
    let scenario;
    try {
      const report = JSON.parse(await readFile(join(dir, flags.includes('--extra') ? 'real-extra-results.json' : 'real-results.json'), 'utf8'));
      scenario = report.scenarios.find(row => row.id === id);
      if (!scenario && report.fatal) scenario = { status: 'fail', error: report.fatal };
    } catch (error) { scenario = { status: 'fail', error: `No report: ${error.message}; exit ${child.status}` }; }
    rows.push({ id, run, status: scenario?.status || 'fail', ms: Date.now() - started, error: scenario?.error ? String(scenario.error).slice(0, 500) : undefined });
    console.log(`${id} #${run} ${rows.at(-1).status} ${Math.round(rows.at(-1).ms / 1000)}s`);
  }
}
const summary = Object.fromEntries(cases.map(([id]) => {
  const own = rows.filter(row => row.id === id), passed = own.filter(row => row.status === 'pass').length;
  return [id, { passed, runs: own.length, rate: `${Math.round(100 * passed / own.length)}%` }];
}));
await writeFile(join(out, 'summary.json'), JSON.stringify({ finishedAt: new Date().toISOString(), runs, summary, rows }, null, 2));
console.log(JSON.stringify(summary));
