import React, { useSyncExternalStore } from 'react';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { Loading } from '../../shared/client/ui/loading.jsx';
import { createSessionRoleDirectory, roleDetails, shadowSessionControl } from './session-role-controls.mjs';
import css from './session-role-controls.css';

function useRole(directory, sessionId) {
  const source = directory.sourceFor(sessionId);
  return [useSyncExternalStore(source.subscribe, source.getSnapshot), source];
}

export function SessionRoleStatus({ directory, sessionId }) {
  const [state, source] = useRole(directory, sessionId);
  if (state.phase === 'ready' && state.role === null) return null;
  if (state.phase === 'loading') return <div className="ba-session-role"><Loading compact label="正在确认会话角色…" /></div>;
  if (state.phase === 'error') return <div className="ba-session-role" data-state="error" role="alert"><span>暂时无法确认会话角色：{state.error}</span><button type="button" onClick={() => source.refresh()}>重试</button></div>;
  const role = state.role;
  const name = { router: 'Router', worker: 'Worker', 'child-worker': '子 Worker' }[role.role];
  const status = { pending: '待核验', ready: '已就绪', blocked: '受阻' }[role.status];
  return <div className="ba-session-role" data-state={role.status} role="status">
    <Tooltip label={roleDetails(role)} openOnClick><button type="button" className="ba-session-role-summary" aria-label={roleDetails(role)}><strong>{name}</strong><span>{status}</span><span className="ba-session-role-model">{role.actual?.model?.model || '模型待核验'}</span><span className="ba-session-role-readonly">只读</span></button></Tooltip>
    {role.reason?.message && <span className="ba-session-role-reason">{role.reason.message}</span>}
  </div>;
}

/** All controls stay inside the official SessionProvider, with the incumbent's bound props. */
export function mountSessionRoleControls(ctx, api) {
  const fingerprints = new Map();
  const fingerprint = sessionId => {
    const row = ctx.sessions?.list.getSnapshot().byId[sessionId], values = row?.projectionValues;
    return JSON.stringify([row?.running, row?.blank, values?.agentPreset, values?.permissions, values?.modelSelection]);
  };
  const directory = createSessionRoleDirectory((sessionId, signal) => {
    fingerprints.set(sessionId, fingerprint(sessionId));
    return api('sessionRole', { sessionId }, signal);
  });
  const cleanup = [];
  const wrap = child => function RoleGuard(props) {
    const [state] = useRole(directory, props.sessionId);
    return state.phase === 'ready' && state.role === null
      ? props.renderSlot(child, 'locked' in props ? { locked: props.locked } : {}) : null;
  };
  for (const [name, id] of [
    ['conversation.input.permission'], ['conversation.input.model'], ['conversation.hero.agentPreset'],
    ['conversation.session.header.actions', 'agent-preset'], ['conversation.input.dock', 'commander-model-empty'],
  ]) cleanup.push(shadowSessionControl(ctx.slots, name, id, wrap));
  cleanup.push(ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'benchgo-session-role', order: -40,
  }, props => <SessionRoleStatus {...props} directory={directory} />)));
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  cleanup.push(() => style.remove());

  // Re-read only relevant session lifecycle/projection changes, never each tool/text frame.
  if (ctx.sessions?.list) cleanup.push(ctx.sessions.list.subscribe(() => {
    for (const source of directory.active()) {
      const next = fingerprint(source.sessionId);
      const prior = fingerprints.get(source.sessionId);
      fingerprints.set(source.sessionId, next);
      if (prior !== undefined && next !== prior) void source.refresh();
    }
  }));
  const connection = ctx.connection?.generation;
  if (connection) {
    let generation = connection.getSnapshot()?.id;
    cleanup.push(connection.subscribe(() => {
      const next = connection.getSnapshot()?.id;
      if (next === generation) return;
      generation = next;
      directory.refresh({ reset: true, defer: next === undefined });
    }));
  }
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; for (const dispose of cleanup.reverse()) dispose(); directory.dispose(); };
  ctx.effect(() => stop);
  return stop;
}
