import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createWorkerCheckpointStore } from '../src/worker-checkpoint-store.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-artifact-binding-'));
  const database = createAssistantOrchestrationStore({ directory: join(root, 'data') });
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const thread = { id: 'thread', source: { type: 'desktop', id: 'owner' } };
  const source = { channel: 'desktop', sessionId: 'owner', messageId: 'original' };
  const mandate = { actorId: 'owner', source, instruction: 'Produce an artifact' };
  const { trigger } = database.ingest({ dedupeKey: 'original', thread, source, actor: { kind: 'human', id: 'owner' }, content: mandate.instruction, mode: 'direct' });
  const ticket = database.createTicket({ threadId: trigger.threadId, target: mandate.instruction, mandate });
  database.createAssignment(ticket.id, {});
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const directory = join(root, 'original'), isolated = join(root, 'worktree');
  await mkdir(directory); await mkdir(isolated);
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = database.prepareRun(assignment.id, { ...ownership, sessionId: 'worker-session', directory });
  database.setRunEnvironment(run.id, { ...ownership, environment: { path: isolated, branch: 'branch', baseCommit: 'commit', repositoryRoot: directory } });
  database.applyTicketRevision(assignment.id, { ...ownership, runId: run.id, boundaryId: 'initial' });
  const warnings = [];
  const checkpoints = createWorkerCheckpointStore({ directory: join(root, 'checkpoints'),
    onObservation: input => database.recordExecutionArtifactObservation(input), onObservationError: metadata => warnings.push(metadata) });
  const freeze = (path = isolated) => ({ ticketId: ticket.id, assignmentId: assignment.id, runId: run.id, fence: assignment.fence,
    instructionRevision: database.appliedTicketSnapshot(assignment.id).instructionRevision, directory: path, callId: 'tool-call' });
  function revise() {
    const nextSource = { ...source, messageId: 'revision' }, instruction = 'Updated artifact requirements';
    const { trigger: revision } = database.ingest({ dedupeKey: 'revision', thread, source: nextSource, actor: { kind: 'human', id: 'owner' }, content: instruction, mode: 'direct' });
    database.changeTicket(ticket.id, { operation: 'revise', expectedInstructionRevision: 1, target: instruction, acceptance: '', reason: 'Owner updated the requirements',
      requestKey: 'revision', mandate: { ...mandate, source: nextSource, instruction }, triggerId: revision.id,
      model: { providerId: 'opaque', modelId: 'opaque' }, validateMandate: () => true });
    database.applyTicketRevision(assignment.id, { ...ownership, runId: run.id, boundaryId: 'updated' });
  }
  return { database, checkpoints, ticket, assignment, run, isolated, directory, warnings, freeze, revise };
}

test('real Run worktree binding publishes complete checkpoint evidence into the one execution journal', async t => {
  const f = await fixture(t), start = f.database.executionFactCursor();
  assert.equal(await f.checkpoints.protect(f.freeze(), async () => { await writeFile(join(f.isolated, 'artifact.txt'), 'created'); return 'official result'; }), 'official result');
  await f.checkpoints.protect(f.freeze(), async () => {});
  const evidence = f.database.executionEvidence({ ticketId: f.ticket.id, runId: f.run.id, instructionRevision: 1, after: start });
  assert.equal(evidence.entries.length, 2); assert.equal(evidence.entries.every(row => row.kind === 'artifact-observation'), true);
  assert.equal(evidence.entries[0].data.comparison.added, 1); assert.equal(evidence.entries[1].data.comparison.netChanged, false);
  assert.equal(evidence.entries[1].data.comparison.unchanged, 1);
  assert.equal(f.checkpoints.observationCoverage(f.run.id).complete, true);
  assert.doesNotMatch(JSON.stringify(evidence), /artifact\.txt|worktree|directory|"hash"|"blob"/);
  assert.deepEqual(f.warnings, []);
  assert.equal(f.database.runs(f.assignment.id)[0].state, 'prepared', 'observations do not advance execution lifecycle');
});

test('a tool frozen before an applied revision change leaves an observation gap without replay or revision relabelling', async t => {
  const f = await fixture(t), identity = f.freeze(); let dispatches = 0;
  const result = await f.checkpoints.protect(identity, async () => { dispatches++; f.revise(); await writeFile(join(f.isolated, 'artifact.txt'), 'created'); return 'completed tool'; });
  assert.equal(result, 'completed tool'); assert.equal(dispatches, 1);
  assert.equal(f.database.executionEvidence({ ticketId: f.ticket.id }).entries.filter(row => row.kind === 'artifact-observation').length, 0);
  const [checkpoint] = await f.checkpoints.list({ runId: f.run.id });
  assert.equal(checkpoint.instructionRevision, 1); assert.equal(checkpoint.state, 'complete'); assert.equal(checkpoint.observationState, 'failed');
  assert.equal(f.checkpoints.observationCoverage(f.run.id).complete, false); assert.equal(f.warnings.length, 1);
  await f.checkpoints.protect(f.freeze(), async () => {});
  const facts = f.database.executionEvidence({ ticketId: f.ticket.id }).entries.filter(row => row.kind === 'artifact-observation');
  assert.equal(facts.length, 1); assert.equal(facts[0].instructionRevision, 2); assert.equal(facts[0].data.sequence, 1);
  assert.equal(f.checkpoints.observationCoverage(f.run.id).complete, false, 'the earlier missing fact remains an explicit gap');
});

test('the original pre-worktree directory cannot masquerade as the persisted execution workspace', async t => {
  const f = await fixture(t);
  await f.checkpoints.protect(f.freeze(f.directory), async () => {});
  assert.equal(f.warnings.length, 1); assert.equal(f.checkpoints.observationCoverage(f.run.id).complete, false);
  assert.equal(f.database.executionEvidence({ ticketId: f.ticket.id }).entries.some(row => row.kind === 'artifact-observation'), false);
});
