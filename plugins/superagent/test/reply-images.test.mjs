import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReplyDeliverables } from '../client/reply-images.mjs';
import { galleryImages, groupReplyImages, safeImageUrl } from '../../shared/client/image-gallery-model.mjs';

test('one reply aggregates images across captions and sources in first occurrence order', () => {
  const source = '先看方案。\n\n![第一张](https://example.test/a.png)\n\n[摄影来源](https://example.test/photos/a)\n\n第二种配色。\n\n![第二张](https://example.test/b.png)\n\n![重复](https://example.test/a.png)\n\n然后继续讨论。';
  const result = extractReplyDeliverables(source);
  assert.deepEqual(result.images, [{ url: 'https://example.test/a.png', alt: '第一张' }, { url: 'https://example.test/b.png', alt: '第二张' }]);
  assert.deepEqual(result.files, []);
  assert.equal(result.text.includes('!['), false);
  assert.match(result.text, /\[摄影来源\]\(https:\/\/example.test\/photos\/a\)/);
  assert.match(result.text, /第二种配色。/);
  assert.equal(extractReplyDeliverables(source).images.length, 2, 'deduplication never crosses message boundaries');
  assert.equal(extractReplyDeliverables('![一](/api/commander/assistant/artifact?file=a.png)\r\n![二](api/commander/assistant/artifact?file=b.png)').images.length, 2);
});

test('files detach from paragraphs, lists, quotes and tables while labels and prose stay readable', () => {
  const source = '查看 [**报告**](https://example.test/report.pdf)，接着讨论。\n\n- [表格](https://example.test/data.xlsx)\n  另附 [音频](/api/file?path=voice.mp3)\n- [压缩包](api/commander/assistant/artifact?file=photos.zip)\n\n> 参考 [视频](https://example.test/movie.mp4)\n> 不改变说明。\n\n| 材料 | 说明 |\n| --- | --- |\n| [文档](https://example.test/notes.docx) | 原始说明 |';
  const result = extractReplyDeliverables(source);
  assert.deepEqual(result.files.map(file => [file.name, file.kind]), [['报告', 'document'], ['表格', 'document'], ['音频', 'audio'], ['压缩包', 'archive'], ['视频', 'video'], ['文档', 'document']]);
  assert.match(result.text, /查看 报告，接着讨论。/);
  assert.match(result.text, /- 表格\n  另附 音频/);
  assert.match(result.text, /> 参考 视频\n> 不改变说明。/);
  assert.match(result.text, /\| 文档 \| 原始说明 \|/);
  assert.doesNotMatch(result.text, /https:\/\/example.test/);
});

test('mixed images and image links aggregate together without losing adjacent explanation', () => {
  const source = '说明 ![示例](https://example.test/a.png) 后文。\n\n[原图](https://example.test/a.png)\n\n[另一张](https://example.test/b.webp)\n\n[![带来源](https://example.test/c.jpg)](https://example.test/photos/c)';
  const result = extractReplyDeliverables(source);
  assert.deepEqual(result.images.map(image => image.url), ['https://example.test/a.png', 'https://example.test/b.webp', 'https://example.test/c.jpg']);
  assert.match(result.text, /说明 示例 后文。/);
  assert.match(result.text, /\[带来源\]\(https:\/\/example.test\/photos\/c\)/);
  assert.deepEqual(result.files, []);
});

test('code, interaction fences and raw HTML never become deliverables', () => {
  for (const source of ['```md\n![示例](https://example.test/a.png)\n[文件](https://example.test/a.pdf)\n```', '```interactive\n{"image":"https://example.test/a.png"}\n```', '`![示例](https://example.test/a.png)`', '    ![缩进代码](https://example.test/a.png)', '<div>\n![原始 HTML](https://example.test/a.png)\n</div>', '<span>![原始 HTML](https://example.test/a.png)</span>']) {
    assert.deepEqual(extractReplyDeliverables(source), { text: source, images: [], files: [] }, source);
  }
  const mixed = extractReplyDeliverables('<span>![HTML](https://example.test/a.png)</span> ![外部](https://example.test/b.png)');
  assert.deepEqual(mixed.images, [{ url: 'https://example.test/b.png', alt: '外部' }]);
  assert.match(mixed.text, /<span>!\[HTML\]/);
});

test('reference definitions and footnotes stay intact after asset references are detached', () => {
  const source = '查看 [资料][doc]，引用[^1]。\n\n![参考图][img]\n\n[文件][file]\n\n[doc]: https://example.test/source\n[img]: https://example.test/a.png\n[file]: https://example.test/a.pdf\n\n[^1]: 来源说明\n    下一行 [来源](https://example.test/article.html)';
  const result = extractReplyDeliverables(source);
  assert.equal(result.images[0].url, 'https://example.test/a.png');
  assert.equal(result.files[0].url, 'https://example.test/a.pdf');
  assert.match(result.text, /查看 \[资料\]\[doc\]，引用\[\^1\]。/);
  assert.ok(result.text.endsWith(source.slice(source.indexOf('[doc]:'))), 'definitions and footnote continuation survive verbatim');
  const unfinished = '文字\r\n\r\n![未完成](';
  assert.deepEqual(extractReplyDeliverables(unfinished), { text: unfinished, images: [], files: [] });
});

test('local file destinations stay explicitly local and are never guessed into image requests', () => {
  const source = '[报告](<E:/工作目录/report.pdf>)\n\n![本地图](images/landscape/photo.png)\n\n[代码](../src/main.mjs#L24)\n\n[本地网页](/tmp/index.html)\n\n![绝对本地图](/tmp/photo.jpg)\n\n[同一报告](<E:/工作目录/report.pdf>)';
  const result = extractReplyDeliverables(source);
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.files.map(file => [file.url, file.local, file.kind]), [['E:/工作目录/report.pdf', true, 'document'], ['images/landscape/photo.png', true, 'image'], ['../src/main.mjs#L24', true, 'file'], ['/tmp/index.html', true, 'web'], ['/tmp/photo.jpg', true, 'image']]);
  assert.equal(result.files[0].name, '报告', 'duplicate references retain the first name');
  assert.equal(result.files[0].filename, 'report.pdf', 'display labels never replace the filename used to select a preview');
  assert.equal(result.files[2].path, '../src/main.mjs');
  assert.equal(result.files[2].line, 24, 'native file opening retains source line references');
  assert.doesNotMatch(result.text, /!\[本地图\]/);
  assert.equal(result.files.some(file => file.url.startsWith('/api/')), false);
});

test('standalone file links leave no duplicate filename bubble', () => {
  const result = extractReplyDeliverables('[报告](https://example.test/report.pdf)\n\n[表格](api/commander/assistant/artifact?file=data.xlsx)');
  assert.equal(result.text.trim(), '');
  assert.deepEqual(result.files.map(file => file.filename), ['report.pdf', 'data.xlsx']);
});

test('source code and configuration deliverables use the same file cards', () => {
  const source = '[脚本](https://example.test/export.py)\n\n[配置](https://example.test/project.toml)\n\n[说明](https://example.test/guide.markdown)';
  const result = extractReplyDeliverables(source);
  assert.equal(result.text.trim(), '');
  assert.deepEqual(result.files.map(file => [file.filename, file.kind]), [['export.py', 'file'], ['project.toml', 'file'], ['guide.markdown', 'document']]);
});

test('ordinary source pages and unsafe destinations remain unchanged', () => {
  for (const source of ['[来源](https://example.test/article.html)', '[来源](https://example.test/photos/123)', '[锚点](#section.pdf)', '![不安全](javascript:alert(1))', '[文件](file:///E:/private.pdf)', '![嵌入](data:image/png;base64,abc)', '[凭据](https://user:secret@example.test/private.pdf)', '[跨站](//example.test/a.pdf)']) assert.deepEqual(extractReplyDeliverables(source), { text: source, images: [], files: [] }, source);
  const endpoint = extractReplyDeliverables('[文件](/api/file?id=123)\n\n[下载](https://example.test/download?file=archive.zip)');
  assert.deepEqual(endpoint.files.map(file => [file.url, file.kind]), [['/api/file?id=123', 'file'], ['https://example.test/download?file=archive.zip', 'archive']]);
});

test('gallery URL validation and grouping retain their existing safety boundary', () => {
  for (const url of ['javascript:alert(1)', 'data:image/svg+xml;base64,abc', 'file:///E:/image.png', 'E:/image.png', '//example.test/a.png', '/\\example.test/a.png', 'https://user:secret@example.test/a.png', ' https://example.test/a.png']) assert.equal(safeImageUrl(url), null, url);
  assert.equal(galleryImages([{ url: 'javascript:alert(1)' }, { url: '/api/assistant/image/1', name: 'image.png' }]).length, 1);
  const groups = groupReplyImages([{ url: '/a.png', groupId: 'turn:1' }, { url: '/b.png', groupId: 'turn:2' }, { url: '/c.png', groupId: 'turn:1' }, { url: '/d.png' }]);
  assert.deepEqual(groups.map(group => group.images.map(image => image.url)), [['/a.png', '/c.png'], ['/b.png'], ['/d.png']]);
});
