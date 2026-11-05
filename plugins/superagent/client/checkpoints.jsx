import { Button } from '../../shared/client/ui/button.jsx';
import React, { useState } from 'react';

const terminal = new Set(['completed', 'failed', 'cancelled', 'closed']);
const labels = { delete: '删除', restore: '恢复', replace: '替换' };

export function CheckpointRestore({ ticket, plan, restore, onRestored }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState(null);
  const stopped = terminal.has(ticket.status) && (ticket.assignments || []).every(row => terminal.has(row.state));
  const conflicts = plan.conflicts || [];
  const submit = async () => {
    if (busy || result || !stopped || conflicts.length || !plan.token) return;
    setBusy(true); setError('');
    try { const value = await restore({ ticketId: ticket.id, runId: plan.runId, token: plan.token }); setResult(value); await onRestored?.(); }
    catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  return <section className="ba-stack" aria-label="检查点恢复预览"><h3>整轮文件恢复预览</h3><p className="ba-note">工作区：{plan.directory}</p>
    <p className="ba-note">只恢复本轮已备份的文件。已发送的消息、请求和其他外部操作不会撤销。</p>
    <h4>文件变化</h4>{plan.changes?.length ? <ul>{plan.changes.map(row => <li key={row.path}>{labels[row.action] || row.action} · {row.path}</li>)}</ul> : <p className="ba-note">没有需要恢复的文件变化。</p>}
    <h4>不在恢复范围</h4><p className="ba-note">{plan.excluded?.length ? plan.excluded.join('、') : '未提供排除项，请重新读取预览。'}</p>
    {!!conflicts.length && <div role="alert"><p>以下文件与检查点冲突，不能覆盖恢复：</p><ul>{conflicts.map(path => <li key={path}>{path}</li>)}</ul></div>}
    {!stopped && <p className="ba-note" role="status">请先终止工单，等待所有执行结束并由宿主确认释放。待核实执行不能恢复。</p>}
    {error && <p role="alert">{error}</p>}
    {result ? <div role="status"><p>文件已恢复，恢复前备份：{result.backupId}</p><p>外部操作未撤销。原执行已禁止续行，继续工作请重新授权开单。</p></div> : <Button type="button" className="ba-primary" disabled={busy || !stopped || !!conflicts.length || !plan.token || !Array.isArray(plan.excluded) || plan.externalEffectsReverted !== false} onClick={submit}>{busy ? '恢复中…' : '确认整轮文件恢复'}</Button>}
  </section>;
}

export function TicketCheckpoints({ ticket, list, preview, restore, reload }) {
  const [rows, setRows] = useState(null), [plan, setPlan] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = async () => {
    setBusy(true); setError(''); setPlan(null);
    try { setRows(await list({ ticketId: ticket.id })); }
    catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  const inspect = async runId => {
    setBusy(true); setError(''); setPlan(null);
    try { setPlan(await preview({ ticketId: ticket.id, runId })); }
    catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  const runs = new Map();
  for (const row of rows || []) {
    if (row.kind !== 'action') continue;
    if (!runs.has(row.runId)) runs.set(row.runId, { runId: row.runId, count: 0, incomplete: false, restored: false });
    const run = runs.get(row.runId); run.count++; run.incomplete ||= row.state !== 'complete'; run.restored ||= !!row.restoredAt;
  }
  return <section className="ba-stack" aria-label="工单检查点"><Button variant="ghost" type="button" className="ba-quiet" disabled={busy} onClick={load}>{busy ? '读取中…' : '查看文件检查点'}</Button>
    {error && <p role="alert">{error}</p>}{rows && !runs.size && <p className="ba-note">尚无可恢复的动作检查点。</p>}
    {Array.from(runs.values()).map(run => <div key={run.runId}><p className="ba-note">执行 {run.runId} · {run.count} 个动作备份{run.restored ? ' · 已恢复' : run.incomplete ? ' · 备份状态待核实' : ''}</p><Button variant="ghost" type="button" className="ba-quiet" disabled={busy || run.incomplete || run.restored} onClick={() => inspect(run.runId)}>预览整轮恢复</Button></div>)}
    {plan && <CheckpointRestore key={plan.token} ticket={ticket} plan={plan} restore={restore} onRestored={reload} />}
  </section>;
}
