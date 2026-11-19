import React, { useLayoutEffect } from 'react';

/** A root replacement must finish mounting before old tab effects can retire its views. */
function commitSafeViews(useViews) {
  const snapshots = new WeakMap(), retainers = new WeakMap();
  return (selector, equal) => useViews(views => {
    let snapshot = snapshots.get(views);
    if (!snapshot) {
      snapshot = views.map(view => {
        let retainTab = retainers.get(view.retainTab);
        if (!retainTab) {
          retainTab = (id, signal) => {
            const release = view.retainTab(id, signal);
            let queued = false;
            return () => {
              if (queued) return;
              queued = true;
              // Occurrence aborts still release synchronously in the official retainer.
              queueMicrotask(release);
            };
          };
          retainers.set(view.retainTab, retainTab);
        }
        return { ...view, retainTab };
      });
      snapshots.set(views, snapshot);
    }
    return selector(snapshot);
  }, equal);
}

/** Adapt the pinned owner's injection contract without replacing its stores or Session policy. */
export function mountWorkbenchRightbarLifecycle(ctx) {
  ctx.effect(() => {
    const entry = ctx.slots.entries('rightbar').find(item => item.children?.['rightbar.session']);
    const face = entry?.inject?.();
    if (typeof entry?.component !== 'function' || typeof face?.mountView !== 'function' || typeof ctx.slots.onEntryError !== 'function'
      || typeof face?.hooks?.views?.getSnapshot !== 'function' || typeof face.hooks.views.subscribe !== 'function') {
      throw new Error('Official rightbar lifecycle contract changed');
    }
    const Original = entry.component, hooks = new WeakMap(), pending = new Map();
    let stopHandoff = () => {};
    const releasePending = () => {
      stopHandoff();
      for (const release of pending.values()) release();
      pending.clear();
    };
    // A live installation can inherit unwrapped old effects. Keep their references
    // owned for the handoff; abandoned/pruned targets and disposal also release them.
    try {
      for (const view of face.hooks.views.getSnapshot()) pending.set(view.reference, face.mountView(view.reference));
    } catch (error) { releasePending(); throw error; }
    if (pending.size) {
      const unsubscribe = face.hooks.views.subscribe(() => {
        const current = new Set(face.hooks.views.getSnapshot().map(view => view.reference));
        for (const [reference, release] of pending) if (!current.has(reference)) {
          pending.delete(reference);
          queueMicrotask(release);
        }
        if (!pending.size) stopHandoff();
      });
      const stopErrors = ctx.slots.onEntryError((key, crashed) => {
        if (key === 'rightbar' && crashed === entry) queueMicrotask(releasePending);
      });
      stopHandoff = () => { unsubscribe(); stopErrors(); stopHandoff = () => {}; };
    }
    function CommitSafeRightbar(props) {
      useLayoutEffect(() => { queueMicrotask(releasePending); }, []);
      let useViews = hooks.get(props.useViews);
      if (!useViews) { useViews = commitSafeViews(props.useViews); hooks.set(props.useViews, useViews); }
      return <Original {...props} useViews={useViews} />;
    }
    entry.component = CommitSafeRightbar;
    return () => {
      if (entry.component === CommitSafeRightbar) entry.component = Original;
      releasePending();
    };
  }, 'workbench: rightbar commit lifetime');
}
