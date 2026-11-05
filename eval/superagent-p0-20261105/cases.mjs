import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { observeSession } from './observe-session.mjs';

const baseTask = `请调研2026年11月4日的新闻热点，整理一份简明中文摘要交给用户。这里是明确的历史日期2026-11-04，不是执行当天。
要求：
1. 通过联网搜索/浏览实际抓取该日最新报道，注明信息来源与报道时间，不要凭记忆编造。
2. 覆盖国内外政治经济、科技（尤其AI）、社会民生等主要领域的6–10条热点，每条1–2句话说明事件与影响。本次选择非生命科学领域新闻。
3. 区分“已验证有多个可靠来源”与“单一来源/待确认”，转载同一报道不当成独立来源。
4. 最后给出整体概览，用一句话总结当天的大势。
5. 若某些渠道无法访问，如实说明缺失部分，不要补写。
6. 直接在本次聊天中交付中文文本摘要即可，无需创建实际产物文件。热点用1.起的连续阿拉伯数字编号，来源写在对应条目中。
请自主派工，并在开单时把上述数目、日期、来源、标注和文本交付条件写进工单任务书的验收条件。`;

const definitions = [
  { id: 'no-files', marker: 'P0_NO_FILES', title: '无文件文本摘要真实交付', condition: '无故障注入；请求只要求文本结果。Worker首轮工作指导：6条满足即可，已有足够可支持事实就整理，访问失败如实说明；不改原验收。' },
  { id: 'fourteen', marker: 'P0_FOURTEEN', title: '首轮14条由真实验收触发原会话纠正', condition: '隔离插件只在Worker首轮追加明确测试条件：首轮故意生成14条；Mandate始终要求6–10条。' },
  { id: 'router-block', marker: 'P0_ROUTER_BLOCK', title: 'Router review问题回答后原单继续', condition: '原始请求保留真实测试用户的阅读重点选择；Worker先给候选并留下该问题，由真实review判断是否ask。', blocking: 'review' },
  { id: 'worker-block', marker: 'P0_WORKER_BLOCK', title: 'Worker原生问题回答后原单继续', condition: '原始请求保留真实测试用户的阅读重点选择；隔离Worker首轮要求用已注册的原生问答工具发问。', blocking: 'worker' },
];

export function itemGroups(text = '') {
  const numbers = [...text.matchAll(/^\s*(?:#{1,6}\s*)?(?:\*\*)?(\d{1,2})[.、．)）](?:\*\*)?\s*\S/gmu)].map(match => Number(match[1]));
  const groups = [];
  for (const number of numbers) {
    if (number === 1) groups.push([1]);
    else if (groups.at(-1)?.at(-1) === number - 1) groups.at(-1).push(number);
  }
  return groups.map(group => group.length);
}
const digestCount = text => itemGroups(text).filter(count => count >= 6).at(-1) || 0;
const countConstraint = /6\s*[–—\-~～至到]\s*10|六\s*(?:[–—\-~～至到])\s*十/u;
const rowsFor = (history, ticketId) => (history.notifications || []).filter(row => (row.taskId || row.ticketId) === ticketId);
const projectResult = result => ({ version: result.version, runId: result.runId, sessionId: result.sessionId, instructionRevision: result.instructionRevision,
  review: result.review, summary: result.summary, finalSummary: result.finalSummary, delivery: result.delivery, checkpoint: result.checkpoint, evidenceRefs: result.evidenceRefs,
  transcript: result.transcript, toolEvidence: result.toolEvidence, itemGroups: itemGroups(result.summary) });

export async function runCases({ call, report, save, output, redact, deadlineMs, selectedCases, directory }) {
  const executions = [];
  if (selectedCases === 'router-stream' || selectedCases === 'all') {
    const scenario = { id: 'router-stream', title: '普通Router文字经官方实时事件流输出', status: 'running', startedAt: new Date().toISOString() };
    report.scenarios.push(scenario);
    try {
      const thread = await call({ action: 'createThread', title: 'P0真实Router流式验证' });
      const ensured = await call({ action: 'ensure', threadId: thread.id });
      scenario.threadId = thread.id; scenario.sessionId = ensured.sessionId;
      await call({ action: 'send', threadId: thread.id, requestId: `P0_STREAM_${randomUUID()}`, text: '请用约250字连续中文解释“为什么任务验收需要具体目标和证据”。这是纯聊天解释题，不需要联网、调查、派工或任何工具，直接用普通文字回答即可。' });
      let history;
      for (const deadline = Date.now() + Math.min(deadlineMs, 180000); Date.now() < deadline;) {
        history = await call({ action: 'history', threadId: thread.id });
        if (!history.running && history.messages?.some(row => row.role === 'assistant')) break;
        if (!history.running && history.error) throw new Error(JSON.stringify(history.error));
        await delay(200);
      }
      await delay(200);
      const frames = (await readFile(join(output, 'router-stream-frames.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.sessionId === ensured.sessionId);
      const attempts = [...new Set(frames.map(row => row.attemptId))].map(attemptId => {
        const current = frames.filter(row => row.attemptId === attemptId);
        const text = current.filter(row => row.type === 'chunk' && row.chunkType === 'text-delta' && row.publicTextLength > 0);
        const growth = text.filter((row, index) => !index || row.publicTextLength > text[index - 1].publicTextLength);
        return { attemptId, start: current.find(row => row.type === 'start'), end: current.find(row => row.type === 'end'), growth };
      });
      const visible = attempts.find(item => item.start && item.end?.outcome?.kind === 'committed' && item.growth.length >= 2 && item.growth[0].observedAt < item.end.observedAt);
      assert.ok(visible, 'No official live text stream with two growing partials before committed end was observed');
      assert.ok(history?.messages?.some(row => row.role === 'assistant' && row.kind === 'final'), 'No durably published final reply');
      assert.equal((await call({ action: 'tickets' })).tickets.filter(row => row.mandate?.source?.sessionId === ensured.sessionId).length, 0, 'Ordinary chat created a Ticket');
      scenario.assertions = { officialStreamEvent: true, increasingPartials: visible.growth.length, firstTextAt: visible.growth[0].observedAt, committedEndAt: visible.end.observedAt, finalChars: visible.end.publicTextLength, ordinaryChatCreatedNoTicket: true };
      scenario.attempts = attempts; scenario.history = history; scenario.status = 'pass';
    } catch (error) { scenario.status = 'fail'; scenario.error = redact(error.stack || error.message); }
    scenario.finishedAt = new Date().toISOString();
    await writeFile(join(output, 'router-stream-evidence.json'), redact(JSON.stringify(scenario, null, 2)));
    await save();
    if (selectedCases === 'router-stream' || scenario.status !== 'pass') return;
  }
  for (const definition of definitions.filter(item => selectedCases === 'all' || item.id === selectedCases)) {
    const scenario = { ...definition, startedAt: new Date().toISOString(), status: 'running', timeline: [] };
    report.scenarios.push(scenario);
    const prefix = `${definition.marker}_${randomUUID()}`;
    let ticket, history, lastFingerprint = '', answered = false, beforeAnswer, budgetResume;
    try {
      await writeFile(join(output, 'active-case.json'), JSON.stringify({ caseId: definition.id, marker: definition.marker, at: new Date().toISOString() }));
      const thread = await call({ action: 'createThread', title: `P0真实验收：${definition.id}` });
      scenario.threadId = thread.id;
      const router = await call({ action: 'ensure', threadId: thread.id });
      scenario.routerSessionId = router.sessionId;
      const blocking = definition.blocking ? '\n本次最终摘要需根据我的阅读重点取舍：AI科技优先或宏观经济优先。我尚未作出选择，不能替我默认。请先开原工单调查候选事实，候选调查后再向我问这个选择；我回答后在原工单继续并交付最终6–10条。不要在开单前问，也不要将未定稿当成最终交付。' : '';
      scenario.originalInstruction = `${baseTask}${blocking}\n隔离运行编号：${prefix}。派工时在任务目标正文保留此编号便于关联；编号不改变验收条件。`;
      await call({ action: 'send', threadId: thread.id, text: scenario.originalInstruction, requestId: prefix });
      await save();
      let ticketId;
      for (const deadline = Date.now() + deadlineMs; Date.now() < deadline;) {
        const [tickets, currentHistory] = await Promise.all([call({ action: 'tickets' }), call({ action: 'history', threadId: thread.id })]);
        history = currentHistory;
        const matches = tickets.tickets.filter(row => row.mandate?.source?.sessionId === router.sessionId && row.mandate?.source?.threadId === thread.id);
        assert.ok(matches.length <= 1, 'Same original request created multiple Tickets');
        if (matches.length) { ticket = matches[0]; ticketId = ticket.id; }
        const fingerprint = JSON.stringify([history.running, history.error, ticket?.status, ticket?.resultVersion, ticket?.assignments?.map(row => [row.id, row.state, row.fence]), ticket?.attentions?.map(row => [row.id, row.origin, row.state]), ticket?.deliveries?.map(row => [row.id, row.state])]);
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          scenario.timeline.push({ at: new Date().toISOString(), routerRunning: history.running, ticketId, ticketStatus: ticket?.status, resultVersion: ticket?.resultVersion,
            assignments: ticket?.assignments?.map(row => ({ id: row.id, state: row.state, fence: row.fence })),
            attentions: ticket?.attentions?.map(row => ({ id: row.id, origin: row.origin, state: row.state, runId: row.runId, sessionId: row.sessionId })),
            deliveries: ticket?.deliveries?.map(row => ({ id: row.id, state: row.state, resultVersion: row.payload?.resultVersion })) });
          scenario.ticketId = ticketId;
          scenario.latest = ticket && { status: ticket.status, resultVersion: ticket.resultVersion, results: ticket.results?.map(projectResult), attentions: ticket.attentions };
          await writeFile(join(output, `${definition.id}-progress.json`), redact(JSON.stringify({ scenario, history }, null, 2)));
          await save();
          console.log(JSON.stringify({ at: new Date().toISOString(), case: definition.id, ticketStatus: ticket?.status, resultVersion: ticket?.resultVersion, attentions: ticket?.attentions?.map(row => ({ origin: row.origin, state: row.state })) }));
        }
        if (history.error && !history.running && !ticket) throw new Error(`Router failed before admission: ${JSON.stringify(history.error)}`);
        if (!budgetResume && ticket?.status === 'waiting' && ticket.continuationWait?.code === 'EXECUTION_BUDGET_EXHAUSTED') {
          const budgetNotification = rowsFor(history, ticket.id).find(row => row.publication?.systemState?.code === 'EXECUTION_BUDGET_EXHAUSTED' || row.systemState?.code === 'EXECUTION_BUDGET_EXHAUSTED');
          if (budgetNotification) {
            const wait = ticket.continuationWait;
            assert.ok(wait.runId && wait.sessionId && wait.assignmentId, 'Budget wait did not preserve original execution identity');
            const before = await observeSession(directory, wait.sessionId);
            budgetResume = scenario.budgetResume = { at: new Date().toISOString(), actor: 'isolated-test-user', explicitAction: '增加10分钟并继续', additionalExecutionMs: 600000,
              expectedResultVersion: ticket.resultVersion, wait, before, budgetNotification };
            // Parent-authorized isolated user action. Exactly once; does not change Goal quotas or other gates.
            budgetResume.receipt = await call({ action: 'ticketResume', ticketId: ticket.id, expectedResultVersion: ticket.resultVersion, additionalExecutionMs: 600000 });
            assert.equal(budgetResume.receipt.queued, true, 'Explicit isolated user budget action was not safely queued');
            await save();
          }
        }
        if (ticket && definition.blocking && !answered) {
          const attention = ticket.attentions.find(row => row.origin === definition.blocking && row.state === 'waiting');
          if (attention) {
            const deliveredQuestion = rowsFor(history, ticket.id).find(row => row.attentionId === attention.id);
            if (deliveredQuestion) {
              beforeAnswer = { ticketId: ticket.id, instructionRevision: ticket.instructionRevision, resultVersion: ticket.resultVersion,
                assignments: ticket.assignments.map(row => row.id), results: ticket.results.map(projectResult), attention, deliveredQuestion };
              scenario.beforeAnswer = beforeAnswer;
              // This is the real isolated test user's decision, not inferred from a page or fabricated receipt.
              const answer = { selected: [], custom: '本次测试用户选择：AI科技优先。请保留政治经济和社会民生的必要覆盖，最终总数仍为6–10条；在原工单与已有会话继续，直接交付到原聊天，不要新建工单。' };
              scenario.answer = { at: new Date().toISOString(), attentionId: attention.id, instructionRevision: ticket.instructionRevision, answer };
              scenario.answerReceipt = await call({ action: 'ticketAnswer', ticketId: ticket.id, attentionId: attention.id, instructionRevision: ticket.instructionRevision, resultVersion: ticket.resultVersion, requestId: `${prefix}_answer`, answer });
              answered = true;
              await save();
            }
          }
        }
        const passed = ticket?.results?.at(-1)?.review?.verdict === 'passed';
        const sent = ticket?.deliveries?.some(row => row.state === 'sent' && row.payload?.resultVersion === ticket.resultVersion && row.payload?.publication?.action === 'deliver');
        if (ticket?.status === 'completed' && passed && sent && rowsFor(history, ticket.id).some(row => row.resultVersion === ticket.resultVersion && row.type === 'ticket.result')) break;
        if (ticket && ['failed', 'cancelled', 'closed'].includes(ticket.status)) throw new Error(`Ticket became terminal before completion: ${ticket.status}`);
        await delay(1500);
      }
      assert.ok(ticket, 'Router did not admit a Ticket within the live deadline');
      scenario.ticketId = ticket.id;
      assert.equal(ticket.status, 'completed', `Live deadline expired; ticket remains ${ticket.status}`);
      assert.equal(ticket.results.at(-1).review?.verdict, 'passed', 'Latest real review did not pass');
      assert.ok(typeof ticket.title === 'string' && ticket.title.trim() && [...ticket.title].length <= 10, 'AI Ticket title must contain at most 10 Unicode characters');
      assert.notEqual(ticket.target, ticket.title, 'Task target was replaced by the short title');
      assert.match((ticket.target || '').replace(/\s+/gu, ''), /2026(?:年|[-/.])11(?:月|[-/.])0?4/u, 'Task target omitted the requested news date');
      assert.match(ticket.target || '', countConstraint, 'Task target omitted the requested item count');
      assert.match(ticket.target || '', /新闻|news/iu, 'Task target omitted the news research objective');
      assert.equal(ticket.mandate?.instruction, scenario.originalInstruction, 'Original complete owner instruction was not retained in Mandate');
      assert.match(ticket.acceptance || ticket.mandate?.acceptance || '', countConstraint, 'Admission omitted the numerical acceptance condition');
      const final = ticket.results.at(-1);
      if (budgetResume) {
        assert.equal(final.runId, budgetResume.wait.runId, 'Budget continuation replaced original Run');
        assert.equal(final.sessionId, budgetResume.wait.sessionId, 'Budget continuation replaced original Worker session');
        const after = await observeSession(directory, final.sessionId, { prefixEvents: budgetResume.before.eventCount });
        assert.equal(after.prefixHash, budgetResume.before.transcriptHash, 'Budget continuation changed the saved official transcript prefix');
        assert.ok((after.counts['tool/result'] || 0) >= (budgetResume.before.counts['tool/result'] || 0), 'Budget continuation lost existing tool results');
        budgetResume.after = after;
      }
      const count = digestCount(final.delivery?.text || '');
      assert.ok(count >= 6 && count <= 10, `Final reviewed delivery has ${count} countable numbered items`);
      assert.ok(ticket.results.some(result => result.toolEvidence?.entries?.some(entry => !entry.isError && /https?:\/\//u.test(`${entry.arguments}\n${entry.text}`))), 'No successful actual network tool evidence observed');
      if (definition.id === 'no-files') assert.equal(final.checkpoint?.files, 0, 'Text-only scenario produced files, so zero-file acceptance is not demonstrated');
      if (definition.id === 'fourteen') {
        const initial = ticket.results.find(result => itemGroups(result.finalSummary || result.summary).includes(14));
        assert.ok(initial, 'Controlled first Worker result did not contain 14 numbered items');
        assert.ok(['rework', 'failed'].includes(initial.review?.verdict), 'Real review did not reject the 14-item submission');
        assert.ok(ticket.results.length >= 2, 'No genuine corrected result was recorded');
        assert.equal(final.runId, initial.runId, 'Correction replaced the original Run');
        assert.equal(final.sessionId, initial.sessionId, 'Correction replaced the original Worker session');
        assert.equal(new Set(ticket.assignments.map(row => row.id)).size, 1, 'Correction created a replacement Assignment');
        scenario.correction = { firstVersion: initial.version, initialItemGroups: itemGroups(initial.finalSummary || initial.summary), firstVerdict: initial.review.verdict, finalVersion: final.version, finalCount: count, runId: final.runId, sessionId: final.sessionId };
      }
      if (definition.blocking) {
        assert.ok(answered && beforeAnswer, `No real ${definition.blocking} Attention was delivered and answered`);
        assert.equal(ticket.id, beforeAnswer.ticketId, 'Answer created a replacement Ticket');
        assert.equal(ticket.instructionRevision, beforeAnswer.instructionRevision, 'Answer changed the original Mandate revision');
        assert.deepEqual(ticket.assignments.map(row => row.id), beforeAnswer.assignments, 'Answer created a replacement Assignment');
        assert.equal(final.sessionId, beforeAnswer.attention.sessionId, 'Answer resumed a different Worker session');
        if (beforeAnswer.attention.runId) assert.equal(final.runId, beforeAnswer.attention.runId, 'Review answer resumed a different Run');
        assert.equal(ticket.attentions.find(row => row.id === beforeAnswer.attention.id)?.state, 'answered');
      }
      const notifications = rowsFor(history, ticket.id);
      const finalNotification = notifications.find(row => row.resultVersion === ticket.resultVersion && row.type === 'ticket.result');
      assert.ok(finalNotification, 'Final result did not return to original chat history');
      assert.equal(finalNotification.threadId, thread.id);
      const mainHistory = await call({ action: 'history', threadId: 'main' });
      assert.equal(rowsFor(mainHistory, ticket.id).length, 0, 'Result leaked into a different conversation');
      scenario.assertions = { aiTitle: ticket.title, titleUnicodeChars: [...ticket.title].length, fullOriginalInstructionRetained: true, fullTargetChars: ticket.target.length,
        textOnlyAccepted: final.checkpoint?.files === 0, finalItemCount: count, realReviewPassed: true, realNetworkEvidence: true, originalChatDelivered: true, noOtherChatDelivery: true };
      scenario.final = { ticket, history, finalNotification };
      scenario.status = 'pass';
      executions.push({ id: scenario.id, ticketId: ticket.id, threadId: thread.id, notificationId: finalNotification.eventId || finalNotification.id });
    } catch (error) {
      scenario.status = 'fail';
      scenario.error = redact(error.stack || error.message);
      scenario.final = { ticket, history };
    } finally {
      scenario.finishedAt = new Date().toISOString();
      await writeFile(join(output, `${definition.id}-evidence.json`), redact(JSON.stringify(scenario, null, 2)));
      if (ticket?.results?.length) await writeFile(join(output, `${definition.id}-final.md`), redact(ticket.results.at(-1).delivery?.text || ''));
      await save();
    }
    if (scenario.status !== 'pass') {
      report.stoppedReason = `Stopped after ${scenario.id} failed; no overlapping controlled Worker conditions are allowed.`;
      break;
    }
  }
  await writeFile(join(output, 'active-case.json'), '{}');
  if (executions.length) {
    report.scenarios.push({ id: 'original-chat', title: '最终结果返回各自原聊天', status: 'pass', evidence: executions,
      note: '每次任务从独立聊天send进入；真实outbox回执与该聊天history.notifications相符，主聊天无该任务结果。' });
  }
  report.controls = (await readFile(join(output, 'worker-controls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  await save();
}
