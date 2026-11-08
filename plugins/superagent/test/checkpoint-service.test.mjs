import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCheckpointService } from '../src/checkpoint-service.mjs';
import { createWorkerCheckpointStore } from '../src/worker-checkpoint-store.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

async function fixture(t, { complete = true, stopped = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-checkpoint-service-')), directory = join(root, 'work');
  await mkdir(directory);
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  database.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = database.createTicket({ threadId: 'thread', target: 'edit file', mandate: { source: { channel: 'desktop', sessionId: 'owner', messageId: 'source' }, admission: 'desktop-approved-delegation', actorId: 'desktop-owner', policyVersion: 'v1', controlledActions: 'require-current-policy-and-harness-approval' } });
  database.createAssignment(ticket.id, { model: { providerId: 'exact', modelId: 'opaque' } });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = database.prepareRun(assignment.id, { ...ownership, sessionId: 'execution', directory });
  database.updateRun(run.id, { ...ownership, state: 'submitted' });
  const checkpoints = createWorkerCheckpointStore({ directory: join(root, 'shadow') });
  const file = join(directory, 'a.txt'); await writeFile(file, 'before');
  await checkpoints.protect({ runId: run.id, ticketId: ticket.id, assignmentId: assignment.id, directory }, () => writeFile(file, 'after'));
  if (complete) {
    const result = { runId: run.id, sessionId: run.sessionId, summary: 'Updated a.txt', selfCheck: { summary: 'Read and checked the updated file' } };
    assert.equal(await readFile(file, 'utf8'), 'after');
    database.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
    if (stopped) database.confirmExecutionStopped(assignment.id, ownership);
    database.commitResult(ticket.id, { assignment, result, uniqueKey: 'result' });
    const [outbox] = database.claimOutbox('fixture-delivery');
    assert.equal(database.getTicket(ticket.id).status, 'waiting');
    database.saveOutboxReply(outbox.id, { owner: 'fixture-delivery',
      publication: { action: 'deliver', origin: 'router', text: '文件已经更新，可以查看本次修改。' } });
    database.finishOutbox(outbox.id, { owner: 'fixture-delivery', sent: true,
      receipt: { status: 'accepted', messageId: 'checkpoint-result' } });
    assert.equal(database.getTicket(ticket.id).status, 'completed');
  }
  let version = 'v1', active = false;
  const service = createCheckpointService({ database, checkpoints, readPolicy: async () => ({ desktopVersion: version }), agents: { get: () => active ? {} : undefined } });
  return { database, checkpoints, service, ticket, run, file, assignment, ownership, revoke: () => { version = 'v2'; }, activate: () => { active = true; }, input: { ticketId: ticket.id, runId: run.id, ownerSessionId: 'owner' } };
}

test('authorized stopped execution restores through the real service and cannot resume', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.list(f.input)).length, 1);
  const preview = await f.service.preview(f.input);
  const result = await f.service.restore({ ...f.input, token: preview.token });
  assert.deepEqual(result.restored, ['a.txt']);
  assert.equal(result.ticket.status, 'closed');
  assert.equal(await readFile(f.file, 'utf8'), 'before');
  await assert.rejects(f.checkpoints.assertRunnable(f.run.id), { code: 'CHECKPOINT_RESTORED' });
});

test('checkpoint reads cannot cross session or ticket boundaries', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.list({ ...f.input, ownerSessionId: 'other' }), { code: 'CHECKPOINT_ACCESS' });
  await assert.rejects(f.service.preview({ ...f.input, runId: 'other-run' }), { code: 'CHECKPOINT_ACCESS' });
});

test('cancelled execution can restore only after its exact executor confirms release', async t => {
  const f = await fixture(t, { complete: false });
  f.database.cancelTicket(f.ticket.id);
  const preview = await f.service.preview(f.input);
  await assert.rejects(f.service.restore({ ...f.input, token: preview.token }), { code: 'CHECKPOINT_EXECUTION_ACTIVE' });
  assert.throws(() => f.database.confirmExecutionStopped(f.assignment.id, { ...f.ownership, fence: f.ownership.fence + 1 }), { code: 'FENCING_CONFLICT' });
  f.database.confirmExecutionStopped(f.assignment.id, f.ownership);
  assert.equal(f.database.runs(f.assignment.id)[0].state, 'cancelled');
  await f.service.restore({ ...f.input, token: preview.token });
  assert.equal(await readFile(f.file, 'utf8'), 'before');
});

for (const options of [{ complete: false }, { stopped: false }, { active: true }, { revoked: true }]) test(`restore requires stopped execution and current policy ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t, options), preview = await f.service.preview(f.input);
  if (options.active) f.activate();
  if (options.revoked) f.revoke();
  await assert.rejects(f.service.restore({ ...f.input, token: preview.token }), { code: options.revoked ? 'CHECKPOINT_POLICY_CHANGED' : 'CHECKPOINT_EXECUTION_ACTIVE' });
  assert.equal(await readFile(f.file, 'utf8'), 'after');
});

test('authority revoked while backup is being prepared prevents writes and blocks old-run continuation', async t => {
  const f = await fixture(t), plan = await f.service.preview(f.input);
  const original = f.checkpoints.restore;
  f.checkpoints.restore = (runId, options) => original(runId, { ...options, beforeWrite: async () => { f.revoke(); await options.beforeWrite(); } });
  await assert.rejects(f.service.restore({ ...f.input, token: plan.token }), { code: 'CHECKPOINT_POLICY_CHANGED' });
  assert.equal(await readFile(f.file, 'utf8'), 'after');
  await assert.rejects(f.checkpoints.assertRunnable(f.run.id), { code: 'CHECKPOINT_RESTORED' });
});
