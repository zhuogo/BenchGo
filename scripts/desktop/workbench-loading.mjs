import { readFileSync } from 'node:fs';

const loadingStyle = readFileSync(new URL('../../plugins/shared/client/ui/loading.css', import.meta.url), 'utf8');
const renderStatus = readFileSync(new URL('./renderer/loading-status.js', import.meta.url), 'utf8');

/** First-paint presentation for the official, framework-free workbench boot page. */
export function workbenchLoadingMarkup() {
  const css = `
[data-dsh-boot] {
  --boot-base: light-dark(#f3f6f6, #101218);
  --boot-grid: light-dark(#007a8619, #77e0db18);
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
  position: static; text-align: center;
  width: min(264px, calc(100vw - 48px)); height: auto; min-height: 0;
  padding: 0; border: 0; border-radius: 0; background: transparent;
  animation: none; transform: none;
  color: light-dark(#161c23, #eef5f6);
  font: 600 14px/20px system-ui, sans-serif;
}
[data-dsh-boot] [data-dsh-boot-spinner]::after { display: none; }
[data-dsh-boot-spinner] > .startup-loading {
  --startup-dot-step: round(down, clamp(0, calc((var(--dsh-boot-arc, 72deg) - 72deg) / 36deg), 6), 1);
}
`;
  return `<style data-benchgo-workbench-loading>${css}${loadingStyle}</style><script>(() => {\n${renderStatus}\n(${presentWorkbenchLoading.toString()})()\n})()</script>`;
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
    progress.setAttribute('aria-live', 'polite');
    progress.setAttribute('aria-atomic', 'true');
    progress.setAttribute('aria-busy', 'true');
    renderLoadingStatus(progress, text);
  }
  observer.observe(document.documentElement, { childList: true, subtree: true });
  update();
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
}
