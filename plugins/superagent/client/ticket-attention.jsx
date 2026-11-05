import React, { useRef, useState } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { attentionMatchesTicket, terminalTicketStates } from './ticket-state.mjs';
import css from './ticket-attention.css';

/** The task page and original chat answer the same durable Attention. */
export function TicketAttention({ api, ticket, attention, onAnswered, showQuestion = true }) {
  const [selected, setSelected] = useState([]), [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [submitted, setSubmitted] = useState(false);
  const request = useRef(null);
  const question = attention.question || {};
  const answered = attention.state === 'answered' || submitted;
  const desktop = ticket.mandate?.source?.channel === 'desktop';
  const stale = !attentionMatchesTicket(attention, ticket);
  const closed = terminalTicketStates.has(ticket.status) || stale;
  const ready = selected.length > 0 || custom.trim().length > 0;
  const change = action => { action(); request.current = null; setError(''); };
  const submit = async event => {
    event.preventDefault();
    if (busy || answered || closed || !ready) return;
    setBusy(true); setError('');
    request.current ||= crypto.randomUUID();
    try {
      await api('ticketAnswer', { ticketId: ticket.id, attentionId: attention.id, instructionRevision: ticket.instructionRevision,
        requestId: request.current, answer: { selected, ...(custom.trim() ? { custom: custom.trim() } : {}) } });
      setSubmitted(true); await onAnswered?.();
    } catch (cause) { setError(cause.message || String(cause)); }
    finally { setBusy(false); }
  };
  return <section className="ba-pending ba-ticket-attention" aria-label="工单问题">
    <style>{css}</style>
    <strong>{answered ? '已答复' : stale ? '旧版本的问题 · 已失效' : closed ? '工单已结束' : '需要你的答复'}</strong>
    {showQuestion && <p>{question.question}</p>}
    {question.detail && <p>{question.detail}</p>}
    {desktop && !answered && !closed ? <form onSubmit={submit}><fieldset disabled={busy} aria-label={question.question}>
      {(question.options || []).map(option => <label className="ba-checkbox" key={option.label}>
        <input type={question.multiSelect ? 'checkbox' : 'radio'} name={attention.id} checked={selected.includes(option.label)}
          onChange={event => change(() => setSelected(question.multiSelect ? event.target.checked ? [...selected, option.label] : selected.filter(label => label !== option.label) : [option.label]))} />
        <span>{option.label}{option.description && <small>{option.description}</small>}</span>
      </label>)}
      <label className="ba-attention-answer">你的答复<textarea rows={3} value={custom} onChange={event => change(() => setCustom(event.target.value))} /></label>
      <Button className="ba-primary" type="submit" disabled={busy || !ready}>{busy ? '提交中…' : '提交答复'}</Button>
    </fieldset></form> : <>
      {!answered && !closed && <p className="ba-note">请在原会话中回复这条问题。</p>}
      {answered && <p role="status" className="ba-note">答复已保存{closed ? '。' : ' · 原工单继续处理'}</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
