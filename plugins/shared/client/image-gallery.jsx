import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui/button.jsx';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconLayersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { galleryImages, safeImageUrl } from './image-gallery-model.mjs';
import { useFeedbackStyle } from './ui/feedback-style.js';
import { useFilmstrip } from './use-filmstrip.mjs';
import { FileSaveButton } from './file-save-button.jsx';
import css from './image-gallery.css';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const previewUrl = image => safeImageUrl(image.thumbnailUrl) || safeImageUrl(image.previewUrl) || image.url;

/** A wheel notch selects once; small trackpad deltas accumulate without racing ahead. */
function useImageWheel(rail, { enabled, ready, onStep }) {
  const latest = useRef(null);
  latest.current = onStep;
  useEffect(() => {
    const node = rail.current;
    if (!node || !enabled) return;
    let accumulated = 0, direction = 0, lastEvent = 0, lastSwitch = -Infinity;
    const reset = () => { accumulated = 0; direction = 0; lastEvent = 0; lastSwitch = -Infinity; };
    const wheel = event => {
      if (event.ctrlKey || event.metaKey) { reset(); return; }
      const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const delta = raw * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1);
      if (!delta) return;
      event.preventDefault();
      const now = performance.now(), nextDirection = Math.sign(delta);
      if (now - lastEvent > 180 || nextDirection !== direction) reset();
      lastEvent = now; direction = nextDirection;
      if (now - lastSwitch < 140) return;
      accumulated += delta;
      if (Math.abs(accumulated) < 32) return;
      accumulated = 0; lastSwitch = now;
      latest.current(nextDirection);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    node.addEventListener('pointerleave', reset);
    return () => { node.removeEventListener('wheel', wheel); node.removeEventListener('pointerleave', reset); };
  }, [enabled, rail, ready]);
}

function GalleryPicture({ image, eager = false, interactive = true, preview = false, decode = false, onReady, canPresent = true, ...layerProps }) {
  const [state, setState] = useState('loading'), [attempt, setAttempt] = useState(0);
  const version = useRef(attempt); version.current = attempt;
  useLayoutEffect(() => { if (state === 'ready' && canPresent) onReady?.(image); }, [state, image, onReady, canPresent]);
  const loaded = event => {
    const node = event.currentTarget, request = attempt;
    if (!decode || !node.decode) { setState('ready'); return; }
    node.decode().then(() => {
      if (node.isConnected && version.current === request) setState('ready');
    }, () => { if (node.isConnected && version.current === request) setState('error'); });
  };
  return <span className="bg-image-picture" data-state={state} {...layerProps}>
    <img key={attempt} src={preview ? previewUrl(image) : image.url} alt={image.alt} loading={eager ? 'eager' : 'lazy'} decoding="async" onLoad={loaded} onError={() => setState('error')} />
    {state === 'loading' && <span className="bg-image-status" role="status">正在加载图片</span>}
    {state === 'error' && <span className="bg-image-status" role="alert"><UIIcon name="picture" size={24} /><span>图片加载失败</span>{interactive && <Button variant="ghost" size="sm" aria-label="重试加载图片" onClick={event => { event.stopPropagation(); setState('loading'); setAttempt(value => value + 1); }}>重试</Button>}</span>}
  </span>;
}

/** Keep the last decoded node until the latest request can be painted; never queue transitions. */
function GalleryPhoto({ image, instant, frozen, interactive, onPresented }) {
  const presented = useRef(null), latest = useRef(null), timer = useRef(0);
  const [frame, setFrame] = useState({ url: image.url, previous: null });
  const [readyUrl, setReadyUrl] = useState(null);
  if (frame.url !== image.url) setFrame({ url: image.url, previous: presented.current });
  const previous = frame.previous?.url !== image.url ? frame.previous : null;
  latest.current = { image, instant, frozen, onPresented, retaining: !!previous };
  const finish = useCallback(url => setFrame(value => value.url === url && value.previous ? { ...value, previous: null } : value), []);
  const ready = useCallback(item => {
    const current = latest.current;
    if (current.frozen || current.image.url !== item.url) return;
    presented.current = item; current.onPresented(item); setReadyUrl(item.url);
    clearTimeout(timer.current);
    if (current.instant || reducedMotion() || !current.retaining) finish(item.url);
    else timer.current = setTimeout(() => finish(item.url), 240);
  }, [finish]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const currentReady = readyUrl === image.url;
  return <>
    <GalleryPicture key={image.url} image={image} eager decode interactive={interactive} onReady={ready} canPresent={!frozen} onTransitionEnd={event => { if (event.propertyName === 'opacity' && event.target.tagName === 'IMG') { clearTimeout(timer.current); finish(image.url); } }} data-current="true" data-presented={currentReady ? 'true' : 'false'} data-switch-instant={instant || undefined} data-retaining={!!previous} />
    {previous && <GalleryPicture key={previous.url} image={previous} eager decode interactive={false} data-current="false" data-presented={!currentReady ? 'true' : 'false'} aria-hidden="true" />}
  </>;
}

const FilmstripItem = React.memo(function FilmstripItem({ image, index, selected, visible, onSelect }) {
  return <button data-image-url={image.url} type="button" aria-label={`查看第 ${index + 1} 张图片`} aria-current={selected ? 'true' : undefined} onClick={() => onSelect(index)}>{visible ? <img src={previewUrl(image)} alt="" loading="lazy" draggable="false" /> : <span>{index + 1}</span>}</button>;
});

/** Only the photo moves. The modal and transcript never animate their layout. */
function usePhotoMotion(node, origin, onClose, onClosing) {
  const animation = useRef(null), phaseRef = useRef('opening');
  const [phase, setPhase] = useState('opening');
  const callbacks = useRef({ onClose, onClosing });
  callbacks.current = { onClose, onClosing };
  const run = useCallback((opening, instant = false, initial = false) => {
    if (!opening) callbacks.current.onClosing();
    const next = opening ? 'opening' : 'closing';
    phaseRef.current = next; setPhase(next);
    const finish = () => {
      if (opening) { phaseRef.current = 'open'; setPhase('open'); }
      else callbacks.current.onClose();
    };
    if (!node || instant || reducedMotion() || !node.animate) {
      animation.current?.cancel(); animation.current = null; finish(); return;
    }
    // Capture the running transform before cancelling so close reverses an opening.
    const current = getComputedStyle(node).transform;
    animation.current?.cancel();
    const target = node.getBoundingClientRect();
    const source = initial ? origin.rect : origin.element()?.getBoundingClientRect();
    if (!source?.width || !source.height || !target.width || !target.height) { finish(); return; }
    // Map the painted contain-image, not its letterbox, back onto the cover.
    const image = node.querySelector('[data-presented="true"] img') || node.querySelector('img');
    const ratio = image?.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : origin.ratio;
    const width = Math.min(target.width, target.height * ratio), height = width / ratio;
    const sx = source.width / width, sy = source.height / height;
    const x = source.left - target.left - (target.width - width) * sx / 2;
    const y = source.top - target.top - (target.height - height) * sy / 2;
    const folded = `translate(${x}px,${y}px) scale(${sx},${sy})`;
    const motion = node.animate([
      { transform: initial ? folded : current },
      { transform: opening ? 'none' : folded },
    ], { duration: opening ? 220 : 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'both' });
    animation.current = motion;
    motion.finished.then(() => {
      if (animation.current !== motion) return;
      finish();
      if (opening) { motion.cancel(); animation.current = null; }
    }, () => {});
  }, [node, origin]);
  useLayoutEffect(() => {
    if (node) run(true, !origin.animate, true);
    return () => { animation.current?.cancel(); animation.current = null; };
  }, [node, origin, run]);
  return { phase, close: instant => run(false, instant), resume: instant => { if (phaseRef.current !== 'open') run(true, instant); } };
}

function ImageViewer({ images, initialUrl, onClose, onClosing, opener, origin }) {
  const [selectedUrl, setSelectedUrl] = useState(initialUrl);
  const index = Math.max(0, images.findIndex(item => item.url === selectedUrl));
  const image = images[index], touch = useRef(null), strip = useRef(null), photoRef = useRef(null), keyboard = useRef(!origin.animate), focusSelection = useRef(false), closing = useRef(false), presented = useRef(image), selection = useRef(null), requestedIndex = useRef(index), preloads = useRef(new Map());
  requestedIndex.current = index;
  const collectionKey = useMemo(() => images.map(item => item.url).join('\n'), [images]), previousUrl = images[index - 1]?.url, nextUrl = images[index + 1]?.url;
  const [photo, setPhoto] = useState(null), [overview, setOverview] = useState(false), [visible, setVisible] = useState(() => new Set()), [presentedUrl, setPresentedUrl] = useState(null);
  const attachPhoto = useCallback(node => { photoRef.current = node; setPhoto(node); }, []);
  const didPresent = useCallback(item => { presented.current = item; setPresentedUrl(item.url); }, []);
  const motion = usePhotoMotion(photo, origin, onClose, () => onClosing(presented.current));
  const close = (instant = keyboard.current) => { closing.current = true; filmstrip.cancel(); setOverview(false); motion.close(instant); };
  const select = (next, scrubbing = false) => { if (scrubbing && closing.current) return; closing.current = false; focusSelection.current = overview || !!(keyboard.current && strip.current?.contains(document.activeElement)); motion.resume(keyboard.current || scrubbing); requestedIndex.current = Math.max(0, Math.min(images.length - 1, next)); setSelectedUrl(images[requestedIndex.current].url); setOverview(false); };
  selection.current = select;
  const selectThumbnail = useCallback(next => selection.current(next), []);
  const move = step => select(requestedIndex.current + step);
  const filmstrip = useFilmstrip(strip, { index, collectionKey, ready: photo, enabled: images.length > 1, onSelect: next => select(next, true), instant: () => keyboard.current });
  useImageWheel(photoRef, { ready: photo, enabled: images.length > 1 && !overview && motion.phase !== 'closing', onStep: step => { keyboard.current = false; select(requestedIndex.current + step, true); } });
  const returnFocus = event => {
    event.preventDefault();
    const target = opener.current?.isConnected ? opener.current : origin.element()?.closest('.bg-image-gallery')?.querySelector('.bg-image-stack-trigger,.bg-image-open');
    target?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    const selected = strip.current?.querySelector('[aria-current="true"]');
    if (!selected) return;
    if (!overview && focusSelection.current) { focusSelection.current = false; selected.focus({ preventScroll: true }); }
  }, [index, photo, overview]);
  useEffect(() => {
    const rail = strip.current;
    if (!rail || !globalThis.IntersectionObserver) return;
    const observer = new IntersectionObserver(entries => {
      setVisible(previous => {
        const next = new Set(previous); let changed = false;
        for (const entry of entries) {
          const url = entry.target.dataset.imageUrl;
          if (entry.isIntersecting && !next.has(url)) { next.add(url); changed = true; }
          else if (!entry.isIntersecting && next.delete(url)) changed = true;
        }
        return changed ? next : previous;
      });
    }, { root: rail, rootMargin: '0px 100px' });
    [...rail.children].forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [collectionKey, photo, images.length > 1]);
  useEffect(() => {
    // Reuse a bounded decode window; abandoned scrubs cannot accumulate full-size tasks.
    const wanted = new Set([image.url, previousUrl, nextUrl]);
    for (const [url, preload] of preloads.current) if (!wanted.has(url)) { preload.src = ''; preloads.current.delete(url); }
    for (const url of [previousUrl, nextUrl].filter(Boolean)) {
      if (preloads.current.has(url)) continue;
      const preload = new Image(); preload.decoding = 'async'; preload.fetchPriority = 'low'; preload.src = url;
      preloads.current.set(url, preload); preload.decode?.().catch(() => {});
    }
  }, [image.url, previousUrl, nextUrl]);
  useEffect(() => () => { for (const preload of preloads.current.values()) preload.src = ''; preloads.current.clear(); }, []);
  return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="bg-image-viewer" closeLabel="关闭图片预览" overlayProps={{ 'data-image-overlay': 'true', 'data-instant': keyboard.current || reducedMotion() }} data-phase={motion.phase} data-instant={keyboard.current || reducedMotion()} onPointerDownCapture={() => { keyboard.current = false; }} onPointerDownOutside={() => { keyboard.current = false; }} onKeyDownCapture={() => { keyboard.current = true; }} onCloseAutoFocus={returnFocus} onEscapeKeyDown={event => { event.preventDefault(); close(true); }} onKeyDown={event => {
    if (event.altKey || event.ctrlKey || event.metaKey || overview) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1); }
  }}>
    <header className="bg-image-viewer-header"><DialogTitle>图片预览</DialogTitle><span aria-live="polite">{index + 1} / {images.length}</span><div className="bg-image-viewer-actions"><FileSaveButton file={image} label="下载图片" className="bg-image-viewer-download" disabled={presentedUrl !== image.url}><span>下载图片</span></FileSaveButton>{images.length > 1 && <Button variant="ghost" size="sm" className="bg-image-overview-toggle" aria-pressed={overview} onClick={() => { motion.resume(keyboard.current); setOverview(value => !value); }}><IconLayersOutlineRegular size={16} />{overview ? '返回大图' : '全部总览'}</Button>}</div></header>
    <DialogDescription className="bg-image-viewer-description">{image.alt}</DialogDescription>
    <div className="bg-image-viewer-stage" data-overview={overview} onPointerDown={event => { if (event.pointerType === 'touch' && !touch.current && !overview && !event.target.closest('button,a,input,select,textarea')) { touch.current = { id: event.pointerId, x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); } }} onPointerCancel={event => { if (touch.current?.id === event.pointerId) touch.current = null; }} onPointerUp={event => {
      const start = touch.current;
      if (!start || start.id !== event.pointerId) return;
      touch.current = null;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1);
    }}>
      {[index - 1, index + 1].filter(i => images[i]).map(i => <button key={i < index ? 'prev' : 'next'} type="button" className={`bg-image-viewer-peek bg-image-viewer-peek-${i < index ? 'prev' : 'next'}`} aria-hidden="true" tabIndex={-1} onClick={() => select(i)}><img src={previewUrl(images[i])} alt="" /></button>)}
      <div ref={attachPhoto} className="bg-image-viewer-photo" aria-hidden={overview || undefined} data-frozen={motion.phase === 'closing'}><GalleryPhoto image={image} instant={keyboard.current || overview} frozen={motion.phase === 'closing'} interactive={!overview} onPresented={didPresent} /></div>
      {!overview && images.length > 1 && <><Button className="bg-image-viewer-prev" variant="ghost" size="icon" aria-label="上一张图片" disabled={index === 0} onClick={() => move(-1)}><IconChevronLeftOutlineRegular size={20} /></Button><Button className="bg-image-viewer-next" variant="ghost" size="icon" aria-label="下一张图片" disabled={index === images.length - 1} onClick={() => move(1)}><IconChevronRightOutlineRegular size={20} /></Button></>}
      {overview && <div className="bg-image-viewer-overview" aria-label="全部图片">{images.map((item, i) => <figure key={item.id || item.url}><div className="bg-image-overview-thumbnail"><button type="button" aria-label={`查看大图 ${i + 1}：${item.alt}`} aria-current={i === index ? 'true' : undefined} onClick={() => select(i)} /><GalleryPicture image={item} preview eager={i < 4} /></div><figcaption><span>{item.alt}</span><FileSaveButton file={item} label={`下载图片 ${i + 1}`} /></figcaption></figure>)}</div>}
    </div>
    {images.length > 1 && <div className="bg-image-filmstrip"><div ref={strip} className="bg-image-viewer-strip" aria-label="选择图片" {...filmstrip.handlers}>{images.map((item, i) => <FilmstripItem key={item.id || item.url} image={item} index={i} selected={i === index} visible={visible.has(item.url) || Math.abs(i - index) <= 1} onSelect={selectThumbnail} />)}</div></div>}
  </DialogContent></Dialog>;
}

/** The stack keeps its footprint; one click lifts its cover into the shared album. */
export function ImageGallery({ images: source = [] }) {
  useFeedbackStyle('benchgo-image-gallery-styles', css);
  const images = useMemo(() => galleryImages(source), [source]);
  const [selection, setSelection] = useState(null), [coverUrl, setCoverUrl] = useState(null);
  const thumbnail = useRef(null), opener = useRef(null), stack = useRef(null);
  useImageWheel(stack, { enabled: images.length > 1 && !selection, onStep: step => setCoverUrl(previous => {
    const index = Math.max(0, images.findIndex(image => image.url === previous));
    return images[(index + step + images.length) % images.length].url;
  }) });
  if (!images.length) return null;
  const cover = images.find(image => image.url === coverUrl) || images[0], multiple = images.length > 1;
  const coverIndex = images.indexOf(cover);
  const deck = Array.from({ length: Math.min(images.length, 3) }, (_, offset) => images[(coverIndex + offset) % images.length]);
  const open = event => {
    opener.current = event.currentTarget;
    const image = thumbnail.current.querySelector('img');
    setSelection({ url: cover.url, origin: { element: () => thumbnail.current, rect: thumbnail.current.getBoundingClientRect(), ratio: image?.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : 4 / 3, animate: event.detail !== 0 && !reducedMotion() } });
  };
  return <section className="bg-image-gallery" data-multiple={multiple} data-expanded={!!selection} aria-label={multiple ? `${images.length} 张图片` : '回复图片'}>
    <div ref={stack} className="bg-image-gallery-deck">
      <div className="bg-image-gallery-cards">{deck.map((image, i) => <figure className="bg-image-gallery-card" key={image.id || image.url} style={{ zIndex: deck.length - i }} aria-hidden={multiple ? true : undefined}>
        <div className="bg-image-tile"><div ref={i === 0 ? thumbnail : undefined} className="bg-image-thumbnail">{!multiple && <button className="bg-image-open" type="button" aria-label={`放大图片 1：${image.alt}`} onClick={open} />}<GalleryPicture key={image.url} image={image} preview eager={i === 0} interactive={!multiple} /><span className="bg-image-magnify" aria-hidden="true"><UIIcon name="search" size={20} /></span></div>
          {!multiple && <figcaption><span>{image.alt}</span><FileSaveButton file={image} label="下载图片 1" /></figcaption>}
        </div></figure>)}</div>
      {multiple && <button className="bg-image-stack-trigger" type="button" aria-label={`展开 ${images.length} 张图片`} aria-haspopup="dialog" aria-expanded={!!selection} onClick={open}><span className="bg-image-stack-label"><UIIcon name="picture" size={16} /><strong>{images.length} 张图片</strong><span>打开相册</span><IconChevronRightOutlineRegular size={16} /></span></button>}
    </div>
    {selection && <ImageViewer images={images} initialUrl={selection.url} origin={selection.origin} onClosing={image => setCoverUrl(image.url)} onClose={() => setSelection(null)} opener={opener} />}
  </section>;
}
