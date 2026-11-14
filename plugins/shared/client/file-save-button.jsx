import React, { useEffect, useId, useRef, useState } from 'react';
import { IconDownloadOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { Button } from './ui/button.jsx';
import { saveOriginalFile } from './file-save.mjs';
import { useFeedbackStyle } from './ui/feedback-style.js';
import css from './file-save-button.css';

/** Saving is an action, never a navigation. Completion reflects the platform's real result. */
export function FileSaveButton({ file, label = '下载文件', className = '', children, disabled = false, ...props }) {
  useFeedbackStyle('benchgo-file-save-styles', css);
  const key = `${file.downloadUrl || file.url}\n${file.filename || file.name || ''}`;
  const latest = useRef(key), pending = useRef(new Set()), alive = useRef(true), timer = useRef(0);
  const [status, setStatus] = useState(null), id = useId();
  latest.current = key;
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); }; }, []);
  useEffect(() => { clearTimeout(timer.current); }, [key]);
  const current = status?.key === key ? status : null;
  const busy = pending.current.has(key), message = current?.message;
  async function save(event) {
    event.preventDefault(); event.stopPropagation();
    if (disabled || pending.current.has(key)) return;
    const captured = { ...file }, instant = event.detail === 0;
    pending.current.add(key); clearTimeout(timer.current);
    setStatus({ key, phase: 'saving', message: '', instant });
    try {
      const result = await saveOriginalFile(captured);
      if (!alive.current || latest.current !== key) return;
      const message = result.status === 'saved' ? '已保存' : result.status === 'requested' ? '已发起下载，保存位置由浏览器设置决定。' : '';
      setStatus({ key, phase: 'idle', message, instant });
      if (message) timer.current = setTimeout(() => { if (alive.current && latest.current === key) setStatus(null); }, 2600);
    } catch (cause) {
      if (alive.current && latest.current === key) setStatus({ key, phase: 'error', message: cause.message || '保存失败，请重试。', instant });
    } finally { pending.current.delete(key); }
  }
  return <span className="bg-file-save" data-instant={current?.instant || undefined} onKeyDownCapture={event => { event.currentTarget.dataset.instant = 'true'; }} onPointerDownCapture={event => { event.currentTarget.dataset.instant = 'false'; }}>
    <Button variant="ghost" size={children ? 'sm' : 'icon'} {...props} className={className} disabled={disabled || busy} aria-label={label} aria-busy={busy || undefined} aria-describedby={message ? id : undefined} data-saving={busy || undefined} onClick={save}>
      <IconDownloadOutlineRegular size={16} />{children}
    </Button>
    {busy && <span className="bg-file-save-sr" role="status">正在选择保存位置或保存文件…</span>}
    {message && <span id={id} className="bg-file-save-note" role={current.phase === 'error' ? 'alert' : 'status'}>{message}</span>}
  </span>;
}
