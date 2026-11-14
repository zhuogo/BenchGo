import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ownerWebServer } from './boundary.mjs';

export const WORKBENCH_MEDIA_PATH = '/api/benchgo/workbench/media';

const mediaTypes = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.txt': 'text/plain', '.md': 'text/plain', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.aiff': 'audio/aiff', '.aif': 'audio/aiff',
  '.wave': 'audio/wav', '.wma': 'audio/x-ms-wma', '.amr': 'audio/amr', '.ape': 'audio/x-ape', '.caf': 'audio/x-caf', '.mka': 'audio/x-matroska',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.qt': 'video/quicktime', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2', '.m2ts': 'video/mp2t', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
};
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const within = (root, target) => { const child = relative(root, target); return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); };
const service = (ctx, name) => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
const validText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

function recordedDirectory(header, events = []) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.type === 'working-directory/change') return events[index].data?.cwd;
  }
  return header?.cwd;
}

/** Only the official Session owner decides the file root, including entered worktrees. */
async function sessionDirectory(ctx, sessionId, signal) {
  const session = ctx.sessions.get(sessionId);
  let directory;
  if (session) {
    const workingDirectory = service(ctx, 'workingDirectory');
    directory = typeof workingDirectory?.get === 'function'
      ? workingDirectory.get(session)
      : recordedDirectory(session.header, session.snapshotEvents?.());
  } else {
    const query = service(ctx, 'sessionQuery');
    if (typeof query?.observeSession !== 'function') throw failure('会话读取服务暂不可用，请打开项目对话后重试', 503);
    let observation;
    try {
      observation = await query.observeSession(sessionId, { projectionMode: 'none', signal });
      directory = recordedDirectory(observation.header, observation.events);
    } catch (error) {
      if (signal.aborted) throw error;
      throw failure('项目对话不存在或暂不可用', 404);
    } finally { observation?.[Symbol.dispose]?.(); }
  }
  signal.throwIfAborted();
  if (!validText(directory, 32768) || !isAbsolute(directory)) throw failure('项目对话没有可用的工作目录', 409);
  return directory;
}

async function locate(ctx, params, signal) {
  const sessionId = params.get('sessionId'), path = params.get('path');
  if (!validText(sessionId, 512) || params.getAll('sessionId').length !== 1) throw failure('请选择项目对话');
  if (!validText(path, 32768) || params.getAll('path').length !== 1) throw failure('文件路径无效');
  const root = await realpath(await sessionDirectory(ctx, sessionId, signal));
  if (!(await stat(root)).isDirectory()) throw failure('项目工作目录不可用', 404);
  const actual = await realpath(resolve(root, path));
  if (!within(root, actual)) throw failure('文件不在当前项目目录中', 403);
  signal.throwIfAborted();
  const before = await stat(actual);
  if (!before.isFile()) throw failure('只能预览普通文件', 404);
  const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat();
    const verified = await realpath(actual);
    if (!within(root, verified) || !info.isFile() || info.dev !== before.dev || info.ino !== before.ino) throw failure('文件已变化，请重新打开', 409);
    signal.throwIfAborted();
    return { handle, info, path: actual, name: basename(actual), mime: mediaTypes[extname(actual).toLowerCase()] ?? 'application/octet-stream' };
  } catch (error) { await handle.close(); throw error; }
}

function byteRange(value, size) {
  if (value === undefined || !/^bytes=/i.test(value)) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) throw failure('请求的文件范围无效', 416);
  const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) throw failure('请求的文件范围无效', 416);
  if (first === null) {
    if (last === 0) throw failure('请求的文件范围无效', 416);
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (first >= size || (last !== null && last < first)) throw failure('请求的文件范围无效', 416);
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

function ifRangeMatches(value, etag, mtime) {
  if (value === undefined) return true;
  if (typeof value !== 'string') return false;
  if (value.startsWith('"') || value.startsWith('W/')) return value === etag;
  const date = Date.parse(value);
  return Number.isFinite(date) && date >= Math.floor(mtime / 1000) * 1000;
}

function disposition(name, attachment) {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${attachment ? 'attachment' : 'inline'}; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

/** Stream through the authenticated local owner surface; large media never enters a JS buffer. */
export function mountWorkbenchMedia(ctx) {
  const server = ownerWebServer(ctx.webServer, ctx.connection), active = new Map();
  ctx.effect(() => async () => {
    for (const controller of active.keys()) controller.abort();
    await Promise.allSettled(active.values());
  });
  for (const meta of [false, true]) ctx.effect(() => server.register({
    kind: 'exact', path: WORKBENCH_MEDIA_PATH + (meta ? '/meta' : ''),
    async handler(req, res) {
      const controller = new AbortController(), { signal } = controller;
      const abort = () => controller.abort();
      const close = () => { if (!res.writableFinished) abort(); };
      let settle;
      active.set(controller, new Promise(resolve => { settle = resolve; }));
      req.once('aborted', abort); res.once('close', close);
      let file;
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD', 'cache-control': 'no-store' }); res.end(); return; }
        file = await locate(ctx, new URL(req.url, 'http://localhost').searchParams, signal);
        const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
        if (meta) {
          const body = JSON.stringify({ ok: true, value: { path: file.path, name: file.name, size: file.info.size, mime: file.mime } });
          res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) });
          res.end(req.method === 'HEAD' ? undefined : body); return;
        }
        const { info } = file;
        const etag = `"bg-${info.dev.toString(16)}-${info.ino.toString(16)}-${info.size.toString(16)}-${info.mtimeMs.toString(16)}-${info.ctimeMs.toString(16)}"`;
        let range;
        try { range = ifRangeMatches(req.headers['if-range'], etag, info.mtimeMs) ? byteRange(req.headers.range, info.size) : null; }
        catch (error) { if (error.status === 416) res.setHeader('content-range', `bytes */${info.size}`); throw error; }
        const params = new URL(req.url, 'http://localhost').searchParams;
        const attachment = params.get('download') === '1' || file.mime === 'application/octet-stream';
        res.writeHead(range ? 206 : 200, {
          ...headers, 'content-type': file.mime, 'content-disposition': disposition(file.name, attachment),
          'content-security-policy': "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
          'accept-ranges': 'bytes', ETag: etag, 'last-modified': info.mtime.toUTCString(),
          'content-length': String(range ? range.end - range.start + 1 : info.size),
          ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${info.size}` } : {}),
        });
        if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
        await pipeline(file.handle.createReadStream({ ...(range || { start: 0, end: info.size - 1 }), autoClose: false }), res, { signal });
      } catch (error) {
        if (signal.aborted || res.destroyed) return;
        if (res.headersSent) { res.destroy(error); return; }
        const missing = ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code);
        const status = error.status || (missing ? 404 : 500);
        const body = JSON.stringify({ ok: false, error: { message: missing ? '文件或项目目录不存在' : error.status ? error.message : '文件读取失败，请重试' } });
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': String(Buffer.byteLength(body)) });
        res.end(req.method === 'HEAD' ? undefined : body);
      } finally {
        req.off('aborted', abort); res.off('close', close);
        await file?.handle.close().catch(() => {});
        active.delete(controller); settle();
      }
    },
  }));
}
