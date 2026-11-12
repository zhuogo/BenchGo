/** Opt-in renderer performance trace. It records durations and their sources
 * only: never message text, input values, request bodies, URL queries or
 * element text. Records stay in memory; only the on/off choice is persisted. */
const STORAGE_KEY = 'benchgo.perf.trace';
const VERSION = 1;
const ENTRY_LIMIT = 2000;
const LABEL_DETAIL_MS = 50;
const EVENT_THRESHOLD_MS = 100;
const NOTIFY_MS = 1000;
const FRAME_TYPES = ['long-animation-frame', 'longtask'];
const noop = () => {};
const round = value => Math.round(value * 10) / 10;
const clip = (value, max) => String(value ?? '').slice(0, max);

function fileName(value) {
  const text = String(value ?? '');
  if (/^data:/i.test(text)) return 'data:';
  return clip(text.split(/[?#]/)[0].split('/').filter(Boolean).pop(), 80);
}
// Script invokers may be a script URL or carry an element `[src=…]` URL.
function invokerName(value) {
  const text = String(value ?? '').replace(/\[src=[^\]]*\]/g, '');
  return text.includes('/') ? fileName(text) : clip(text, 80);
}
function describeTarget(node) {
  if (typeof node?.tagName !== 'string') return '';
  const classes = String(node.getAttribute?.('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2);
  const label = clip(node.getAttribute?.('aria-label'), 40);
  return node.tagName.toLowerCase() + classes.map(name => `.${name}`).join('') + (label ? `[${label}]` : '');
}

// Layout cost follows page size. Counts only: no text, names or attribute values.
function pageScale(document) {
  if (typeof document?.querySelectorAll !== 'function') return null;
  const count = selector => { try { return document.querySelectorAll(selector).length; } catch { return null; } };
  let rules = 0;
  for (const sheet of document.styleSheets ?? []) { try { rules += sheet.cssRules.length; } catch { /* cross-origin sheet */ } }
  return {
    nodes: count('*'), styleElements: count('style'), styleRules: rules,
    sidebarNodes: count('.cmd-shell-sidebar *'), sidebarRows: count('.cmd-session-row'),
    centerNodes: count('[class*="centerCol"] *'), rightbarNodes: count('[data-rightbar-col] *'),
    chatRows: count('[data-chat-key]'), chatNodes: count('.ba-chat-feed *'), officialChatNodes: count('[data-conversation-scroll] *'),
    chatTextLength: [...document.querySelectorAll('.ba-chat-feed, [data-conversation-scroll]')].reduce((total, node) => total + (node.textContent?.length ?? 0), 0),
    codeBlocks: count('pre'), tables: count('table'), svgNodes: count('svg *'), hiddenRetained: count('[hidden] *'),
  };
}

export function createPerfTrace(scope = globalThis) {
  const clock = scope.performance, listeners = new Set();
  const types = scope.PerformanceObserver?.supportedEntryTypes ?? [];
  let supported = {
    'long-animation-frame': types.includes('long-animation-frame'),
    longtask: types.includes('longtask'),
    event: types.includes('event'),
    visibilitychange: typeof scope.document?.addEventListener === 'function',
  };
  let enabled = false, startedAt = null, observers = [], timer = null, snapshot;
  let ring, head, dropped, frames, interactions, labels, lastInteraction;
  const reset = () => { ring = []; head = 0; dropped = 0; frames = { count: 0, max: 0 }; interactions = { count: 0, max: 0 }; labels = new Map(); lastInteraction = 0; };
  const summarize = () => ({
    frames: { type: FRAME_TYPES.find(type => supported[type]) ?? null, count: frames.count, maxDuration: round(frames.max) },
    interactions: { count: interactions.count, maxDuration: round(interactions.max) },
    labels: Object.fromEntries([...labels].map(([label, item]) => [label, { count: item.count, totalDuration: round(item.total), maxDuration: round(item.max) }])),
    entries: ring.length,
    dropped,
  });
  const publish = () => {
    if (timer !== null) { scope.clearTimeout(timer); timer = null; }
    snapshot = { enabled, supported, startedAt, summary: summarize() };
    for (const listener of [...listeners]) listener();
  };
  // Recording never notifies directly; subscribers hear about it at most once a second.
  const touch = () => { if (timer === null) timer = scope.setTimeout(() => { timer = null; publish(); }, NOTIFY_MS); };
  const push = entry => {
    if (ring.length < ENTRY_LIMIT) ring.push(entry);
    else { ring[head] = entry; head = (head + 1) % ENTRY_LIMIT; dropped++; }
    touch();
  };
  const recordFrame = entry => {
    frames.count++; frames.max = Math.max(frames.max, entry.duration);
    const item = { kind: entry.entryType, t: round(entry.startTime), duration: round(entry.duration) };
    if (entry.entryType === 'long-animation-frame') {
      item.blockingDuration = round(entry.blockingDuration ?? 0);
      // The phase split needs no script attribution, which some hosts withhold:
      // work before rendering, rendering callbacks, then style and layout.
      const end = entry.startTime + entry.duration, render = entry.renderStart || end, layout = entry.styleAndLayoutStart || end;
      item.scriptDuration = round(render - entry.startTime); item.renderDuration = round(layout - render); item.layoutDuration = round(end - layout);
      item.scriptCount = entry.scripts?.length ?? 0;
      item.scripts = [...(entry.scripts ?? [])].sort((a, b) => b.duration - a.duration).slice(0, 3).map(script => ({
        invoker: invokerName(script.invoker), invokerType: clip(script.invokerType, 40), sourceFunctionName: clip(script.sourceFunctionName, 80), sourceFile: fileName(script.sourceURL),
        duration: round(script.duration), forcedLayoutDuration: round(script.forcedStyleAndLayoutDuration ?? 0),
      }));
    }
    push(item);
  };
  const recordEvent = entry => {
    // One interaction reports several events (pointerdown, pointerup, click): count it once.
    // Hover and other events outside an interaction stay in the details only.
    const interactionId = entry.interactionId || 0;
    if (interactionId) {
      if (interactionId !== lastInteraction) { interactions.count++; lastInteraction = interactionId; }
      interactions.max = Math.max(interactions.max, entry.duration);
    }
    push({ kind: 'event', t: round(entry.startTime), name: entry.name, duration: round(entry.duration), inputDelay: round(entry.processingStart - entry.startTime), interactionId, target: describeTarget(entry.target) });
  };
  const recordVisibility = () => push({ kind: 'visibility', t: round(clock.now()), state: scope.document.visibilityState });
  const observe = (type, record, options) => {
    try {
      const observer = new scope.PerformanceObserver(list => { for (const entry of list.getEntries()) record(entry); });
      observer.observe({ type, ...options });
      observers.push(observer);
      return true;
    } catch { supported = { ...supported, [type]: false }; return false; }
  };
  const start = () => {
    for (const type of FRAME_TYPES) if (supported[type] && observe(type, recordFrame)) break;
    if (supported.event) observe('event', recordEvent, { durationThreshold: EVENT_THRESHOLD_MS });
    if (supported.visibilitychange) scope.document.addEventListener('visibilitychange', recordVisibility);
  };
  const stop = () => {
    for (const observer of observers) observer.disconnect();
    observers = [];
    if (supported.visibilitychange) scope.document.removeEventListener('visibilitychange', recordVisibility);
  };

  reset();
  try { enabled = scope.localStorage.getItem(STORAGE_KEY) === '1'; } catch { /* storage unavailable: off until asked */ }
  if (enabled) { startedAt = new Date().toISOString(); start(); }
  publish();

  return {
    time(label) {
      if (!enabled) return noop;
      const startTime = clock.now();
      return () => {
        if (!enabled) return;
        const duration = clock.now() - startTime;
        const item = labels.get(label) ?? { count: 0, total: 0, max: 0 };
        item.count++; item.total += duration; item.max = Math.max(item.max, duration);
        labels.set(label, item);
        if (duration >= LABEL_DETAIL_MS) push({ kind: 'time', t: round(startTime), label, duration: round(duration) });
        else touch();
      };
    },
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setEnabled(value) {
      const next = !!value;
      if (next === enabled) return;
      enabled = next;
      try { if (next) scope.localStorage.setItem(STORAGE_KEY, '1'); else scope.localStorage.removeItem(STORAGE_KEY); } catch { /* this window only */ }
      if (next) { startedAt ??= new Date().toISOString(); start(); } else stop();
      publish();
    },
    clear() { reset(); startedAt = enabled ? new Date().toISOString() : null; publish(); },
    export: () => ({
      version: VERSION,
      startedAt,
      exportedAt: new Date().toISOString(),
      timeOrigin: clock.timeOrigin,
      userAgent: scope.navigator?.userAgent ?? '',
      viewport: { width: scope.innerWidth ?? null, height: scope.innerHeight ?? null },
      devicePixelRatio: scope.devicePixelRatio ?? null,
      page: pageScale(scope.document),
      enabled,
      supported,
      summary: summarize(),
      entries: [...ring.slice(head), ...ring.slice(0, head)],
    }),
  };
}

export const perfTrace = createPerfTrace();
