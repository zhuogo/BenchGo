import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
const MAX = 25 * 1024 * 1024;
const error = (message, status, code) => Object.assign(new Error(message), { status, code });
export function createDocumentPreview({ run = execute, executable = process.env.BENCHGO_LIBREOFFICE } = {}) {
  let tool, running = 0;
  const waiting = [], pending = new Map(), cache = new Map();
  let cacheBytes = 0;
  async function discover() {
    if (tool) return tool;
    const candidates = executable ? [executable] : process.platform === 'win32' ? [join(process.env.ProgramFiles || 'C:/Program Files', 'LibreOffice/program/soffice.exe'), join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'LibreOffice/program/soffice.exe'), 'soffice'] : ['libreoffice', 'soffice'];
    for (const path of candidates) {
      try { const result = await run(path, ['--version'], { timeout: 5000, windowsHide: true, maxBuffer: 65536 }); tool = { path, version: result.stdout.trim() }; return tool; } catch {}
    }
    throw error('未安装 LibreOffice，无法转换此文档；请下载原文件，或安装 LibreOffice 后重试。', 503, 'PREVIEW_CONVERTER_UNAVAILABLE');
  }
  return { async convert({ name, bytes }) {
    const extension = extname(name).toLowerCase();
    if (!['.ppt', '.pptx', '.doc', '.docx', '.odt', '.rtf'].includes(extension)) throw error('此格式不支持 PDF 转换预览', 415, 'PREVIEW_FORMAT_UNSUPPORTED');
    if (bytes.length > MAX) throw error('文件超过 25 MiB，无法预览', 413, 'PREVIEW_TOO_LARGE');
    const converter = await discover();
    const key = createHash('sha256').update(converter.version).update(extension).update(bytes).digest('hex');
    if (cache.has(key)) { const value = cache.get(key); cache.delete(key); cache.set(key, value); return value; }
    if (pending.has(key)) return pending.get(key);
    if (running && waiting.length >= 8) throw error('文档转换繁忙，请稍后重试', 429, 'PREVIEW_BUSY');
    const task = (async () => {
      if (running) await new Promise(resolve => waiting.push(resolve));
      running++;
      let directory;
      try {
        directory = await mkdtemp(join(tmpdir(), 'benchgo-preview-'));
        const input = join(directory, `input${extension}`);
        await writeFile(input, bytes, { mode: 0o600 });
        try { await run(converter.path, [`-env:UserInstallation=${pathToFileURL(join(directory, 'profile')).href}`, '--headless', '--nologo', '--nodefault', '--norestore', '--convert-to', 'pdf', '--outdir', directory, input], { timeout: 60000, windowsHide: true, maxBuffer: 65536 }); }
        catch (cause) { throw error(cause.killed ? '文档转换超时，请下载原文件查看' : '文档转换失败，请下载原文件查看', 422, 'PREVIEW_CONVERSION_FAILED'); }
        const output = join(directory, 'input.pdf');
        const info = await stat(output).catch(() => null);
        if (!info?.isFile() || info.size > MAX) throw error('转换结果不可用或超过 25 MiB，请下载原文件查看', 422, 'PREVIEW_CONVERSION_FAILED');
        const result = await readFile(output);
        if (!result.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw error('转换未生成有效 PDF', 422, 'PREVIEW_CONVERSION_FAILED');
        cache.set(key, result); cacheBytes += result.length;
        while (cacheBytes > 64 * 1024 * 1024) { const first = cache.keys().next().value; cacheBytes -= cache.get(first).length; cache.delete(first); }
        return result;
      } finally { try { if (directory) await rm(directory, { recursive: true, force: true }); } finally { running--; waiting.shift()?.(); } }
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  } };
}
export const documentPreview = createDocumentPreview();
export const previewFailure = failure => Response.json({ error: failure.message, code: failure.code || 'PREVIEW_FAILED' }, { status: failure.status || 500, headers: { 'cache-control': 'no-store' } });
