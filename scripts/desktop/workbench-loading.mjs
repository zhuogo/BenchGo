/** First-paint presentation for the official, framework-free workbench boot page. */
export function workbenchLoadingMarkup(sharedLoadingCss) {
  if (/<\/style/i.test(sharedLoadingCss)) throw new Error('Invalid loading stylesheet');
  const css = `${sharedLoadingCss}
[data-dsh-boot] { min-height: 100dvh; }
[data-dsh-boot] > div > :first-child,
[data-dsh-boot] [data-dsh-boot-spinner] + div { display: none; }
[data-dsh-boot] [data-dsh-boot-spinner] {
  display: flex; position: static; width: auto; height: auto; min-height: 0;
  padding: 0; border: 0; border-radius: 0; background: transparent;
  animation: none; transform: none;
}
[data-dsh-boot] [data-dsh-boot-spinner]::after { display: none; }
`;
  return `<style data-benchgo-workbench-loading>${css}</style><script>(${presentWorkbenchLoading.toString()})()</script>`;
}

/** Decorate the official progress node; its ownership, errors and React handoff stay intact. */
function presentWorkbenchLoading() {
  const text = navigator.language.toLowerCase().startsWith('zh') ? '正在加载…' : 'Loading…';
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
    progress.classList.add('bg-loading', 'bg-loading-compact');
    progress.setAttribute('role', 'status');
    progress.setAttribute('aria-label', text);
    progress.setAttribute('aria-live', 'polite');
    progress.setAttribute('aria-atomic', 'true');
    progress.setAttribute('aria-busy', 'true');
    const label = document.createElement('span');
    label.className = 'bg-loading-text';
    label.setAttribute('aria-hidden', 'true');
    for (const [index, character] of Array.from(text).entries()) {
      const letter = document.createElement('span');
      letter.className = 'bg-loading-character';
      letter.style.animationDelay = `${index * .075}s`;
      letter.textContent = character;
      label.append(letter);
    }
    progress.replaceChildren(label);
  }
  observer.observe(document.documentElement, { childList: true, subtree: true });
  update();
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
}
