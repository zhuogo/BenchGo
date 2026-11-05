// Measures host routing only: no synthetic LLM timings or coding-quality claims.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { createAssistantOrchestrationStore } from '../plugins/superagent/src/orchestration-store.mjs';
import { ingestAssistantEvent } from '../plugins/superagent/src/intake.mjs';

const policy = { version: 'eval', ownerIds: ['owner'], threadIds: ['chat'] };
function run(subscribe) {
  const db = createAssistantOrchestrationStore({ filename: ':memory:' });
  const durations = []; let direct = 0, candidates = 0, duplicate = 0;
  try {
    for (let i = 0; i < 300; i++) {
      const threadId = `thread-${i % 20}`;
      const event = { channel: 'feishu', sourceKey: `message-${i}`, threadId, source: { chatId: 'chat' }, actor: { kind: 'human', id: 'owner' }, text: i < 20 ? '处理此任务' : '同一事项的后续上下文', kind: 'group', mentioned: true };
      const start = performance.now();
      const result = ingestAssistantEvent(db, event, policy);
      durations.push(performance.now() - start);
      if (result.candidate) candidates++;
      if (result.delivery) direct++;
      if (i < 20 && subscribe) {
        const ticket = db.createTicket({ threadId, target: event.text, mandate: {} });
        db.subscribe(ticket.id, threadId, { cursorTriggerId: result.trigger.id });
      }
      if (ingestAssistantEvent(db, event, policy).duplicate) duplicate++;
    }
    durations.sort((a, b) => a - b);
    return { messages: 300, initialRequests: 20, followups: 280, candidates, direct, duplicateReplaysRejected: duplicate, hostIngressP50Ms: durations[149], hostIngressP95Ms: durations[284] };
  } finally { db.close(); }
}
const subscribed = run(true), withoutSubscriptions = run(false);
assert.equal(subscribed.direct, 280);
assert.equal(subscribed.candidates, 20);
assert.equal(withoutSubscriptions.candidates, 300);
assert.equal(subscribed.duplicateReplaysRejected, 300);
const report = { generatedAt: new Date().toISOString(), scope: 'Deterministic local ingress only. Candidate counts are not measured LLM calls. No cache token or end-to-end performance claims.', subscribed, withoutSubscriptions };
await writeFile(new URL('./superagent-20261103/optimization-subscriptions.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
