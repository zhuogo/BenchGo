import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuxiliaryOperations } from '../src/auxiliary-operations.mjs';

const requireHarness = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
const attachmentRequire = createRequire(new URL('../../../deepseek-harness/packages/attachment/attachment-local/package.json', import.meta.url));
const load = name => import(pathToFileURL(requireHarness.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm');
const { default: AttachmentLocal } = await import(pathToFileURL(attachmentRequire.resolve('@deepseek-ai/dsh-attachment-local')).href);
const sharp = attachmentRequire('sharp');

test('official Harness prepared vision dispatch reads durable image and rejects text-only main', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'auxiliary-harness-')), ctx = new Context(), seen = [];
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(AttachmentLocal, { dshHome: directory });
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ff0000' } }).png().toBuffer();
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: id === 'main/text-only' ? ['text'] : ['text', 'image'] }; }
    async *stream(options) {
      seen.push(options);
      const image = options.messages.at(-1).content.find(block => block.type === 'image');
      assert.ok(image, 'real model request must retain an image block');
      const stored = await ctx.attachments.readImage(image.attachment);
      assert.equal(stored.ref.width, 1); assert.equal(stored.ref.height, 1);
      assert.ok(stored.data.length > 0);
      yield { type: 'text-delta', index: 0, text: 'One image inspected' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['official-fixture'], new Adapter());
  const config = { models: [{ providerId: 'official-fixture', modelId: 'main/text-only' }], auxiliary: {
    capabilities: ['vision'], models: [{ providerId: 'official-fixture', modelId: 'aux/opaque' }],
  } };
  const api = createAuxiliaryOperations({ ctx, store: { getConfig: async () => config, ledger: { append: record => record } },
    artifacts: { fetch: async () => new Response(png, { headers: { 'content-type': 'image/png' } }) } });
  const result = await api.analyzeImage({ file: 'test.png', question: 'Describe this image' });
  assert.equal(result.text, 'One image inspected');
  assert.equal(seen[0].model, 'aux/opaque');
  assert.equal(result.source.kind, 'artifact');
  config.auxiliary.capabilities = [];
  await assert.rejects(api.analyzeImage({ file: 'test.png', question: 'Describe' }), /不支持图片/);
  assert.equal(seen.length, 1, 'text-only route must not get an image placeholder');
});
