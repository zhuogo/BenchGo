import React, { useState } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { ticketWaiting } from './ticket-state.mjs';
import { TicketAttention } from './ticket-attention.jsx';
import css from './ticket-waiting.css';

/** This is a system status, never an invented Router report or an implicit authorization. */
export function TicketWaiting({ api, ticket, onRefresh, onOpenResources, canOpenGoals = !!onOpenResources, showQuestion = true }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const waiting = ticketWaiting(ticket);
  if (!waiting) return null;
  async function act(action) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (action.kind === 'goals' || action.kind === 'tasks') onOpenResources?.(action.kind, action.kind === 'tasks' ? { ticketId: ticket.id } : undefined);
      else if (action.kind !== 'refresh') {
        const response = await api(({ resume: 'ticketResume', review: 'ticketRetryReview', stop: 'ticketStop' })[action.kind], action.input);
        if (response?.queued === false) throw new Error(`原工单暂未恢复（${response.code || 'WAITING'}）`);
      }
      await onRefresh?.();
    } catch (cause) { setError(cause.message || String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="ba-ticket-waiting ba-surface ba-stack" aria-label="工单等待状态" data-state={waiting.status} aria-busy={busy || undefined}>
    <style>{css}</style>
    <strong><UIIcon name="schedules" size={16} />系统状态 · {waiting.label}</strong>
    <p>{waiting.reason}</p>
    {waiting.retryAt && <p>下次自动核验：<time dateTime={waiting.retryAt}>{new Date(waiting.retryAt).toLocaleString('zh-CN')}</time></p>}
    {showQuestion && waiting.attention && <TicketAttention key={`${waiting.attention.id}:${ticket.instructionRevision}:${ticket.resultVersion}`} api={api} ticket={ticket} attention={waiting.attention} onAnswered={onRefresh} />}
    <div className="ba-row-actions">{waiting.actions.map(action => <Button key={action.kind} variant="ghost" type="button"
      disabled={busy || (action.kind === 'goals' ? !canOpenGoals : action.kind === 'tasks' ? !onOpenResources : action.kind === 'refresh' ? !onRefresh : !api)}
      onClick={() => act(action)}>{action.label}</Button>)}</div>
    {busy && <p role="status">正在处理，请稍候…</p>}
    {error && <p role="alert">操作未完成：{error}。请先刷新状态，再选择下一步。</p>}
  </section>;
}
