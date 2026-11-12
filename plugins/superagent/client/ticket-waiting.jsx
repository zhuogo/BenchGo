import React, { useState } from 'react';
import { TaskIconButton } from './task-list.jsx';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { ticketWaiting } from './ticket-state.mjs';
import { TicketAttention } from './ticket-attention.jsx';
import css from './ticket-waiting.css';

/** This is a system status, never an invented Router report or an implicit authorization. */
export function TicketWaiting({ api, ticket, onRefresh, onOpenResources, showQuestion = true, compact = false, hideRefresh = false, singleLine = false }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const waiting = ticketWaiting(ticket);
  if (!waiting) return null;
  const actions = waiting.actions.filter(action => (!compact || action.kind !== 'tasks') && (!hideRefresh || action.kind !== 'refresh'));
  async function act(action) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (action.kind === 'tasks') onOpenResources?.(action.kind, { ticketId: ticket.id });
      else if (action.kind !== 'refresh') {
        const response = await api('ticketResume', action.input);
        if (response?.queued === false || response?.status === 'blocked') throw new Error(response.reason || `原工单暂未恢复（${response.code || 'WAITING'}）`);
      }
      await onRefresh?.();
    } catch (cause) { setError(cause.message || String(cause)); }
    finally { setBusy(false); }
  }
  return <section className={`ba-ticket-waiting ba-stack${singleLine ? ' ba-ticket-waiting-row' : compact ? ' ba-ticket-waiting-compact' : ' ba-surface'}`} aria-label={compact ? '待处理事项' : '工单等待状态'} data-state={waiting.status} aria-busy={busy || undefined}>
    <style>{css}</style>
    {!compact && <Tooltip label={`等待处理：${waiting.reason}`}><span tabIndex={0} role="img" aria-label={`等待处理：${waiting.reason}`}><UIIcon name="schedules" size={16} /></span></Tooltip>}
    <Tooltip label={waiting.reason} onlyWhenClipped><p className="ba-ticket-waiting-reason" tabIndex={singleLine ? 0 : undefined}>{waiting.reason}</p></Tooltip>
    {waiting.executionNotice?.recoveryBlocked && <p>{waiting.executionNotice.recoveryBlocked}</p>}
    {showQuestion && waiting.attention && <TicketAttention key={`${waiting.attention.id}:${ticket.instructionRevision}:${ticket.resultVersion}`} api={api} ticket={ticket} attention={waiting.attention} onAnswered={onRefresh} />}
    {actions.length > 0 && <div className="ba-row-actions">{actions.map(action => <TaskIconButton key={action.kind} icon={({ resume: 'play', tasks: 'edit', refresh: 'refresh' })[action.kind]} label={action.label}
      spinning={busy && action.kind === 'refresh'} disabled={busy || (action.kind === 'tasks' ? !onOpenResources : action.kind === 'refresh' ? !onRefresh : !api)}
      onClick={() => act(action)} />)}</div>}
    {busy && !singleLine && <p role="status">正在处理，请稍候…</p>}
    {error && <p role="alert">操作未完成：{error}。已有记录保留，可刷新记录后重试。</p>}
  </section>;
}
