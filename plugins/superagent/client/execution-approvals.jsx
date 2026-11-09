import React, { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { retainAssistantSession } from './session-retain.mjs';
import { executionApprovalResponse } from './execution-approval.mjs';

const ApprovalContext = createContext(null), EMPTY_STATUSES = new Map();
export const EXECUTION_APPROVAL_SLOT = 'benchgo.assistant.execution-approval';
export const executionApprovalChildren = { [EXECUTION_APPROVAL_SLOT]: { kind: 'single', scope: 'session' } };

export function OfficialExecutionApproval({ renderFactorySlot }) {
  const { pending, origin, readOrigins, isCurrent } = useContext(ApprovalContext);
  const response = useRef(null);
  if (response.current?.pending !== pending) response.current = { pending,
    value: executionApprovalResponse({ pending, origin, readOrigins, isCurrent }) };
  const responder = response.current.value;
  return renderFactorySlot('conversation.approval.card', {
    requestKey: pending.key, callId: pending.callId, subject: { name: origin.title },
    title: pending.displayReason?.zh || pending.reason || pending.displayReason?.en || '允许本次对外动作？',
    canAnswer: responder.canAnswer, onAllow: () => responder.answer('allowed-once'), onReject: () => responder.answer('rejected'),
  });
}

function WorkerApproval({ ctx, origin, api, SessionProvider, renderSlot }) {
  const [retained, setRetained] = useState(null), alive = useRef(false);
  const source = ctx.uiSession?.sessionStatus;
  const statuses = useSyncExternalStore(listener => source?.subscribe(listener) || (() => {}), () => source?.getSnapshot() || EMPTY_STATUSES);
  const pending = statuses.get(origin.sessionId)?.pendingInteraction;
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController(); let reference;
    setRetained(null);
    void (async () => {
      reference = await retainAssistantSession(ctx.sessions, origin.sessionId, controller.signal);
      if (controller.signal.aborted) { reference.release(); return; }
      await reference.ready;
      if (!controller.signal.aborted) setRetained({ sessionId: origin.sessionId, reference });
    })().catch(error => { if (!controller.signal.aborted) console.warn('[BenchGo] execution approval connection failed', error); });
    return () => { alive.current = false; controller.abort(); reference?.release(); };
  }, [ctx, origin.sessionId]);
  if (retained?.sessionId !== origin.sessionId || pending?.kind !== 'approval' || pending.toolName !== 'assistant_external_action' || pending.sessionId !== origin.sessionId || !pending.answerable) return null;
  const readOrigins = async () => (await api('executionApprovalOrigins', { threadId: origin.ownerThreadId, ownerSessionId: origin.ownerSessionId })).origins || [];
  return <ApprovalContext.Provider value={{ pending, origin, readOrigins, isCurrent: () => alive.current }}>
    <SessionProvider session={retained.reference}>{renderSlot(EXECUTION_APPROVAL_SLOT, {})}</SessionProvider>
  </ApprovalContext.Provider>;
}

/** Only the currently opened source chat presents its own Workers' official pending requests. */
export function ExecutionApprovals({ ctx, api, threadId, ownerSessionId, SessionProvider, renderSlot }) {
  const [snapshot, setSnapshot] = useState(null);
  useEffect(() => {
    if (!ownerSessionId) return;
    const controller = new AbortController(); let timer, inFlight = false, dirty = false;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(tick, 150); };
    const tick = async () => {
      if (controller.signal.aborted || document.hidden) return;
      if (inFlight) { dirty = true; return; }
      inFlight = true;
      try {
        const result = await api('executionApprovalOrigins', { threadId, ownerSessionId }, controller.signal);
        if (!controller.signal.aborted) setSnapshot({ threadId, ownerSessionId, origins: result.origins || [] });
      } catch (error) { if (!controller.signal.aborted) { setSnapshot(null); console.warn('[BenchGo] execution approval origins unavailable', error); } }
      finally {
        inFlight = false;
        if (dirty && !controller.signal.aborted) { dirty = false; schedule(); }
      }
    };
    const unsubscribe = ctx.uiSession?.sessionStatus?.subscribe(schedule);
    document.addEventListener('benchgo:assistant-changed', schedule);
    document.addEventListener('visibilitychange', schedule);
    const fallback = setInterval(tick, 10000);
    void tick();
    return () => {
      controller.abort(); clearTimeout(timer); clearInterval(fallback); unsubscribe?.();
      document.removeEventListener('benchgo:assistant-changed', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [ctx, api, threadId, ownerSessionId]);
  if (snapshot?.threadId !== threadId || snapshot?.ownerSessionId !== ownerSessionId) return null;
  return <div className="ba-pending-list">{snapshot.origins.map(origin => <WorkerApproval key={`${origin.runId}:${origin.sessionId}`} ctx={ctx} origin={origin} api={api} SessionProvider={SessionProvider} renderSlot={renderSlot} />)}</div>;
}

export function mountExecutionApprovals(ctx) {
  ctx.effect(() => ctx.slots.inject(EXECUTION_APPROVAL_SLOT, () => ctx.slots.register({ name: EXECUTION_APPROVAL_SLOT }, OfficialExecutionApproval)));
}
