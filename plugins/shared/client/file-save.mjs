/** Save original bytes through the existing Desktop bridge or browser download. */
const RELEASE_DELAY_MS = 60_000;
const extensions = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tiff',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'application/json': 'json',
  'text/plain': 'txt', 'text/markdown': 'md', 'text/html': 'html', 'text/csv': 'csv',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'video/mp4': 'mp4', 'video/webm': 'webm',
};

function sameOrigin(left, right) {
  return !!right && left.protocol === right.protocol && left.host === right.host;
}

function sourceUrl(file, environment) {
  const value = file?.downloadUrl ?? file?.url;
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\u0000-\u001f\u007f\\]/u.test(value)) throw new Error('文件地址无效。');
  let page, url;
  try {
    const base = environment.document?.baseURI || environment.location?.href;
    if (base) page = new URL(base);
    url = new URL(value, page);
  } catch { throw new Error('文件地址无效。'); }
  if (url.username || url.password) throw new Error('文件地址不能包含登录凭据。');
  if (!['http:', 'https:'].includes(url.protocol)
    && !(url.protocol === 'dsh-app:' && url.hostname === 'app' && sameOrigin(url, page))) throw new Error('不支持此文件地址，请使用网页文件链接。');
  return { url, sameOrigin: sameOrigin(url, page) };
}

function leaf(value) { return value?.split(/[\\/]/u).filter(Boolean).at(-1); }
function decode(value) { try { return decodeURIComponent(value); } catch { return value; } }
function byteLength(character) {
  const code = character.codePointAt(0);
  return code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
}
function truncate(value, limit) {
  let result = '', bytes = 0;
  for (const character of value) {
    const size = byteLength(character);
    if (bytes + size > limit) break;
    result += character; bytes += size;
  }
  return result;
}
function filename(file, url, mediaType) {
  const explicit = [file?.filename, file?.name].find(value => typeof value === 'string' && value.trim());
  const suggested = explicit || leaf(url.searchParams.get('file')) || leaf(url.searchParams.get('path')) || leaf(decode(url.pathname)) || 'file';
  let name = suggested.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '_').replace(/^[. ]+|[. ]+$/gu, '') || 'file';
  const type = mediaType?.split(';')[0].trim().toLowerCase();
  const extension = Object.hasOwn(extensions, type) ? extensions[type] : undefined;
  const currentExtension = name.match(/\.([^.]+)$/u)?.[1].toLowerCase();
  const imageExtensions = /^(?:jpe?g|jpe|png|gif|webp|avif|svg|bmp|tiff?)$/u;
  const compatible = type === 'image/jpeg' ? /^(?:jpe?g|jpe)$/u.test(currentExtension || '')
    : type === 'image/tiff' ? /^tiff?$/u.test(currentExtension || '') : currentExtension === extension;
  if (extension && type.startsWith('image/') && imageExtensions.test(currentExtension || '') && !compatible) name = name.slice(0, -currentExtension.length) + extension;
  else if (!name.includes('.') && extension) name += `.${extension}`;
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)) name = `_${name}`;
  const dot = name.lastIndexOf('.'), suffix = dot > 0 ? truncate(name.slice(dot), 32) : '';
  const suffixBytes = [...suffix].reduce((size, character) => size + byteLength(character), 0);
  return truncate(dot > 0 ? name.slice(0, dot) : name, 255 - suffixBytes) + suffix;
}

async function readOriginal(url, isSameOrigin, environment) {
  let response;
  try {
    response = await environment.fetch(url.href, { credentials: isSameOrigin ? 'same-origin' : 'omit', referrerPolicy: 'no-referrer' });
  } catch (cause) { throw new Error('无法下载文件，请检查网络或来源是否允许跨域访问。', { cause }); }
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}），请确认文件仍可访问。`);
  try { return await response.blob(); }
  catch (cause) { throw new Error('文件内容读取失败，请检查网络后重试。', { cause }); }
}

/** Explicit cancellation is final; failure never navigates to an external browser. */
export async function saveOriginalFile(file, environment = globalThis) {
  const { url, sameOrigin: isSameOrigin } = sourceUrl(file, environment);
  const native = environment.dshDesktop?.fileActions;
  const mediaType = typeof file?.mimeType === 'string' ? file.mimeType : undefined;
  if (typeof native?.save === 'function') {
    const blob = url.protocol === 'dsh-app:' ? await readOriginal(url, isSameOrigin, environment) : undefined;
    let objectUrl;
    try {
      const original = blob === undefined ? url.href : (objectUrl = environment.URL.createObjectURL(blob));
      const type = blob?.type || mediaType;
      const result = await native.save({ url: original, name: filename(file, url, type), ...(type ? { mediaType: type } : {}), mode: 'saveAs' });
      if (result?.status === 'cancelled' || result?.status === 'saved' && typeof result.path === 'string') return result;
      throw new Error('原生保存未返回有效结果。');
    } catch (cause) { throw new Error('保存文件失败，请重试。', { cause }); }
    finally { if (objectUrl !== undefined) environment.URL.revokeObjectURL(objectUrl); }
  }
  if (typeof environment.fetch !== 'function' || typeof environment.URL?.createObjectURL !== 'function'
    || typeof environment.URL?.revokeObjectURL !== 'function' || typeof environment.document?.createElement !== 'function'
    || !environment.document?.body || typeof environment.setTimeout !== 'function') throw new Error('当前环境不支持文件下载。');
  const blob = await readOriginal(url, isSameOrigin, environment);
  let objectUrl, anchor, requested = false;
  try {
    objectUrl = environment.URL.createObjectURL(blob);
    anchor = environment.document.createElement('a');
    anchor.href = objectUrl; anchor.download = filename(file, url, blob.type || mediaType); anchor.hidden = true;
    environment.document.body.append(anchor);
    anchor.click(); requested = true;
    return { status: 'requested' };
  } catch (cause) { throw new Error('保存文件失败，请重试。', { cause }); }
  finally {
    anchor?.remove();
    if (objectUrl !== undefined) {
      if (requested) environment.setTimeout(() => environment.URL.revokeObjectURL(objectUrl), RELEASE_DELAY_MS);
      else environment.URL.revokeObjectURL(objectUrl);
    }
  }
}
