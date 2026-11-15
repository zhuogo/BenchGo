import { askNativeQuestion } from '../../../benchgo/src/questions.mjs';
import { validateAnswer } from './adapter.mjs';
import { text } from '../pairing/store.mjs';

/** Direct coding sessions retain their runtime ownership and approval handling. */
export function createNativeAdapter(ctx) {
  const requireCommander = () => {
    const commander = ctx.get('commander');
    if (!commander) throw Object.assign(new Error('Harness 聚合模块不可用，请在 BenchGo 插件中启用'), { status: 503 });
    return commander;
  };
  const candidate = session => session?.ownerSessionId?.startsWith('commander-web:') && !session.archived;
  const visible = session => candidate(session) && ctx.workspaceRegistry.list().some(p => p.id === session.projectId && p.path === session.cwd);
  const wire = (s, pinned) => ({ id: `native:${s.id}`, native: true, projectId: s.projectId, title: s.title || s.provider, running: ['running', 'waiting', 'connecting'].includes(s.status), updatedAt: s.updatedAt, engine: s.provider, provider: s.provider, ...(s.model === undefined ? {} : { model: s.model }), status: s.status, ...(s.archived ? { archived: true } : {}), ...(pinned?.has(s.id) ? { pinned: true } : {}) });
  const list = (availableProjects, { includeArchived = false } = {}) => {
    const sessions = ctx.get('commander')?.list().filter(session => includeArchived ? session?.ownerSessionId?.startsWith('commander-web:') : candidate(session)) ?? [];
    if (!sessions.length) return [];
    const pathsByProject = new Map();
    for (const project of availableProjects ?? ctx.workspaceRegistry.list()) {
      let paths = pathsByProject.get(project.id);
      if (!paths) pathsByProject.set(project.id, paths = new Set());
      paths.add(project.path);
    }
    const pinned = new Set(ctx.workspaceRegistry.pinnedSessionIds ?? []);
    return sessions.filter(session => pathsByProject.get(session.projectId)?.has(session.cwd)).map(session => wire(session, pinned));
  };
  const dispatch = async input => {
    if (!input.id?.startsWith('native:')) throw new Error('会话不存在');
    const commander = requireCommander();
    const id = input.id.slice('native:'.length);
    const session = commander.snapshot(id);
    if (!visible(session)) throw new Error('会话不属于可用的直接工作区，请通过官方 Harness 会话操作');
    if (input.action === 'send') {
      text(input.text, '消息', 20_000); text(input.requestId, 'requestId');
      if (['disconnected', 'closed'].includes(session.status)) await commander.connect(id);
      return requireCommander().submit(id, input.text, { requestId: input.requestId });
    }
    if (input.action === 'cancel') { await commander.interrupt(id); return { accepted: true }; }
    if (input.action === 'respond') {
      const pending = session.pendingApprovals.find(p => p.id === input.interactionId);
      if (!pending) throw new Error('审批已处理或过期');
      if (pending.kind === 'permission' && typeof input.answer?.allow !== 'boolean') throw new Error('需要明确允许或拒绝');
      let answer = input.answer;
      if (pending.kind === 'question') answer = await askNativeQuestion(session.provider, pending, async ({ questions }) => { validateAnswer(input.answer, questions); return input.answer; });
      requireCommander().approve(id, pending.id, answer);
      return { accepted: true };
    }
    if (input.action !== 'history') throw new Error('不支持的原生会话操作');
    const records = commander.get(id).events;
    const messages = [];
    let assistant;
    for (const event of records) {
      if (event.type === 'input.accepted' || event.type === 'input.steer') {
        messages.push({ id: `${input.id}:${event.seq}`, role: 'user', text: event.data.text }); assistant = undefined;
      }
      if (event.type === 'text.delta') {
        if (!assistant || assistant.turnId !== event.turnId) { assistant = { id: `${input.id}:${event.seq}`, role: 'assistant', text: '', turnId: event.turnId }; messages.push(assistant); }
        assistant.text += event.data.text;
      }
      if (event.type === 'session.error' || event.type === 'provider.error') messages.push({ id: `${input.id}:${event.seq}`, role: 'system', text: event.data.message || '原生工具连接失败' });
    }
    const questionsOf = p => session.provider === 'pi' ? [{ id: 'value', question: p.details?.title || 'Pi 问题', options: p.details?.options?.map(label => ({ label })) }] : (p.details?.questions || []).map((q, index) => ({ ...q, id: session.provider === 'codex' ? q.id : String(index), multiSelect: q.multiSelect === true || q.multiple === true }));
    const interactions = session.pendingApprovals.map(p => ({ id: p.id, kind: p.kind, title: p.details?.title || p.method || '等待确认', details: p.details, ...(p.kind === 'question' ? { questions: questionsOf(p) } : {}) }));
    return { messages, running: wire(session).running, interactions, hasMore: false, cursor: records[0]?.seq ?? 0, truncated: records[0]?.seq > 1 };
  };
  const managementOperations = () => {
    const commander = ctx.get('commander');
    return [...(typeof commander?.archive === 'function' ? ['archive', 'unarchive'] : []), ...(typeof commander?.remove === 'function' ? ['delete'] : [])];
  };
  const managementScope = async (id, _device, prior, allowDeleted = false) => {
    if (typeof id !== 'string' || !id.startsWith('native:')) throw new Error('会话 ID 无效');
    const raw = id.slice('native:'.length);
    const hidden = new Set(await ctx.get?.('assistant')?.sidebarPrivateSessionIds?.() || []);
    const session = requireCommander().list().find(row => row.id === raw), scope = session ?? (allowDeleted ? prior : undefined);
    if (!scope || hidden.has(raw) || hidden.has(id) || hidden.has(scope.ownerSessionId) || !scope.ownerSessionId?.startsWith('commander-web:') || !ctx.workspaceRegistry.list().some(project => project.id === scope.projectId && project.path === (scope.cwd ?? scope.path))) throw Object.assign(new Error('会话不属于可用的直接工作区'), { status: 404, code: 'NOT_FOUND' });
    if (prior && (scope.projectId !== prior.projectId || (scope.cwd ?? scope.path) !== prior.path || scope.ownerSessionId !== prior.ownerSessionId)) throw Object.assign(new Error('会话归属已变化'), { status: 409, code: 'SESSION_SCOPE_CHANGED' });
    return { projectId: scope.projectId, path: scope.cwd ?? scope.path, ownerSessionId: scope.ownerSessionId };
  };
  const manage = async (input, _device, guard) => {
    await guard();
    guard.authorize();
    const id = input.id.slice('native:'.length), commander = requireCommander();
    if (input.operation === 'delete') { guard.mutation(); await commander.remove(id); return { deleted: true }; }
    if (['archive', 'unarchive'].includes(input.operation)) { guard.mutation(); await commander.archive(id, input.operation === 'archive'); return {}; }
    throw Object.assign(new Error('此原生会话不支持此操作'), { status: 422, code: 'UNSUPPORTED' });
  };
  return { list, dispatch, managementOperations, managementScope, manage };
}
