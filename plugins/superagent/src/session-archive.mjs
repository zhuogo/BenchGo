import { randomUUID } from 'node:crypto';
import { readDismissedHarnessIds } from '../../base/src/web.mjs';
import { isSidebarSessionVisible, latestSidebarNativeSessions, sidebarSessionTitle, sidebarSessionUpdatedAt } from '../../base/shared/sidebar-session.mjs';
import { superagentSessionInventory } from './execution-session.mjs';

const activeNative = new Set(['running', 'waiting', 'connecting']);
const text = { type: 'string', minLength: 1, maxLength: 256 };
const resultLimit = 30;
const identity = ({ native, id }) => (native ? 'native:' : 'official:') + id;
const harnessOf = row => row.native || row.boundId ? 'native' : 'official';

async function listWorkbenchSessions(ctx, store, currentId, signal, fail) {
  const registry = ctx.workspaceRegistry;
  const controller = ctx.get('sessionController');
  const commander = ctx.get('commander');
  const execution = ctx.get('benchgoExecution');
  if (!controller || typeof registry?.archiveSession !== 'function' || typeof commander?.archive !== 'function') {
    throw fail('SESSION_ARCHIVE_UNAVAILABLE', '本机会话管理服务尚未就绪');
  }
  const [state, { items }, dismissed] = await Promise.all([
    store.getState(), controller.list({}, signal), readDismissedHarnessIds(ctx.benchgo.directory),
  ]);
  const owned = new Set(superagentSessionInventory({ state, database: store.orchestration }).ownedSessionIds);
  owned.add(currentId);
  const protectedSession = id => owned.has(id) || execution?.ownerOfSession?.(id);
  const hidden = new Set(dismissed);
  const projects = registry.list();
  const projectBySession = new Map();
  for (const project of projects) for (const id of project.sessionIds) {
    if (!projectBySession.has(id)) projectBySession.set(id, project.id);
  }
  const officialById = new Map(items.map(item => [item.sessionId, item]));
  const nativeSessions = commander.list();
  const nativeOwners = latestSidebarNativeSessions(nativeSessions);
  const archived = new Set(registry.archivedSessionIds);
  const pinned = new Set(registry.pinnedSessionIds);
  const rows = [];
  for (const item of items) {
    const id = item.sessionId;
    const projectionValues = item.projections?.values;
    const display = { ...item, title: projectionValues?.title, projectionValues,
      displayTitle: item.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || id };
    const native = nativeOwners.get(id);
    if (hidden.has(id) || protectedSession(id) || native?.executionId || !isSidebarSessionVisible(display)) continue;
    rows.push({ id, native: false, boundId: native?.id, projectId: projectBySession.get(id),
      title: sidebarSessionTitle(display), updatedAt: sidebarSessionUpdatedAt(display),
      active: item.running || activeNative.has(native?.status), archived: archived.has(id), pinned: pinned.has(id) || pinned.has(native?.id) });
  }
  for (const item of nativeSessions) {
    if (item.executionId || protectedSession(item.id) || protectedSession(item.ownerSessionId)) continue;
    const owner = officialById.get(item.ownerSessionId);
    if (hidden.has(item.ownerSessionId) || owner?.origin === 'subagent'
      || (owner && (!item.parentId || item.harnessAdopted))) continue;
    if (!item.title && !activeNative.has(item.status) && item.status !== 'failed') continue;
    rows.push({ id: item.id, native: true, projectId: item.projectId, title: item.title || item.provider,
      updatedAt: item.updatedAt, active: activeNative.has(item.status), archived: item.archived, pinned: pinned.has(item.id) });
  }
  return { registry, commander, projects, rows };
}

function previewCutoff(input, fail) {
  if (input.harness !== undefined && input.harness !== 'official') throw fail('MANAGEMENT_INPUT', '归档预览仅支持 harness=official 或省略 harness');
  if (input.ids && new Set(input.ids).size !== input.ids.length) throw fail('MANAGEMENT_INPUT', 'ids 中的会话 ID 不可重复，请去重后重新预览');
  const before = input.before === undefined ? Infinity : Date.parse(input.before);
  if (input.before !== undefined && (!Number.isFinite(before) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.before))) {
    throw fail('MANAGEMENT_INPUT', 'before 必须是带时区的 ISO 时间，例如 2026-11-01T00:00:00+08:00');
  }
  return before;
}

function previewSelection({ rows, projects }, input, before, fail) {
  let projectId;
  if (input.project) {
    const byId = projects.find(project => project.id === input.project);
    const matches = byId ? [byId] : projects.filter(project => project.title === input.project);
    if (matches.length !== 1) throw fail('SESSION_ARCHIVE_PROJECT', '项目名称不存在或不唯一，请使用准确的项目 ID');
    projectId = matches[0].id;
  }
  const title = input.title?.trim().toLowerCase();
  const ids = input.ids && new Set(input.ids);
  return rows.filter(row => !row.archived && (projectId === undefined || row.projectId === projectId)
    && (input.harness === undefined || harnessOf(row) === input.harness)
    && (!title || row.title.toLowerCase().includes(title)) && (!ids || ids.has(identity(row))))
    .sort((a, b) => b.updatedAt - a.updatedAt || identity(a).localeCompare(identity(b)))
    .slice(input.keepLatest ?? 0)
    .filter(row => row.updatedAt < before);
}

const view = (row, projects) => ({ id: identity(row), harness: harnessOf(row), title: row.title.slice(0, 200), updatedAt: row.updatedAt ?? null,
  projectId: row.projectId ?? null, project: projects.find(project => project.id === row.projectId)?.title?.slice(0, 200) ?? null });

async function archiveWorkbenchSession(row, previous, registry, commander, retryingNative) {
  if (!row || row.boundId !== previous.boundId || row.projectId !== previous.projectId
    || row.updatedAt !== previous.updatedAt || row.title !== previous.title) {
    return { status: 'skipped', reason: '会话范围或活动时间已变化' };
  }
  if (!retryingNative && registry.archivedSessionIds.includes(row.id) && !row.native) return { status: 'alreadyArchived' };
  if (row.active || row.pinned || registry.pinnedSessionIds.includes(row.id)
    || row.boundId && registry.pinnedSessionIds.includes(row.boundId)) {
    return { status: 'skipped', reason: '会话正在活动或已置顶' };
  }
  const nativeId = row.native ? row.id : row.boundId;
  let officialArchived = retryingNative && registry.archivedSessionIds.includes(row.id);
  try {
    if (nativeId) {
      const native = commander.snapshot(nativeId);
      if (row.native && native.archived) return { status: 'alreadyArchived' };
      if (activeNative.has(native.status)) return { status: officialArchived ? 'partial' : 'skipped', reason: '关联原生会话仍有执行活动' };
    }
    if (!row.native && !officialArchived) {
      await registry.archiveSession(row.id);
      officialArchived = true;
    }
    if (nativeId) await commander.archive(nativeId, true);
    return { status: 'archived' };
  } catch (error) {
    if (officialArchived) return { status: 'partial', reason: '官方会话已归档，关联原生会话待核实' };
    if (error.code === 'workspace/session-active') return { status: 'skipped', reason: '会话仍有活动' };
    return { status: 'failed', reason: String(error.message || error).slice(0, 200) };
  }
}

export function registerSessionArchive({ ctx, store, agent, register, authority, inputFor, fail }) {
  const previews = new Map();
  let officialBatch;
  const ids = { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'string', minLength: 1 }, description: 'Exact IDs without duplicates.' };
  const prepare = async (args, exec, stamp) => {
    const before = previewCutoff(args, fail);
    const catalog = await listWorkbenchSessions(ctx, store, agent.id, exec.signal, fail);
    const matching = previewSelection(catalog, args, before, fail);
    const eligible = matching.filter(row => !row.pinned && !row.active);
    await authority(exec, stamp);
    return { catalog, eligible, protected: matching.length - eligible.length,
      plan: { stamp, rows: new Map(eligible.map(row => [identity(row), row])), results: new Map() } };
  };
  const apply = async (plan, args, exec, stamp) => {
    if (Object.hasOwn(args, 'all') && Object.hasOwn(args, 'ids')) {
      throw fail('SESSION_ARCHIVE_SCOPE', 'all 和 ids 只能传一个。整批归档用 all:true，归档子集只传 ids');
    }
    if (args.all !== true) {
      if (Object.hasOwn(args, 'all') || !Array.isArray(args.ids) || !args.ids.length) {
        throw fail('SESSION_ARCHIVE_SCOPE', '请提供 all:true，或提供至少一个来自该预览的会话 ID 到 ids');
      }
      if (new Set(args.ids).size !== args.ids.length) throw fail('SESSION_ARCHIVE_SCOPE', 'ids 中的会话 ID 不可重复，请去重');
      if (args.ids.some(id => !plan.rows.has(id))) {
        throw fail('SESSION_ARCHIVE_SCOPE', 'ids 包含不在该预览可归档清单中的会话。请使用该预览返回的完整 ID，或重新预览所需范围');
      }
    }
    const selected = args.all === true ? [...plan.rows.keys()] : args.ids;
    const selection = JSON.stringify([...selected].sort());
    if (plan.selection && plan.selection !== selection) throw fail('SESSION_ARCHIVE_SCOPE', '本清单已提交另一组会话，请重新预览');
    if (plan.pending) return plan.pending;
    plan.selection = selection;
    plan.pending = (async () => {
      const { rows, registry, commander } = await listWorkbenchSessions(ctx, store, agent.id, exec.signal, fail);
      const fresh = new Map(rows.map(row => [identity(row), row]));
      const counts = { archived: 0, alreadyArchived: 0, skipped: 0, failed: 0, partial: 0 };
      const issues = [];
      for (const key of selected) {
        let result = plan.results.get(key);
        if (!result || result.status === 'failed' || result.status === 'partial') {
          await authority(exec, stamp);
          result = await archiveWorkbenchSession(fresh.get(key), plan.rows.get(key), registry, commander, result?.status === 'partial');
          plan.results.set(key, result);
        }
        counts[result.status]++;
        if (result.reason && issues.length < resultLimit) issues.push({ id: key, title: plan.rows.get(key).title.slice(0, 200), ...result });
      }
      return { ...counts, total: selected.length, issues, issuesTruncated: counts.skipped + counts.failed + counts.partial > issues.length };
    })();
    try { return await plan.pending; }
    finally { plan.pending = null; }
  };
  const previewParameters = {
    harness: { type: 'string', enum: ['official'], description: 'DeepSeek Harness only. Omit to include all local Harness types.' },
    project: text, title: text, before: text, keepLatest: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, ids,
  };
  const applyParameters = { previewId: text, ids, all: { type: 'boolean', enum: [true] } };
  const preview = async (input, exec) => {
    const args = inputFor(input, Object.keys(previewParameters));
    const { stamp } = await authority(exec);
    const prepared = await prepare(args, exec, stamp);
    const previewId = randomUUID();
    previews.set(previewId, prepared.plan);
    if (previews.size > 8) previews.delete(previews.keys().next().value);
    return { previewId, total: prepared.eligible.length, items: prepared.eligible.slice(0, resultLimit).map(row => view(row, prepared.catalog.projects)),
      truncated: prepared.eligible.length > resultLimit, protected: prepared.protected };
  };
  const applyPreview = async (input, exec) => {
    const args = inputFor(input, Object.keys(applyParameters));
    const { stamp } = await authority(exec);
    const plan = previews.get(args.previewId);
    if (!plan || plan.stamp !== stamp) throw fail('MANAGEMENT_STALE_INSTRUCTION', 'previewId 不属于本轮有效预览。请用 assistant_session_archive_preview 取得新的 previewId');
    return apply(plan, args, exec, stamp);
  };
  register('assistant_session_archive_preview', 'Preview ordinary local Workbench chats. Omit unused filters. before is an exclusive last-activity cutoff in ISO format with time zone. keepLatest retains the newest N in scope. Returned previewId freezes the eligible rows, including any beyond the display limit.', previewParameters, [], preview);
  register('assistant_session_archive_apply', 'Archive the exact local chat preview for the current explicit instruction. Use the returned previewId. Pass all:true for the entire frozen preview, or ids for an exact subset. Report the receipt.', applyParameters, ['previewId'], applyPreview);
  register('assistant_session_archive_official', 'Use immediately, with {}, when the user explicitly asks to archive all DeepSeek Harness chats on this device. The host freezes and archives that scope, skipping protected chats and excluding external Harness and SuperAgent sessions. Report the receipt. For a preview-only, narrower, or all-Harness request use assistant_session_archive_preview.', {}, [], async (input, exec) => {
    if (Object.keys(input).length) throw fail('MANAGEMENT_INPUT', '本工具不接受参数');
    const { stamp } = await authority(exec);
    if (officialBatch?.stamp !== stamp) officialBatch = { stamp };
    const batch = officialBatch;
    batch.prepared ??= prepare({ harness: 'official' }, exec, stamp);
    let prepared;
    try { prepared = await batch.prepared; }
    catch (error) { batch.prepared = undefined; throw error; }
    await authority(exec, stamp);
    const receipt = await apply(prepared.plan, { all: true }, exec, stamp);
    return { ...receipt, protected: prepared.protected };
  });
}
