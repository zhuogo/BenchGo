import { Tooltip, IconDownloadOutlineRegular, IconCodeOutlineRegular, IconInspectOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BINARY_LIMIT, TEXT_LIMIT, checkOfficeArchive, decodeText, fileUrl, frameDocument, pdfUrl, previewKind, readPreview, visibleRows } from './preview-model.mjs';
import { CustomSelect } from './custom-select.jsx';
import { Button } from './ui/button.jsx';
import { Loading } from './ui/loading.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import css from './artifact-preview.css';

const asset = name => new URL(`api/benchgo/preview-assets/${name}.js`, document.baseURI).href;
const load = name => import(/* @vite-ignore */ asset(name));
const textKinds = ['text', 'markdown', 'json', 'html'];
function Frame({ html, title }) {
  const frame = useRef(null), [scheme, setScheme] = useState('light');
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const read = () => {
      const style = getComputedStyle(frame.current), rgb = style.backgroundColor.match(/^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/);
      const dark = rgb ? Number(rgb[1]) * .2126 + Number(rgb[2]) * .7152 + Number(rgb[3]) * .0722 < 128 : style.colorScheme === 'dark' || (style.colorScheme.includes('dark') && media.matches);
      setScheme(dark ? 'dark' : 'light');
    };
    const observer = new MutationObserver(read);
    for (let node = frame.current?.parentElement; node; node = node.parentElement) observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-ds-dark-theme'] });
    read(); media.addEventListener('change', read);
    return () => { observer.disconnect(); media.removeEventListener('change', read); };
  }, []);
  return <iframe ref={frame} className="bg-preview-frame" title={title} sandbox="" referrerPolicy="no-referrer" srcDoc={frameDocument(html, scheme)} />;
}

function PreviewState({ title, description, loading = false, error = false, onRetry }) {
  if (loading) return <Loading className="bg-preview-state" label={title} />;
  return <div className="bg-preview-state" role={error ? 'alert' : 'status'} aria-busy={loading}>
    <span className="bg-preview-state-icon" aria-hidden="true"><UIIcon name={error ? 'close' : 'box'} size={24} /></span>
    <strong>{title}</strong>{description && <p>{description}</p>}{onRetry && <Button variant="outline" onClick={onRetry}>重试</Button>}
  </div>;
}

function JsonNode({ name, value, depth = 0 }) {
  const [open, setOpen] = useState(depth === 0), [count, setCount] = useState(50);
  if (value === null || typeof value !== 'object') return <div className="bg-json-value"><strong>{name}</strong>: {JSON.stringify(value)}</div>;
  const keys = Object.keys(value);
  return <div className="bg-json-node"><button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" style={{ transform: open ? 'rotate(90deg)' : undefined, verticalAlign: 'middle' }}><path d="m9 5 7 7-7 7" /></svg> {name} <span>{Array.isArray(value) ? `[${keys.length}]` : `{${keys.length}}`}</span></button>
    {open && (depth >= 30 ? <p>层级较深，请切换原文查看。</p> : <div>{keys.slice(0, count).map(key => <JsonNode key={key} name={key} value={value[key]} depth={depth + 1} />)}{count < keys.length && <button type="button" onClick={() => setCount(n => n + 50)}>再显示 50 项</button>}</div>)}
  </div>;
}
function Sheet({ bytes, onRetry }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [query, setQuery] = useState(''), [top, setTop] = useState(0), [cell, setCell] = useState('');
  const worker = useRef(null), scroller = useRef(null), timer = useRef(null);
  useEffect(() => {
    const instance = new Worker(asset('sheet-worker'), { type: 'module' }); worker.current = instance;
    const deadline = () => { clearTimeout(timer.current); timer.current = setTimeout(() => { instance.terminate(); setError('表格解析超时，请下载查看'); }, 20000); };
    instance.onmessage = ({ data: value }) => { clearTimeout(timer.current); if (value.error) setError(value.error); else setData(value); };
    instance.onerror = () => { clearTimeout(timer.current); setError('表格解析器加载失败，请重试'); };
    instance.startDeadline = deadline; deadline();
    const copy = bytes.slice(); instance.postMessage({ bytes: copy }, [copy.buffer]);
    return () => { clearTimeout(timer.current); instance.terminate(); };
  }, [bytes]);
  const rows = useMemo(() => visibleRows(data?.rows || [], query), [data, query]);
  if (error) return <div role="alert"><p>{error}</p><button type="button" onClick={onRetry}>重试</button></div>;
  if (!data) return <Loading label="正在解析表格" />;
  const start = Math.max(0, Math.floor(top / 32) - 4), visible = rows.slice(start, start + 32);
  const resetScroll = () => { setTop(0); if (scroller.current) scroller.current.scrollTop = 0; };
  return <div className="bg-sheet"><div className="bg-preview-tools"><label>工作表 <CustomSelect aria-label={'\u5de5\u4f5c\u8868'} value={String(data.index)} options={data.names.map((name, index) => ({ value: String(index), label: name }))} onChange={value => { resetScroll(); setQuery(''); setCell(''); worker.current.startDeadline(); worker.current.postMessage({ index: Number(value) }); }} /></label><input type="search" placeholder="搜索当前工作表" aria-label="搜索当前工作表" value={query} onChange={event => { resetScroll(); setQuery(event.target.value); }} /><span>{rows.length} 行</span></div>
    <p className="bg-preview-note">数据快览 · 公式显示文件保存的结果，不重新计算；图表、透视表及部分格式不展示。{data.truncated && ' 已限制为前 10000 行、100 列。'}</p>
    <div className="bg-sheet-scroll" ref={scroller} onScroll={event => setTop(event.currentTarget.scrollTop)} tabIndex={0} aria-label="表格内容"><table style={{ width: data.columns.length * 140 + 56 }}><thead><tr><th scope="col" style={{ width: 56 }}>行</th>{data.columns.map(name => <th scope="col" key={name}>{name}</th>)}</tr></thead><tbody>
      {start > 0 && <tr aria-hidden="true"><td colSpan={data.columns.length + 1} style={{ height: start * 32, padding: 0 }} /></tr>}
      {visible.map(({ row, index }) => <tr key={index}><th scope="row">{index + data.startRow}</th>{data.columns.map((column, col) => <td key={column}><Tooltip label={String(row[col] ?? '')} side="top" delayMs={450} onlyWhenClipped portal><button type="button" onClick={() => setCell(`${column}${index + data.startRow}: ${row[col] ?? ''}`)}>{String(row[col] ?? '')}</button></Tooltip></td>)}</tr>)}
      {start + visible.length < rows.length && <tr aria-hidden="true"><td colSpan={data.columns.length + 1} style={{ height: (rows.length - start - visible.length) * 32, padding: 0 }} /></tr>}
    </tbody></table>{!rows.length && <p>没有匹配的单元格</p>}</div>
    {cell && <pre className="bg-cell-value" tabIndex={0}>{cell}</pre>}
  </div>;
}
function Pdf({ bytes, onRetry }) {
  const [doc, setDoc] = useState(null), [page, setPage] = useState(1), [zoom, setZoom] = useState(1), [error, setError] = useState(''), [busy, setBusy] = useState(true);
  const canvas = useRef(null), holder = useRef(null);
  useEffect(() => {
    let disposed = false, task;
    load('pdf').then(module => { if (disposed) return; task = module.load(bytes.slice(), asset('pdf-worker')); return task.promise; }).then(value => { if (!disposed && value) { setDoc(value); setBusy(false); } }).catch(cause => { if (!disposed) { setError(cause.message); setBusy(false); } });
    return () => { disposed = true; void task?.destroy(); };
  }, [bytes]);
  useEffect(() => {
    if (!doc) return;
    let disposed = false, task;
    setBusy(true); setError('');
    doc.getPage(page).then(value => {
      if (disposed) return;
      const width = Math.max(240, (holder.current?.clientWidth || 800) - 32), base = value.getViewport({ scale: 1 });
      const scale = Math.min(2, width / base.width) * zoom, ratio = Math.min(2, window.devicePixelRatio || 1), viewport = value.getViewport({ scale: scale * ratio });
      const node = canvas.current; node.width = viewport.width; node.height = viewport.height; node.style.width = `${viewport.width / ratio}px`; node.style.height = `${viewport.height / ratio}px`;
      task = value.render({ canvasContext: node.getContext('2d'), viewport }); return task.promise;
    }).then(() => { if (!disposed) setBusy(false); }).catch(cause => { if (!disposed) { setError(cause.message); setBusy(false); } });
    return () => { disposed = true; task?.cancel(); };
  }, [doc, page, zoom]);
  return <div className="bg-pdf" ref={holder}><div className="bg-preview-tools"><button type="button" disabled={!doc || page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button><span>{page} / {doc?.numPages || '—'}</span><button type="button" disabled={!doc || page >= doc.numPages} onClick={() => setPage(p => p + 1)}>下一页</button><label>缩放 <CustomSelect aria-label={'\u7f29\u653e'} value={String(zoom)} onChange={value => setZoom(Number(value))} options={[{ value: '1', label: '\u9002\u5408\u5bbd\u5ea6' }, { value: '1.5', label: '150%' }, { value: '2', label: '200%' }]} /></label></div>{busy && <Loading label="正在渲染页面…" compact />}{error && <div role="alert"><p>{error}</p><button type="button" onClick={onRetry}>重试</button></div>}<div className="bg-pdf-page"><canvas ref={canvas} aria-label={`第 ${page} 页`} role="img" /></div><p className="bg-preview-note">逐页快览；需要全文检索或辅助阅读时，请下载原文件。</p></div>;
}
function Content({ file, kind, converted, source }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let alive = true;
    setData(null); setError('');
    (async () => {
      const url = converted || kind === 'office' ? pdfUrl(file.url) : fileUrl(file.url).href;
      const actual = converted || kind === 'office' ? 'pdf' : kind;
      const bytes = await readPreview(await fetch(url, { signal: controller.signal, credentials: 'same-origin' }), textKinds.includes(actual) ? TEXT_LIMIT : BINARY_LIMIT, controller.signal);
      if (['sheet', 'docx'].includes(actual)) checkOfficeArchive(bytes);
      let value = { bytes, kind: actual };
      if (textKinds.includes(actual)) {
        value.text = decodeText(bytes);
        if (actual === 'json') { try { value.json = JSON.parse(value.text); } catch (cause) { value.note = `JSON 格式错误：${cause.message}`; } }
        if (actual === 'markdown') value.html = (await load('markdown')).render(value.text);
        if (actual === 'html') value.html = (await load('markdown')).sanitizeHtml(value.text);
      } else if (actual === 'docx') value.html = await (await load('docx')).render(bytes);
      if (alive) setData(value);
    })().catch(cause => { if (alive && !controller.signal.aborted) setError(cause.message || '预览失败'); });
    return () => { alive = false; controller.abort(); };
  }, [file.url, kind, converted, revision]);
  if (error) return <PreviewState title="暂时无法预览" description={error} error onRetry={() => setRevision(v => v + 1)} />;
  if (!data) return <PreviewState title="正在打开文件…" description="正在读取内容，请稍候。" loading />;
  if (textKinds.includes(data.kind) && !data.text?.trim()) return <PreviewState title="这个文件还是空的" description="文件尚未写入内容，可以返回继续浏览。" />;
  if (data.kind === 'sheet') return <Sheet bytes={data.bytes} onRetry={() => setRevision(v => v + 1)} />;
  if (data.kind === 'pdf') return <Pdf bytes={data.bytes} onRetry={() => setRevision(v => v + 1)} />;
  return <>
    {data.kind === 'html' && <p className="bg-preview-note">安全预览：脚本、外部资源和页面跳转已禁用。自包含 HTML 可直接展示，完整交互请下载后打开。</p>}
    {data.kind === 'docx' && <p className="bg-preview-note">文档排版可能与 Office 有差异，可尝试 PDF 预览。</p>}
    {data.note && <p role="alert">{data.note}</p>}
    {source || data.kind === 'text' || data.note ? <pre className="bg-preview-text" tabIndex={0}>{data.text || '（空文件）'}</pre> : data.kind === 'json' ? <div className="bg-json"><JsonNode name="根节点" value={data.json} /></div> : <Frame html={data.html} title={`${file.name} 内容`} />}
  </>;
}
export function ArtifactPreview({ file, onClose }) {
  const kind = previewKind(file.name), [converted, setConverted] = useState(false), [source, setSource] = useState(false), back = useRef(null);
  useEffect(() => { back.current?.focus({ preventScroll: true }); setConverted(false); setSource(false); }, [file.url]);
  let url, download;
  try { url = fileUrl(file.url).href; const target = fileUrl(file.downloadUrl || file.url); target.searchParams.set('download', '1'); download = target.href; } catch { /* Invalid descriptors are not navigable. */ }
  const media = ['image', 'audio', 'video'].includes(kind);
  return <section className="bg-preview" aria-label="文件预览" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose?.(); } }}><style>{css}</style>
    <header className="bg-preview-header"><Button ref={back} variant="ghost" className="bg-preview-back" onClick={onClose}>← 返回</Button><Tooltip label={file.name} side="top" delayMs={450} onlyWhenClipped portal><h2 tabIndex={0}>{file.name}</h2></Tooltip><div className="bg-preview-actions">{download && <Tooltip label="下载原文件" side="top" delayMs={350} portal><a className="bg-preview-download" href={download} download aria-label={`下载 ${file.name}`}><IconDownloadOutlineRegular size={18} /></a></Tooltip>}{url && ['markdown', 'json', 'html'].includes(kind) && <Tooltip label={source ? '查看预览' : '查看原文'} side="top" delayMs={350} portal><Button variant="ghost" className="bg-preview-mode" aria-label={source ? '查看预览' : '查看原文'} aria-pressed={source} onClick={() => setSource(value => !value)}>{source ? <IconInspectOutlineRegular size={18} /> : <IconCodeOutlineRegular size={18} />}</Button></Tooltip>}</div></header>
    {['docx', 'doc'].includes(file.name.split('.').at(-1)?.toLowerCase()) && <div className="bg-preview-tools"><button type="button" aria-pressed={converted} onClick={() => setConverted(v => !v)}>{converted ? '文档预览' : '尝试 PDF 预览'}</button></div>}
    {!url ? <PreviewState title="文件地址不可用" description="请返回列表刷新后重新打开。" error /> : media ? <Media key={url} kind={kind} url={url} name={file.name} /> : <Content key={file.url + converted} file={file} kind={kind} converted={converted} source={source} />}
  </section>;
}
function Media({ kind, url, name }) {
  const [state, setState] = useState('loading'), [revision, setRevision] = useState(0);
  if (state === 'error') return <PreviewState title="暂时无法预览" description="媒体加载失败或格式不受支持，也可以下载原文件查看。" error onRetry={() => { setState('loading'); setRevision(value => value + 1); }} />;
  const ready = () => setState('ready'), failed = () => setState('error');
  return <><div className="bg-preview-media" aria-busy={state === 'loading'} key={revision}>{kind === 'image' ? <img src={url} alt={name} onLoad={ready} onError={failed} /> : kind === 'audio' ? <audio src={url} controls preload="metadata" onLoadedMetadata={ready} onError={failed} /> : <video src={url} controls preload="metadata" onLoadedMetadata={ready} onError={failed} />}</div>{state === 'loading' && <PreviewState title="正在打开文件…" description="正在读取媒体内容。" loading />}</>;
}
