import test from 'node:test';
import assert from 'node:assert/strict';
import { saveOriginalFile } from '../../shared/client/file-save.mjs';

function fixture(baseURI = 'https://benchgo.test/workspace/') {
  const calls = { saves: [], fetches: [], blobs: [], revoked: [], anchors: [], timers: [] };
  const bytes = new Uint8Array([0, 128, 255, 13, 10]);
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const environment = {
    document: { baseURI, body: { append(anchor) { anchor.appended = true; } }, createElement(tag) {
      assert.equal(tag, 'a');
      const anchor = { click() { this.clicked = true; }, remove() { this.removed = true; } };
      calls.anchors.push(anchor); return anchor;
    } },
    URL: { createObjectURL(value) { calls.blobs.push(value); return 'blob:original'; }, revokeObjectURL(value) { calls.revoked.push(value); } },
    async fetch(...args) { calls.fetches.push(args); return { ok: true, status: 200, async blob() { return blob; } }; },
    setTimeout(callback, delay) { calls.timers.push({ callback, delay }); },
  };
  const native = (result = { status: 'saved', path: 'C:\\Downloads\\photo.jpg' }) => {
    environment.dshDesktop = { fileActions: { async save(request) { calls.saves.push(request); return result; } } };
  };
  return { environment, calls, blob, bytes, native };
}

test('native save passes signed public original directly without fetching or changing query parameters', async () => {
  const f = fixture('dsh-app://app/'); f.native();
  const url = 'https://images.test/photo.jpg?token=a%2Fb&signature=xyz#original';
  const result = await saveOriginalFile({ url: 'https://images.test/preview.webp', downloadUrl: url, filename: 'photo.jpg', mimeType: 'image/jpeg' }, f.environment);
  assert.deepEqual(result, { status: 'saved', path: 'C:\\Downloads\\photo.jpg' });
  assert.deepEqual(f.calls.saves, [{ url, name: 'photo.jpg', mediaType: 'image/jpeg', mode: 'saveAs' }]);
  assert.equal(f.calls.fetches.length, 0); assert.equal(f.calls.blobs.length, 0);
});

test('native dsh-app original uses authorized same-origin fetch and keeps Blob URL alive until completion', async () => {
  const f = fixture('dsh-app://app/'); f.native();
  let finish;
  f.environment.dshDesktop.fileActions.save = request => { f.calls.saves.push(request); return new Promise(resolve => { finish = resolve; }); };
  const pending = saveOriginalFile({ url: '/api/commander/assistant/artifact?file=photos%2Fnight.jpg&signature=keep' }, f.environment);
  while (!finish) await Promise.resolve();
  assert.deepEqual(f.calls.revoked, []);
  assert.equal(f.calls.blobs[0], f.blob);
  assert.deepEqual(f.calls.fetches, [['dsh-app://app/api/commander/assistant/artifact?file=photos%2Fnight.jpg&signature=keep', { credentials: 'same-origin', referrerPolicy: 'no-referrer' }]]);
  assert.deepEqual(f.calls.saves, [{ url: 'blob:original', name: 'night.jpg', mediaType: 'image/jpeg', mode: 'saveAs' }]);
  finish({ status: 'saved', path: 'E:\\night.jpg' });
  assert.deepEqual(await pending, { status: 'saved', path: 'E:\\night.jpg' });
  assert.deepEqual(f.calls.revoked, ['blob:original']);
});

test('native cancellation returns once and never starts a browser fallback', async () => {
  const f = fixture(); f.native({ status: 'cancelled' });
  assert.deepEqual(await saveOriginalFile({ url: 'https://images.test/a.jpg' }, f.environment), { status: 'cancelled' });
  assert.equal(f.calls.saves.length, 1); assert.equal(f.calls.fetches.length, 0); assert.equal(f.calls.anchors.length, 0);
});

test('native rejection releases temporary data and never navigates or retries', async () => {
  const f = fixture('dsh-app://app/'); f.native();
  f.environment.dshDesktop.fileActions.save = async request => { f.calls.saves.push(request); throw new Error('disk full'); };
  await assert.rejects(saveOriginalFile({ url: 'api/file?path=photo.jpg' }, f.environment), /保存文件失败/u);
  assert.equal(f.calls.saves.length, 1); assert.equal(f.calls.anchors.length, 0);
  assert.deepEqual(f.calls.revoked, ['blob:original']);
});

test('Web saves exact original bytes with an unattargeted temporary anchor and delayed release', async () => {
  const f = fixture();
  assert.deepEqual(await saveOriginalFile({ url: 'https://images.test/a.jpg?signature=keep', name: '风景' }, f.environment), { status: 'requested' });
  assert.deepEqual(new Uint8Array(await f.calls.blobs[0].arrayBuffer()), f.bytes);
  assert.deepEqual(f.calls.fetches, [['https://images.test/a.jpg?signature=keep', { credentials: 'omit', referrerPolicy: 'no-referrer' }]]);
  const anchor = f.calls.anchors[0];
  assert.equal(anchor.href, 'blob:original'); assert.equal(anchor.download, '风景.jpg');
  assert.equal('target' in anchor, false); assert.equal(anchor.appended, true); assert.equal(anchor.clicked, true); assert.equal(anchor.removed, true);
  assert.deepEqual(f.calls.revoked, []); assert.equal(f.calls.timers.length, 1);
  assert.ok(f.calls.timers[0].delay >= 1000);
  f.calls.timers[0].callback(); assert.deepEqual(f.calls.revoked, ['blob:original']);
});

test('Web resolves Link-relative URLs and keeps same-origin credentials', async () => {
  const f = fixture('https://link.test/link/workbench/session/');
  await saveOriginalFile({ url: 'api/file?path=folder%2Freport.jpg' }, f.environment);
  assert.equal(f.calls.fetches[0][0], 'https://link.test/link/workbench/session/api/file?path=folder%2Freport.jpg');
  assert.equal(f.calls.fetches[0][1].credentials, 'same-origin');
  assert.equal(f.calls.anchors[0].download, 'report.jpg');
});

test('filename priority, parameter leaf selection and platform-safe names', async () => {
  for (const [file, expected] of [
    [{ filename: 'explicit.jpg', name: 'label', url: 'https://images.test/url.jpg?file=param.jpg' }, 'explicit.jpg'],
    [{ name: 'named.jpg', url: 'https://images.test/url.jpg?file=param.jpg' }, 'named.jpg'],
    [{ url: 'https://images.test/url.jpg?file=dir%2Fparam.jpg&path=other.jpg' }, 'param.jpg'],
    [{ url: 'https://images.test/url.jpg?path=C%3A%5Cfolder%5Cpath.jpg' }, 'path.jpg'],
    [{ url: 'https://images.test/%E9%9B%AA%E5%B1%B1.jpg' }, '雪山.jpg'],
    [{ url: 'https://images.test/a.jpg', filename: '../CON?.jpg' }, '_CON_.jpg'],
    [{ url: 'https://images.test/a.jpg', filename: 'CON.jpg' }, '_CON.jpg'],
  ]) {
    const f = fixture(); await saveOriginalFile(file, f.environment);
    assert.equal(f.calls.anchors[0].download, expected);
  }
  const f = fixture(); await saveOriginalFile({ url: 'https://images.test/a.jpg', filename: '雪'.repeat(200) + '.jpg' }, f.environment);
  assert.ok(new TextEncoder().encode(f.calls.anchors[0].download).length <= 255);
  assert.match(f.calls.anchors[0].download, /\.jpg$/u);
});

test('Web matches known image suffixes to original MIME while preserving compatible and document suffixes', async () => {
  for (const [name, type, expected] of [
    ['风景.png', 'image/webp', '风景.webp'],
    ['风景.jpeg', 'image/jpeg', '风景.jpeg'],
    ['风景.tif', 'image/tiff', '风景.tif'],
    ['报告.docx', 'application/zip', '报告.docx'],
  ]) {
    const f = fixture();
    f.environment.fetch = async () => ({ ok: true, blob: async () => new Blob(['original'], { type }) });
    await saveOriginalFile({ url: 'https://images.test/original', name }, f.environment);
    assert.equal(f.calls.anchors[0].download, expected);
  }
});

test('invalid URLs, credentials and foreign dsh-app origins fail before native or browser operations', async () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/photo.jpg', 'ftp://files.test/a.jpg', 'blob:foreign', 'data:image/png;base64,AAAA', 'https://user:secret@images.test/a.jpg', 'dsh-app://other/a.jpg', 'dsh-app://app:123/a.jpg', '\\server\\a.jpg', ' https://images.test/a.jpg', 'https://images.test/a\n.jpg']) {
    const f = fixture('dsh-app://app/'); f.native();
    await assert.rejects(saveOriginalFile({ url }, f.environment), /文件地址/u, url);
    assert.equal(f.calls.saves.length, 0); assert.equal(f.calls.fetches.length, 0);
  }
  const f = fixture(); f.native();
  await assert.rejects(saveOriginalFile({ url: 'dsh-app://app/api/file' }, f.environment), /文件地址/u);
  await assert.rejects(saveOriginalFile({ url: 'https://images.test/good.jpg', downloadUrl: 'javascript:alert(1)' }, f.environment), /文件地址/u);
});

test('HTTP and CORS/network errors are readable and never open a fallback link', async () => {
  for (const mode of ['404', 'cors', 'body']) {
    const f = fixture();
    f.environment.fetch = async () => {
      if (mode === 'cors') throw new TypeError('Failed to fetch');
      return { ok: mode !== '404', status: mode === '404' ? 404 : 200, async blob() { throw new Error('lost connection'); } };
    };
    await assert.rejects(saveOriginalFile({ url: 'https://images.test/a.jpg' }, f.environment), mode === '404' ? /HTTP 404/u : mode === 'cors' ? /网络.*跨域/u : /内容读取失败/u);
    assert.equal(f.calls.anchors.length, 0); assert.equal(f.calls.blobs.length, 0);
  }
});

test('failed browser click removes its anchor and releases unused Blob immediately', async () => {
  const f = fixture();
  const create = f.environment.document.createElement;
  f.environment.document.createElement = tag => { const anchor = create(tag); anchor.click = () => { throw new Error('blocked'); }; return anchor; };
  await assert.rejects(saveOriginalFile({ url: 'https://images.test/a.jpg' }, f.environment), /保存文件失败/u);
  assert.equal(f.calls.anchors[0].removed, true); assert.deepEqual(f.calls.revoked, ['blob:original']);
  assert.equal(f.calls.timers.length, 0);
});
