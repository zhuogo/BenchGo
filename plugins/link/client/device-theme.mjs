const scheme = value => value === 'light' || value === 'dark' ? value : '';
const mediaTheme = host => host.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

/** The host presenter owns the resolved palette, including explicit light mode. */
export function readHostTheme(host = globalThis) {
  const root = host.document?.documentElement, body = host.document?.body;
  return scheme(root?.style?.colorScheme) || scheme(root?.getAttribute?.('data-ds-theme-source'))
    || (body?.hasAttribute?.('data-ds-dark-theme') ? 'dark' : mediaTheme(host));
}

export function observeHostTheme(onChange, host = globalThis) {
  let current;
  const sync = () => { const next = readHostTheme(host); if (next !== current) { current = next; onChange(next); } };
  const media = host.matchMedia?.('(prefers-color-scheme: dark)');
  const observer = host.MutationObserver && new host.MutationObserver(sync);
  for (const node of [host.document?.documentElement, host.document?.body]) {
    if (node) observer?.observe(node, { attributes: true, attributeFilter: ['style', 'data-ds-theme-source', 'data-ds-dark-theme'] });
  }
  if (media?.addEventListener) media.addEventListener('change', sync); else media?.addListener?.(sync);
  sync();
  return () => { observer?.disconnect(); if (media?.removeEventListener) media.removeEventListener('change', sync); else media?.removeListener?.(sync); };
}

export function initialDeviceTheme(host = globalThis) {
  return scheme(new URLSearchParams(host.location?.search || '').get('theme')) || mediaTheme(host);
}

export function themedWorkbenchUrl(value, host = globalThis) {
  const url = new URL(value, host.location.href);
  const params = new URLSearchParams(url.hash.slice(1));
  params.set('themeParentOrigin', host.location.origin);
  params.set('theme', readHostTheme(host));
  url.hash = params.toString();
  return url.href;
}

export function sendWorkbenchTheme(frame, url, theme = readHostTheme()) {
  frame?.contentWindow?.postMessage({ type: 'dsh-devices:theme', theme }, new URL(url).origin);
}

/** The remote presenter can reapply its saved preference after the shell boots. */
export function inheritWorkbenchTheme(host = globalThis) {
  if (!host.parent || host.parent === host) return;
  const params = new URLSearchParams(host.location.hash.slice(1));
  const origin = params.get('themeParentOrigin');
  let theme = scheme(params.get('theme'));
  if (!origin || !theme) return;
  const { document } = host, root = document.documentElement;
  const apply = () => {
    if (root.style.colorScheme !== theme) root.style.colorScheme = theme;
    if (root.getAttribute('data-dsh-workbench-theme') !== theme) root.setAttribute('data-dsh-workbench-theme', theme);
    const body = document.body;
    if (body && body.hasAttribute('data-ds-dark-theme') !== (theme === 'dark')) body.toggleAttribute('data-ds-dark-theme', theme === 'dark');
  };
  const style = document.createElement('style');
  style.textContent = 'html[data-dsh-workbench-theme] body{background-color:var(--dsw-alias-bg-base,var(--dsh-boot-bg))}html[data-dsh-workbench-theme=light] body{--dsh-boot-bg:#fff}html[data-dsh-workbench-theme=dark] body{--dsh-boot-bg:#151517}';
  document.head.append(style);
  const observer = new host.MutationObserver(apply);
  observer.observe(root, { attributes: true, attributeFilter: ['style'] });
  const watchBody = () => {
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
    apply();
  };
  if (document.body) watchBody();
  else document.addEventListener('DOMContentLoaded', watchBody, { once: true });
  const receive = event => {
    if (event.source !== host.parent || event.origin !== origin || event.data?.type !== 'dsh-devices:theme') return;
    const next = scheme(event.data.theme);
    if (next) { theme = next; apply(); }
  };
  host.addEventListener('message', receive);
  apply();
}

/** Device pages accept appearance updates only from their declared embedding parent. */
export function connectDeviceTheme(onChange = () => {}, host = globalThis) {
  const params = new URLSearchParams(host.location?.search || '');
  const parentOrigin = host.__DSH_DEVICE_PARENT_ORIGIN__ || params.get('parentOrigin');
  const embedded = host.parent && host.parent !== host;
  let inherited = embedded && Boolean(scheme(params.get('theme'))), current;
  const apply = next => {
    if (next === current) return;
    current = next;
    const root = host.document?.documentElement, body = host.document?.body;
    if (root?.style) root.style.colorScheme = next;
    root?.setAttribute?.('data-dsh-device-theme', next);
    body?.toggleAttribute?.('data-ds-dark-theme', next === 'dark');
    onChange(next);
  };
  const media = host.matchMedia?.('(prefers-color-scheme: dark)');
  const followSystem = () => { if (!inherited) apply(mediaTheme(host)); };
  const receive = event => {
    if (!embedded || !parentOrigin || event.source !== host.parent || event.origin !== parentOrigin || event.data?.type !== 'dsh-devices:theme') return;
    const next = scheme(event.data.theme); if (!next) return;
    const background = event.data.background;
    if (typeof background === 'string' && /^(#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/i.test(background)) host.document?.documentElement?.style?.setProperty?.('--dsh-conversation-background', background);
    inherited = true; apply(next);
  };
  host.addEventListener('message', receive);
  if (media?.addEventListener) media.addEventListener('change', followSystem); else media?.addListener?.(followSystem);
  apply(initialDeviceTheme(host));
  if (embedded && parentOrigin) host.parent.postMessage({ type: 'dsh-devices:theme-ready' }, parentOrigin);
  return () => {
    host.removeEventListener('message', receive);
    if (media?.removeEventListener) media.removeEventListener('change', followSystem); else media?.removeListener?.(followSystem);
  };
}
