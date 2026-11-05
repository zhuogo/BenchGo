import React, { useEffect, useId, useRef, useState } from 'react';
import { AssistantDocuments } from './documents.jsx';
import css from './memory.css';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import { ResourceIcon } from '../../shared/client/resource-icon.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { ResourceState } from './resource-state.jsx';
import { groupByDay } from './time-groups.mjs';

export function MemoryPage({ api, refresh, onDirtyChange, entries, threadId }) {
  const [tab, setTab] = useState('entries'), [dirty, setDirty] = useState(false), id = useId();
  const reportDirty = React.useCallback(value => { setDirty(value); onDirtyChange?.(value); }, [onDirtyChange]);
  const choose = next => {
    if (next === tab) return;
    if (dirty && !window.confirm('切换视图会放弃未保存的记忆修改。')) return;
    reportDirty(false); setTab(next);
  };
  return <section className="ba-memory-page"><style>{css}</style>
    <SegmentedControl options={[{ value: 'entries', label: '记忆动态', icon: <ResourceIcon name="feed" size={16} /> }, { value: 'document', label: 'MEMORY.md', icon: <ResourceIcon name="book" size={16} /> }]} value={tab} onChange={choose} label="记忆视图" tabIdPrefix={id} panelId={`${id}-panel`} />
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} tabIndex={0}>{tab === 'entries' ? <MemoryFeed api={api} refresh={refresh} entries={entries} threadId={threadId} onDirtyChange={reportDirty} /> : <AssistantDocuments api={api} refresh={refresh} memory onDirtyChange={reportDirty} />}</div>
  </section>;
}

export function MemoryFeed({ api, entries = [], refresh, threadId, onDirtyChange }) {
  const [draft, setDraft] = useState(''), [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState(null);
  const composer = useRef(null), inFlight = useRef(false), composerId = useId();
  const dirty = editing ? draft !== editing.content : Boolean(draft.trim());
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);

  // A completed write must not become a failed save merely because refreshing fails.
  async function mutate(operation, message, onSaved) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setFeedback(null);
    try {
      await operation(); onSaved();
      try { await refresh(); setFeedback({ message }); }
      catch (cause) { setFeedback({ error: true, refresh: true, message: `${message}；列表刷新失败：${cause.message || String(cause)}` }); }
    } catch (cause) { setFeedback({ error: true, message: cause.message || String(cause) }); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function retryRefresh() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { await refresh(); setFeedback({ message: '记忆已更新' }); }
    catch (cause) { setFeedback({ error: true, refresh: true, message: `列表刷新失败：${cause.message || String(cause)}` }); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function clearDraft() { setDraft(''); setEditing(null); }
  function edit(entry) {
    if (editing?.id === entry.id) { composer.current?.focus(); return; }
    if (dirty && !window.confirm('编辑这条记忆会放弃当前草稿。')) return;
    setEditing(entry); setDraft(entry.content); setFeedback(null);
    composer.current?.focus();
    composer.current?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  const save = event => {
    event.preventDefault();
    if (!draft.trim() || !dirty) return;
    return mutate(() => api('memorySave', {
      memory: { ...(editing ? { id: editing.id } : {}), content: draft, source: editing?.source || { kind: 'user', threadId } },
      ...(editing ? { revision: editing.revision } : {}),
    }), editing ? '记忆已修改' : '已记住', clearDraft);
  };
  const forget = entry => mutate(() => api('memoryDelete', { id: entry.id, revision: entry.revision }), '已忘记这条记忆', () => {
    if (editing?.id === entry.id) clearDraft();
  });
  const groups = groupByDay(entries, entry => entry.updatedAt || entry.createdAt);
  const sourceLabel = entry => entry.document === 'USER.md' ? '关于你' : entry.document === 'TOOLS.md' ? '工具笔记' : '长期记忆';
  return <section className="ba-memory-feed" aria-busy={busy}>
    <form className="ba-memory-compose" data-editing={!!editing} onSubmit={save}>
      <label htmlFor={composerId} className="ba-memory-compose-title"><UIIcon name="edit" size={16} /><span>{editing ? '修改这段记忆' : '有什么值得记住？'}</span></label>
      <textarea id={composerId} ref={composer} rows={3} maxLength={16000} disabled={busy} placeholder="一个偏好、一项决定，或想让助手记住的小事…" value={draft} onChange={event => setDraft(event.target.value)} />
      <footer><span>对话记忆自动记录，无需逐条确认</span><div className="ba-row-actions">
        {editing && <Button variant="ghost" type="button" className="ba-quiet" disabled={busy} onClick={() => { if (dirty && !window.confirm('取消会放弃未保存的记忆修改。')) return; clearDraft(); }}>取消</Button>}
        <Button variant="default" type="submit" className="ba-primary" disabled={busy || !draft.trim() || !dirty}>{busy ? '处理中…' : editing ? '保存修改' : '记下来'}</Button>
      </div></footer>
    </form>
    {feedback && <div className="ba-memory-feedback" data-error={feedback.error || undefined} role={feedback.error ? 'alert' : 'status'}><UIIcon name={feedback.error ? 'bulb' : 'check'} size={16} /><span>{feedback.message}</span>{feedback.refresh && <Button variant="outline" type="button" disabled={busy} onClick={retryRefresh}>重试刷新</Button>}</div>}
    <div className="ba-memory-feed-heading"><h3>记忆时间线</h3><span>{entries.length} 条 · 按最近更新</span></div>
    {!entries.length && <ResourceState icon="bulb" title="从一件小事开始" description="对话中值得记住的内容会自动记录，你也可以在这里补充。" actionLabel="写下第一条记忆" onAction={() => composer.current?.focus()} />}
    <div className="ba-memory-posts">{groups.map(group => <section className="ba-memory-day" key={group.key}>
      <h4>{group.label}<span>{group.entries.length} 条</span></h4>
      {group.entries.map(entry => {
        const time = entry.updatedAt || entry.createdAt;
        return <article className="ba-memory-post" key={entry.id} data-editing={editing?.id === entry.id}>
          <header><span className="ba-memory-source">{sourceLabel(entry)}</span><span>{time && !Number.isNaN(new Date(time).getTime()) ? <time dateTime={time}>{new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</time> : '手动记录'}</span></header>
          <p>{entry.content}</p>
          <footer><Button variant="ghost" type="button" className="ba-quiet" disabled={busy} onClick={() => edit(entry)}><UIIcon name="edit" size={15} />编辑</Button><Button variant="ghost" type="button" className="ba-quiet" disabled={busy} onClick={() => forget(entry)}><UIIcon name="trash" size={15} />忘记</Button></footer>
        </article>;
      })}
    </section>)}</div>
  </section>;
}
