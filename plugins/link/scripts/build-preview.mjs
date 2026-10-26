import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = new URL('../dist/preview/', import.meta.url);
await mkdir(output, { recursive: true });
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta http-equiv="refresh" content="0;url=/link/"><title>BenchGo</title></head><body><p>正在打开 BenchGo…</p><script>location.replace("/link/" + location.search + location.hash)</script><noscript><a href="/link/">打开 BenchGo</a></noscript></body></html>';
await writeFile(new URL('index.html', output), html);
console.log(`Mobile entry built: ${fileURLToPath(output)}`);
