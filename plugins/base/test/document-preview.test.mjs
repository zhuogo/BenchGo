import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createDocumentPreview } from '../src/document-preview.mjs';

test('converter reports missing optional engine and unsupported format', async () => {
  const preview = createDocumentPreview({ run: async () => { throw new Error('missing'); } });
  await assert.rejects(preview.convert({ name: 'a.pptx', bytes: Buffer.from('a') }), { status: 503, code: 'PREVIEW_CONVERTER_UNAVAILABLE' });
  await assert.rejects(preview.convert({ name: 'a.exe', bytes: Buffer.from('a') }), { status: 415 });
});
test('conversion deduplicates content, caches, serializes and cleans temporary files', async () => {
  let calls = 0, active = 0, max = 0; const directories = [];
  const preview = createDocumentPreview({ run: async (_command, args, options) => {
    assert.equal(options.windowsHide, true);
    if (args[0] === '--version') return { stdout: 'LibreOffice test' };
    calls++; active++; max = Math.max(max, active);
    const directory = dirname(args.at(-1)); directories.push(directory);
    await writeFile(join(directory, 'input.pdf'), '%PDF-1.4 test'); active--; return { stdout: '' };
  } });
  const input = { name: '演示.pptx', bytes: Buffer.from('deck') };
  const results = await Promise.all([preview.convert(input), preview.convert(input), preview.convert({ ...input, bytes: Buffer.from('other') })]);
  assert.equal(results[0].toString(), '%PDF-1.4 test'); assert.equal(calls, 2); assert.equal(max, 1);
  await preview.convert(input); assert.equal(calls, 2);
  for (const directory of directories) await assert.rejects(access(directory), { code: 'ENOENT' });
});
test('failed conversion cleans isolated profile and releases queue', async () => {
  let directory;
  const preview = createDocumentPreview({ run: async (_command, args) => {
    if (args[0] === '--version') return { stdout: 'LibreOffice test' };
    directory = dirname(args.at(-1)); throw Object.assign(new Error('timeout'), { killed: true });
  } });
  await assert.rejects(preview.convert({ name: 'bad.doc', bytes: Buffer.from('bad') }), { code: 'PREVIEW_CONVERSION_FAILED' });
  await assert.rejects(access(directory), { code: 'ENOENT' });
});
