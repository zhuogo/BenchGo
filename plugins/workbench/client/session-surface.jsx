import React, { useSyncExternalStore } from 'react';
import { SidebarSessionViews } from '../../../deepseek-harness/packages/client/ui-sidebar-right/src/client/session-views.ts';

const surfaces = new WeakMap();
const ASSISTANT_PANEL = 'benchgo-assistant';
export const WORKBENCH_SESSION_CORNER = 'benchgo.workbench.session.corner';

/** Declare on the session-scoped conversation entry that renders the official corner. */
export const workbenchSessionSurfaceChildren = {
  [WORKBENCH_SESSION_CORNER]: { kind: 'single', scope: 'session' },
};

/** Keep one commit's body cleanup from retiring a view its replacement still needs. */
function commitSafeView(view, retainers, holds) {
  let retainTab = retainers.get(view.retainTab);
  if (!retainTab) {
    retainTab = (id, signal) => {
      const release = view.retainTab(id, signal);
      let held = true, queued = false;
      const finish = () => {
        if (!held) return;
        held = false;
        holds.delete(finish);
        signal.removeEventListener('abort', finish);
        release();
      };
      holds.add(finish);
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
      return () => {
        if (queued) return;
        queued = true;
        queueMicrotask(finish);
      };
    };
    retainers.set(view.retainTab, retainTab);
  }
  return { ...view, retainTab };
}

/** Project an auxiliary conversation through the pinned official seats and controller. */
function installSurface(ctx, sidebar) {
  const entries = ctx.slots.entries('rightbar').filter(entry => entry.children?.['rightbar.session']);
  const entry = entries[0], face = entry?.inject?.(), originalMounted = sidebar.mounted;
  const corners = ctx.slots.entries('conversation.session.header.corner').filter(entry => entry.locale === 'sidebarRight');
  const corner = corners[0];
  if (entries.length !== 1 || typeof entry.component !== 'function' || typeof face?.mountView !== 'function'
    || corners.length !== 1 || typeof corner.component !== 'function' || !corner.store || typeof corner.inject !== 'function'
    || typeof face?.hooks?.views?.getSnapshot !== 'function' || typeof face.hooks.views.subscribe !== 'function'
    || typeof originalMounted?.getSnapshot !== 'function' || typeof originalMounted.subscribe !== 'function'
    || typeof ctx.layout?.panelInfo?.getSnapshot !== 'function' || typeof ctx.layout.panelInfo.subscribe !== 'function'
    || typeof ctx.sessions?.retain !== 'function' || typeof sidebar.openResourceIn !== 'function'
    || Object.getOwnPropertyDescriptor(sidebar, 'mounted')?.writable !== true) {
    throw new Error('Official rightbar session-surface contract changed');
  }
  const Original = entry.component, auxiliary = new SidebarSessionViews(ctx.sessions), claims = new Map();
  const listeners = new Set(), mountedListeners = new Set(), references = new WeakSet(), retainers = new WeakMap(), holds = new Set();
  const viewHooks = new WeakMap(), panelHooks = new WeakMap(), mountHooks = new WeakMap(), renderKeys = new WeakMap(), merged = new WeakMap();
  let nextRenderKey = 0;
  let disposed = false, syncing = false, rerun = false, mounts = 0;
  let snapshot = { sessionId: undefined, views: auxiliary.source.getSnapshot() };
  let mountedSession = originalMounted.getSnapshot();
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const getSnapshot = () => snapshot;
  const mounted = {
    getSnapshot: () => mountedSession,
    subscribe(listener) { mountedListeners.add(listener); return () => mountedListeners.delete(listener); },
  };
  const sync = () => {
    if (disposed) return;
    if (syncing) { rerun = true; return; }
    syncing = true;
    try {
      do {
        rerun = false;
        const sessionId = ctx.layout.panelInfo.getSnapshot().activePanelId === ASSISTANT_PANEL ? [...claims.values()].at(-1) : undefined;
        const native = face.hooks.views.getSnapshot();
        // The same session may already have an ordinary rightbar view. Its
        // original reference and mount owner take precedence over an extra one.
        auxiliary.select(native.some(view => view.sessionId === sessionId) ? undefined : sessionId);
        const views = auxiliary.source.getSnapshot();
        for (const view of views) references.add(view.reference);
        const changed = snapshot.sessionId !== sessionId || snapshot.views !== views;
        if (changed) snapshot = { sessionId, views };
        const selected = sessionId ?? originalMounted.getSnapshot();
        if (mountedSession !== selected) {
          mountedSession = selected;
          for (const listener of [...mountedListeners]) listener();
        }
        if (changed) for (const listener of [...listeners]) listener();
      } while (rerun);
    } finally { syncing = false; }
  };
  const combine = (native, value) => {
    let values = merged.get(native);
    if (!values) { values = new WeakMap(); merged.set(native, values); }
    let result = values.get(value);
    if (!result) {
      const byId = new Map(native.map(view => [view.sessionId, { ...view, selected: value.sessionId === undefined ? view.selected : view.sessionId === value.sessionId }]));
      for (const view of value.views) if (!byId.has(view.sessionId)) byId.set(view.sessionId, commitSafeView(view, retainers, holds));
      result = [...byId.values()];
      values.set(value, result);
    }
    return result;
  };
  function SessionSurfaceRightbar(props) {
    let useViews = viewHooks.get(props.useViews);
    if (!useViews) {
      const useNativeViews = props.useViews;
      useViews = (selector, equal) => {
        const native = useNativeViews(value => value);
        const value = useSyncExternalStore(subscribe, getSnapshot);
        return selector(combine(native, value));
      };
      viewHooks.set(props.useViews, useViews);
    }
    let usePanelInfo = panelHooks.get(props.usePanelInfo);
    if (!usePanelInfo) {
      const useNativePanelInfo = props.usePanelInfo;
      usePanelInfo = (selector, equal) => {
        const active = useSyncExternalStore(subscribe, getSnapshot).sessionId !== undefined;
        return useNativePanelInfo(info => selector(active ? { ...info, activePanelId: null } : info), equal);
      };
      panelHooks.set(props.usePanelInfo, usePanelInfo);
    }
    let mountView = mountHooks.get(props.mountView);
    if (!mountView) {
      mountView = reference => {
        if (!references.has(reference)) return props.mountView(reference);
        const release = auxiliary.mount(reference);
        mounts++;
        let held = true;
        return () => {
          if (!held) return;
          held = false;
          release(); mounts--;
          if (disposed && mounts === 0) auxiliary.dispose();
        };
      };
      mountHooks.set(props.mountView, mountView);
    }
    let renderKey = renderKeys.get(props.useViews);
    if (renderKey === undefined) { renderKey = nextRenderKey++; renderKeys.set(props.useViews, renderKey); }
    // A surrounding adapter may replace a hook with a composed hook during
    // reload. A fresh subtree gives that new hook its own React hook sequence.
    return <Original key={renderKey} {...props} useViews={useViews} usePanelInfo={usePanelInfo} mountView={mountView} />;
  }
  const stops = [face.hooks.views.subscribe(sync), auxiliary.source.subscribe(sync), originalMounted.subscribe(sync), ctx.layout.panelInfo.subscribe(sync)];
  // The conversation package already owns its corner declaration. An alias
  // reuses its exact implementation and Store without redeclaring that slot.
  const stopCorner = ctx.slots.inject(WORKBENCH_SESSION_CORNER, () => ctx.slots.register({
    name: WORKBENCH_SESSION_CORNER, locale: corner.locale, store: corner.store, inject: corner.inject,
  }, corner.component));
  sidebar.mounted = mounted;
  entry.component = SessionSurfaceRightbar;
  sync();
  return {
    owners: 1,
    activate(sessionId) {
      if (disposed) throw new Error('Workbench session surface is unavailable');
      const token = {};
      claims.set(token, sessionId);
      try { sync(); } catch (error) { claims.delete(token); sync(); throw error; }
      return () => { if (claims.delete(token)) sync(); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopCorner();
      stops.forEach(stop => stop());
      claims.clear();
      if (entry.component === SessionSurfaceRightbar) entry.component = Original;
      if (sidebar.mounted === mounted) sidebar.mounted = originalMounted;
      mountedSession = originalMounted.getSnapshot();
      snapshot = { sessionId: undefined, views: [] };
      for (const listener of [...listeners]) listener();
      for (const listener of [...mountedListeners]) listener();
      listeners.clear(); mountedListeners.clear();
      // A replaced root may still own committed SessionProviders. Retire their
      // views now; their mount releases finish disposal after the last commit.
      for (const release of [...holds]) release();
      auxiliary.select(undefined);
      if (mounts === 0) auxiliary.dispose();
    },
  };
}

/** Mount once per host; every owning Cordis effect releases its installation share. */
export function mountWorkbenchSessionSurface(ctx) {
  ctx.effect(() => {
    const sidebar = ctx.sidebarRight;
    if (!sidebar || typeof sidebar !== 'object') throw new Error('Official rightbar session-surface service is unavailable');
    let surface = surfaces.get(sidebar);
    if (surface) surface.owners++;
    else { surface = installSurface(ctx, sidebar); surfaces.set(sidebar, surface); }
    return () => {
      if (--surface.owners !== 0) return;
      if (surfaces.get(sidebar) === surface) surfaces.delete(sidebar);
      surface.dispose();
    };
  }, 'workbench: auxiliary session surfaces');
}

/** Claim the active assistant conversation after its Session reference is ready. */
export function activateWorkbenchSessionSurface(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Workbench session surface requires a session');
  const surface = surfaces.get(ctx.sidebarRight);
  if (!surface) throw new Error('Workbench session surface is not mounted');
  return surface.activate(sessionId);
}
