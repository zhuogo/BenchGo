import { SuperAgentSurfaceContext } from './conversation.jsx';
import { ResourceState } from './resource-state.jsx';
import React, { useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createSessionRoleDirectory, shadowSessionControl } from './session-role-controls.mjs';

function useRole(directory, sessionId) {
  const source = directory.sourceFor(sessionId);
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}

/** All controls stay inside the official SessionProvider, with the incumbent's bound props. */
export function mountSessionRoleControls(ctx, api, onOpenOwned) {
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
    const state = useRole(directory, props.sessionId);
    return state.phase === 'ready' && (state.role === null || state.role.role === 'child-worker')
      ? props.renderSlot(child, 'locked' in props ? { locked: props.locked } : {}) : null;
  };
  for (const [name, id] of [
    ['conversation.input.permission'], ['conversation.input.model'], ['conversation.hero.agentPreset'],
    ['conversation.session.header.actions', 'agent-preset'], ['conversation.input.dock', 'commander-model-empty'],
  ]) cleanup.push(shadowSessionControl(ctx.slots, name, id, wrap));
  // Public content wrapper, also used by Voice. Internal occurrences carry an
  // explicit Context marker; native occurrences use the official session attribute.
  if (onOpenOwned) cleanup.push(ctx.slots.inject('conversation.hero.frame', () => ctx.slots.register({
    name: 'conversation.hero.frame', id: 'benchgo-superagent-private', order: -100,
  }, function NativeConversationFrame({ children }) {
    const internal = useContext(SuperAgentSurfaceContext), host = useRef(null);
    const [identity, setIdentity] = useState({ ready: false, sessionId: undefined });
    const [error, setError] = useState(''), [opening, setOpening] = useState(false);
    useLayoutEffect(() => {
      if (internal) return;
      const owner = host.current?.closest('[data-conversation-session]');
      const read = () => { const sessionId = owner?.dataset.conversationSession || undefined; setIdentity(value => value.ready && value.sessionId === sessionId ? value : { ready: true, sessionId }); };
      read();
      if (!owner) return;
      const observer = new MutationObserver(read); observer.observe(owner, { attributes: true, attributeFilter: ['data-conversation-session'] });
      return () => observer.disconnect();
    }, [internal]);
    const state = useRole(directory, internal ? undefined : identity.sessionId);
    const open = async () => {
      setOpening(true); setError('');
      try { await onOpenOwned(state.role); } catch (cause) { setError(cause.message || '请稍后重试'); } finally { setOpening(false); }
    };
    let content;
    if (internal || identity.ready && state.phase === 'ready' && state.role?.role !== 'router') content = children;
    else if (!identity.ready || state.phase === 'loading') content = <ResourceState kind="loading" title="正在读取会话归属" />;
    else if (state.phase === 'error') content = <ResourceState kind="error" title="会话归属暂不可用" description={state.error} actionLabel="重试" onAction={() => directory.sourceFor(identity.sessionId).refresh()} />;
    else content = <ResourceState kind={error ? 'error' : 'empty'} title="此会话由 SuperAgent 管理" description={error || '请在 SuperAgent 内查看消息与执行记录。'} actionLabel={opening ? '正在打开…' : '在 SuperAgent 中打开'} onAction={opening ? undefined : open} />;
    return <div ref={host} style={{ display: 'contents' }}>{content}</div>;
  })));
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
