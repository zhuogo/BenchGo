import { Button } from '../../shared/client/ui/button.jsx';
import React, { useEffect, useId, useRef, useState } from 'react';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import { ResourceIcon } from '../../shared/client/resource-icon.jsx';

const labels = { 'USER.md': '主人档案', 'IDENTITY.md': '我的身份', 'SOUL.md': '我的人设', 'AGENTS.md': '工作约定', 'TOOLS.md': '工具笔记', 'MEMORY.md': '共同记忆' };
const descriptions = { 'USER.md': '你的偏好、背景与习惯，让每次协作更合拍。', 'IDENTITY.md': '助手的名字与身份，在每一次对话中保持一致。', 'SOUL.md': '定义助手的性格、表达方式与价值取向。', 'AGENTS.md': '把协作原则与工作流程，变成助手遵循的约定。', 'TOOLS.md': '记录工具的用法与环境细节，减少重复说明。', 'MEMORY.md': '值得长期记住的事情，留在你们的共同记忆里。' };

export function AssistantDocuments({ api, refresh, memory = false, onDirtyChange }) {
  const initial = memory ? 'MEMORY.md' : 'USER.md', panelId = useId();
  const [selected, setSelected] = useState(initial);
  const [base, setBase] = useState(null), [draft, setDraft] = useState('');
  const [preview, setPreview] = useState(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const dirty = !!base && draft !== base.content;
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  async function load(name) {
    const at = ++generation.current; setBusy(true); setError(''); setPreview(null); setNotice('');
    try {
      const response = await api('profileDocuments', { op: 'list' });
      const rows = response.documents;
      if (at !== generation.current) return;
      const document = rows.find(row => row.name === name);
      if (!document) throw new Error('档案文件不存在');
      setSelected(name); setBase(document); setDraft(document.content);
    } catch (cause) { if (at === generation.current) setError(cause.message); }
    finally { if (at === generation.current) setBusy(false); }
  }
  useEffect(() => { void load(initial); return () => { generation.current++; }; }, []);
  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await api('profileDocuments', { op: 'update', name: selected, content: draft, expectedHash: base.hash });
      setBase(response.document); setDraft(response.document.content); setPreview(null); setNotice('已保存，下次请求生效');
      await refresh();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  return <section className="ba-group ba-documents">
    {!memory && <SegmentedControl options={Object.entries(labels).filter(([name]) => name !== 'MEMORY.md').map(([value, label]) => ({ value, label }))} value={selected} onChange={load} label="档案文件" panelId={panelId} disabled={busy || dirty} />}
    {error && <div className="ba-document-alert"><ResourceIcon name="document" size={20} /><div><strong>{base ? '档案更新未完成' : '暂时无法读取档案'}</strong><p className="ba-document-error" role="alert">{error}{base ? '。草稿已保留，可复制后重新载入。' : ''}</p></div><Button variant="outline" type="button" disabled={busy} onClick={() => { if (!dirty || window.confirm('重新载入会放弃此处未保存的草稿。')) void load(selected); }}>重试读取</Button></div>}
    {base && <div className="ba-document-editor" id={panelId} role={memory ? undefined : 'tabpanel'} aria-labelledby={memory ? undefined : `${panelId}-${selected}`} aria-busy={busy}>
      <header className="ba-document-heading"><span className="ba-document-symbol"><ResourceIcon name={memory ? 'book' : 'document'} size={22} /></span><div><h2>{labels[selected]}</h2><p>{descriptions[selected]}</p></div><span className="ba-document-file">{selected}</span></header>
      <label><span><span>档案正文</span><small>{draft.length.toLocaleString()} 字符 · Markdown</small></span><textarea aria-label={`${selected} 正文`} rows={16} value={draft} disabled={busy} placeholder="写下想让助手了解的内容…" onChange={event => { setDraft(event.target.value); setPreview(null); setNotice(''); }} /></label>
      <div className="ba-document-actions" data-dirty={dirty}><span className="ba-document-sync" data-dirty={dirty} role="status">{busy ? '处理中…' : notice || (dirty ? '有未保存的修改，保存后可切换档案。' : '已与文件同步')}</span><div className="ba-row-actions"><Button variant="ghost" type="button" disabled={busy} onClick={() => { if (!dirty || window.confirm('重新载入会放弃此处未保存的草稿。')) void load(selected); }}>重新载入</Button><Button variant="ghost" type="button" disabled={busy || !dirty} onClick={() => setPreview(preview ? null : { before: base.content, after: draft })}>{preview ? '收起预览' : '预览修改'}</Button><Button variant="default" type="button" className="ba-primary" disabled={busy || !dirty} onClick={save}>保存</Button></div></div>
      {preview && <div className="ba-document-diff"><section><strong>当前正文</strong><pre>{preview.before}</pre></section><section><strong>将保存的正文</strong><pre>{preview.after}</pre></section></div>}
    </div>}
    {!base && busy && <div className="ba-document-loading" role="status" aria-busy="true"><ResourceIcon name="document" size={24} /><strong>正在读取档案…</strong><div className="ba-document-skeleton" aria-hidden="true"><i /><i /><i /><i /></div></div>}
  </section>;
}
