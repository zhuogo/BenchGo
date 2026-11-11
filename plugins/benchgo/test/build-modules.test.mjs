import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('module build preserves source and assets while excluding recovery files and replacing stale output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-modules-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plugins = join(directory, 'plugins');
  const put = async (file, content = 'fixture') => {
    const target = join(plugins, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  await put('benchgo/scripts/build-modules.mjs');
  await copyFile(new URL('../scripts/build-modules.mjs', import.meta.url), join(plugins, 'benchgo/scripts/build-modules.mjs'));
  for (const module of ['harness', 'superagent', 'voice', 'interactive', 'efficiency', 'workbench']) {
    await put(`${module}/package.json`, '{"type":"module"}');
    await put(`${module}/src/plugin.mjs`, "export const name = 'fixture';");
  }
  await put('workbench/scripts/vendor-adapter.mjs', `
import { mkdir, writeFile } from 'node:fs/promises';
export async function prepareWorkbenchVendors() {
  const output = new URL('../lib/', import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL('ssh-host.mjs', output), "export const transport = true;");
  await writeFile(new URL('DSH-SSH-LICENSE', output), 'Vendor license');
  await writeFile(new URL('NOTICE', output), 'Vendor notice');
}`);
  await put('workbench/src/plugin.mjs', "export { transport } from '../lib/ssh-host.mjs';");
  await put('superagent/src/service.mjs', "import { value } from '../../benchgo/src/shared.mjs';\nexport { value };\n");
  await put('benchgo/src/shared.mjs', 'export const value = 1;');
  await put('superagent/shared/catalog.mjs', 'export default [];');
  await put('superagent/prompts/builtin-layer.md', '# 内置层\n\nPublished runtime rules');
  await put('superagent/src/prompt.mjs', "export const builtinLayer = new URL('../prompts/builtin-layer.md', import.meta.url);\n");
  await put('superagent/assets/pet/SOURCE.md', 'Preserved provenance');
  await put('voice/client/audio-worklet.js');
  await put('voice/shared/protocol-catalog.mjs', "export const protocols = ['auto', 'speech'];");
  await put('voice/src/protocols.mjs', "export { protocols } from '../shared/protocol-catalog.mjs';");
  await put('voice/prompts/conversation.md', '# 实时语音交互\n\nSpeak naturally.');
  await put('voice/src/conversation-prompt.mjs', "export const prompt = new URL('../prompts/conversation.md', import.meta.url);\n");
  await put('voice/scripts/build-noise.mjs', `
import { mkdir, writeFile } from 'node:fs/promises';
export async function buildNoise() {
  const output = new URL('../lib/', import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL('noise-worklet.js', output), '// reviewed noise fixture');
}`);
  await put('voice/locale/en.json', '{}');
  const backups = ['plugin.mjs.bak', 'plugin.mjs.bak2', 'plugin.mjs.bak-20261104-board', 'plugin.mjs.orig', 'plugin.mjs.rej', 'plugin.mjs.tmp', 'plugin.mjs.swp', 'plugin.mjs~'];
  for (const file of backups) await put(`superagent/src/${file}`);
  await put('superagent/src/recovery.bak/nested.mjs');
  await put('benchgo/lib/modules/superagent/src/removed.mjs');
  await put('benchgo/lib/modules/superagent/src/plugin.mjs.bak');
  const { buildModules } = await import(pathToFileURL(join(plugins, 'benchgo/scripts/build-modules.mjs')).href);
  await buildModules();
  const output = join(plugins, 'benchgo/lib/modules');
  const publishedWorkbench = await import(pathToFileURL(join(output, 'workbench/src/plugin.mjs')).href);
  assert.equal(publishedWorkbench.transport, true);
  assert.equal(await readFile(join(output, 'workbench/lib/DSH-SSH-LICENSE'), 'utf8'), 'Vendor license');
  assert.equal(await readFile(join(output, 'workbench/lib/NOTICE'), 'utf8'), 'Vendor notice');
  assert.deepEqual((await readdir(join(output, 'superagent/src'))).sort(), ['plugin.mjs', 'prompt.mjs', 'service.mjs']);
  assert.match(await readFile(join(output, 'superagent/src/service.mjs'), 'utf8'), /from '\.\.\/\.\.\/\.\.\/\.\.\/src\/shared\.mjs'/);
  assert.equal(await readFile(join(output, 'superagent/assets/pet/SOURCE.md'), 'utf8'), 'Preserved provenance');
  const publishedPrompt = await import(pathToFileURL(join(output, 'superagent/src/prompt.mjs')).href);
  assert.equal(await readFile(publishedPrompt.builtinLayer, 'utf8'), await readFile(join(plugins, 'superagent/prompts/builtin-layer.md'), 'utf8'));
  for (const file of backups) assert.equal(await readFile(join(plugins, 'superagent/src', file), 'utf8'), 'fixture');
  assert.equal(await readFile(join(plugins, 'superagent/src/recovery.bak/nested.mjs'), 'utf8'), 'fixture');
  assert.equal(await readFile(join(output, 'voice/client/audio-worklet.js'), 'utf8'), 'fixture');
  const voiceProtocols = await import(pathToFileURL(join(output, 'voice/src/protocols.mjs')).href);
  assert.deepEqual(voiceProtocols.protocols, ['auto', 'speech']);
  const voicePrompt = await import(pathToFileURL(join(output, 'voice/src/conversation-prompt.mjs')).href);
  assert.equal(await readFile(voicePrompt.prompt, 'utf8'), await readFile(join(plugins, 'voice/prompts/conversation.md'), 'utf8'));
});
