export const VIEWPORT_BREAKPOINT = 1024;
export const DRAWER_BREAKPOINT = 768;
export const VIEWPORT_SETTLE_MS = 90;
const region = width => width < DRAWER_BREAKPOINT ? 0 : width < VIEWPORT_BREAKPOINT ? 1 : 2;

export function createResponsiveLayoutActions(actions, schedule = setTimeout, cancel = clearTimeout) {
  let committed, pending = 0, timer;
  const commit = width => {
    pending = 0;
    committed = width;
    actions.setViewportWidth(width);
  };
  return {
    ...actions,
    setViewportWidth(rawWidth) {
      const width = Math.round(rawWidth);
      if (!Number.isFinite(width) || width <= 0 || width === pending) return;
      if (width === committed) {
        if (timer) cancel(timer);
        timer = undefined; pending = 0;
        return;
      }
      if (committed === undefined || region(committed) !== region(width)) {
        if (timer) cancel(timer);
        timer = undefined;
        commit(width);
        return;
      }
      pending = width;
      if (timer) cancel(timer);
      timer = schedule(() => {
        timer = undefined;
        if (pending) commit(pending);
      }, VIEWPORT_SETTLE_MS);
    },
    dispose() {
      if (timer) cancel(timer);
      timer = undefined;
      if (pending) commit(pending);
    },
  };
}
