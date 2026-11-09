import React, { useSyncExternalStore } from 'react';
import { createSessionRoleDirectory, shadowSessionControl } from './session-role-controls.mjs';

function useRole(directory, sessionId) {
  const source = directory.sourceFor(sessionId);
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
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
    const state = useRole(directory, props.sessionId);
    return state.phase === 'ready' && state.role === null
      ? props.renderSlot(child, 'locked' in props ? { locked: props.locked } : {}) : null;
  };
  for (const [name, id] of [
    ['conversation.input.permission'], ['conversation.input.model'], ['conversation.hero.agentPreset'],
    ['conversation.session.header.actions', 'agent-preset'], ['conversation.input.dock', 'commander-model-empty'],
  ]) cleanup.push(shadowSessionControl(ctx.slots, name, id, wrap));
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
