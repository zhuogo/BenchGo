/** Desktop privilege comes from the official owned-host connection transport. */
export function localWorkbenchPage(page, connection) {
  if (page.protocol === 'dsh-app:') return page.hostname === 'app' && connection?.isLoopback === true;
  return ['http:', 'https:'].includes(page.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(page.hostname);
}
