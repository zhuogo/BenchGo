import { desktopTaskOwnerScope, ownsDesktopTask } from './desktop-task-owner.mjs';
import { normalizeTaskTitle } from './task-title.mjs';
import { isDesktopTaskManagementScope } from './desktop-task-management-authority.mjs';
import { createHash } from 'node:crypto';

export const TASK_SUMMARY_MAX_CHARS = 320;
const concise = (value, max = TASK_SUMMARY_MAX_CHARS) => typeof value === 'string' ? Array.from(value.replace(/\s+/gu, ' ').trim()).slice(0, max).join('') : '';
const sections = ['requirements', 'results', 'revisions', 'assignments', 'runs', 'attentions', 'deliveries'];
const sourceIdentity = source => Object.fromEntries(['channel', 'sessionId', 'threadId', 'deviceId', 'messageId']
  .filter(key => typeof source?.[key] === 'string').map(key => [key, source[key]]));
function recordFragment({ identity, value }, { section, textLimit, textOffset = 0, expectedHash }) {
  const serialized = JSON.stringify(value), totalCharacters = serialized.length;
  const contentHash = createHash('sha256').update(serialized).digest('hex');
  if (expectedHash !== undefined && expectedHash !== contentHash) throw Object.assign(new Error('任务记录已变化，请重新读取该记录'), { code: 'TASK_READ_CONFLICT' });
  if (textOffset > totalCharacters) throw new Error('记录正文偏移超出范围');
  if (!textOffset && totalCharacters <= textLimit) return { identity, value, truncated: false };
  const nextTextOffset = textOffset + textLimit < totalCharacters ? textOffset + textLimit : null;
  return { identity, encoding: 'json', text: serialized.slice(textOffset, textOffset + textLimit), textOffset,
    totalCharacters, nextTextOffset, contentHash, truncated: true,
    nextRead: nextTextOffset === null ? null : { section, recordId: identity, expectedHash: contentHash, textOffset: nextTextOffset, textLimit, limit: 1 } };
}

/** A bounded paragraph for routine coordination; persisted evidence stays in get. */
export function conciseTaskSummary(task) {
  const live = task.liveSummary;
  const reason = task.continuationWait;
  const control = task.executionControl || {};
  const summary = control.stopped ? '已停止，等待明确的继续要求。'
    : control.stopRequested ? '正在确认停止，等待执行端核实。'
    : control.paused || control.pauseRequested ? '已请求暂停，等待明确恢复。'
    : [concise(reason?.reason || live?.blocker, 120),
      reason?.resumeConditions || reason?.nextStep ? `继续条件：${concise(reason.resumeConditions || reason.nextStep, 120)}` : '',
      reason?.code === 'EXECUTION_FAILED' ? '下一步：补充条件后明确继续或修订要求。' : concise(live?.progress, 60)].filter(Boolean).join('；');
  return concise(summary || ({ running: '正在推进。', waiting: '等待执行条件。', completed: '已完成。' })[task.status]);
}

/** Read current desktop conversation tasks from the orchestration store. */
export function createDesktopTaskAccess(database, taskManagement) {
  const presentation = task => {
    const row = taskManagement ? taskManagement.project('task', [task])[0]
      : { ...task, taskMeta: { version: 0 }, archived: task.archived === true, cleanup: null };
    const title = normalizeTaskTitle(row.taskMeta.title || row.title, row.target);
    return { ...row, title, taskMeta: { ...row.taskMeta, title } };
  };
  const owned = (task, ownerSessionId) => {
    if (!isDesktopTaskManagementScope(ownerSessionId) && !ownsDesktopTask(task, ownerSessionId)) throw new Error('任务不属于当前会话');
    return task;
  };
  return {
    query(ownerSessionId, { status, projectId, archived, query, createdAfter, createdBefore, channel, sessionId, limit = 20, offset = 0 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('任务查询 limit 必须为 1 到 100');
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('任务查询 offset 必须为非负整数');
      if (archived !== undefined && typeof archived !== 'boolean') throw new Error('任务查询 archived 必须为布尔值');
      const scope = isDesktopTaskManagementScope(ownerSessionId) ? undefined : desktopTaskOwnerScope(ownerSessionId);
      if (scope && !scope.sessionIds.length) return { tasks: [], nextOffset: null };
      const rows = database.listTasks({ ...(scope ? { ownerSessionIds: scope.sessionIds, ownerThreadId: scope.threadId } : {}), status, projectId, archived, query, createdAfter, createdBefore, channel, sessionId, limit: limit + 1, offset, newestFirst: true });
      return {
        tasks: rows.slice(0, limit).map(presentation).map(task => ({
          id: task.id, title: task.title, status: task.status,
          taskMeta: task.taskMeta, archived: task.archived, cleanup: task.cleanup,
          liveSummary: conciseTaskSummary(task),
          result: task.resultVersion > 0 ? { taskId: task.id, version: task.resultVersion } : null,
          adjustmentOfTaskId: task.adjustmentOfTaskId ?? null,
          project: task.mandate.project ?? null, threadId: task.threadId,
          source: sourceIdentity(task.mandate.source),
          instructionRevision: task.instructionRevision,
          createdAt: task.createdAt, updatedAt: task.updatedAt,
        })),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    },
    read(id, ownerSessionId, { section = 'overview', offset = 0, limit = 10, textLimit = 4000, textOffset = 0, recordId, expectedHash } = {}) {
      if (!['overview', ...sections].includes(section)) throw new Error('无效任务详情分区');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('任务详情 limit 必须为 1 到 50');
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(textOffset) || textOffset < 0) throw new Error('任务详情偏移必须为非负整数');
      if (!Number.isSafeInteger(textLimit) || textLimit < 1 || textLimit > 12000) throw new Error('任务详情 textLimit 必须为 1 到 12000');
      if (textOffset && (!recordId || limit !== 1)) throw new Error('分段续读须提供稳定 recordId 并使用 limit=1');
      if (expectedHash !== undefined && (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedHash) || !recordId || limit !== 1)) throw new Error('记录版本校验须提供有效 expectedHash、recordId 并使用 limit=1');
      if (section === 'overview' && (offset || textOffset || recordId !== undefined)) throw new Error('概览不接受记录偏移，请选择具体详情分区');
      const raw = database.getTask(id);
      if (!raw) return null;
      const task = presentation(owned(raw, ownerSessionId));
      const coreTextLimit = Math.max(1, Math.floor(textLimit / 4));
      const short = value => typeof value === 'string' ? value.slice(0, coreTextLimit) : '';
      const source = sourceIdentity(task.mandate.source);
      const requirementsId = `requirements:${task.instructionRevision}:${task.updatedAt}`;
      const core = { id: task.id, kind: 'task', title: task.title, target: short(task.target), acceptance: short(task.acceptance),
        status: task.status, instructionRevision: task.instructionRevision, resultVersion: task.resultVersion,
        executionExited: task.executionExited, executionControl: task.executionControl, archived: task.archived,
        cleanup: task.cleanup, taskMeta: task.taskMeta, threadId: task.threadId, source,
        project: task.mandate.project ?? null, mandate: { source },
        adjustmentOfTaskId: task.adjustmentOfTaskId ?? null, createdAt: task.createdAt, updatedAt: task.updatedAt,
        liveSummary: conciseTaskSummary(task),
        textTruncated: task.target.length > coreTextLimit || task.acceptance.length > coreTextLimit,
        sections: sections.map(name => ({ section: name, ...(name === 'requirements' ? { recordId: requirementsId } : {}), offset: 0 })) };
      if (section !== 'overview') {
        let page;
        if (section === 'requirements') {
          if (offset || recordId !== undefined && recordId !== requirementsId) throw Object.assign(new Error('任务要求或状态已变化，请重新读取概览'), { code: 'TASK_READ_CONFLICT' });
          page = { items: [{ identity: requirementsId, value: { target: task.target, acceptance: task.acceptance, mandate: task.mandate,
            pauseReason: task.pauseReason, continuationWait: task.continuationWait } }], nextOffset: null };
        } else page = database.taskReadPage(id, { section, offset, limit, recordId });
        if (recordId !== undefined && !page.items.length) throw Object.assign(new Error('任务记录不存在或已变化，请重新读取对应分区'), { code: 'TASK_READ_CONFLICT' });
        const budget = Math.max(1, Math.floor(textLimit / Math.max(1, page.items.length)));
        return { ...core, section, records: page.items.map(item => recordFragment(item, { section, textLimit: budget, textOffset, expectedHash })),
          pagination: { section, offset, limit, nextOffset: page.nextOffset } };
      }
      const resultPage = database.taskReadPage(id, { section: 'results', limit: 1 });
      const attentionPage = database.taskReadPage(id, { section: 'attentions', limit, pendingOnly: true });
      const budget = Math.max(1, Math.floor(textLimit / 2 / Math.max(1, resultPage.items.length + attentionPage.items.length)));
      return { ...core, section,
        results: resultPage.items.map(item => recordFragment(item, { section: 'results', textLimit: budget })),
        attentions: attentionPage.items.map(item => recordFragment(item, { section: 'attentions', textLimit: budget })),
        revisions: [], assignments: [], deliveries: [],
        pagination: { results: { nextOffset: resultPage.nextOffset }, attentions: { nextOffset: attentionPage.nextOffset, pendingOnly: true } } };
    },
  };
}
