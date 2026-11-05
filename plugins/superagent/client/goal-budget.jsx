import { Button } from '../../shared/client/ui/button.jsx';
import React, { useEffect, useState } from 'react';
import { ResourceState } from './resource-state.jsx';

const fields = [['requests', '请求次数'], ['tokens', 'Token 数']];
export function budgetDraft(budget = {}) {
  const result = Object.fromEntries(fields.map(([key]) => [key, budget[key] === undefined ? '' : String(budget[key])]));
  const date = budget.deadline === undefined ? null : new Date(budget.deadline);
  result.deadline = date && Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, -1) : '';
  return result;
}
export function parseBudget(draft) {
  const result = {};
  for (const [key, label] of fields) {
    if (!draft[key]?.trim()) continue;
    const value = Number(draft[key]);
    if (!Number.isFinite(value) || value < 0 || (key !== 'cost' && !Number.isSafeInteger(value))) throw new Error(`${label}须为非负${key === 'cost' ? '数字' : '整数'}`);
    result[key] = value;
  }
  if (draft.deadline) {
    result.deadline = new Date(draft.deadline).getTime();
    if (!Number.isSafeInteger(result.deadline) || result.deadline < 0) throw new Error('截止时间无效');
  }
  return result;
}
export function BudgetFields({ value, onChange }) {
  return <><div className="ba-goal-fields">{fields.map(([key, label]) => <label key={key}>{label}<input type="number" min="0" step="1" value={value[key]} placeholder="不限制" onChange={event => onChange({ ...value, [key]: event.target.value })} /></label>)}<label>截止时间（本地时间）<input type="datetime-local" step="any" value={value.deadline} onChange={event => onChange({ ...value, deadline: event.target.value })} /></label></div><p className="ba-note">留空表示不限制，0 表示不允许新增消耗。Token 按已报告用量限制后续请求，可能超出额度；未报告的用量不算作 0。费用尚无可靠计价来源，暂不支持设置费用额度。</p></>;
}
export function GoalBudget({ row, api, reload, onDirtyChange }) {
  const state = row.budgetState;
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(budgetDraft(state?.budget));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [version, setVersion] = useState(state?.version);
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(budgetDraft(state?.budget));
  useEffect(() => { onDirtyChange?.(row.id, dirty); return () => onDirtyChange?.(row.id, false); }, [dirty, row.id, onDirtyChange]);
  if (!state) return <ResourceState icon="folder" title="预算记录暂不可用" description="重新读取目标，查看已记录的用量与执行额度。" actionLabel="重新读取" onAction={reload} />;
  const save = async event => {
    event.preventDefault(); if (busy) return;
    setError(''); setBusy(true);
    try { await api('goalBudgetUpdate', { id: row.id, budget: parseBudget(draft), expectedVersion: version }); setEditing(false); await reload(); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  return <div className="ba-goal-budget"><p className="ba-note">累计用量{state.parentGoalId ? ` · 同时受父目标 ${state.parentGoalId} 额度约束` : ''}</p><div className="ba-goal-fields">{fields.map(([key, label]) => <div key={key}><span>{label}：</span><strong>{state.usage?.[key] ?? '—'}</strong><span> / {state.budget[key] ?? '不限制'}</span></div>)}</div>
    {!!(state.usage?.unknownTokens || state.usage?.unknownCost) && <p className="ba-note">另有 {state.usage.unknownTokens || 0} 次 Token 用量、{state.usage.unknownCost || 0} 次费用未报告，以上仅为已知累计。</p>}
    {state.budget.deadline !== undefined && <p className="ba-note">截止：{new Date(state.budget.deadline).toLocaleString()}</p>}
    {error && <p role="alert">{error}</p>}
    {editing ? <form onSubmit={save}><fieldset disabled={busy}><BudgetFields value={draft} onChange={setDraft} /><p className="ba-note">保存不会清零历史用量，也不会自动恢复执行。预算等待时使用“继续执行”恢复任务或验收。</p><Button className="ba-primary" type="submit">{busy ? '保存中…' : '保存预算'}</Button><Button variant="ghost" className="ba-quiet" type="button" onClick={() => { setEditing(false); setError(''); }}>取消</Button></fieldset></form> : !['completed', 'failed', 'cancelled', 'cancelling'].includes(row.status) && <Button variant="ghost" type="button" className="ba-quiet" onClick={() => { setDraft(budgetDraft(state.budget)); setVersion(state.version); setError(''); setEditing(true); }}>调整预算</Button>}
  </div>;
}
