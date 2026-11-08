import React, { useMemo, useRef, useState } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import { Button } from '../../shared/client/ui/button.jsx';
import { parseInteractive, responseText, splitInteractive, validateForm } from './protocol.mjs';
import css from './reply.css';

const defaultLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

function State({ kind, title, detail, children }) {
  return <div className="bg-interactive-state" data-state={kind} role={kind === 'error' ? 'alert' : 'status'}>
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M7 13h6"/></svg>
    <strong>{title}</strong><p>{detail}</p>{children}
  </div>;
}

export function InteractiveReply({ text = '', streaming = false, labels = defaultLabels, onSubmit, disabled = false, onlyCards = false }) {
  const segments = useMemo(() => splitInteractive(text, streaming), [text, streaming]);
  return <><style>{css}</style>{segments.map((segment, index) => segment.kind === 'markdown'
    ? !onlyCards && <MarkdownText key={`md-${index}`} text={segment.text} labels={labels} streaming={streaming} />
    : <InteractiveCard key={segment.key} segment={segment} onSubmit={onSubmit} disabled={disabled || streaming} />)}</>;
}

export function InteractiveCard({ segment, onSubmit, disabled = false }) {
  const parsed = useMemo(() => {
    if (!segment.complete) return {};
    try { return { document: parseInteractive(segment.text) }; } catch (error) { return { error: error.message }; }
  }, [segment.text, segment.complete]);
  const [recovery, setRecovery] = useState(''), recoveryBusy = useRef(false), recoveryRequest = useRef({});
  async function regenerate() {
    if (!onSubmit || disabled || recoveryBusy.current) return;
    recoveryBusy.current = true; setRecovery('正在请求重新生成…');
    try { await onSubmit('上一条回复的交互内容无法显示，请用 BenchGo UI version 1 的 benchgo-ui JSON 块重新生成，保留原本的数据和需求。', recoveryRequest.current); setRecovery('已请求重新生成'); }
    catch (error) { setRecovery(`请求失败：${error.message}，可以重试。`); recoveryBusy.current = false; }
  }
  if (segment.loading) return <section className="bg-interactive" aria-busy="true"><State kind="loading" title="正在生成交互内容" detail="内容完整后即可填写或选择。" /></section>;
  if (!segment.complete || parsed.error) return <section className="bg-interactive"><State kind="error" title="交互内容暂时无法显示" detail={parsed.error || '回复已停止，交互数据尚未完整。'}>{onSubmit && <Button variant="ghost" disabled={disabled || recoveryBusy.current} onClick={regenerate}>请求重新生成</Button>}{recovery && <p role="status">{recovery}</p>}</State><details><summary>查看原始内容</summary><pre>{segment.text.slice(0,65536)}</pre></details></section>;
  const document = parsed.document;
  return <section className="bg-interactive" aria-label={document.title || '交互回复'}>
    {document.title && <h3>{document.title}</h3>}
    {!document.blocks.length ? <State kind="empty" title="没有可展示的内容" detail="可以继续告诉助手需要展示的数据或填写的信息。" /> : document.blocks.map(block => <Block key={`${block.id}:${JSON.stringify(block)}`} document={document} block={block} disabled={disabled} onSubmit={onSubmit} />)}
  </section>;
}

function Block({ document, block, disabled, onSubmit }) {
  const [draft, setDraft] = useState({}), [status, setStatus] = useState('idle'), [error, setError] = useState(''), [selected, setSelected] = useState(null);
  const pending = useRef(false), request = useRef({});
  const locked = disabled || status === 'sending' || status === 'sent' || !onSubmit;
  async function submit(values, label) {
    if (locked || pending.current) return;
    pending.current = true; setStatus('sending'); setError('');
    try {
      const text = responseText(document, block, values);
      if (request.current.text !== text) request.current = { text };
      await onSubmit(text, request.current);
      setSelected(label); setStatus('sent');
    } catch (cause) { setError(cause.message || '发送失败，请重试'); setStatus('idle'); }
    finally { pending.current = false; }
  }
  const notice = <>{error && <p className="bg-interactive-error" role="alert">{error}，请检查后重试。</p>}{status === 'sent' && <p className="bg-interactive-note" role="status">已发送{selected ? `：${selected}` : '答复'}</p>}{!onSubmit && ['form','choices'].includes(block.type) && <p className="bg-interactive-note">当前会话不可提交，请重新连接后重试。</p>}</>;
  return <div className="bg-interactive-block">
    {block.title && <h4>{block.title}</h4>}
    {block.type === 'form' && (block.fields.length ? <form onSubmit={event => {
      event.preventDefault();
      try { const values = validateForm(block, draft); void submit(values); } catch (cause) { setError(cause.message); }
    }}><fieldset disabled={locked}>{block.fields.map(field => <label key={field.id} className={field.type === 'checkbox' ? 'bg-interactive-check' : ''}>
      {field.type !== 'checkbox' && <span>{field.label}{field.required && <span aria-label="必填"> *</span>}</span>}
      {field.type === 'textarea' ? <textarea rows={3} maxLength={8000} value={draft[field.id] ?? ''} required={field.required} placeholder={field.placeholder} onChange={event => setDraft(value => ({ ...value, [field.id]: event.target.value }))} />
        : field.type === 'select' ? <select value={draft[field.id] ?? ''} required={field.required} onChange={event => setDraft(value => ({ ...value, [field.id]: event.target.value }))}><option value="">请选择</option>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          : <input type={field.type} value={field.type === 'checkbox' ? undefined : draft[field.id] ?? ''} checked={field.type === 'checkbox' ? draft[field.id] === true : undefined} required={field.required} maxLength={8000} placeholder={field.placeholder} min={field.min} max={field.max} step={field.type === 'number' ? field.step ?? 'any' : undefined} onChange={event => setDraft(value => ({ ...value, [field.id]: field.type === 'checkbox' ? event.target.checked : event.target.value }))} />}
      {field.type === 'checkbox' && <span>{field.label}{field.required && ' *'}</span>}
    </label>)}<Button type="submit" disabled={locked}>{status === 'sending' ? '发送中…' : status === 'sent' ? '已发送' : block.submitLabel}</Button></fieldset>{notice}</form> : <State kind="empty" title="表单还没有字段" detail="请告诉助手需要收集哪些信息。" />)}
    {block.type === 'choices' && <>{block.options.length ? <div className="bg-interactive-choices">{block.options.map(option => <Button variant="outline" key={option.value} disabled={locked} onClick={() => submit({ choice: option.value, label: option.label }, option.label)}>{option.label}</Button>)}</div> : <State kind="empty" title="暂时没有选项" detail="请让助手补充可供比较的方案。" />}{status === 'sending' && <p role="status">正在发送选择…</p>}{notice}</>}
    {block.type === 'table' && <DataTable columns={block.columns} rows={block.rows} />}
    {block.type === 'chart' && <Chart block={block} />}
  </div>;
}

function DataTable({ columns, rows }) {
  if (!rows.length) return <State kind="empty" title="还没有数据" detail="提供数据后，助手可以生成对比表或图表。" />;
  return <div className="bg-interactive-table" tabIndex={0} role="region" aria-label="数据表"><table><thead><tr>{columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} data-number={typeof cell === 'number' || undefined}>{cell === null ? '—' : cell}</td>)}</tr>)}</tbody></table></div>;
}

function Chart({ block }) {
  if (!block.data.length) return <State kind="empty" title="还没有图表数据" detail="请提供带名称和数值的数据，缺失值不会被当作零。" />;
  const values = block.data.map(point => point.value), min = Math.min(0, ...values), max = Math.max(0, ...values), scale = Math.max(Math.abs(min),Math.abs(max)) || 1, span = max/scale - min/scale || 1;
  const left = 70, right = 570, top = 20, bottom = 190, width = right - left;
  const y = value => bottom - (value/scale - min/scale) / span * (bottom - top), step = width / block.data.length;
  const x = index => left + step * (index + .5), zero = y(0);
  const number = value => new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 5 }).format(value);
  const ticks = [...new Set([max, min < 0 && max > 0 ? 0 : max/2 + min/2, min])];
  return <figure className="bg-interactive-chart"><svg viewBox="0 0 600 230" role="img" aria-label={`${block.title || '数据图表'}${block.unit ? `，单位：${block.unit}` : ''}`}>
    {ticks.map((value,index) => <g key={index}><line x1={left} x2={right} y1={y(value)} y2={y(value)} className="bg-interactive-grid"/><text x={left - 8} y={y(value) + 4} textAnchor="end">{number(value)}</text></g>)}
    {block.kind === 'line' ? <><polyline points={block.data.map((point,index) => `${x(index)},${y(point.value)}`).join(' ')} className="bg-interactive-line"/>{block.data.length === 1 && <circle cx={x(0)} cy={y(block.data[0].value)} r="3" className="bg-interactive-bar"/>}</> : block.data.map((point,index) => <rect key={index} x={x(index) - Math.max(1, step * .65)/2} width={Math.max(1, step * .65)} y={Math.min(zero,y(point.value))} height={Math.abs(zero - y(point.value))} className="bg-interactive-bar"><title>{point.label}：{point.value}{block.unit}</title></rect>)}
    {block.data.map((point,index) => (index === 0 || index === block.data.length - 1 || index % Math.ceil(block.data.length / 4) === 0) && <text key={index} x={x(index)} y="213" textAnchor="middle">{point.label.length > 10 ? `${point.label.slice(0,9)}…` : point.label}</text>)}
  </svg>{block.unit && <figcaption>单位：{block.unit}</figcaption>}<details><summary>查看数据</summary><DataTable columns={['名称', block.unit || '数值']} rows={block.data.map(point => [point.label, point.value])}/></details></figure>;
}
