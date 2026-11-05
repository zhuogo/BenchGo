// Safe progress snapshots for this evaluation's own independent temporary profiles.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { observeSession } from './observe-session.mjs';
import { DatabaseSync } from 'node:sqlite';
const output = resolve(process.argv[2] || ''), controls = (await readFile(join(output, 'worker-controls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const snapshots = [];
for (const control of controls) {
  for (const temporary of (await readdir(tmpdir())).filter(name => name.startsWith('benchgo-p0-real-'))) {
    try {
      const statistics = await observeSession(join(tmpdir(), temporary), control.sessionId);
      snapshots.push(statistics);
      const database = new DatabaseSync(join(tmpdir(), temporary, 'user/.benchgo/assistant/assistant.db'), { readOnly: true });
      try {
        const row = database.prepare("SELECT t.id,t.title,t.target,t.acceptance,t.mandate FROM sa_tickets t JOIN sa_assignments a ON a.ticket_id=t.id JOIN sa_runs r ON r.assignment_id=a.id WHERE json_extract(r.payload,'$.sessionId')=?").get(control.sessionId);
        if (row) await writeFile(join(output, 'task-contract.json'), JSON.stringify({ ...row, mandate: JSON.parse(row.mandate) }, null, 2));
      } finally { database.close(); }
      console.log(JSON.stringify({ marker: control.marker, sessionId: control.sessionId, updatedAt: statistics.updatedAt, counts: statistics.counts, toolResultStats: statistics.toolResultStats, hosts: [...new Set(statistics.tools.flatMap(tool => tool.hosts))] }));
      break;
    } catch { /* Only an owned matching isolated session is eligible. */ }
  }
}
await writeFile(join(output, 'worker-progress-statistics.json'), JSON.stringify({ at: new Date().toISOString(), snapshots }, null, 2));
