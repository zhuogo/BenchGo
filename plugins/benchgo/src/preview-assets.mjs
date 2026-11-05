import { readFile } from 'node:fs/promises';
export const previewAssets = ['markdown.js', 'docx.js', 'sheet-worker.js', 'pdf.js', 'pdf-worker.js'];
export async function mountPreviewAssets(ctx) {
  let resources = [];
  try { resources = JSON.parse(await readFile(new URL('../lib/preview/resources.json', import.meta.url), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const safeResources = resources.filter(name => /^(cmaps|standard_fonts|wasm)\/[a-zA-Z0-9_.-]+$/.test(name));
  for (const name of [...previewAssets, ...safeResources]) ctx.effect(() => ctx.connection.fetch.register({
    path: `/api/benchgo/preview-assets/${name}`, methods: ['GET'], requestBody: 'buffered',
    async fetch() {
      try { return new Response(new Uint8Array(await readFile(new URL(`../lib/preview/${name}`, import.meta.url))), { headers: { 'content-type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream', 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff' } }); }
      catch { return new Response('预览组件尚未构建，请运行 npm run reload:plus', { status: 503 }); }
    },
  }));
}
