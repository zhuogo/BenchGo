import { Button } from '../../shared/client/ui/button.jsx';
import React, { useId, useMemo, useState } from 'react';
import { AssistantCard, inspectCardHtml } from './card.jsx';
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './identity-card-editor.css';

export function IdentityCardEditor({ config, onChange, defaultName }) {
  const custom = config.cardHtml !== null && config.cardHtml !== undefined;
  const [editing, setEditing] = useState(false);
  const id = useId();
  const inspection = useMemo(() => inspectCardHtml(config.cardHtml), [config.cardHtml]);
  const toggleLabel = editing ? '收起 HTML 编辑' : '编辑 HTML';
  return <section className="ba-card-editor">
    <style>{css}</style>
    <div className="ba-card-editor-heading">
      <div><h3>侧栏名片</h3><p>在工作台侧栏展示你的助手。</p></div>
      <div className="ba-card-editor-actions">
        {!custom && <label className="ba-card-motion"><span>动态效果</span><input type="checkbox" role="switch" checked={config.cardMotion !== false} onChange={event => onChange({ cardMotion: event.target.checked })} /></label>}
        <Tooltip label={toggleLabel} delayMs={450} portal><Button variant="ghost" type="button" className="ba-card-code-toggle" aria-label={toggleLabel} aria-expanded={editing} aria-controls={id + '-panel'} onClick={() => setEditing(!editing)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 7-5 5 5 5m10-10 5 5-5 5M14 4l-4 16" /></svg></Button></Tooltip>
      </div>
    </div>
    <div className="ba-card-preview-stage"><div className="ba-card-preview"><AssistantCard pet={config.pet} name={config.name || defaultName} html={config.cardHtml} motion={config.cardMotion !== false} /></div><span className="ba-card-preview-caption"><i aria-hidden="true" />{custom ? '自定义名片' : '当前形象'}</span></div>
    {custom && <div className="ba-card-custom-note"><span>当前使用 HTML 名片，修改后可在上方预览。</span><Button variant="ghost" type="button" onClick={() => onChange({ cardHtml: null })}>使用当前形象</Button></div>}
    <div id={id + '-panel'} hidden={!editing}>
      {editing && <div className="ba-card-code"><label htmlFor={id + '-html-input'}>HTML / CSS</label><textarea id={id + '-html-input'} aria-describedby={inspection.issues.length ? id + '-issues' : undefined} rows={4} maxLength={16000} spellCheck={false} placeholder="<div>你好，我在这里</div>" value={config.cardHtml || ''} onChange={event => onChange({ cardHtml: event.target.value })} /><span className="ba-card-code-count">{(config.cardHtml || '').length} / 16000</span>{inspection.issues.length > 0 && <ul className="ba-card-issues" id={id + '-issues'} role="status">{inspection.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}</div>}
    </div>
  </section>;
}
