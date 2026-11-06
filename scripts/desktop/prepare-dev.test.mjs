import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const scriptUrl = new URL('./prepare-dev.mjs', import.meta.url);
const source = (await readFile(scriptUrl, 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(scriptUrl.href));

async function launch({ enrollmentCode = 0, output = '{"managed":true,"directory":"managed-release"}', syncError, appDirectory, discoverBuilds } = {}) {
  const children = [];
  const events = [];
  let forwarded = '';
  let complete;
  const finished = runInNewContext(`(async () => { ${source} })()`, {
    URL, join, resolve, fileURLToPath,
    existsSync: path => discoverBuilds
      ? path.endsWith('artifacts')
        ? true
        : path.endsWith('artifacts/windows/win-unpacked/BenchGo.exe')
        ? false
        : path.endsWith('BenchGo.exe') && /windows-(?:fix|alt)/.test(path)
      : true,
    readdirSync: () => discoverBuilds ? [{ name: 'windows-alt', isDirectory: () => true }, { name: 'windows-fix', isDirectory: () => true }] : [],
    statSync: path => ({ mtimeMs: path.includes('windows-fix') ? 20 : 10 }),
    process: { env: { BENCHGO_TEST_ENV: 'preserved', BENCHGO_DEV_APP_DIR: appDirectory }, stdout: { write: chunk => { forwarded += chunk; } } },
    console: { log() {} },
    async syncDevelopmentPlugin({ root, enrollment }) {
      events.push('sync');
      assert.equal(typeof root, 'string');
      assert.equal(enrollment.managed, true);
      assert.equal(enrollment.directory, 'managed-release');
      if (syncError) throw syncError;
    },
    spawn(executable, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = encoding => assert.equal(encoding, 'utf8');
      child.unref = () => { child.unreferenced = true; };
      children.push({ child, executable, args, options });
      if (children.length === 1) complete = () => {
        child.stdout.emit('data', output.slice(0, 5));
        child.stdout.emit('data', output.slice(5));
        child.emit('close', enrollmentCode);
      };
      else events.push('launch');
      return child;
    },
  });
  assert.equal(children.length, 1);
  complete();
  return { children, events, finished, forwarded };
}

test('desktop detaches from launcher terminal streams after plugin enrollment', async () => {
  const { children, events, finished, forwarded } = await launch();
  await finished;
  assert.equal(children.length, 2);
  assert.deepEqual(Array.from(children[0].options.stdio), ['ignore', 'pipe', 'inherit']);
  assert.equal(children[0].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(children[0].options.env.BENCHGO_TEST_ENV, 'preserved');
  assert.ok(children[0].args.includes('init-profile'));
  assert.equal(children[0].args[1], fileURLToPath(new URL('./plugin-bundle.mjs', scriptUrl)), 'development enrollment uses current layout validation instead of the older packaged helper');
  assert.equal(children[1].executable, children[0].executable);
  assert.equal(children[1].options.stdio, 'ignore');
  assert.equal(children[1].options.detached, true);
  assert.equal(children[1].child.unreferenced, true);
  assert.deepEqual(events, ['sync', 'launch']);
  assert.equal(forwarded, '{"managed":true,"directory":"managed-release"}');
});

test('development launcher can select another unpacked BenchGo build', async () => {
  const appDirectory = join(fileURLToPath(new URL('../../', scriptUrl)), 'artifacts/windows-fix/win-unpacked');
  const { children, finished } = await launch({ appDirectory });
  await finished;
  assert.equal(children[0].executable, join(appDirectory, 'BenchGo.exe'));
  assert.ok(children[0].args.includes(join(appDirectory, 'resources')));
  assert.equal(children[1].executable, join(appDirectory, 'BenchGo.exe'));
});

test('development launcher finds the newest Windows build when the default directory is empty', async () => {
  const root = fileURLToPath(new URL('../../', scriptUrl));
  const appDirectory = join(root, 'artifacts/windows-fix/win-unpacked');
  const { children, finished } = await launch({ discoverBuilds: true });
  await finished;
  assert.equal(children[0].executable, join(appDirectory, 'BenchGo.exe'));
  assert.ok(children[0].args.includes(join(appDirectory, 'resources')));
  assert.equal(children[1].executable, join(appDirectory, 'BenchGo.exe'));
});

test('failed plugin enrollment prevents the desktop from opening', async () => {
  const { children, events, finished } = await launch({ enrollmentCode: 1 });
  await assert.rejects(finished, /\(1\)/);
  assert.equal(children.length, 1);
  assert.deepEqual(events, []);
});

test('invalid enrollment output prevents synchronization and desktop launch', async () => {
  const { children, events, finished } = await launch({ output: 'invalid JSON' });
  await assert.rejects(finished, /JSON/);
  assert.equal(children.length, 1);
  assert.deepEqual(events, []);
});

test('synchronization failure prevents desktop launch', async () => {
  const { children, events, finished } = await launch({ syncError: new Error('copy failed') });
  await assert.rejects(finished, /copy failed/);
  assert.equal(children.length, 1);
  assert.deepEqual(events, ['sync']);
});
