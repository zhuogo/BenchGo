import { resolve } from 'node:path';

/** Keep the primary workspace's media and lease timers running while hidden. */
export function prepareBackgroundInput(source) {
  const code = source.replaceAll('\r\n', '\n');
  const anchor = 'webviewTag: primary,';
  if (!code.includes('function createWindow(preload, show = false, primary = false)')
    || code.split(anchor).length !== 2 || code.includes('backgroundThrottling:')) {
    throw new Error('Official main changed; review background voice integration');
  }
  return code.replace(anchor, anchor + '\n            backgroundThrottling: !primary,');
}

/** Restrict the override to the staged official main entry, leaving upstream intact. */
export function backgroundExecutionPlugin(mainPath) {
  const target = resolve(mainPath);
  let transformed = 0;
  return {
    name: 'benchgo-background-execution',
    buildStart() { transformed = 0; },
    transform(source, id) {
      if (resolve(id) !== target) return null;
      transformed++;
      return { code: prepareBackgroundInput(source), map: null };
    },
    generateBundle() {
      if (transformed !== 1) throw new Error(`Official main changed: expected one background execution entry, got ${transformed}`);
    },
  };
}

/** A plugin-only reload cannot supply this main-process policy to an old package. */
export function verifyBackgroundBundle(source) {
  if (!/webviewTag:\s*primary,\s*backgroundThrottling:\s*!primary,/.test(source)) {
    throw new Error('Compiled desktop is missing the primary workspace background execution policy');
  }
}
