import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { observeSession } from '../superagent-p0-20261105/observe-session.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rowsFor = (history, ticketId) => (history?.notifications || []).filter(row => (row.taskId || row.ticketId) === ticketId);
const identity = ticket => ({ ticketId: ticket.id, instructionRevision: ticket.instructionRevision,
  assignmentIds: ticket.assignments.map(row => row.id), resultVersion: ticket.resultVersion });
const readRuns = (directory, ticketId) => {
  const db = new DatabaseSync(join(directory, 'user/.benchgo/assistant/assistant.db'), { readOnly: true });
  try {
    return db.prepare('SELECT r.id,r.assignment_id,r.state,r.fence,r.payload FROM sa_runs r JOIN sa_assignments a ON a.id=r.assignment_id WHERE a.ticket_id=? ORDER BY r.created_at').all(ticketId)
      .map(row => { const payload = JSON.parse(row.payload); return { id: row.id, assignmentId: row.assignment_id, state: row.state, fence: row.fence, sessionId: payload.sessionId }; });
  } finally { db.close(); }
};
const definitions = {
  'attention-1': { title: '阻塞问答一', attention: true, nonblocking: false, choice: '列表' },
  'attention-2': { title: '非阻塞问答', attention: true, nonblocking: true, choice: '短句' },
  'attention-3': { title: '阻塞问答二', attention: true, nonblocking: false, choice: '短句' },
  'pause-resume': { title: '首轮暂停恢复', pause: true },
  adjustment: { title: '交付后关联调整', adjustment: true },
};
function taskFor(definition, fixture) {
  const base = `请派一个 Worker 读取本地文档 ${fixture}，只根据文档在本聊天交付三条事实：Alpha、Beta和总计。使用简体中文，完整保留三项数字；无需联网，无需创建或修改任何文件。请将这些完整条件写入同一工单任务书，不增加阶段、数量或交付物。`;
  if (!definition.attention) return base;
  return `${base}\n本任务还包含一次明确的协作路径验证，请先开单，由 Worker 读取文档后通过正式 ask_user_question 分别提出两个问题：\nQ-known：“交付语言使用简体中文还是英文？”——我已在本请求授权简体中文，总助手可根据原请求答复，无需再次问我。\nQ-user：“最终展示采用列表还是短句？”——请给出“列表”和“短句”两个选项。\n${definition.nonblocking ? 'Q-user是非阻塞的展示偏好：若需选择格式，你可自行决定，采用默认列表。我没有明确选择，但已授权以列表为稳妥默认继续并完成交付，不需要等待我的答复。不得把稳妥默认说成用户已经回答。' : 'Q-user是阻塞最终排版的选择：我尚未选择，请先完成独立的三条事实读取，再把这个问题回传本聊天，我会按问题编号答复；不能替我选展示方式。收到真实答案后，用我的展示方式完成三条事实交付。'}\n全过程保持原工单和原执行会话。不要在开单前由总助手询问，也不要把待回答说明作为最终完成。`;
}

export async function runCase({ call, report, save, output, redact, selectedCase, directory, fixture }) {
  const definition = definitions[selectedCase], started = Date.now();
  const scenario = { id: selectedCase, ...definition, status: 'running', startedAt: new Date().toISOString(), timeline: [], userActions: [] };
  report.scenarios.push(scenario);
  let ticket, history, thread, router, lastFingerprint, answered = false, paused = false, resumed = false, pauseBefore;
  const persist = async () => {
    scenario.latest = ticket && { ...identity(ticket), status: ticket.status, reviews: ticket.results?.map(row => ({ version: row.version, runId: row.runId,
      sessionId: row.sessionId, verdict: row.review?.verdict, reason: row.review?.reason, diagnostic: row.review?.diagnostic, routing: row.review?.routing, deliveryOrigin: row.delivery?.origin })) };
    await writeFile(join(output, 'progress.json'), redact(JSON.stringify({ scenario, ticket, history }, null, 2))); await save();
  };
  try {
    thread = await call({ action: 'createThread', title: `晚间验收：${definition.title}` });
    router = await call({ action: 'ensure', threadId: thread.id });
    scenario.threadId = thread.id; scenario.routerSessionId = router.sessionId;
    scenario.originalInstruction = taskFor(definition, fixture);
    await call({ action: 'send', threadId: thread.id, requestId: `EVENING_${selectedCase}_${randomUUID()}`, text: scenario.originalInstruction });
    let deadline = Date.now() + (definition.pause ? 1800000 : 720000);
    for (; Date.now() < deadline;) {
      const [tickets, currentHistory] = await Promise.all([call({ action: 'tickets' }), call({ action: 'history', threadId: thread.id })]);
      history = currentHistory;
      const matches = tickets.tickets.filter(row => row.mandate?.source?.sessionId === router.sessionId && row.mandate?.source?.threadId === thread.id);
      assert.ok(matches.length <= 1, 'Original task created more than one Ticket');
      ticket = matches[0];
      const fingerprint = digest([history.running, history.error, ticket?.status, ticket?.resultVersion, ticket?.assignments?.map(row => [row.id, row.state, row.fence]), ticket?.attentions, ticket?.attentionResolutions, ticket?.deliveries?.map(row => [row.id, row.state])]);
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        scenario.timeline.push({ at: new Date().toISOString(), routerRunning: history.running, ticketId: ticket?.id, status: ticket?.status,
          resultVersion: ticket?.resultVersion, assignments: ticket?.assignments?.map(row => ({ id: row.id, state: row.state, fence: row.fence })),
          attentions: ticket?.attentions, attentionResolutions: ticket?.attentionResolutions });
        await persist();
        console.log(JSON.stringify({ case: selectedCase, elapsedSeconds: Math.round((Date.now() - started) / 1000), status: ticket?.status, resultVersion: ticket?.resultVersion, attentionCount: ticket?.attentions?.length }));
      }
      if (history.error && !history.running && !ticket) throw new Error(`Router failed before admission: ${JSON.stringify(history.error)}`);
      if (definition.pause && ticket && !paused && ticket.assignments.some(row => row.state === 'claimed')) {
        const frames = (await readFile(join(output, 'stream-frames.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        const workerStarted = frames.find(row => row.role === 'worker' && row.type === 'start');
        if (workerStarted) {
          assert.equal(ticket.resultVersion, 0, 'Pause trigger occurred after a Result existed');
          const runs = readRuns(directory, ticket.id);
          assert.equal(runs.length, 1, 'Pause trigger must target one original Run');
          pauseBefore = { ...identity(ticket), run: runs[0], workerStarted };
          scenario.pauseBefore = pauseBefore;
          scenario.userActions.push({ at: new Date().toISOString(), actor: 'isolated-test-user', action: 'ticketPause', ticketId: ticket.id, reason: 'Controlled pause on first real Worker stream, before any Result.' });
          scenario.pauseReceipt = await call({ action: 'ticketPause', ticketId: ticket.id }); paused = true;
          await persist();
        }
      }
      if (definition.pause && paused && !resumed && ticket.status === 'paused') {
        assert.equal(ticket.resultVersion, 0, 'Paused checkpoint already has a Result');
        pauseBefore.transcript = await observeSession(directory, pauseBefore.run.sessionId);
        scenario.userActions.push({ at: new Date().toISOString(), actor: 'isolated-test-user', action: 'ticketResume', ticketId: ticket.id });
        scenario.resumeReceipt = await call({ action: 'ticketResume', ticketId: ticket.id }); resumed = true;
        deadline = Date.now() + 1800000; await persist();
      }
      if (definition.attention && ticket && !answered) {
        const waiting = ticket.attentions.filter(row => row.state === 'waiting');
        assert.ok(!waiting.some(row => /Q-known|简体中文.*英文|英文.*简体中文/u.test(row.question?.question || '')), 'Router escalated an already authorized known answer');
        const attention = waiting.find(row => /Q-user|列表|短句/u.test(row.question?.question || ''));
        const notification = attention && rowsFor(history, ticket.id).find(row => row.attentionId === attention.id);
        if (definition.nonblocking && attention) throw new Error('Nonblocking authorized default was escalated instead of continuing');
        if (attention && notification) {
          scenario.beforeAnswer = { ...identity(ticket), attention, notification, runs: readRuns(directory, ticket.id) };
          const label = attention.question.options?.find(row => row.label.includes(definition.choice))?.label;
          const answer = label ? { selected: [label] } : { selected: [], custom: `问题编号 ${attention.id}：我选择${definition.choice}。请在原工单和原会话继续交付。` };
          scenario.userActions.push({ at: new Date().toISOString(), actor: 'isolated-test-user', action: 'ticketAnswer', ticketId: ticket.id, attentionId: attention.id, answer });
          scenario.answerReceipt = await call({ action: 'ticketAnswer', ticketId: ticket.id, attentionId: attention.id, instructionRevision: ticket.instructionRevision,
            resultVersion: ticket.resultVersion, requestId: `EVENING_ANSWER_${randomUUID()}`, answer });
          answered = true; await persist();
        }
      }
      const final = ticket?.results?.at(-1);
      if (ticket?.status === 'completed' && final?.review?.verdict === 'passed' && ticket.deliveries.some(row => row.state === 'sent' && row.payload?.resultVersion === ticket.resultVersion && row.payload?.publication?.action === 'deliver')
        && rowsFor(history, ticket.id).some(row => row.resultVersion === ticket.resultVersion && row.type === 'ticket.result')) break;
      if (ticket && ['failed', 'cancelled', 'closed'].includes(ticket.status)) throw new Error(`Terminal before completion: ${ticket.status}`);
      await delay(750);
    }
    assert.ok(ticket, 'No Ticket admitted in the observation window');
    assert.equal(ticket.status, 'completed', `Live deadline expired; ticket remains ${ticket.status}`);
    assert.equal(ticket.mandate.instruction, scenario.originalInstruction, 'Complete original user instruction was not retained');
    const final = ticket.results.at(-1), delivery = final.delivery?.text || '';
    assert.equal(final.review.verdict, 'passed');
    for (const pattern of [/Alpha[^\d]*7/iu, /Beta[^\d]*11/iu, /(?:总计|合计|总共)[^\d]*18/u]) assert.match(delivery, pattern, 'Reviewed final delivery omitted a fixture fact');
    assert.equal(final.checkpoint?.files, 0, 'Text-only task created deliverable files');
    const failures = ticket.results.flatMap(row => row.review?.routing?.attempts || []).filter(row => ['TIMEOUT', 'AUXILIARY_QUALITY', 'REVIEW_UNAVAILABLE'].includes(row.code));
    assert.equal(failures.length, 0, 'Review had timeout/quality/unavailable attempts');
    assert.ok(!ticket.results.some(row => ['TIMEOUT', 'AUXILIARY_QUALITY', 'REVIEW_UNAVAILABLE'].includes(row.review?.diagnostic?.code)), 'Review entered an internal failure wait');
    if (definition.attention) {
      if (definition.nonblocking) {
        assert.equal(answered, false, 'Nonblocking default must not be represented as a human answer');
        assert.equal(ticket.attentions.length, 0, 'Nonblocking authorized default created a user Attention');
      } else {
        assert.ok(answered, 'No genuine user Q-user Attention was delivered and answered');
        assert.deepEqual(identity(ticket).assignmentIds, scenario.beforeAnswer.assignmentIds, 'Answer replaced Assignment');
        assert.equal(ticket.instructionRevision, scenario.beforeAnswer.instructionRevision);
        assert.equal(final.sessionId, scenario.beforeAnswer.attention.sessionId, 'Answer replaced Worker session');
        assert.equal(final.runId, scenario.beforeAnswer.runs[0]?.id, 'Answer replaced original Run');
        assert.equal(ticket.attentions.filter(row => row.state === 'answered').length, 1, 'Expected exactly one real user answer');
      }
      scenario.triageEvidence = ticket.attentionResolutions || [];
      assert.ok(scenario.triageEvidence.length, 'No persisted Router triage evidence observed; Worker-only chain is insufficient');
      const routeOf = row => row.resolution?.route || row.route;
      const self = scenario.triageEvidence.find(row => routeOf(row) === 'self');
      const decision = scenario.triageEvidence.find(row => routeOf(row) === (definition.nonblocking ? 'default' : 'user'));
      assert.ok(self, 'Known language question was not answered by Router');
      assert.ok(decision, `No Router ${definition.nonblocking ? 'default' : 'user'} decision observed`);
      assert.equal(self.sessionId, final.sessionId); assert.equal(decision.sessionId, final.sessionId);
      if (definition.nonblocking) {
        const resolution = decision.resolution || decision;
        assert.equal(resolution.nonBlocking, true, 'Default resolution lacks nonblocking authorization');
        assert.ok(resolution.authorization, 'Default resolution lacks explicit owner authorization');
      }
    }
    if (definition.pause) {
      assert.ok(paused && resumed, 'No controlled first-result pause/resume observed');
      assert.deepEqual(identity(ticket).assignmentIds, pauseBefore.assignmentIds);
      assert.equal(final.runId, pauseBefore.run.id); assert.equal(final.sessionId, pauseBefore.run.sessionId);
      scenario.pauseAfter = await observeSession(directory, final.sessionId, { prefixEvents: pauseBefore.transcript.eventCount });
      assert.equal(scenario.pauseAfter.prefixHash, pauseBefore.transcript.transcriptHash, 'Continuation changed the persisted original transcript prefix');
    }
    const finalNotification = rowsFor(history, ticket.id).find(row => row.resultVersion === ticket.resultVersion && row.type === 'ticket.result');
    assert.equal(finalNotification.threadId, thread.id);
    assert.equal(rowsFor(await call({ action: 'history', threadId: 'main' }), ticket.id).length, 0, 'Result delivered to unrelated conversation');
    scenario.final = { ticket, history, finalNotification, runs: readRuns(directory, ticket.id) };
    scenario.assertions = { realReviewPassed: true, completeFixtureFacts: true, textOnly: true, originalChatDelivered: true, noOtherChatDelivery: true,
      singleAssignment: ticket.assignments.length === 1, finalRunId: final.runId, finalSessionId: final.sessionId, finalDeliveryOrigin: final.delivery?.origin };
    if (definition.adjustment) await runAdjustment({ call, scenario, ticket, thread, output, redact, directory });
    const requests = (await readFile(join(output, 'supplier-requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === 'request');
    assert.ok(requests.length, 'No actual supplier stream request observation');
    const expectedRoutes = [...report.isolatedConfig.models, ...report.isolatedConfig.workerModels, report.isolatedConfig.auxiliary].filter(Boolean);
    assert.ok(requests.every(request => request.stream === true && expectedRoutes.some(route => route.providerId === request.providerId && route.modelId === request.modelId)), 'Actual request changed configured exact provider/model');
    scenario.assertions.actualStreamingRequests = requests.length;
    scenario.assertions.actualModels = [...new Set(requests.map(row => `${row.providerId}/${row.modelId}`))];
    scenario.status = 'pass';
  } catch (error) {
    scenario.status = 'fail'; scenario.error = redact(error.stack || error.message); scenario.final ||= { ticket, history };
  } finally {
    scenario.finishedAt = new Date().toISOString(); scenario.elapsedMs = Date.now() - started;
    await writeFile(join(output, 'evidence.json'), redact(JSON.stringify(scenario, null, 2)));
    if (ticket?.results?.length) await writeFile(join(output, 'final.md'), redact(ticket.results.at(-1).delivery?.text || ''));
    await save();
  }
}

async function runAdjustment({ call, scenario, ticket, thread, output, redact, directory }) {
  const before = { id: ticket.id, status: ticket.status, resultVersion: ticket.resultVersion, instructionRevision: ticket.instructionRevision,
    updatedAt: ticket.updatedAt, resultHash: digest(ticket.results) };
  const input = { action: 'ticketChange', operation: 'reopen', id: ticket.id, threadId: thread.id,
    expectedInstructionRevision: ticket.instructionRevision, requestId: `EVENING_ADJUST_${randomUUID()}`,
    reason: '已交付事实保持不变，追加总计单独一句。', target: '在原结果的 Alpha=7、Beta=11、合计18 三条准确事实之后，单独增加一句“总计为18件。”，直接在原聊天交付简体中文文本，不创建文件。',
    acceptance: '完整保留 Alpha=7、Beta=11、合计18，另有独立一句“总计为18件。”；文本直接回原聊天。' };
  scenario.userActions.push({ at: new Date().toISOString(), actor: 'isolated-test-user', ...input });
  const created = await call(input), adjustmentId = created.id;
  assert.ok(adjustmentId && adjustmentId !== ticket.id, 'Completed ticket was not replaced by a distinct adjustment ticket');
  assert.equal(created.adjustmentOfTicketId, ticket.id); assert.equal(created.instructionRevision, 1);
  let adjustment, history;
  for (const deadline = Date.now() + 720000; Date.now() < deadline;) {
    const [tickets, currentHistory] = await Promise.all([call({ action: 'tickets' }), call({ action: 'history', threadId: thread.id })]);
    const original = tickets.tickets.find(row => row.id === ticket.id);
    assert.deepEqual({ id: original.id, status: original.status, resultVersion: original.resultVersion, instructionRevision: original.instructionRevision,
      updatedAt: original.updatedAt, resultHash: digest(original.results) }, before, 'Completed parent ticket/result changed');
    adjustment = tickets.tickets.find(row => row.id === adjustmentId); history = currentHistory;
    if (adjustment?.status === 'completed' && adjustment.results.at(-1)?.review?.verdict === 'passed'
      && rowsFor(history, adjustmentId).some(row => row.resultVersion === adjustment.resultVersion && row.type === 'ticket.result')) break;
    if (adjustment && ['failed', 'cancelled', 'closed'].includes(adjustment.status)) throw new Error(`Adjustment became ${adjustment.status}`);
    await delay(1000);
  }
  assert.equal(adjustment?.status, 'completed', 'Adjustment did not complete');
  assert.match(adjustment.results.at(-1).delivery?.text || '', /总计为\s*18\s*件/u);
  scenario.adjustment = { before, input, receipt: created, final: adjustment, history, runs: readRuns(directory, adjustmentId) };
  await writeFile(join(output, 'adjustment-evidence.json'), redact(JSON.stringify(scenario.adjustment, null, 2)));
}
