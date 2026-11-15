/** A paired carrier remains remote even when its proxy listens on loopback. */
export function localWorkbenchPage(page, connection, scope = globalThis) {
  if (scope.__DSH_LINK_WORKBENCH__ || (scope.__DSH_TRANSPORT__ && scope.__DSH_TRANSPORT__.ownsHost !== true)) return false;
  if (page.protocol === 'dsh-app:') return page.hostname === 'app' && connection?.isLoopback === true;
  return ['http:', 'https:'].includes(page.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(page.hostname);
}
