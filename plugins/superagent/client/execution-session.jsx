import React, { useEffect, useLayoutEffect, useState } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { CustomSelect } from '../../shared/client/custom-select.jsx';
import { AssistantConversation } from './conversation.jsx';
import { ResourceState } from './resource-state.jsx';
import { executionSessionNavigation } from './execution-session-navigation.mjs';
export { openExecutionSession } from './execution-session-navigation.mjs';

/** This is navigation over the official Sessions, not a second transcript store. */
export function ExecutionSessionPanel({ ctx, execution, api, SessionProvider, renderSlot, onClose, onOpenTicket }) {
  const [catalog, setCatalog] = useState(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false, timer, controller;
    const load = async () => {
      controller = new AbortController();
      try {
        const value = await api('executionSessions', {}, controller.signal);
        if (!disposed) { setCatalog(value.sessions || []); setError(''); }
      } catch (cause) { if (!disposed && !controller.signal.aborted) setError(cause.message || '请稍后重试'); }
      finally { if (!disposed) timer = setTimeout(() => { if (!document.hidden) void load(); else timer = setTimeout(load, 2500); }, 2500); }
    };
    setError(''); void load();
    return () => { disposed = true; controller?.abort(); clearTimeout(timer); };
  }, [api, execution.ticketId, retry]);
  const entries = catalog?.filter(row => row.ticketId === execution.ticketId) || [];
  const current = entries.find(row => row.sessionId === execution.sessionId);
  const reason = error ? '执行状态暂未刷新，请重试后继续。' : current?.reason || '此执行会话仅供查看。需要继续工作时，请在原工单调整要求。';
  const canPrompt = !error && current?.promptable === true;
  useLayoutEffect(() => {
    const blocks = ctx.conversation?.blocks;
    if (!blocks || canPrompt) return;
    const previous = blocks.storeFor(execution.sessionId).getSnapshot(), block = { reason };
    blocks.set(execution.sessionId, block);
    return () => { if (blocks.storeFor(execution.sessionId).getSnapshot() === block) blocks.set(execution.sessionId, previous); };
  }, [ctx, execution.sessionId, canPrompt, reason]);
  const options = entries.map((row, index) => ({ value: row.sessionId, label: `${row.role === 'child-worker' ? '子 Worker' : 'Worker'} · ${row.title || row.sessionId}${row.runId ? ' · ' + (index + 1) : ''}` }));
  return <section className="ba-execution-session" aria-label="执行会话">
    <header className="ba-execution-heading"><Button variant="ghost" type="button" onClick={onClose}>返回</Button><div><h2>{execution.title || '执行会话'}</h2><p>工单执行记录</p></div><Button variant="ghost" type="button" disabled={!execution.ticketId} onClick={() => onOpenTicket(execution.ticketId)}>原工单</Button></header>
    {catalog && entries.length > 1 && <div className="ba-execution-switch"><CustomSelect aria-label="切换执行会话" value={execution.sessionId} options={options} onChange={id => executionSessionNavigation.select(entries.find(row => row.sessionId === id))} /></div>}
    {!catalog ? <ResourceState kind={error ? 'error' : 'loading'} title={error ? '无法读取执行会话' : '正在读取执行会话'} description={error || undefined} actionLabel="重试" onAction={error ? () => setRetry(value => value + 1) : undefined} /> : <>
      {error && <div className="ba-error" role="alert"><span>执行状态刷新失败：{error}</span><Button variant="ghost" type="button" onClick={() => setRetry(value => value + 1)}>重试</Button></div>}
      {!current ? <ResourceState kind="empty" title="执行会话暂不可用" description="未找到这次执行记录，请返回原工单查看当前执行。" actionLabel="查看原工单" onAction={() => onOpenTicket(execution.ticketId)} /> : <>
        {!canPrompt && <p className="ba-execution-note" role="status">{reason}</p>}
        <AssistantConversation execution ctx={ctx} sessionId={execution.sessionId} SessionProvider={SessionProvider} renderSlot={renderSlot} />
      </>}
    </>}
  </section>;
}
