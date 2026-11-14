import { useEffect, useLayoutEffect, useRef } from 'react';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Native touch scrolling; pointer dragging and a small release spring share its scroll position. */
export function useFilmstrip(rail, { index, collectionKey, ready, enabled, onSelect, instant }) {
  const latest = useRef(null), state = useRef({ nodes: [], centers: [], painted: new Set(), nextPainted: new Set(), styles: new WeakMap(), width: 0, viewport: null, measure: null, frame: 0, spring: 0, wheelTimer: 0, pointer: null, emitted: null, target: null, blockClick: false });
  latest.current = { index, onSelect, instant };
  const lowerBound = position => {
    const centers = state.current.centers;
    let lo = 0, hi = centers.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (centers[mid] < position) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const nearest = position => {
    const centers = state.current.centers, next = Math.min(lowerBound(position), centers.length - 1);
    return next > 0 && Math.abs(centers[next - 1] - position) < Math.abs(centers[next] - position) ? next - 1 : next;
  };
  const paint = (node, proximity) => {
    const styles = state.current.styles;
    if (styles.get(node) === proximity) return;
    styles.set(node, proximity);
    node.style.transform = `scale(${0.86 + proximity * 0.18})`;
    node.style.opacity = String(0.45 + proximity * 0.55);
  };
  const draw = () => {
    const node = rail.current, data = state.current;
    if (!node || !data.centers.length) return;
    // ResizeObserver will realign the explicit selection before scroll can pick a neighbour.
    if (data.viewport?.clientWidth !== data.width) return;
    const viewport = data.width, center = node.scrollLeft + viewport / 2, reach = viewport / 2 + 80;
    const first = lowerBound(center - reach), end = lowerBound(center + reach);
    // Reuse bounded sets so large jumps also reset just the previous visible window.
    const nextPainted = data.nextPainted;
    nextPainted.clear();
    for (let i = first; i < end; i++) {
      const item = data.nodes[i];
      nextPainted.add(item);
      paint(item, Math.max(0, 1 - Math.abs(data.centers[i] - center) / 100));
    }
    for (const item of data.painted) if (!nextPainted.has(item)) paint(item, 0);
    data.nextPainted = data.painted; data.painted = nextPainted;
    if (data.target !== null) {
      if (Math.abs(node.scrollLeft - data.target) < 1) data.target = null;
      return;
    }
    const next = nearest(center);
    if (next !== latest.current.index && next !== data.emitted) {
      data.emitted = next;
      latest.current.onSelect(next);
    }
  };
  const schedule = () => {
    const data = state.current;
    if (!data.spring && !data.frame) data.frame = requestAnimationFrame(() => { data.frame = 0; draw(); });
  };
  const stop = () => {
    const data = state.current;
    cancelAnimationFrame(data.spring); data.spring = 0;
    clearTimeout(data.wheelTimer); data.wheelTimer = 0;
    data.target = null;
    if (rail.current) { rail.current.dataset.dragging = 'false'; rail.current.scrollTo({ left: rail.current.scrollLeft, behavior: 'instant' }); }
  };
  const settle = (velocity = 0) => {
    const node = rail.current, data = state.current;
    if (!node || !data.centers.length) return;
    cancelAnimationFrame(data.frame); data.frame = 0;
    const x = node.scrollLeft, max = node.scrollWidth - node.clientWidth;
    const chosen = nearest(clamp(x + velocity * 120, 0, max) + node.clientWidth / 2);
    const target = clamp(data.centers[chosen] - node.clientWidth / 2, 0, max);
    if (reduceMotion()) { node.scrollLeft = target; node.dataset.dragging = 'false'; draw(); return; }
    // Critically damped spring (mass 1, stiffness 400, damping 40), seeded by release velocity.
    const start = performance.now(), displacement = x - target, v = clamp(velocity * 1000, -2500, 2500), omega = 20;
    const tick = now => {
      const t = (now - start) / 1000, decay = Math.exp(-omega * t), coefficient = v + omega * displacement;
      const position = target + (displacement + coefficient * t) * decay;
      const speed = (v - omega * coefficient * t) * decay;
      const finished = (Math.abs(position - target) < .2 && Math.abs(speed) < 3) || t > .65;
      node.scrollLeft = finished ? target : clamp(position, 0, max);
      if (finished) node.dataset.dragging = 'false';
      data.spring = finished ? 0 : requestAnimationFrame(tick);
      // The spring owns its drawing; native scroll events must not add a second RAF.
      draw();
    };
    data.spring = requestAnimationFrame(tick);
  };
  const reveal = (next, immediately = false) => {
    const node = rail.current, data = state.current;
    if (!node || !data.centers.length) return;
    stop(); data.emitted = null;
    const left = clamp(data.centers[next] - node.clientWidth / 2, 0, node.scrollWidth - node.clientWidth);
    data.target = left;
    node.scrollTo({ left, behavior: immediately || latest.current.instant() || reduceMotion() ? 'instant' : 'smooth' });
    schedule();
  };
  useLayoutEffect(() => {
    const node = rail.current;
    if (!node) return;
    const viewport = node.parentElement || node;
    const measure = (align = false) => {
      const data = state.current;
      if (align) stop();
      data.viewport = viewport; data.width = viewport.clientWidth;
      node.style.paddingInline = `${Math.max(0, (data.width - 60) / 2)}px`;
      data.nodes = [...node.children];
      data.centers = data.nodes.map(child => child.offsetLeft + child.offsetWidth / 2);
      if (align) reveal(latest.current.index, true);
      else schedule();
    };
    state.current.measure = measure;
    measure(true);
    const observer = new ResizeObserver(() => { if (viewport.clientWidth !== state.current.width) measure(true); }); observer.observe(viewport);
    const wheel = event => {
      if (event.ctrlKey || !state.current.centers.length) return;
      stop();
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return; // Native horizontal/trackpad momentum.
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1);
      if (!delta) return;
      event.preventDefault(); node.dataset.dragging = 'true'; node.scrollLeft += delta;
      state.current.wheelTimer = setTimeout(() => settle(), 100);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); node.removeEventListener('wheel', wheel); stop(); cancelAnimationFrame(state.current.frame); state.current.frame = 0; state.current.pointer = null; state.current.measure = null; };
  }, [ready, enabled]);
  useLayoutEffect(() => { state.current.measure?.(); }, [collectionKey, ready]);
  useLayoutEffect(() => {
    if (state.current.emitted === index) return;
    reveal(index);
  }, [index, ready, enabled]);
  useEffect(() => () => { cancelAnimationFrame(state.current.frame); cancelAnimationFrame(state.current.spring); clearTimeout(state.current.wheelTimer); }, []);
  const finish = (event, cancelled = false) => {
    const data = state.current, pointer = data.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    data.pointer = null;
    if (rail.current?.hasPointerCapture(pointer.id)) rail.current.releasePointerCapture(pointer.id);
    if (pointer.dragged) { data.blockClick = true; settle(cancelled || performance.now() - pointer.time > 80 ? 0 : pointer.velocity); }
  };
  return { cancel: () => { stop(); cancelAnimationFrame(state.current.frame); state.current.frame = 0; state.current.pointer = null; }, handlers: {
    onScroll: schedule,
    onDragStart: event => event.preventDefault(),
    onPointerDown: event => {
      const data = state.current; data.blockClick = false; stop();
      if (event.pointerType === 'touch' || event.button !== 0 || data.pointer) return;
      data.pointer = { id: event.pointerId, x: event.clientX, scroll: rail.current.scrollLeft, lastX: event.clientX, time: performance.now(), velocity: 0, dragged: false };
    },
    onPointerMove: event => {
      const data = state.current, pointer = data.pointer, node = rail.current;
      if (!pointer || pointer.id !== event.pointerId || !node) return;
      const distance = event.clientX - pointer.x;
      if (!pointer.dragged && Math.abs(distance) < 5) return;
      if (!pointer.dragged) { pointer.dragged = true; node.dataset.dragging = 'true'; node.setPointerCapture(pointer.id); }
      const now = performance.now(), dt = now - pointer.time;
      if (dt > 0) pointer.velocity = pointer.velocity * .35 + (pointer.lastX - event.clientX) / dt * .65;
      pointer.lastX = event.clientX; pointer.time = now;
      node.scrollLeft = pointer.scroll - distance;
      event.preventDefault(); schedule();
    },
    onPointerUp: event => finish(event),
    onPointerCancel: event => finish(event, true),
    onLostPointerCapture: event => finish(event, true),
    onPointerLeave: () => { if (state.current.pointer && !state.current.pointer.dragged) state.current.pointer = null; },
    onClickCapture: event => { if (state.current.blockClick && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); state.current.blockClick = false; } },
  } };
}
