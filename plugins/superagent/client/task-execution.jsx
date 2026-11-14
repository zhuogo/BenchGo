import React, { useId } from 'react';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { ResourceState } from './resource-state.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import css from './task-execution.css';
import { executionStatusText } from '../src/task-lifecycle.mjs';

const statusLabels = { running: '运行中', waiting: '当前未执行', completed: '执行结束', failed: '执行失败', cancelled: '已停止', unknown: '状态未知' };
const legacyActivities = new Map([['已返回父 Worker', '子任务已完成'], ['子 Worker 执行失败', '子任务执行失败'], ['子 Worker 已停止', '子任务已停止'], ['正在协调子 Worker', '正在协调子任务']]);
const activityText = value => legacyActivities.get(value) || executionStatusText(value);
const genericActivities = new Set(['正在执行', '执行中', '运行中', '正在处理', '正在处理任务', '正在执行命令', '正在读取文件', '正在修改文件', '正在搜索网页', '正在读取网页', '正在使用工具', '正在协调子任务', '正在协调并行任务', '正在处理子任务', '等待新的执行动态', '执行结束', '执行已结束', '本轮执行已结束', '子任务已完成', '并行任务已完成', '任务执行已完成']);
export function visibleExecutionActivity(value) {
  const text = activityText(value?.trim()) || '';
  return genericActivities.has(text.replace(/[.。…\s]+$/u, '')) ? '' : text;
}
const stamp = value => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date : null;
};
function UpdatedAt({ value }) {
  const date = stamp(value);
  return date ? <Tooltip label={date.toLocaleString('zh-CN')} portal><time tabIndex={0} dateTime={date.toISOString()}>{date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time></Tooltip> : null;
}
function ExecutionMark({ status, active, label }) {
  const paths = status === 'completed' ? <path d="m4 8 3 3 5-6" /> : status === 'failed' ? <><path d="m5 5 6 6m0-6-6 6" /></> : status === 'cancelled' ? <path d="M5 8h6" /> : null;
  return <Tooltip label={label}><span className="ba-execution-mark" data-status={status} data-active={active ? 'true' : undefined} role="img" aria-label={label} tabIndex={0}>{paths ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg> : <i aria-hidden="true" />}</span></Tooltip>;
}

/** One timeline of retained summaries, executor activity history and current facts. */
export function TaskExecution({ execution, taskStatus, executionControl, stale = false, sessionAvailable = false, outcome }) {
  const titleId = useId();
  const recentOnly = stale || execution?.observed === false || (taskStatus && taskStatus !== 'running');
  const inactive = recentOnly || ['preparing', 'waiting', 'unknown', 'finished'].includes(execution?.phase)
    || ['pauseRequested', 'paused', 'stopRequested', 'stopped'].some(key => executionControl?.[key]);
  const summary = execution?.summary;
  const summaries = (summary?.history || []).filter(row => typeof row.text === 'string' && row.text.trim()).map(row => ({ ...row, text: executionStatusText(row.text.trim()) }));
  const currentText = executionStatusText(summary?.text?.trim());
  if (currentText && summaries.at(-1)?.text.trim() !== currentText) summaries.push({ text: currentText, generatedAt: summary.generatedAt || execution.updatedAt, watermark: summary.watermark });
  const rows = [];
  for (const worker of [execution?.worker, ...execution?.children || []].filter(Boolean)) {
    const status = statusLabels[worker.status] ? worker.status : 'unknown';
    const child = worker !== execution.worker;
    const history = (worker.history || []).filter(row => typeof row.activity === 'string' && row.activity.trim());
    const last = history.at(-1);
    const candidate = last?.activitySource === 'report' ? last : last?.status === 'completed' ? history.at(-2) : null;
    // Keep the last reported action at the same current node when execution ends.
    // Earlier running records remain history, not proof that every reported action succeeded.
    const completedReport = status === 'completed' && candidate?.activitySource === 'report' ? candidate : null;
    const active = status === 'running' && !inactive && !worker.historical;
    const state = executionControl?.stopRequested && status === 'running' ? '等待执行端退出'
      : (recentOnly || worker.historical) && status === 'running' ? '上次记录为运行中'
        : status === 'running' && !active ? '当前未执行' : child && status === 'completed' ? '子任务已完成' : statusLabels[status];
    const text = status === 'completed' ? visibleExecutionActivity(completedReport?.activity)
      : visibleExecutionActivity(worker.activity) || (status === 'running' ? '' : state);
    rows.push({ id: worker.id, worker: true, text, time: worker.updatedAt, status, state, active,
      markStatus: status === 'running' && !active ? 'waiting' : status });
    for (const entry of [...history].reverse()) {
      const historicalText = visibleExecutionActivity(entry.activity);
      if (!historicalText || entry === completedReport) continue;
      // The final retained event is already represented by the current fact.
      if (entry === last && entry.status === status && historicalText === text) continue;
      rows.push({ id: `${worker.id}:history:${entry.seq}`, historyWorker: worker.id, text: historicalText,
        time: entry.time, status: statusLabels[entry.status] ? entry.status : 'unknown', markStatus: entry.status === 'running' ? 'history' : entry.status,
        state: `历史动态 · 当时${statusLabels[entry.status] || '状态未知'}` });
    }
  }
  const activityTexts = new Set(rows.map(row => row.text));
  rows.push(...summaries.map((row, index) => ({ id: `summary:${row.watermark ?? row.generatedAt}:${index}`, text: visibleExecutionActivity(row.text), time: row.generatedAt, status: 'summary' }))
    .filter(row => row.text && !activityTexts.has(row.text)).reverse());
  if (outcome && !rows.some(row => row.text === outcome.trim())) rows.push({ id: 'outcome', text: outcome.trim(), time: execution?.updatedAt, status: 'completed' });
  rows.sort((a, b) => (stamp(b.time)?.getTime() || 0) - (stamp(a.time)?.getTime() || 0));
  const scope = [summary?.historyTruncated && '仅保留最近的阶段进展。', [execution?.worker, ...execution?.children || []].some(worker => worker?.historyTruncated) && '每个执行会话最多保留最近 64 条执行动态。', '时间线按时间倒序展示已保存的动作摘要与执行状态，未记录的历史不会补造。', sessionAvailable ? '完整过程可通过查看执行会话打开。' : '当前未能定位原执行会话。'].filter(Boolean).join('');
  return <section className="ba-task-execution" aria-labelledby={titleId}>
    <style>{css}</style>
    <div className="ba-progress-heading"><h3 id={titleId}>全执行记录</h3><Tooltip label={scope} maxWidth={360} portal openOnClick><Button variant="ghost" size="icon" className="ba-execution-scope" aria-label="记录范围"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></svg></Button></Tooltip></div>
    {stale && <p className="ba-execution-notice" role="status">动态更新暂不可用，以下保留上次记录。</p>}
    {!rows.length && <ResourceState icon="schedules" title="还没有执行记录" description="执行产生进展后会在这里实时更新。" />}
    <ol className="ba-execution-timeline" aria-label="执行时间线">{rows.map(row => <li key={row.id} className="ba-execution-worker" data-worker-id={row.worker ? row.id : undefined} data-worker-status={row.worker ? row.status : undefined} data-history-worker-id={row.historyWorker}>
      <ExecutionMark status={row.markStatus || row.status} active={row.active} label={row.state || '依据公开执行内容生成的进度摘要'} />
      <div className="ba-execution-worker-body">{row.text && <Tooltip label={row.state || '依据公开执行内容生成的进度摘要'}><p tabIndex={0} aria-label={row.state ? `${row.text} · ${row.state}` : undefined}>{row.text}</p></Tooltip>}<UpdatedAt value={row.time} /></div>
    </li>)}</ol>
    {execution?.uncertainty?.automatic && execution.uncertainty.reasonCode === 'saved-result-pending' && executionStatusText(execution.uncertainty.reason) !== currentText && <p className="ba-execution-notice" role="status">{executionStatusText(execution.uncertainty.reason) || '正在自动保存执行结果。'}</p>}
    {execution?.limitation && <p className="ba-execution-notice">{execution.limitation}</p>}
  </section>;
}
