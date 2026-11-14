import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { TaskDetail } from './task-list.jsx';
import { ResourceState } from './resource-state.jsx';
import { activityLabels } from './activity-data.mjs';

/** A frozen server manifest is the sole authority for either presentation change. */
export function TaskCleanup({ api, mode, taskIds, onClose, onChanged }) {
  const restore = mode === 'restore';
  const verb = restore ? '恢复展示' : '归档';
  const [preview, setPreview] = useState(null), [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(true), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const request = useRef(null);
  useEffect(() => {
    let current = true;
    setLoading(true); setReady(false); setError(''); request.current = null;
    void api(restore ? 'taskCleanupRestorePreview' : 'taskCleanupPreview', { taskIds, requestId: crypto.randomUUID() }).then(value => {
      if (!current) return;
      if (!value?.previewId || !value?.manifestHash || !Array.isArray(value.items) || !Array.isArray(value.excluded)) throw new Error('清单未完整返回，请重新读取。');
      setPreview(value); setSelected(value.items.map(item => item.id)); setReady(true);
    }).catch(cause => { if (current) setError(cause.message || '清单读取失败'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, restore, taskIds, attempt]);
  const submit = async () => {
    if (busy || loading || !ready || !preview || !selected.length) return;
    setBusy(true); setError('');
    const signature = JSON.stringify([preview.previewId, selected]);
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    try {
      await api(restore ? 'taskCleanupRestore' : 'taskCleanupCommit', { previewId: preview.previewId, manifestHash: preview.manifestHash, selectedTaskIds: selected, requestId: request.current.id });
      await onChanged(selected);
    } catch (cause) { setError(cause.message || `${verb}未完成，请重试`); }
    finally { setBusy(false); }
  };
  const updateSelection = (id, checked) => { setSelected(values => checked ? [...values, id] : values.filter(value => value !== id)); };
  return <TaskDetail inline open title={`${verb}任务`} onClose={() => { if (!busy) onClose(); }} footer={preview?.items.length > 0 && <div className="ba-row-actions"><Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button disabled={busy || loading || !ready || !selected.length} onClick={submit}>{busy ? '正在提交…' : `确认${verb} ${selected.length} 项`}</Button></div>}>
    <p className="ba-note">{restore ? '恢复后任务重新显示在原状态中，成果与执行记录保留。' : '仅整理已结束任务的展示位置，成果、执行记录及关联文件全部保留。请核对本次清单，可取消勾选以缩小范围。'}</p>
    {loading && !preview && <ResourceState kind="loading" title={`正在准备${verb}清单`} />}
    {loading && preview && <p role="status" className="ba-note">正在重新核对清单…</p>}
    {error && <ResourceState kind="error" title={preview ? `${verb}尚未完成` : `${verb}清单暂时无法读取`} description={error} actionLabel="重新核对清单" onAction={() => { if (!busy && !loading) setAttempt(value => value + 1); }} />}
    {preview && <>
      {preview.items.length ? <section className="ba-cleanup-manifest" aria-label={`${verb}清单`} aria-busy={loading || busy}>
        <div className="ba-cleanup-summary"><strong>已选 {selected.length} / {preview.items.length} 项</strong><Button variant="ghost" disabled={busy || loading} onClick={() => setSelected(selected.length === preview.items.length ? [] : preview.items.map(item => item.id))}>{selected.length === preview.items.length ? '取消全选' : '全选'}</Button></div>
        <ul>{preview.items.map(item => <li key={item.id}><label><input type="checkbox" checked={selected.includes(item.id)} disabled={busy || loading} onChange={event => updateSelection(item.id, event.target.checked)} /><span><strong>{item.title || item.id}</strong><span className="ba-cleanup-item-state">原状态：{activityLabels[item.status] || item.status || '未记录'}</span><small>{restore ? '恢复展示标记，保持原任务状态' : '归档后保留成果与执行记录，可在“已归档”中恢复展示'}</small></span></label></li>)}</ul>
      </section> : !loading && !error && <ResourceState icon="archive" title={`没有可${verb}的任务`} description={restore ? '当前范围内没有手动归档的任务。' : '当前范围内没有可归档的已结束任务。正在执行的任务会继续保留。'} />}
      {!!preview.excluded.length && <section className="ba-cleanup-excluded" aria-label="未纳入清单"><h3>未纳入清单 · {preview.excluded.length} 项</h3><ul>{preview.excluded.map((item, index) => <li key={item.id || index}><strong>{item.title || item.id || '任务'}</strong><span>{item.reason || '当前不可操作'}</span></li>)}</ul></section>}
      {!!preview.items.length && <p className="ba-note">点击确认仅批准本次勾选的任务。清单状态发生变化时需重新核对。</p>}
    </>}
  </TaskDetail>;
}
