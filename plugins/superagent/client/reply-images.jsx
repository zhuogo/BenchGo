import React, { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
import { InteractiveReply } from '../../interactive/client/reply.jsx';
import { ImageGallery } from '../../shared/client/image-gallery.jsx';
import { ArtifactPreview } from '../../shared/client/artifact-preview.jsx';
import { FileSaveButton } from '../../shared/client/file-save-button.jsx';
import { fileUrl, previewKind } from '../../shared/client/preview-model.mjs';
import { ResourceIcon } from '../../shared/client/resource-icon.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import { extractReplyDeliverables } from './reply-images.mjs';
import { installStreamTextReveal } from './stream-text-reveal.mjs';
import css from './reply-deliverables.css';

function previewable(file) {
  if (file.local) return false;
  try { fileUrl(file.url); } catch { return false; }
  return /\.(?:pdf|docx|xlsx?|csv|tsv|pptx|md|markdown|txt|json|html?|mp3|wav|ogg|m4a|flac|mp4|webm|mov)(?:$|[?#])/i.test(file.filename || file.name);
}

function ReplyFile({ file, onPreview, onOpenFile }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const kind = file.kind || previewKind(file.name);
  const icon = kind === 'video' ? 'video' : ['web', 'html', 'json'].includes(kind) ? 'code' : 'document';
  const canPreview = previewable(file);
  async function open() {
    if (!file.local) { onPreview({ ...file, name: file.filename || file.name }); return; }
    setError(''); setBusy(true);
    try { await onOpenFile(file.path || file.url, file.line ? { line: file.line } : undefined); } catch (cause) { setError(cause.message || '文件暂时无法打开，请重试。'); } finally { setBusy(false); }
  }
  async function copyPath() {
    setError('');
    try { if (!await writeClipboard(file.path || file.url)) throw new Error('路径复制失败，请重试。'); setCopied(true); }
    catch (cause) { setError(cause.message); }
  }
  const label = <><ResourceIcon name={icon} size={22} /><span className="ba-reply-file-label"><strong>{file.name}</strong><span>{file.local ? '本地文件' : canPreview ? '点击预览' : '打开文件'}</span></span></>;
  return <div className="ba-reply-file-item"><div className="ba-reply-file">
    {file.local || canPreview ? <Button variant="ghost" className="ba-reply-file-open" disabled={busy || (file.local && !onOpenFile)} onClick={open} aria-label={`打开 ${file.name}`}>{label}</Button>
      : <a className="ba-reply-file-open" href={file.url} target="_blank" rel="noopener noreferrer" aria-label={`打开 ${file.name}`}>{label}</a>}
    {file.local ? <Button variant="ghost" size="sm" onClick={copyPath} aria-label={`复制 ${file.name} 路径`}>{copied ? '已复制' : '复制路径'}</Button>
      : <FileSaveButton file={file} className="ba-reply-file-download" label={`下载 ${file.name}`} />}
    </div>{file.local && !onOpenFile && <p className="ba-reply-file-note">当前会话无法打开此本地文件，可复制路径。</p>}{error && <p className="ba-reply-file-note" role="alert">{error}</p>}</div>;
}

/** Delivery stays attached to its reply, outside the prose bubble. */
export function ReplyDeliverables({ images = [], files = [], onOpenFile }) {
  const [selected, setSelected] = useState(null);
  if (!images.length && !files.length) return null;
  return <section className="ba-reply-deliverables" aria-label="交付文件"><style>{css}</style>
    {!!images.length && <ImageGallery images={images} />}
    {!!files.length && <div className="ba-reply-files">{files.map(file => <ReplyFile key={file.url} file={file} onPreview={setSelected} onOpenFile={onOpenFile} />)}</div>}
    {selected && <ArtifactPreview file={{ ...selected, pdfUrl: false }} onClose={() => setSelected(null)} />}
  </section>;
}

export const AssistantReply = memo(function AssistantReply({ text = '', streaming = false, labels, disabled, onSubmit, onOpenFile, assistantName = 'BenchGo' }) {
  const delivery = useMemo(() => extractReplyDeliverables(text), [text]);
  const body = useRef(null), reveal = useRef(null), hasText = !!delivery.text.trim();
  useLayoutEffect(() => () => { reveal.current?.(); reveal.current = null; }, [hasText]);
  useLayoutEffect(() => {
    if (streaming && hasText && body.current) {
      reveal.current?.();
      reveal.current = installStreamTextReveal(body.current);
    } else reveal.current?.finish();
  }, [streaming, hasText]);
  return <>{hasText && <div ref={body} className="ba-chat-content" style={{ position: 'relative' }} aria-label={assistantName}><InteractiveReply text={delivery.text} streaming={streaming} labels={labels} disabled={disabled} onSubmit={onSubmit} /></div>}
    <ReplyDeliverables images={delivery.images} files={delivery.files} onOpenFile={onOpenFile} />
  </>;
});
