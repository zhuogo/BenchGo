import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { workbenchLoadingMarkup } from './workbench-loading.mjs';

/** Add presentation before the workbench entry executes, without editing upstream. */
export function workbenchLoadingPlugin(documentPath) {
  const target = resolve(documentPath);
  const css = readFileSync(new URL('../../plugins/shared/client/ui/loading.css', import.meta.url), 'utf8');
  const markup = workbenchLoadingMarkup(css);
  let transformed = 0;
  return {
    name: 'benchgo-workbench-loading',
    buildStart() { transformed = 0; },
    transform(source, id) {
      if (resolve(id) !== target) return null;
      const anchor = "const BOOT = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>';";
      if (source.split(anchor).length !== 2) throw new Error('Official web document changed; review workbench loading integration');
      transformed++;
      return { code: source.replace(anchor, `${anchor.slice(0, -1)} + ${JSON.stringify(markup)};`), map: null };
    },
    generateBundle() {
      if (transformed !== 1) throw new Error(`Official web document changed: expected one boot document, got ${transformed}`);
    },
  };
}

export function verifyWorkbenchLoadingBundle(source) {
  for (const required of ['data-benchgo-workbench-loading', 'data-dsh-boot-spinner', 'bg-loading-hit']) {
    if (!source.includes(required)) throw new Error(`Compiled desktop is missing workbench loading presentation: ${required}`);
  }
}
