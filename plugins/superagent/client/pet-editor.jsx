import { Button } from '../../shared/client/ui/button.jsx';
import React, { useEffect, useId, useRef, useState } from 'react';
import { Switch, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { PetAvatar } from '../../shared/client/pet-avatar.jsx';
import css from './pet-editor.css';

// Storage and revision handling stay with the owning SuperAgent settings view.
export function PetEditor({ name, pet, currentSrc, previewSrc, motion = true, motionNotice = '', busy = false, expressions = [], canRestore = false, onUpload, onApply, onCancel, onRestore, onReset, onMotionChange, onDesign, onExpression }) {
  const input = useRef(null);
  const id = useId();
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const [previewAction, setPreviewAction] = useState({ action: 'idle', key: 0 });
  useEffect(() => {
    if (previewAction.action === 'idle') return;
    const timer = setTimeout(() => setPreviewAction(value => ({ ...value, action: 'idle' })), 2400);
    return () => clearTimeout(timer);
  }, [previewAction.key]);
  const disabled = busy || reading;
  async function upload(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setError('请选择 PNG、WebP 或 JPEG 图片。'); return; }
    if (file.size > 8 * 1024 * 1024) { setError('图片不能超过 8 MB。'); return; }
    setReading(true);
    try { await onUpload(file); } catch (cause) { setError(cause.message || '图片读取失败，请重试。'); } finally { setReading(false); }
  }
  return <section className="ba-pet-editor" aria-labelledby={id + '-title'}>
    <style>{css}</style>
    <header><h3 id={id + '-title'}>我的形象</h3><span>外观改变，记忆与经历继续保留</span></header>
    <div className="ba-pet-editor-preview">
      <PetAvatar key={previewAction.key} pet={pet} src={previewSrc || currentSrc} alt={`${name || '助手'}的形象`} size={144} action={previewAction.action} motion={motion} />
      <div className="ba-pet-editor-summary"><strong>{name || '未命名'}</strong><p>{previewSrc ? '新形象预览，应用后生效' : '可以保留默认形象，也可以创造完全不同的自己。'}</p><div className="ba-pet-editor-actions">
        <Button variant="secondary" type="button" className="ba-secondary" disabled={disabled} onClick={() => input.current?.click()}>{reading ? '读取中…' : '上传图片'}</Button>
        {onDesign && <Button variant="secondary" type="button" className="ba-secondary" disabled={disabled} onClick={onDesign}>让 AI 帮我设计</Button>}
      </div><small>PNG / WebP / JPEG，最大 8 MB</small></div>
    </div>
    <input ref={input} hidden type="file" accept="image/png,image/webp,image/jpeg" onChange={upload} disabled={disabled} />
    {error && <p className="ba-note" role="alert">{error}</p>}
    {previewSrc && <div className="ba-pet-editor-actions"><Button variant="default" type="button" className="ba-primary" disabled={disabled} onClick={onApply}>应用形象</Button><Button variant="ghost" type="button" className="ba-quiet" disabled={disabled} onClick={onCancel}>取消预览</Button></div>}
    <div className="ba-pet-editor-expression ba-pet-editor-toolbar"><span>动作预览</span><div className="ba-pet-editor-actions">{[['acknowledge', '点头'], ['focus', '侧倾'], ['happy', '轻跃'], ['waiting', '摇摆']].map(([action, label]) => <Button variant="ghost" type="button" className="ba-quiet" disabled={disabled || !motion} key={action} onClick={() => setPreviewAction(value => ({ action, key: value.key + 1 }))}>{label}</Button>)}</div>
      <div className="ba-pet-editor-restore">
        {onRestore && <Tooltip label={canRestore ? '恢复上一版形象' : '暂无上一版形象可恢复'} side="top" delayMs={350} portal><Button variant="ghost" type="button" className="ba-quiet ba-pet-restore-button" aria-label="恢复上一版形象" aria-disabled={disabled || !canRestore} onClick={() => { if (!disabled && canRestore) onRestore(); }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h10a7 7 0 0 1 0 14M7 2 3 6l4 4"/></svg></Button></Tooltip>}
        {onReset && <Tooltip label="恢复默认形象" side="top" delayMs={350} portal><Button variant="ghost" type="button" className="ba-quiet ba-pet-restore-button" aria-label="恢复默认形象" aria-disabled={disabled} onClick={() => { if (!disabled) onReset(); }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/></svg></Button></Tooltip>}
      </div>
    </div>
    {pet?.kind === 'custom' && <small>动作只移动当前形象；表情使用自己上传的图片。</small>}
    {expressions.length > 0 && <div className="ba-pet-editor-expression"><span>可用表情</span><div className="ba-pet-editor-actions">{expressions.map(expression => <Button variant="ghost" type="button" className="ba-quiet" disabled={disabled} key={expression.id} onClick={() => onExpression?.(expression.id)}>{expression.label || expression.id}</Button>)}</div></div>}
    <div className="ba-pet-editor-toggle"><div className="ba-pet-editor-toggle-copy"><span>动态回应</span><small>播放简短动作，遵循系统减少动态效果设置</small>{motionNotice && <small role="status">{motionNotice}</small>}</div><Switch label="动态回应" checked={motion} disabled={disabled} onChange={onMotionChange} /></div>
  </section>;
}
