import React, { useId } from 'react';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { ResourceState } from './resource-state.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import css from './task-execution.css';
import { executionStatusText } from '../src/ticket-lifecycle.mjs';

const statusLabels = { running: '运行中', waiting: '当前未执行', completed: '执行结束', failed: '执行失败', cancelled: '已停止', unknown: '状态未知' };
const stamp = value => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date : null;
};
function UpdatedAt({ value }) {
  const date = stamp(value);
  return date ? <Tooltip label={date.toLocaleString('zh-CN')} portal><time tabIndex={0} dateTime={date.toISOString()}>{date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</time></Tooltip> : null;
}
function ExecutionMark({ status }) {
  const paths = status === 'completed' ? <path d="m4 8 3 3 5-6" /> : status === 'failed' ? <><path d="m5 5 6 6m0-6-6 6" /></> : status === 'cancelled' ? <path d="M5 8h6" /> : null;
  return <span className="ba-execution-mark" data-status={status} aria-hidden="true">{paths ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths}</svg> : <i />}</span>;
}

/** One timeline of retained summaries and each executor's latest observed fact. */
export function TaskExecution({ execution, ticketStatus, executionControl, stale = false, sessionAvailable = false, outcome }) {
  const titleId = useId();
  const recentOnly = stale || execution?.observed === false || (ticketStatus && ticketStatus !== 'running');
  const summary = execution?.summary;
  const summaries = (summary?.history || []).filter(row => typeof row.text === 'string' && row.text.trim()).map(row => ({ ...row, text: executionStatusText(row.text.trim()) }));
  const currentText = executionStatusText(summary?.text?.trim());
  if (currentText && summaries.at(-1)?.text.trim() !== currentText) summaries.push({ text: currentText, generatedAt: summary.generatedAt || execution.updatedAt, watermark: summary.watermark });
  const rows = summaries.map((row, index) => ({ id: `summary:${row.watermark ?? row.generatedAt}:${index}`, label: '阶段进展', text: executionStatusText(row.text.trim()), time: row.generatedAt, status: 'summary' })).reverse();
  for (const worker of [execution?.worker, ...execution?.children || []].filter(Boolean)) {
    const status = statusLabels[worker.status] ? worker.status : 'unknown';
    const child = worker !== execution.worker;
    const state = executionControl?.stopRequested && status === 'running' ? '等待执行端退出' : recentOnly && status === 'running' ? '上次记录为运行中' : child && status === 'completed' ? '已返回父 Worker' : statusLabels[status];
    const text = status === 'completed' ? state : executionStatusText(worker.activity?.trim()) || (status === 'running' ? '等待新的执行动态' : state);
    if (!child && text === currentText) continue;
    rows.push({ id: worker.id, worker: true, label: worker.label || (child ? '子 Worker' : '主 Worker'), text, time: worker.updatedAt, status, state });
  }
  if (outcome && !rows.some(row => row.text === outcome.trim())) rows.push({ id: 'outcome', label: '执行结果', text: outcome.trim(), time: execution?.updatedAt, status: 'completed' });
  rows.sort((a, b) => (stamp(b.time)?.getTime() || 0) - (stamp(a.time)?.getTime() || 0));
  const scope = [summary?.historyTruncated && '仅保留最近的阶段进展。', '时间线包含已保存的阶段摘要和各 Worker 最近一次可核实的动态，未记录的历史不会补造。', sessionAvailable ? '完整过程可通过查看执行会话打开。' : '当前未能定位原执行会话。'].filter(Boolean).join('');
  return <section className="ba-task-execution" aria-labelledby={titleId}>
    <style>{css}</style>
    <div className="ba-progress-heading"><h3 id={titleId}>全执行记录</h3><Tooltip label={scope} maxWidth={360} portal openOnClick><Button variant="ghost" size="icon" className="ba-execution-scope" aria-label="记录范围"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></svg></Button></Tooltip></div>
    {stale && <p className="ba-execution-notice" role="status">动态更新暂不可用，以下保留上次记录。</p>}
    {!rows.length && <ResourceState icon="schedules" title="还没有执行记录" description="执行产生进展后会在这里实时更新。" />}
    <ol className="ba-execution-timeline" aria-label="执行时间线">{rows.map(row => <li key={row.id} className="ba-execution-worker" data-worker-id={row.worker ? row.id : undefined} data-worker-status={row.worker ? row.status : undefined}>
      <ExecutionMark status={row.status} />
      <div className="ba-execution-worker-body"><div className="ba-execution-worker-heading"><Tooltip label={row.state || '依据公开执行内容生成的进度摘要'}><strong tabIndex={0} aria-label={row.state ? `${row.label} · ${row.state}` : undefined}>{row.label}</strong></Tooltip><UpdatedAt value={row.time} /></div><p>{row.text}</p></div>
    </li>)}</ol>
    {execution?.uncertainty?.automatic && execution.uncertainty.reasonCode === 'saved-result-pending' && executionStatusText(execution.uncertainty.reason) !== currentText && <p className="ba-execution-notice" role="status">{executionStatusText(execution.uncertainty.reason) || '正在自动保存执行结果。'}</p>}
    {execution?.limitation && <p className="ba-execution-notice">{execution.limitation}</p>}
  </section>;
}
