import { createHash } from 'node:crypto';
import { harnessSelection } from './selection.mjs';
import { DelegationBridge } from './delegation.mjs';
import { decodeRouteModelId } from '../../base/src/picker-catalog.mjs';
import { isFullNativePermission } from './permissions.mjs';

const text = (value, name, max = 20000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
};

export async function mountHarnessWeb(ctx, commander, config = {}, dependencies = {}) {
  const maxDepth = config.maxDelegationDepth ?? 3;
  const maxChildren = config.maxDelegationChildren ?? 5;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) throw new Error('maxDelegationDepth must be an integer from 1 to 8');
  if (!Number.isSafeInteger(maxChildren) || maxChildren < 1 || maxChildren > 64) throw new Error('maxDelegationChildren must be an integer from 1 to 64');
  const childCreations = new Map();
  const capabilities = { delegation: { available: false } };
  let delegationError, disposed = false;
  ctx.effect(() => () => { disposed = true; commander.delegate = undefined; });
  const unavailable = (name, error) => {
    capabilities[name] = { available: false, error: error.message, ...(error.code ? { code: error.code } : {}) };
    ctx.logger?.warn?.(`BenchGo ${name} unavailable: ${error.message}`);
  };
  const project = id => {
    const p = ctx.workspaceRegistry.get(text(id, 'projectId', 200));
    if (!p) throw new Error('Project no longer exists');
    return p;
  };
  const result = id => {
    const s = commander.snapshot(id);
    const events = commander.get(id).events.filter(e => e.turnId === s.turnId);
    return { session: s, text: events.filter(e => e.type === 'text.delta').map(e => e.data.text).join('').slice(-60000),
      events: events.filter(e => ['turn.completed', 'session.error', 'provider.error'].includes(e.type)).slice(-10), cursor: s.cursor,
      pending: !['idle', 'failed', 'disconnected', 'closed'].includes(s.status),
      ...(s.status === 'running' || s.status === 'waiting' ? { next: 'Read again with operation=result and sessionId; do not create a duplicate child.' } : {}),
    };
  };
  commander.delegate = async (parentId, args, { signal } = {}) => {
    if (delegationError) throw new Error(`Native delegation unavailable: ${delegationError.message}`, { cause: delegationError });
    const parent = commander.snapshot(parentId);
    if (!parent.ownerSessionId) throw new Error('Native delegation requires an owning conversation');
    if (!args || typeof args !== 'object') throw new Error('Invalid delegation arguments');
    if (args.operation === 'result') {
      const child = commander.snapshot(text(args.sessionId, 'sessionId', 200));
      if (child.parentId !== parentId) throw new Error('Only direct delegated children can be read');
      return result(child.id);
    }
    const provider = text(args.provider, 'provider', 100);
    const providerId = text(args.providerId, 'providerId', 200);
    const model = text(args.model, 'model', 300);
    const prompt = text(args.text, 'text');
    if (signal?.aborted) throw signal.reason;
    if (!['codex', 'claude', 'pi', 'opencode', 'gemini', 'grok', 'mcode'].includes(provider)) throw new Error('Unsupported native provider');
    let depth = 0, ancestor = parent;
    while (ancestor.parentId) { ancestor = commander.snapshot(ancestor.parentId); depth++; }
    if (depth >= maxDepth) throw new Error('Delegation depth limit reached');
    const fingerprint = createHash('sha256').update(JSON.stringify([parentId, parent.turnId, provider, providerId, model, prompt])).digest('hex');
    const requestId = args.requestId === undefined ? fingerprint : text(args.requestId, 'requestId', 180);
    if (!isFullNativePermission(await commander.permissionFor(parent))) {
      const answer = await commander.ask(parentId, { kind: 'permission', method: 'commander_delegate', details: { provider, providerId, model, text: prompt, cwd: parent.cwd } }, signal);
      if (!answer.allow) throw new Error('Delegation denied by user');
    }
    // Reserve identity and submit under the same per-parent serialization.
    const creation = (childCreations.get(parentId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const activeParent = commander.snapshot(parentId);
      if (!commander.drivers.has(parentId) || activeParent.turnId !== parent.turnId ||
          commander.interruptedTurns.get(parentId) === parent.turnId || !['running', 'waiting'].includes(activeParent.status)) {
        throw new Error('Parent native turn is no longer active');
      }
      if (signal?.aborted) throw signal.reason;
      const existing = commander.list().find(s => s.parentId === parentId && s.delegationRequestId === requestId);
      const receiptId = `delegation:${requestId}`;
      if (existing && existing.delegationFingerprint !== fingerprint) throw new Error('requestId was already used for a different delegation');
      if (existing && commander.get(existing.id).receipts[receiptId]) {
        if (commander.get(existing.id).receipts[receiptId].receipt.status === 'uncertain') throw new Error('Delegated submission is uncertain; inspect the original native session before retrying');
        return existing;
      }
      if (existing) {
        await commander.connect(existing.id);
        if (signal?.aborted || commander.interruptedTurns.get(parentId) === parent.turnId || commander.snapshot(parentId).turnId !== parent.turnId) throw new Error('Parent native turn is no longer active');
        await commander.submit(existing.id, prompt, { requestId: receiptId });
        return existing;
      }
      if (commander.list().filter(s => s.parentId === parentId && !s.archived).length >= maxChildren) throw new Error('Delegation child limit reached');
      // Re-resolve the registered project: native engines cannot choose another directory.
      const p = parent.projectId ? project(parent.projectId) : ctx.workspaceRegistry.list().find(p => p.path === parent.cwd);
      if (!p) throw new Error('Parent project is no longer registered');
      const child = await commander.create({ provider, route: { providerId, model }, cwd: p.path, projectId: p.id,
        parentId, parentTurnId: parent.turnId, ownerSessionId: parent.ownerSessionId, title: prompt.slice(0, 60),
        delegationRequestId: requestId, delegationFingerprint: fingerprint });
      if (signal?.aborted || commander.interruptedTurns.get(parentId) === parent.turnId || commander.snapshot(parentId).turnId !== parent.turnId) throw new Error('Parent native turn is no longer active');
      commander.event(parentId, 'delegation.created', { sessionId: child.id, provider, model });
      await commander.submit(child.id, prompt, { requestId: receiptId });
      return child;
    });
    childCreations.set(parentId, creation);
    let child;
    try { child = await creation; }
    finally { if (childCreations.get(parentId) === creation) childCreations.delete(parentId); }
    if (signal) {
      const cancel = () => { void commander.stopExecution(child.id).catch(error => ctx.logger?.warn?.(`Delegated stop not confirmed: ${error.message}`)); };
      signal.addEventListener('abort', cancel, { once: true });
      try { await commander.wait(child.id, { timeout: 55000, signal }); }
      finally { signal.removeEventListener('abort', cancel); }
    } else await commander.wait(child.id, { timeout: 55000 });
    const value = result(child.id);
    commander.event(parentId, 'delegation.result', { sessionId: child.id, status: value.session.status });
    return value;
  };
  const dispatch = async input => {
    if (disposed) throw Object.assign(new Error('Harness 聚合已停用'), { status: 503, code: 'HARNESS_UNAVAILABLE' });
    const { action } = input;
    if (action === 'doctor') return { providers: await commander.doctor() };
    if (action === 'events') {
      // Owner-authenticated human may inspect conversation-owned delegations as well.
      const id = text(input.id, 'sessionId', 200);
      return { session: commander.snapshot(id), ...commander.events(id, input.after ?? 0, 500) };
    }
    if (action === 'adopt') {
      const s = commander.snapshot(text(input.id, 'sessionId', 200));
      if (!s.parentId && !s.ownerSessionId?.startsWith('commander-web:detached:')) throw new Error('Only delegated sessions can be adopted');
      if (['running', 'waiting', 'connecting'].includes(s.status)) throw new Error('Finish or interrupt the active native session before opening it in Harness');
      const harnessId = text(input.harnessSessionId, 'harnessSessionId', 200);
      const agent = ctx.get('agents')?.get(harnessId);
      if (!agent || agent.session.header.cwd !== s.cwd) throw new Error('Harness session must be open in the same project');
      const selection = harnessSelection(ctx, agent);
      const binding = decodeRouteModelId(selection.model);
      if (selection.provider !== `commander-${s.provider}` || !binding || binding.providerId !== s.route?.providerId || binding.model !== s.route?.model) throw new Error('Harness session must select the same native tool and API model');
      const record = commander.get(s.id);
      record.ownerSessionId = harnessId;
      record.harnessAdopted = true;
      await commander.persist();
      return { session: commander.snapshot(s.id) };
    }
    // The Connection route is owner-authenticated. Humans may manage native
    // records owned by Harness too; model-side tools retain their own scope.
    if (action === 'archive' || action === 'delete') {
      const id = text(input.id, 'sessionId', 200);
      if (commander.snapshot(id).executionId)
        throw Object.assign(new Error('工单的执行记录只读，请返回原工单管理。'), { status: 403, code: 'EXECUTION_INPUT_REQUIRES_OWNER' });
      if (action === 'delete') return commander.remove(id);
      if (input.archived !== undefined && typeof input.archived !== 'boolean') throw new Error('Invalid archived flag');
      return commander.archive(id, input.archived ?? true);
    }
    throw new Error(`Unknown BenchGo action: ${action}`);
  };
  try {
    const bridge = await (dependencies.openDelegationBridge ?? (c => new DelegationBridge(c).open()))(commander);
    commander.delegationBridge = bridge;
    ctx.effect(() => async () => {
      if (commander.delegationBridge === bridge) commander.delegationBridge = undefined;
      await bridge.close();
    });
    capabilities.delegation = { available: true };
  } catch (error) { delegationError = error; unavailable('delegation', error); }
  return { dispatch, capabilities };
}
