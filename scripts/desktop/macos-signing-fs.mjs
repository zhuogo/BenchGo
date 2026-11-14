/** Build-process only: queue descriptor pressure before electron-builder loads isbinaryfile. */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const desktopRequire = createRequire(new URL('../../deepseek-harness/apps/desktop/package.json', import.meta.url));
const builderRequire = createRequire(desktopRequire.resolve('app-builder-lib'));
// osx-sign 1.3.x scans the entire app with Promise.all before applying signIgnore.
// Use the locked build dependency's supported application-level EMFILE retry queue;
// every file is still inspected and every selected executable is still signed.
builderRequire('graceful-fs').gracefulify(fs);
console.error('[BenchGo packaging] graceful-fs descriptor queue enabled for macOS signing');
