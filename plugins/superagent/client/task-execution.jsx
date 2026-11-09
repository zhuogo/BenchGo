import React, { useId } from 'react';
import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import css from './task-execution.css';

const statusLabels = { running: '运行中', waiting: '等待后续', completed: '执行结束', failed: '执行失败', cancelled: '已停止', unknown: '状态未知' };
const stamp = value => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date : null;
};

function UpdatedAt({ value }) {
  const date = stamp(value);
  return date ? <time dateTime={date.toISOString()} title={date.toLocaleString('zh-CN')}>{date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time> : <span>时间未记录</span>;
}

function ExecutionMark({ status }) {
  const paths = status === 'completed' ? <path d="m4 8 3 3 5-6" /> : status === 'failed' ? <><path d="m5 5 6 6m0-6-6 6" /></> : status === 'cancelled' ? <path d="M5 8h6" /> : null;
  return <span className="ba-execution-mark" data-status={status} aria-hidden="true">{paths ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths}</svg> : <i />}</span>;
}

function ExecutorRow({ worker, child = false, recentOnly = false }) {
  const status = statusLabels[worker.status] ? worker.status : 'unknown';
  const label = worker.label || (child ? '子 Worker' : '主 Worker');
  const statusText = recentOnly && status === 'running' ? '上次记录为运行中' : child && status === 'completed' ? '已返回父 Worker' : statusLabels[status];
  const summary = worker.activity?.trim() || (status === 'running' ? '等待新的执行动态' : statusText);
  return <li className="ba-execution-worker" data-worker-id={worker.id} data-worker-status={status} title={`${statusText} · 最近活动：${stamp(worker.updatedAt)?.toLocaleString('zh-CN') || '时间未记录'}`}>
    <ExecutionMark status={status} />
    <div className="ba-execution-worker-body">
      <div className="ba-execution-worker-heading"><strong title={label}>{label}</strong>{(recentOnly || status !== 'running') && summary !== statusText && <span className="ba-execution-status" data-status={status}>{statusText}</span>}</div>
      <p title={summary}>{summary}</p>
    </div>
  </li>;
}

/** A projection of observed execution only; no inferred percentage or transcript text. */
export function TaskExecution({ execution, ticketStatus, stale = false }) {
  const titleId = useId();
  const children = execution?.children || [];
  const counts = execution?.childCounts;
  const currentChildren = children.filter(worker => worker.status !== 'completed');
  const completed = [execution?.worker && { ...execution.worker, child: false }, ...children.map(worker => ({ ...worker, child: true }))].filter(worker => worker?.status === 'completed');
  const recentOnly = stale || execution?.observed === false || (ticketStatus && !['open', 'claimed', 'verifying', 'resuming'].includes(ticketStatus));
  if (!execution?.worker && !children.length) return execution?.limitation ? <p className="ba-execution-notice">{execution.limitation}</p> : null;
  return <section className="ba-task-execution" aria-labelledby={titleId}>
    <style>{css}</style>
    <div className="ba-execution-heading"><h3 id={titleId}>{recentOnly ? '最近执行记录' : '执行动态'}</h3>{execution && <span className="ba-execution-updated">最近更新 <UpdatedAt value={execution.updatedAt} /></span>}</div>
    {stale && <p className="ba-execution-notice" role="status">动态更新暂不可用，以下保留上次记录。</p>}
    {!stale && recentOnly && [execution?.worker, ...children].some(worker => worker?.status === 'running') && <p className="ba-execution-notice">以下为最近一次执行记录，不代表 Worker 当前仍在运行。</p>}
    <div className="ba-execution-timeline">
      <div className="ba-execution-current">
      {execution.worker && execution.worker.status !== 'completed' && <ul className="ba-execution-workers" aria-label="主 Worker"><ExecutorRow worker={execution.worker} recentOnly={recentOnly} /></ul>}
      {currentChildren.length > 0 && <><div className="ba-execution-children-heading"><h4>子 Worker</h4>{counts && <span>{counts.completed || 0}/{counts.total} 已返回</span>}</div>
      <ul className="ba-execution-workers ba-execution-children" aria-label="子 Worker">{currentChildren.map(child => <ExecutorRow key={child.id} worker={child} recentOnly={recentOnly} child />)}</ul></>}
      </div>
      {completed.length > 0 && <Disclosure className="ba-execution-completed" title={`已结束步骤 · ${completed.length}`}><ul className="ba-execution-workers" aria-label="已结束步骤">{completed.map(worker => <ExecutorRow key={worker.id} worker={worker} child={worker.child} recentOnly={recentOnly} />)}</ul></Disclosure>}
      {execution.limitation && <p className="ba-execution-notice">{execution.limitation}</p>}
    </div>
  </section>;
}
