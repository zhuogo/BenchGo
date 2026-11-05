import { documentPreview, previewFailure } from '../../benchgo/src/document-preview.mjs';
import { readdir, lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, isAbsolute, join, extname, basename } from 'node:path';

const maxBytes = 25 * 1024 * 1024;
const types = {
  csv: ['spreadsheet', 'text/csv; charset=utf-8'], tsv: ['spreadsheet', 'text/tab-separated-values; charset=utf-8'],
  xlsx: ['spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], xls: ['spreadsheet', 'application/vnd.ms-excel'],
  docx: ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], doc: ['document', 'application/msword'],
  pptx: ['presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'], ppt: ['presentation', 'application/vnd.ms-powerpoint'],
  odt: ['document', 'application/vnd.oasis.opendocument.text'], rtf: ['document', 'application/rtf'],
  html: ['web', 'text/html; charset=utf-8'], htm: ['web', 'text/html; charset=utf-8'],
  md: ['text', 'text/markdown; charset=utf-8'], txt: ['text', 'text/plain; charset=utf-8'], json: ['text', 'application/json'],
  yaml: ['text', 'text/plain; charset=utf-8'], yml: ['text', 'text/plain; charset=utf-8'], toml: ['text', 'text/plain; charset=utf-8'], log: ['text', 'text/plain; charset=utf-8'],
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], webp: ['image', 'image/webp'], gif: ['image', 'image/gif'], avif: ['image', 'image/avif'],
  pdf: ['document', 'application/pdf'], mp4: ['video', 'video/mp4'], webm: ['video', 'video/webm'], mp3: ['audio', 'audio/mpeg'], wav: ['audio', 'audio/wav'],
};
function validPath(value) {
  return typeof value === 'string' && value.length <= 4096 && !/[\\:\x00-\x1f\x7f]/.test(value) && (value === '' || value.split('/').every(part => part && part !== '.' && part !== '..'));
}
function contained(root, path) { const child = relative(root, path); return !isAbsolute(child) && child !== '..' && !child.startsWith('../') && !child.startsWith('..\\'); }
function failure(message, status) { return Object.assign(new Error(message), { status }); }

// Read only, rooted in this assistant's configuration directory. Directory links
// are deliberately excluded so browsing cannot escape into other workspaces.
export function createAssistantSystemFiles({ directory, preview = documentPreview }) {
  const root = resolve(directory);
  async function locate(path) {
    if (!validPath(path)) throw failure('文件路径无效', 400);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw failure('配置目录不可用', 404);
    const base = await realpath(root);
    let current = root, info = rootInfo;
    for (const part of path ? path.split('/') : []) {
      current = join(current, part);
      info = await lstat(current);
      if (info.isSymbolicLink()) throw failure('不支持访问链接文件', 404);
    }
    const actual = await realpath(current);
    if (!contained(base, actual)) throw failure('文件不在配置目录中', 404);
    return { actual, info };
  }
  return {
    async list({ path = '' } = {}) {
      const folder = await locate(path);
      if (!folder.info.isDirectory()) throw failure('文件夹不存在', 404);
      const files = [];
      for (const entry of await readdir(folder.actual, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
        const filePath = path ? `${path}/${entry.name}` : entry.name;
        if (!validPath(filePath)) continue;
        let file;
        try { file = await locate(filePath); } catch (error) { if (error.status === 404 || ['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
        const isDirectory = file.info.isDirectory();
        const [kind, mimeType] = types[extname(entry.name).slice(1).toLowerCase()] || ['file', 'application/octet-stream'];
        const url = `api/commander/assistant/system-file?file=${encodeURIComponent(filePath)}`;
        files.push({ id: filePath, path: filePath, name: entry.name, kind: isDirectory ? 'directory' : kind, mimeType: isDirectory ? null : mimeType, bytes: isDirectory ? null : file.info.size, updatedAt: file.info.mtime.toISOString(), ...(!isDirectory ? { url, downloadUrl: `${url}&download=1`, available: file.info.size <= maxBytes } : {}) });
      }
      files.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      return { path, root, entries: files.map(file => ({ ...file, type: file.kind === 'directory' ? 'directory' : 'file' })), parentPath: path ? path.split('/').slice(0, -1).join('/') : null, rootLabel: '总助手配置区', files };
    },
    async read({ path } = {}) {
      const file = await locate(path);
      if (!file.info.isFile()) throw failure('文件不存在', 404);
      const result = { path, name: basename(path), bytes: file.info.size, content: null };
      const extension = extname(path).slice(1).toLowerCase();
      if (['db', 'sqlite', 'sqlite3'].includes(extension) || (types[extension] && types[extension][0] !== 'text')) return { ...result, reason: '此文件为二进制格式，无法预览文本。' };
      const handle = await open(file.actual, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.dev !== file.info.dev || info.ino !== file.info.ino) throw failure('文件已变化，请刷新重试', 409);
        const buffer = Buffer.alloc(128 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const bytes = buffer.subarray(0, bytesRead), truncated = info.size > bytesRead;
        if (bytes.includes(0)) return { ...result, reason: '此文件为二进制格式，无法预览文本。' };
        try { return { ...result, bytes: info.size, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated }), truncated }; }
        catch { return { ...result, reason: '此文件不是 UTF-8 文本，暂不支持预览。' }; }
      } finally { await handle.close(); }
    },
    async fetch(request) {
      let handle;
      try {
        const params = new URL(request.url).searchParams, path = params.get('file');
        if (!path) throw failure('文件路径无效', 400);
        const file = await locate(path);
        if (!file.info.isFile()) throw failure('文件不存在', 404);
        if (file.info.size > maxBytes) throw failure('文件超过 25 MB，暂不支持读取', 413);
        handle = await open(file.actual, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const info = await handle.stat();
        if (!info.isFile() || info.dev !== file.info.dev || info.ino !== file.info.ino) throw failure('文件已变化，请刷新重试', 409);
        if (info.size > maxBytes) throw failure('文件超过 25 MB，暂不支持读取', 413);
        const [kind, mimeType] = types[extname(path).slice(1).toLowerCase()] || ['file', 'application/octet-stream'];
        const name = basename(path), encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
        if (params.get('preview') === 'pdf') return new Response(await preview.convert({ name: path, bytes: await handle.readFile() }), { headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'" } });
        const attachment = params.get('download') === '1' || kind === 'file' || kind === 'web';
        return new Response(await handle.readFile(), { headers: { 'content-type': mimeType, 'content-disposition': `${attachment ? 'attachment' : 'inline'}; filename="${name.replace(/[^a-zA-Z0-9._-]/g, '_')}"; filename*=UTF-8''${encoded}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'" } });
      } catch (error) {
        if (new URL(request.url).searchParams.get('preview') === 'pdf' && error.status) return previewFailure(error);
        return new Response(['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code) ? '文件不存在' : error.message, { status: error.status || (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code) ? 404 : 500), headers: { 'cache-control': 'no-store' } });
      } finally { await handle?.close(); }
    },
  };
}
