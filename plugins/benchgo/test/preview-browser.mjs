// Functional smoke test only: no screenshots, no visible browser, no external services.
// Run: node plugins/benchgo/test/preview-browser.mjs [path-to-chromium]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url), XLSX = require('xlsx'), JSZip = require('jszip');
const browser = process.argv[2] || process.env.BENCHGO_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ArtifactPreview} from './plugins/shared/client/artifact-preview.jsx'; window.show = name => createRoot(document.getElementById('root')).render(React.createElement(ArtifactPreview,{file:{name,url:'api/file?name='+name},onClose(){}}));`, resolveDir: root, loader: 'jsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'text' }, nodePaths: [join(root, 'plugins/link/node_modules')], define: { 'process.env.NODE_ENV': '"production"' } });
const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Name', 'Value'], ['BenchGo', 42], ['Other', 7]]), 'Data');
const zip = new JSZip();
zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX smoke</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>');
const stream = 'BT /F1 24 Tf 50 150 Td (PDF smoke) Tj ET';
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
let pdf = '%PDF-1.4\n', offsets = [0];
for (let i = 0; i < objects.length; i++) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
const xref = pdf.length; pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const fixtures = { 'sample.md': '# Markdown smoke\n\n| A | B |\n| - | - |\n| 1 | 2 |\n<script>parent.__pwn=1</script>', 'sample.json': '{"hello":"BenchGo","rows":[1,2]}', 'sample.html': '<h1>HTML smoke</h1><script>parent.__pwn=1</script><meta http-equiv="refresh" content="0;url=https://example.com"><a href="https://example.com">link</a>', 'sample.xlsx': XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), 'sample.xls': XLSX.write(book, { type: 'buffer', bookType: 'biff8' }), 'sample.csv': 'Name,Value\nBenchGo,42', 'sample.docx': await zip.generateAsync({ type: 'nodebuffer' }), 'sample.pdf': pdf };
const requests = [], server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'); requests.push(url.pathname + url.search);
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div><script src="/app.js"></script>'); }
    else if (url.pathname === '/app.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); }
    else if (url.pathname.startsWith('/api/benchgo/preview-assets/')) { const name = url.pathname.slice('/api/benchgo/preview-assets/'.length); if (!/^[\w./-]+$/.test(name) || name.includes('..')) throw Error('bad path'); res.setHeader('content-type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'); res.end(await readFile(new URL('../lib/preview/' + name, import.meta.url))); }
    else if (url.pathname === '/api/file') { const name = url.searchParams.get('name'); if (name === 'sample.pptx') { res.statusCode = 503; res.setHeader('content-type', 'application/json'); res.end('{"error":"未安装 LibreOffice"}'); } else { res.end(fixtures[name]); } }
    else { res.statusCode = 404; res.end(); }
  } catch (error) { res.statusCode = 500; res.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(join(tmpdir(), 'benchgo-preview-test-'));
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket, sequence = 0; const pending = new Map();
try {
  const endpoint = await new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(Error('Browser startup timed out')), 20000); child.once('error', reject); child.stderr.on('data', chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } }); });
  socket = new WebSocket(endpoint); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(Error(message.error.message)) : resolve(message.result); } };
  const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async expression => { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const wait = async expression => { const end = Date.now() + 20000; while (Date.now() < end) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Timed out: ' + expression + '\n' + await evaluate('document.body.innerText')); };
  const open = async name => { await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` }, sessionId); await wait('!!window.show'); await evaluate(`window.show(${JSON.stringify(name)})`); };
  await open('sample.md'); await wait("document.querySelector('iframe')?.srcdoc.includes('<h1>Markdown smoke</h1>')");
  assert.equal(await evaluate("document.querySelector('iframe').srcdoc.includes('<script>')"), false);
  assert.equal(requests.some(path => path.includes('/docx.js') || path.includes('/sheet-worker.js') || path.includes('/pdf.js')), false, 'unused renderers must not load');
  await open('sample.json'); await wait("document.querySelector('.bg-json')?.textContent.includes('BenchGo')");
  await open('sample.html'); await wait("document.querySelector('iframe')?.srcdoc.includes('HTML smoke')");
  assert.equal(await evaluate("document.querySelector('iframe').srcdoc.includes('http-equiv=\"refresh\"')"), false);
  assert.equal(await evaluate('Boolean(window.__pwn)'), false);
  for (const ext of ['xlsx', 'xls', 'csv']) { await open('sample.' + ext); await wait("document.querySelector('.bg-sheet')?.textContent.includes('BenchGo')"); }
  await open('sample.docx'); await wait("document.querySelector('iframe')?.srcdoc.includes('DOCX smoke')");
  await open('sample.pdf'); await wait("document.querySelector('canvas')?.width > 300 && !document.querySelector('[role=status]')");
  assert.equal(await evaluate("Boolean(document.querySelector('[role=alert]'))"), false);
  await open('sample.pptx'); await wait("document.querySelector('[role=alert]')?.textContent.includes('未安装 LibreOffice')");
  assert.ok(requests.some(path => path.includes('preview=pdf')));
  console.log('Preview browser smoke passed: MD, JSON, HTML isolation, XLSX, XLS, CSV, DOCX, PDF, optional PPT fallback, lazy loading.');
  await command('Browser.close');
} finally {
  socket?.close();
  if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
