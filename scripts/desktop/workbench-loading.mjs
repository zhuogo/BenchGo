/** First-paint presentation for the official, framework-free workbench boot page. */
export function workbenchLoadingMarkup() {
  const css = `
[data-dsh-boot] {
  --boot-base: light-dark(#f3f6f6, #101218);
  --boot-grid: light-dark(#007a8619, #77e0db18);
  --boot-magenta: light-dark(#9a387d, #cf80be);
  --boot-cyan: light-dark(#007a86, #77e0db);
  --boot-trace: light-dark(#007a8640, #77e0db40);
  --dsh-boot-label-primary: light-dark(#20292e, #e9f1f3);
  --dsh-boot-label-secondary: light-dark(#48575f, #b7c2cb);
  color-scheme: light dark;
  box-sizing: border-box; min-height: 100dvh; height: auto; padding: 24px;
  background:
    linear-gradient(transparent, var(--boot-base) 34% 66%, transparent),
    linear-gradient(90deg, var(--boot-grid) 1px, transparent 1px) center / 24px 24px,
    linear-gradient(var(--boot-grid) 1px, transparent 1px) center / 24px 24px var(--boot-base);
  overflow-wrap: anywhere;
}
body[data-ds-dark-theme] [data-dsh-boot] { color-scheme: dark; }
[data-dsh-boot] > div { min-width: 0; max-width: 100%; }
[data-dsh-boot] > div > :first-child,
[data-dsh-boot] [data-dsh-boot-spinner] + div { display: none; }
[data-dsh-boot] [data-dsh-boot-spinner] {
  display: grid; justify-items: center; gap: 15px; position: static;
  width: min(264px, calc(100vw - 48px)); height: auto; min-height: 0;
  padding: 0; border: 0; border-radius: 0; background: transparent;
  animation: none; transform: none;
  color: var(--dsh-boot-label-primary);
  font: 600 14px/20px system-ui, sans-serif;
}
[data-dsh-boot] [data-dsh-boot-spinner]::after { display: none; }
.benchgo-boot-rail {
  position: relative; width: 100%; height: 9px;
  background:
    repeating-linear-gradient(90deg, transparent 0 calc(12.5% - 1px), var(--boot-trace) calc(12.5% - 1px) 12.5%) center / 100% 100% no-repeat,
    linear-gradient(var(--boot-trace), var(--boot-trace)) center / 100% 1px no-repeat;
  border-inline: 1px solid var(--boot-trace);
}
.benchgo-boot-rail::before {
  content: ''; position: absolute; inset: 3px 0;
  background: linear-gradient(90deg, var(--boot-magenta), var(--boot-cyan));
  transform: scaleX(clamp(0, calc((var(--dsh-boot-arc, 72deg) - 72deg) / 216deg), 1));
  transform-origin: left;
  transition: transform 200ms var(--ease-out, cubic-bezier(.23, 1, .32, 1));
}
.benchgo-boot-rail::after {
  content: ''; position: absolute; top: 3px; right: -2px;
  width: 3px; height: 3px; background: var(--boot-cyan);
  animation: benchgo-boot-signal 1.6s ease-in-out infinite alternate;
}
@keyframes benchgo-boot-signal { from { opacity: .35; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .benchgo-boot-rail::before { transition: none; }
  .benchgo-boot-rail::after { animation: none; }
}
`;
  return `<style data-benchgo-workbench-loading>${css}</style><script>(${presentWorkbenchLoading.toString()})()</script>`;
}

/** Decorate the official progress node; its ownership, errors and React handoff stay intact. */
function presentWorkbenchLoading() {
  const text = navigator.language.toLowerCase().startsWith('zh') ? '正在加载工作台…' : 'Loading workbench…';
  let container;
  let mounted = false;
  const observer = new MutationObserver(update);
  function update() {
    if (!container) {
      container = document.getElementById('root');
      if (!container) return;
      observer.disconnect();
      observer.observe(container, { childList: true, subtree: true });
    }
    const boot = container.querySelector(':scope > [data-dsh-boot]');
    if (!boot) {
      if (mounted) observer.disconnect();
      return;
    }
    mounted = true;
    const progress = boot.querySelector('[data-dsh-boot-spinner]');
    if (!progress || progress.dataset.benchgoLoading !== undefined) return;
    progress.dataset.benchgoLoading = '';
    progress.setAttribute('role', 'status');
    progress.setAttribute('aria-label', text);
    progress.setAttribute('aria-live', 'polite');
    progress.setAttribute('aria-atomic', 'true');
    progress.setAttribute('aria-busy', 'true');
    const rail = document.createElement('span');
    rail.className = 'benchgo-boot-rail';
    rail.setAttribute('aria-hidden', 'true');
    progress.replaceChildren(rail, text);
  }
  observer.observe(document.documentElement, { childList: true, subtree: true });
  update();
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
}
