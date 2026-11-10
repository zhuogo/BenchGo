import React, { useState } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { ticketWaiting } from './ticket-state.mjs';
import { TicketAttention } from './ticket-attention.jsx';
import css from './ticket-waiting.css';

/** This is a system status, never an invented Router report or an implicit authorization. */
export function TicketWaiting({ api, ticket, onRefresh, onOpenResources, showQuestion = true }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const waiting = ticketWaiting(ticket);
  const notice = waiting?.executionNotice;
  const date = value => { const parsed = new Date(value); return value != null && Number.isFinite(parsed.getTime()) ? parsed : null; };
  const nextCheck = date(notice?.nextCheckAt), stopRequested = date(notice?.stopRequestedAt);
  if (!waiting) return null;
  async function act(action) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (action.kind === 'tasks') onOpenResources?.(action.kind, { ticketId: ticket.id });
      else if (action.kind !== 'refresh') {
        const response = await api(({ resume: 'ticketResume', stop: 'ticketStop' })[action.kind], action.input);
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
    {notice && <dl className="ba-ticket-verification-facts">
      {notice.attempts !== null && <div><dt>自动核查</dt><dd>已查 {notice.attempts} 次</dd></div>}
      {nextCheck && <div><dt>下次核查</dt><dd><time dateTime={nextCheck.toISOString()}>{nextCheck.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time></dd></div>}
      {!nextCheck && notice.automatic === false && <div><dt>下次核查</dt><dd>等待完整恢复证据后安排</dd></div>}
      {notice.recoveryBlocked && <div className="ba-ticket-verification-blocked"><dt>核查条件</dt><dd>{notice.recoveryBlocked}</dd></div>}
      {stopRequested && <div><dt>停止生效</dt><dd><time dateTime={stopRequested.toISOString()}>{stopRequested.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time></dd></div>}
      {(notice.escalated || notice.automatic === false) && <div className="ba-ticket-verification-escalated"><dt>异常跟进</dt><dd>{notice.automatic === false ? '已提请 Router 跟进恢复条件。' : '已提请 Router 跟进，系统继续自动核查。'}</dd></div>}
    </dl>}
    {showQuestion && waiting.attention && <TicketAttention key={`${waiting.attention.id}:${ticket.instructionRevision}:${ticket.resultVersion}`} api={api} ticket={ticket} attention={waiting.attention} onAnswered={onRefresh} />}
    <div className="ba-row-actions">{waiting.actions.map(action => <Button key={action.kind} variant="ghost" type="button"
      disabled={busy || (action.kind === 'tasks' ? !onOpenResources : action.kind === 'refresh' ? !onRefresh : !api)}
      onClick={() => act(action)}>{action.label}</Button>)}</div>
    {busy && <p role="status">正在处理，请稍候…</p>}
    {error && <p role="alert">操作未完成：{error}。已有记录保留，可刷新记录后重试。</p>}
  </section>;
}
