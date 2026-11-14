const DURATION = 180;
const FEATHER = 24;
const MAX_RECTS = 8;
const maskSelector = '[data-stream-text-mask]';
const excluded = 'style,script,pre,code,table,button,input,textarea,svg,.bg-interactive,' + maskSelector;

function tailText(node) {
  if (node.nodeType === 3) return node.data.trim() ? node : null;
  if (node.nodeType !== 1 || node.matches(excluded)) return null;
  for (let child = node.lastChild; child; child = child.previousSibling) {
    const text = tailText(child);
    if (text) return text;
  }
  return null;
}

function enteringBlock(block, root) {
  for (let node = block; node && node !== root; node = node.parentElement) {
    if (node.getAnimations().some(animation => animation.animationName === 'ba-chat-reveal' && animation.playState === 'running')) return true;
  }
  return false;
}

/** Reveal appended prose without changing the official, selectable Markdown. */
export function installStreamTextReveal(root) {
  const document = root.ownerDocument, window = document.defaultView;
  const noop = () => {};
  noop.finish = noop;
  if (!window?.MutationObserver || !window.ResizeObserver || !root.animate) return noop;
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const entries = new Set();
  let layer, finishing = false, disposed = false, finishingBlocks = 0;
  const selected = () => {
    const selection = document.getSelection();
    return selection && !selection.isCollapsed && selection.containsNode(root, true);
  };
  function detach() {
    if (disposed) return;
    disposed = true;
    observer.disconnect(); resize.disconnect();
    root.removeAttribute('data-stream-revealing');
    root.removeEventListener('pointerdown', clear);
    document.removeEventListener('selectionchange', clear);
    document.removeEventListener('visibilitychange', clear);
    media.removeEventListener('change', clear);
  }
  function remove(entry) {
    if (!entries.delete(entry)) return;
    entry.animation.onfinish = null; entry.animation.cancel(); entry.clip.remove();
    if (!entries.size) {
      layer?.remove(); layer = undefined;
      maybeDetach();
    }
  }
  function maybeDetach() { if (finishing && !entries.size && !finishingBlocks) detach(); }
  function clear() { for (const entry of entries) remove(entry); }
  function geometry(rect, origin) {
    return [rect.left - origin.left - root.clientLeft, rect.top - origin.top - root.clientTop, rect.width, rect.height];
  }
  function checkGeometry(origin = root.getBoundingClientRect()) {
    const ranges = new Map();
    for (const entry of entries) {
      const span = entry.span;
      if (!span.node.isConnected || span.node.length < span.end) { clear(); return; }
      if (!ranges.has(span)) {
        const range = document.createRange();
        range.setStart(span.node, span.start); range.setEnd(span.node, span.end);
        ranges.set(span, range.getClientRects());
      }
      const rect = ranges.get(span)[entry.index];
      if (!rect || geometry(rect, origin).some((value, index) => Math.abs(value - entry.geometry[index]) > .5)) { clear(); return; }
    }
  }
  const ownMutation = record => record.target.nodeType === 1 && record.target.closest(maskSelector)
    || record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node.nodeType === 1 && node.matches(maskSelector));
  function process(records) {
    records = records.filter(record => !ownMutation(record));
    if (!records.length || disposed) return;
    // A later history rewrite invalidates geometry; ordinary completion itself
    // leaves the existing veils alive until the short reveal has drained.
    if (finishing) { clear(); detach(); return; }
    if (media.matches || document.hidden || selected()) { clear(); return; }
    const tail = tailText(root), block = tail?.parentElement?.closest('p,li');
    if (!block || !tail.parentElement.closest('[class*="_markdown"]') || tail.parentElement.closest(excluded)
      || enteringBlock(block, root)) { clear(); return; }
    const edits = records.filter(record => record.type === 'characterData' && record.target === tail);
    const before = edits[0]?.oldValue;
    if (!before || !tail.data.startsWith(before) || tail.length <= before.length
      || records.some(record => record.type !== 'characterData' || record.target !== tail)) { clear(); return; }
    const range = document.createRange();
    range.setStart(tail, before.length); range.setEnd(tail, tail.length);
    const span = { node: tail, start: before.length, end: tail.length };
    const view = root.closest('[data-assistant-scroll]')?.getBoundingClientRect()
      || { top: 0, bottom: window.innerHeight };
    const rects = [...range.getClientRects()].map((rect, index) => ({ rect, index }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom).slice(-MAX_RECTS);
    if (!rects.length) return;
    const origin = root.getBoundingClientRect(), background = window.getComputedStyle(root).backgroundColor;
    if (background === 'transparent' || background === 'rgba(0, 0, 0, 0)') { clear(); return; }
    checkGeometry(origin);
    // Bound active geometry across all chunks; never restart an earlier veil.
    while (entries.size + rects.length > MAX_RECTS) remove(entries.values().next().value);
    if (!layer) {
      layer = document.createElement('span'); layer.dataset.streamTextMask = '';
      layer.setAttribute('aria-hidden', 'true');
      Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', userSelect: 'none' });
      root.append(layer);
    }
    rects.forEach(({ rect, index: rectIndex }, index) => {
      const clip = document.createElement('span'), veil = document.createElement('i');
      Object.assign(clip.style, { position: 'absolute', overflow: 'hidden', left: `${rect.left - origin.left - root.clientLeft}px`,
        top: `${rect.top - origin.top - root.clientTop}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      Object.assign(veil.style, { position: 'absolute', inset: '0 auto 0 0', width: `${rect.width + FEATHER}px`,
        background: `linear-gradient(to right, transparent, ${background} ${FEATHER}px, ${background})`, transform: `translateX(-${FEATHER}px)` });
      clip.append(veil); layer.append(clip);
      const animation = veil.animate([{ transform: `translateX(-${FEATHER}px)` }, { transform: `translateX(${rect.width}px)` }], {
        duration: DURATION, delay: Math.min(index * 30, 60), easing: 'linear', fill: 'forwards',
      });
      const entry = { clip, animation, span, index: rectIndex, geometry: geometry(rect, origin) }; entries.add(entry);
      animation.onfinish = () => remove(entry);
    });
  }
  const observer = new window.MutationObserver(process);
  observer.observe(root, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
  const resize = new window.ResizeObserver(() => { if (entries.size) checkGeometry(); });
  resize.observe(root);
  root.dataset.streamRevealing = 'true';
  root.addEventListener('pointerdown', clear, { passive: true });
  document.addEventListener('selectionchange', clear);
  document.addEventListener('visibilitychange', clear);
  media.addEventListener('change', clear);
  const dispose = () => { finishing = true; clear(); detach(); };
  dispose.finish = () => {
    if (disposed || finishing) return;
    // React can append the last text and settle streaming in the same commit,
    // before MutationObserver gets its microtask. Include that final suffix.
    process(observer.takeRecords());
    finishing = true;
    // Block entry is presentation state too: removing its CSS selector on the
    // business streaming boundary would snap the last new paragraph to opaque.
    const blocks = root.getAnimations({ subtree: true }).filter(animation => animation.animationName === 'ba-chat-reveal' && animation.playState !== 'finished');
    finishingBlocks = blocks.length;
    for (const animation of blocks) {
      const settled = () => { finishingBlocks--; maybeDetach(); };
      animation.finished.then(settled, settled);
    }
    maybeDetach();
  };
  return dispose;
}
