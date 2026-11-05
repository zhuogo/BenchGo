import test from 'node:test';
import assert from 'node:assert/strict';
import { fileUrl, pdfUrl, previewKind, decodeText, readPreview, checkOfficeArchive, visibleRows, frameDocument } from '../../shared/client/preview-model.mjs';

test('preview URLs preserve opaque file names and enforce the current origin', () => {
  const base = 'https://benchgo.test/workbench/';
  const value = 'api/file?file=%E6%8A%A5%E5%91%8A%20%26%20v1.docx&token=Exact%3AID&download=1';
  assert.equal(fileUrl(value, base).searchParams.get('file'), '报告 & v1.docx');
  const pdf = new URL(pdfUrl(value, base));
  assert.equal(pdf.searchParams.get('preview'), 'pdf');
  assert.equal(pdf.searchParams.get('token'), 'Exact:ID');
  assert.equal(pdf.searchParams.has('download'), false);
  for (const input of ['https://other.test/file', '//other.test/file', 'javascript:alert(1)', 'data:text/plain,test', 'file:///C:/a']) assert.throws(() => fileUrl(input, base));
  const previous = globalThis.document;
  try { globalThis.document = { baseURI: 'https://benchgo.test/link/workbench/' }; assert.equal(fileUrl('api/file').pathname, '/link/workbench/api/file'); }
  finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
  assert.equal(fileUrl('api/commander/assistant/system-file?file=note.md', 'dsh-app://app/').protocol, 'dsh-app:');
  assert.throws(() => fileUrl('dsh-app://other/api/file', 'dsh-app://app/'));
});

test('formats are case insensitive and text decoding rejects binary and invalid UTF-8', () => {
  for (const [name, kind] of [['说明.MD', 'markdown'], ['a.json', 'json'], ['a.XLSX', 'sheet'], ['a.tsv', 'sheet'], ['a.docx', 'docx'], ['a.PPTX', 'office'], ['a.html', 'html'], ['a.pdf', 'pdf']]) assert.equal(previewKind(name), kind);
  assert.equal(decodeText(new TextEncoder().encode('中文 😀\n')), '中文 😀\n');
  assert.equal(decodeText(new Uint8Array()), '');
  assert.throws(() => decodeText(Uint8Array.of(65, 0, 66)));
  assert.throws(() => decodeText(Uint8Array.of(0xc3, 0x28)));
});

test('stream reader bounds declared and actual sizes and cancels oversized reads', async () => {
  let cancelled = false;
  const declared = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': '9' } });
  await assert.rejects(readPreview(declared, 8));
  assert.equal(cancelled, true);
  cancelled = false;
  const chunked = new Response(new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3)); controller.enqueue(Uint8Array.of(4, 5)); }, cancel() { cancelled = true; } }));
  await assert.rejects(readPreview(chunked, 4));
  assert.equal(cancelled, true);
  assert.deepEqual(await readPreview(new Response(Uint8Array.of(1, 2, 3)), 3), Uint8Array.of(1, 2, 3));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readPreview(new Response('ok'), 8, controller.signal), { name: 'AbortError' });
  await assert.rejects(readPreview(new Response('{"error":"converter unavailable"}', { status: 503 }), 100), /converter unavailable/);
});

function archive(sizes, { encrypted = false, entries = sizes.length, offset = 4 } = {}) {
  const bytes = new Uint8Array(4 + sizes.length * 46 + 22), view = new DataView(bytes.buffer);
  bytes.set([0x50, 0x4b]);
  sizes.forEach((size, index) => { const at = 4 + index * 46; view.setUint32(at, 0x02014b50, true); view.setUint32(at + 24, size, true); view.setUint16(at + 8, encrypted ? 1 : 0, true); });
  const end = bytes.length - 22;
  view.setUint32(end, 0x06054b50, true); view.setUint16(end + 10, entries, true); view.setUint32(end + 16, offset, true);
  return bytes;
}

test('Office guard rejects expanded ZIP bombs, encrypted archives and malformed directories', () => {
  assert.doesNotThrow(() => checkOfficeArchive(Uint8Array.of(1, 2, 3)));
  assert.doesNotThrow(() => checkOfficeArchive(archive([32 * 1024 * 1024, 32 * 1024 * 1024])));
  assert.throws(() => checkOfficeArchive(archive([64 * 1024 * 1024, 1])), /64 MiB/);
  assert.throws(() => checkOfficeArchive(archive([1], { encrypted: true })), /加密/);
  assert.throws(() => checkOfficeArchive(archive([], { entries: 4097 })), /复杂/);
  assert.throws(() => checkOfficeArchive(archive([1], { offset: 0xffffffff })), /结构/);
  assert.throws(() => checkOfficeArchive(Uint8Array.of(0x50, 0x4b)), /不完整/);
  const padded = new Uint8Array(100); const valid = archive([4]); padded.set(valid, 10);
  assert.doesNotThrow(() => checkOfficeArchive(padded.subarray(10, 10 + valid.length)));
});

test('sheet filtering retains source row indices and frame isolation blocks active content', () => {
  const rows = [['Alpha', 0], ['中文', 42], ['ALPHABET', null]];
  assert.deepEqual(visibleRows(rows, ' alpha ').map(row => row.index), [0, 2]);
  assert.deepEqual(visibleRows(rows, '42'), [{ row: rows[1], index: 1 }]);
  assert.equal(visibleRows(rows, '').length, 3);
  const frame = frameDocument('<h1>报告</h1>');
  assert.match(frame, /script-src 'none'/);
  assert.match(frame, /default-src 'none'/);
  assert.match(frame, /form-action 'none'/);
  assert.match(frame, /<h1>报告<\/h1>/);
});
