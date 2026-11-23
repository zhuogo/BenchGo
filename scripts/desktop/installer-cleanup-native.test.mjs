import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const officialTransactions = join(repository, 'deepseek-harness/apps/desktop/scripts/installer-directories.nsh');
const quote = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');

function inside(root, path) {
  const child = relative(root, path);
  assert(child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child), `Fixture path escapes its temporary root: ${path}`);
  return path;
}

async function compilerPath() {
  const cache = join(process.env.LOCALAPPDATA ?? '', 'electron-builder/Cache/nsis-3.0.4.1');
  const roots = [cache];
  if (existsSync(cache)) for (const entry of await readdir(cache, { withFileTypes: true })) if (entry.isDirectory()) roots.push(join(cache, entry.name));
  const compiler = roots.flatMap(root => [join(root, 'Bin/makensis.exe'), join(root, 'makensis.exe')]).find(existsSync);
  assert(compiler, `The cached NSIS compiler is required: ${cache}`);
  return compiler;
}

async function execute(file, args, cwd, env = process.env) {
  return new Promise((resolveResult, reject) => {
    execFile(file, args, { cwd, env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed || error.signal)) { reject(error); return; }
      resolveResult({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

async function bootstrap() {
  const source = await readFile(join(repository, 'scripts/desktop/package-windows.mjs'), 'utf8');
  const templates = [...source.matchAll(/const bootstrap = (`[\s\S]*?`);/g)];
  assert.equal(templates.length, 1, 'the production installer has one bootstrap template');
  assert.doesNotMatch(templates[0][1], /(?<!\\)\$\{/, 'the fixture evaluates a literal, not packaging-script expressions');
  return runInNewContext(templates[0][1], Object.create(null), { timeout: 1000 });
}

function fixtureSource({ directory, current, staged, retired, profileExit, mode, wrapper }) {
  const report = quote(join(directory, 'result.ini'));
  const commands = [...wrapper.matchAll(/^\s*nsExec::ExecToStack .*$/gm)];
  assert.equal(commands.length, 1, 'the production wrapper has one enrollment process boundary');
  assert.match(commands[0][0], /init-profile.*--retired-directory "\$benchgoRetiredDirectory"/);
  // Only the external profile call is mocked. Run the imported callback at the
  // committed boundary as well: silent NSIS does not promise a GUI lifecycle.
  let adapted = wrapper.replace(commands[0][0], `
  !insertmacro FixtureSnapshot "committed"
  Call .onGUIEnd
  !insertmacro FixtureSnapshot "after-gui-end"
  Push "fixture profile output"
  Push "${profileExit}"
`);
  const messages = [...adapted.matchAll(/^\s*MessageBox .*$/gm)];
  assert.equal(messages.length, 1, 'the production enrollment failure has one message');
  adapted = adapted.replace(messages[0][0], '\n    DetailPrint "Fixture enrollment failed"');
  const end = mode === 'pre-commit-abort' ? `
  Call .onGUIEnd
  !insertmacro FixtureSnapshot "after-abort"
  SetErrorLevel 2
  Quit
` : `
  !insertmacro customInstall
  !insertmacro FixtureSnapshot "completed"
  SetErrorLevel 0
`;
  return `Unicode true
RequestExecutionLevel user
Name "BenchGo isolated cleanup fixture"
OutFile "${quote(join(directory, 'fixture.exe'))}"
SilentInstall silent
ShowInstDetails nevershow
SetCompress off
!include "LogicLib.nsh"
!define INSTALL_REGISTRY_KEY "BenchGo fixture never reads registry"
!include "${quote(officialTransactions)}"
!include "${quote(join(dirname(officialTransactions), 'restart-banner.nsh'))}"

!macro dshOfficialCustomInit
!macroend
!macro dshOfficialCustomInstall
  !insertmacro dshFinishDirectories
!macroend
!macro FixtureSnapshot Section
  WriteINIStr "${report}" "\${Section}" "oldMoved" "$dshOldMoved"
  WriteINIStr "${report}" "\${Section}" "newMoved" "$dshNewMoved"
  WriteINIStr "${report}" "\${Section}" "retired" "$benchgoRetiredDirectory"
  WriteINIStr "${report}" "\${Section}" "directoryError" "$dshDirectoryError"
  WriteINIStr "${report}" "\${Section}" "restoreError" "$dshRestoreError"
!macroend
${adapted}
Function .onInit
  InitPluginsDir
  StrCpy $INSTDIR "${quote(current)}"
  StrCpy $dshFinalDirectory $INSTDIR
  StrCpy $dshNewDirectory "${quote(staged)}"
  StrCpy $dshOldDirectory "${quote(retired)}"
  StrCpy $dshOldMoved ""
  StrCpy $dshNewMoved ""
  StrCpy $dshDirectoryError 0
  StrCpy $dshRestoreError 0
  StrCpy $dshRecoveryStopped ""
  SetOutPath $PLUGINSDIR
FunctionEnd
Section
  Call dshPromoteDirectories
  IfErrors promotion_failed
  !insertmacro FixtureSnapshot "promoted"
${end}
  Goto fixture_done
promotion_failed:
  !insertmacro FixtureSnapshot "promotion-failed"
  Call .onGUIEnd
  !insertmacro FixtureSnapshot "after-gui-end"
  SetErrorLevel 2
  Quit
fixture_done:
SectionEnd
`;
}

async function report(path) {
  const bytes = await readFile(path);
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString('utf16le').slice(1) : bytes.toString('utf8').replace(/^\uFEFF/, '');
  const result = {}; let section;
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^\[(.+)\]$/);
    if (heading) { section = result[heading[1]] = {}; continue; }
    const equals = line.indexOf('=');
    if (section && equals >= 0) section[line.slice(0, equals)] = line.slice(equals + 1);
  }
  return result;
}

test('native NSIS wrapper preserves deferred trees and the official transaction callbacks', { skip: process.platform !== 'win32', timeout: 120_000 }, async t => {
  const compiler = await compilerPath();
  const nsisRoot = basename(dirname(compiler)).toLowerCase() === 'bin' ? dirname(dirname(compiler)) : dirname(compiler);
  const wrapper = await bootstrap();
  const base = await realpath(tmpdir());
  const temporary = await realpath(await mkdtemp(join(base, 'benchgo-installer-cleanup-')));
  assert.equal(resolve(dirname(temporary)).toLowerCase(), resolve(base).toLowerCase());
  assert(basename(temporary).startsWith('benchgo-installer-cleanup-'));
  try {
    for (const mode of ['upgrade', 'new-install', 'profile-failure', 'promote-failure', 'pre-commit-abort']) await t.test(mode, async () => {
      const directory = inside(temporary, join(temporary, mode));
      await mkdir(directory);
      const current = inside(temporary, join(directory, 'BenchGo'));
      const guid = `{${randomUUID().toUpperCase()}}`;
      const staged = inside(temporary, `${current}.new-${guid}`);
      const retired = inside(temporary, `${current}.old-${guid}`);
      if (mode !== 'new-install') { await mkdir(current); await writeFile(join(current, 'original.txt'), 'previous application'); }
      if (mode !== 'promote-failure') { await mkdir(staged); await writeFile(join(staged, 'updated.txt'), 'updated application'); }
      const script = inside(temporary, join(directory, 'fixture.nsi'));
      await writeFile(script, fixtureSource({ directory, current, staged, retired, mode, wrapper, profileExit: mode === 'profile-failure' ? 1 : 0 }));
      const built = await execute(compiler, ['/V2', script], directory, { ...process.env, NSISDIR: nsisRoot });
      assert.equal(built.code, 0, `NSIS compilation failed:\n${built.stdout}\n${built.stderr}`);
      const ran = await execute(inside(temporary, join(directory, 'fixture.exe')), ['/S'], directory);
      assert.equal(ran.code, ['profile-failure', 'promote-failure', 'pre-commit-abort'].includes(mode) ? 2 : 0, `${mode}: ${ran.stdout}\n${ran.stderr}`);
      const state = await report(inside(temporary, join(directory, 'result.ini')));
      if (mode === 'promote-failure' || mode === 'pre-commit-abort') {
        assert.equal(await readFile(join(current, 'original.txt'), 'utf8'), 'previous application');
        assert.equal(existsSync(join(current, 'updated.txt')), false);
        assert.equal(existsSync(retired), false, 'the official rollback restores the previous tree');
        const after = state[mode === 'promote-failure' ? 'after-gui-end' : 'after-abort'];
        assert.equal(after.oldMoved, ''); assert.equal(after.newMoved, ''); assert.equal(after.restoreError, '0');
        if (mode === 'promote-failure') assert.notEqual(state['promotion-failed'].directoryError, '0', 'missing staged input fails the real MoveFileEx promotion');
        assert.equal(state.committed, undefined, 'failed or abandoned promotion never reaches the wrapper commit');
      } else {
        assert.equal(state.promoted.newMoved, '1');
        assert.equal(state.promoted.oldMoved, mode === 'new-install' ? '' : '1');
        for (const phase of ['committed', 'after-gui-end']) {
          assert.equal(state[phase].oldMoved, '', `${phase}: the retired tree is no longer a rollback target`);
          assert.equal(state[phase].newMoved, '', `${phase}: the official commit clears the promoted-tree rollback flag`);
          assert.equal(state[phase].retired, mode === 'new-install' ? '' : retired);
        }
        assert.equal(await readFile(join(current, 'updated.txt'), 'utf8'), 'updated application');
        assert.equal(existsSync(join(current, 'original.txt')), false);
        if (mode === 'new-install') assert.equal(existsSync(retired), false);
        else assert.equal(await readFile(join(retired, 'original.txt'), 'utf8'), 'previous application', 'even profile failure retains the committed backup for deferred cleanup');
        assert.equal(!!state.completed, mode !== 'profile-failure', 'the real wrapper exits immediately on enrollment failure');
      }
      assert.equal(existsSync(staged), false, 'promotion or rollback consumes only the fixture staging tree');
    });
  } finally {
    inside(base, temporary);
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
