import React, { useId, useRef, useState } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { attentionMatchesTask, terminalTaskStates } from './task-state.mjs';
import css from './task-attention.css';

/** The task page and original chat answer the same durable Attention. */
export function TaskAttention({ api, task, attention, onAnswered, showQuestion = true }) {
  const [selected, setSelected] = useState([]), [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [submitted, setSubmitted] = useState(false);
  const [supplementOpen, setSupplementOpen] = useState(false);
  const id = useId();
  const request = useRef(null);
  const question = attention.question || {};
  const options = question.options || [];
  const answered = attention.state === 'answered' || submitted;
  const desktop = task.mandate?.source?.channel === 'desktop';
  const stale = !attentionMatchesTask(attention, task);
  const closed = terminalTaskStates.has(task.status) || task.executionControl?.stopRequested || task.executionControl?.stopped || stale;
  const ready = selected.length > 0 || custom.trim().length > 0;
  const change = action => { action(); request.current = null; setError(''); };
  const submit = async event => {
    event.preventDefault();
    if (busy || answered || closed || !ready) return;
    setBusy(true); setError('');
    request.current ||= crypto.randomUUID();
    try {
      await api('taskAnswer', { taskId: task.id, attentionId: attention.id, instructionRevision: attention.instructionRevision ?? task.instructionRevision,
        requestId: request.current, answer: { selected, ...(custom.trim() ? { custom: custom.trim() } : {}) } });
      setSubmitted(true); await onAnswered?.();
    } catch (cause) { setError(cause.message || String(cause)); }
    finally { setBusy(false); }
  };
  const answerInput = <label className="ba-attention-answer">{options.length ? '补充内容' : '你的答复'}<textarea rows={2} value={custom}
    placeholder={options.length ? '补充你的偏好或要求…' : '在这里输入你的答复…'}
    onChange={event => change(() => setCustom(event.target.value))} /></label>;
  return <section className="ba-pending ba-task-attention" aria-label="任务问题" data-state={answered ? 'answered' : closed ? 'closed' : busy ? 'busy' : error ? 'error' : 'ready'}>
    <style>{css}</style>
    <header className="ba-attention-head"><strong><UIIcon name={answered ? 'check' : closed ? 'close' : 'topic'} size={16} />{answered ? '已答复' : stale ? '旧版本的问题 · 已失效' : closed ? '任务已结束' : '需要你的答复'}</strong>
      {!answered && !closed && options.length > 0 && <span>{question.multiSelect ? '可多选' : '单选'}</span>}</header>
    {showQuestion && <p className="ba-attention-question">{question.question}</p>}
    {question.detail && <p className="ba-attention-detail">{question.detail}</p>}
    {desktop && !answered && !closed ? <form onSubmit={submit} aria-busy={busy}><fieldset disabled={busy} aria-label={question.question}>
      {options.length > 0 && <div className="ba-attention-options">{options.map((option, index) => <label className="ba-attention-option" data-selected={selected.includes(option.label)} key={option.label}>
        <input type={question.multiSelect ? 'checkbox' : 'radio'} name={attention.id} checked={selected.includes(option.label)} aria-label={option.label}
          aria-describedby={option.description ? `${id}-option-${index}` : undefined}
          onChange={event => change(() => setSelected(question.multiSelect ? event.target.checked ? [...selected, option.label] : selected.filter(label => label !== option.label) : [option.label]))} />
        <span className="ba-attention-option-copy"><span>{option.label}</span>{option.description && <small id={`${id}-option-${index}`}>{option.description}</small>}</span>
        <span className="ba-attention-option-check"><UIIcon name="check" size={16} /></span>
      </label>)}</div>}
      {options.length > 0 ? <Disclosure className="ba-attention-supplement" title={custom.trim() ? '补充说明 · 已填写' : '补充说明'} open={supplementOpen} onOpenChange={setSupplementOpen} disabled={busy}>{answerInput}</Disclosure> : answerInput}
      {error && <div role="alert" className="ba-attention-error"><UIIcon name="close" size={16} /><div><strong>答复未提交，请重试</strong><p>{error}</p></div></div>}
      <div className="ba-attention-actions"><Button type="submit" disabled={busy || !ready}>{busy && <UIIcon name="refresh" size={15} />}{busy ? '提交中…' : error ? '重试提交' : '提交答复'}</Button></div>
    </fieldset></form> : <>
      {!answered && !closed && <p className="ba-note">请在原会话中回复这条问题。</p>}
      {answered && <p role="status" className="ba-note">答复已保存{closed ? '。' : ' · 原任务继续处理'}</p>}
      {!answered && closed && <p className="ba-note">{stale ? '问题对应的要求已更新，无需再答复。' : '这条问题已关闭，无需再答复。'}</p>}
      {answered && error && <p role="alert" className="ba-attention-error">答复已保存，但显示暂未更新：{error}</p>}
    </>}
  </section>;
}
