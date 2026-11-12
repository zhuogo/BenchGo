import { documentPreview, previewFailure } from '../../benchgo/src/document-preview.mjs';
import { createHash } from 'node:crypto';
import { readdir, lstat, realpath, open, unlink, link } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, relative, isAbsolute, extname, basename } from 'node:path';

const artifactTypes = Object.freeze({
  png: ['image/png', 'image'], jpg: ['image/jpeg', 'image'], jpeg: ['image/jpeg', 'image'], webp: ['image/webp', 'image'], gif: ['image/gif', 'image'], avif: ['image/avif', 'image'], svg: ['image/svg+xml', 'image'],
  pdf: ['application/pdf', 'document'], txt: ['text/plain; charset=utf-8', 'text'], md: ['text/markdown; charset=utf-8', 'text'], csv: ['text/csv; charset=utf-8', 'text'], json: ['application/json', 'text'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document'], xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'spreadsheet'], pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'presentation'],
  doc: ['application/msword', 'document'], xls: ['application/vnd.ms-excel', 'spreadsheet'], ppt: ['application/vnd.ms-powerpoint', 'presentation'], odt: ['application/vnd.oasis.opendocument.text', 'document'], rtf: ['application/rtf', 'document'], tsv: ['text/tab-separated-values; charset=utf-8', 'text'],
  mp4: ['video/mp4', 'video'], webm: ['video/webm', 'video'], mov: ['video/quicktime', 'video'], m4v: ['video/x-m4v', 'video'], mkv: ['video/x-matroska', 'video'], avi: ['video/x-msvideo', 'video'],
  mp3: ['audio/mpeg', 'audio'], wav: ['audio/wav', 'audio'], m4a: ['audio/mp4', 'audio'], aac: ['audio/aac', 'audio'], ogg: ['audio/ogg', 'audio'], opus: ['audio/ogg; codecs=opus', 'audio'], flac: ['audio/flac', 'audio'],
  html: ['text/html; charset=utf-8', 'web'], htm: ['text/html; charset=utf-8', 'web'], css: ['text/css; charset=utf-8', 'web'], js: ['text/javascript; charset=utf-8', 'web'], mjs: ['text/javascript; charset=utf-8', 'web'], jsx: ['text/plain; charset=utf-8', 'web'], ts: ['text/plain; charset=utf-8', 'web'], tsx: ['text/plain; charset=utf-8', 'web'], vue: ['text/plain; charset=utf-8', 'web'], svelte: ['text/plain; charset=utf-8', 'web'], wasm: ['application/wasm', 'web'],
});
const artifactCategories = new Set(['document', 'image', 'video', 'audio', 'web']);
const artifactCategory = kind => artifactCategories.has(kind) ? kind : 'document';
function artifactName(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(value)) return null;
  const segments = value.split('/');
  return segments.every(part => part && part !== '.' && part !== '..') && artifactTypes[extname(value).slice(1).toLowerCase()] ? value : null;
}
function within(directory, path) { const child = relative(directory, path); return child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`); }

// Artifacts belong only to the assistant workspace. Never follow directory links
// into project folders or serve generated HTML in the application's origin.
export function createAssistantArtifacts({ workspace, preview = documentPreview }) {
  const directory = resolve(workspace, 'artifacts');
  // Opaque metadata fingerprint: listing large media must not read every file's contents.
  const fingerprint = info => createHash('sha256').update(JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])).digest('hex');
  const root = async () => {
    const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return info?.isDirectory() && !info.isSymbolicLink() ? realpath(directory) : null;
  };
  const fileInfo = async (name, base) => {
    if (!artifactName(name) || !base) return null;
    const path = resolve(directory, ...name.split('/'));
    if (!within(directory, path)) return null;
    let current = directory;
    for (const part of name.split('/')) {
      current = join(current, part);
      const info = await lstat(current).catch(error => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; });
      if (!info || info.isSymbolicLink()) return null;
    }
    const actual = await realpath(path);
    if (!within(base, actual)) return null;
    const info = await lstat(actual);
    return info.isFile() && info.size <= 25 * 1024 * 1024 ? { path: actual, info } : null;
  };
  const openFile = async file => {
    const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > 25 * 1024 * 1024 || info.dev !== file.info.dev || info.ino !== file.info.ino) { await handle.close(); return null; }
    return { handle, info };
  };
  return {
    async manage({ op, file: name, name: newName, expectedHash } = {}) {
      if (!['delete', 'rename', 'copy'].includes(op)) throw new Error('不支持的产物操作');
      const base = await root(), file = await fileInfo(name, base);
      if (!file) throw new Error('产物不存在或不可操作，请刷新列表');
      const opened = await openFile(file);
      if (!opened) throw new Error('产物已变化，请刷新列表');
      let bytes;
      try {
        if (expectedHash !== undefined && expectedHash !== fingerprint(opened.info)) throw new Error('产物已变化，请刷新后重试');
        if (op === 'copy') bytes = await opened.handle.readFile();
      } finally { await opened.handle.close(); }
      if (op === 'delete') {
        await unlink(file.path);
        return { removed: true, file: name };
      }
      if (typeof newName !== 'string' || newName.length > 255 || !artifactName(newName) || /[\/<>"|?*]/u.test(newName) || /[. ]$/u.test(newName) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(newName)) throw new Error('文件名无效或文件类型不支持');
      const targetName = name.includes('/') ? `${name.slice(0, name.lastIndexOf('/') + 1)}${newName}` : newName;
      if (targetName === name) throw new Error('请输入不同的文件名');
      const target = resolve(file.path, '..', newName);
      try {
        if (op === 'copy') {
          const destination = await open(target, 'wx');
          let complete = false;
          try { await destination.writeFile(bytes); complete = true; }
          finally { await destination.close(); if (!complete) await unlink(target).catch(() => {}); }
        } else {
          // Hard-link creation fails atomically if the target exists; rename() would overwrite it.
          await link(file.path, target);
          try { await unlink(file.path); } catch (error) { await unlink(target).catch(() => {}); throw error; }
        }
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error('同名文件已存在，请使用其他名称');
        throw error;
      }
      return { file: targetName, previousFile: name, copied: op === 'copy' };
    },
    async list({ after, limit = 50, category } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('产物分页数量无效');
      if (category !== undefined && !artifactCategories.has(category)) throw new Error('产物分类无效');
      let offset = 0;
      if (after !== undefined) {
        try {
          if (typeof after !== 'string' || after.length > 512) throw new Error();
          const decoded = JSON.parse(Buffer.from(after, 'base64url').toString());
          if (!Number.isSafeInteger(decoded.offset) || decoded.offset < 0 || (decoded.category !== undefined && decoded.category !== category)) throw new Error();
          offset = decoded.offset;
        } catch { throw new Error('产物游标无效'); }
      }
      const base = await root(), rows = [];
      const walk = async (folder = '') => {
        const entries = await readdir(join(directory, folder), { withFileTypes: true }).catch(error => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return []; throw error; });
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const name = folder ? `${folder}/${entry.name}` : entry.name;
          if (entry.isDirectory()) { if (!/[\\:\x00-\x1f\x7f]/.test(entry.name)) await walk(name); continue; }
          if (!entry.isFile() || !artifactName(name)) continue;
          const type = artifactTypes[extname(name).slice(1).toLowerCase()], group = artifactCategory(type[1]);
          if (category && group !== category) continue;
          const file = await fileInfo(name, base); if (!file) continue;
          const url = `api/commander/assistant/artifact?file=${encodeURIComponent(name)}`;
          rows.push({ id: name, name, kind: type[1], category: group, mimeType: type[0], bytes: file.info.size, updatedAt: file.info.mtime.toISOString(), url, downloadUrl: `${url}&download=1`, file });
        }
      };
      if (base) await walk();
      rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
      const page = [];
      for (const { file, ...row } of rows.slice(offset, offset + limit)) {
        row.hash = fingerprint(file.info);
        page.push(row);
      }
      const next = offset + Math.min(limit, Math.max(0, rows.length - offset));
      return { artifacts: page, total: rows.length, nextCursor: next < rows.length ? Buffer.from(JSON.stringify({ offset: next, category })).toString('base64url') : null, hasMore: next < rows.length };
    },
    async fetch(request) {
      const params = new URL(request.url).searchParams, name = artifactName(params.get('file'));
      if (!name) return new Response('Invalid artifact', { status: 400 });
      let opened;
      try {
        const file = await fileInfo(name, await root()); if (!file) return new Response('Not found', { status: 404 });
        opened = await openFile(file); if (!opened) return new Response('Not found', { status: 404 });
        const type = artifactTypes[extname(name).slice(1).toLowerCase()], category = artifactCategory(type[1]);
        const attachment = params.get('download') === '1' || category === 'web' || type[0] === 'image/svg+xml';
        const filename = basename(name), safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const headers = { 'content-type': type[0], 'content-disposition': `${attachment ? 'attachment' : 'inline'}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`, 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'" };
        let bytes = await opened.handle.readFile(); await opened.handle.close(); opened = null;
        if (params.get('preview') === 'pdf') {
          bytes = await preview.convert({ name, bytes });
          headers['content-type'] = 'application/pdf';
          headers['content-disposition'] = 'inline';
        }
        return new Response(bytes, { headers });
      } catch (error) {
        await opened?.handle.close().catch(() => {});
        if (params.get('preview') === 'pdf' && error.status) return previewFailure(error);
        if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return new Response('Not found', { status: 404 });
        throw error;
      }
    },
  };
}
