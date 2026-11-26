import { readLimited } from '../../base/shared/http.mjs';
import { externalImageUrl } from '../shared/generation-result.mjs';

export const imageTypes = Object.freeze({
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
});
export const audioTypes = Object.freeze({
  mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', pcm: 'audio/pcm',
});
export const MAX_REFERENCE = 16 * 1024 * 1024;

export const mediaFailure = (message, status = 400, code = 'MEDIA_INVALID') => Object.assign(new Error(message), { status, code });

function matches(bytes, offset, pattern) {
  return Buffer.from(bytes.subarray(offset, offset + pattern.length)).equals(Buffer.from(pattern));
}

export function imageFormat(bytes) {
  if (matches(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return 'png';
  if (matches(bytes, 0, [255, 216, 255])) return 'jpeg';
  if (matches(bytes, 0, 'RIFF') && matches(bytes, 8, 'WEBP')) return 'webp';
  if (matches(bytes, 0, 'GIF87a') || matches(bytes, 0, 'GIF89a')) return 'gif';
  if (/^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg(?:\s|>)/iu.test(new TextDecoder().decode(bytes.subarray(0, 4096)))) return 'svg';
}

function jsonBody(body) {
  return { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}

function appendImage(form, key, image, name) {
  form.append(key, image.blob, name + '.' + image.format);
}

export function submission(input, route) {
  const { kind, operation, prompt, reference, mask, seconds, format, voice } = input;
  const size = input.size ?? route.size, quality = input.quality ?? route.quality;
  const model = route.modelId;
  if (kind === 'audio') {
    return { path: '/audio/speech', ...jsonBody({ model, input: prompt, voice, response_format: format }) };
  }
  if (kind === 'image' && operation === 'generate') {
    return { path: '/images/generations', ...jsonBody({ model, prompt, n: 1, size, quality, output_format: format }) };
  }
  const body = new FormData();
  body.append('model', model);
  body.append('prompt', prompt);
  if (size) body.append('size', size);
  if (kind === 'video') {
    if (seconds !== undefined) body.append('seconds', String(seconds));
    if (reference.length) appendImage(body, 'input_reference', reference[0], 'reference');
    return { path: '/videos', body };
  }
  if (quality) body.append('quality', quality);
  if (format) body.append('output_format', format);
  const field = reference.length === 1 ? 'image' : 'image[]';
  reference.forEach((image, index) => appendImage(body, field, image, 'reference-' + (index + 1)));
  if (mask) appendImage(body, 'mask', mask, 'mask');
  return { path: '/images/edits', body };
}

export async function mediaJson(response, signal, limit = 1024 * 1024) {
  try {
    return JSON.parse(new TextDecoder().decode(await readLimited(response, limit, signal)));
  } catch {
    await discard(response);
    throw mediaFailure('媒体供应商返回了无效的 JSON', 502, 'MEDIA_REPLY_INVALID');
  }
}

export async function discard(response) {
  await response.body?.cancel().catch(() => {});
}

export async function readMediaProviderError(response, signal) {
  let text;
  try { text = new TextDecoder().decode(await readLimited(response, 16 * 1024, signal)); }
  catch { await discard(response); return null; }
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return body?.error ?? body;
}

export function rejectsSpeechVoice(error) {
  const code = typeof error?.code === 'string' ? error.code : error?.type;
  const message = typeof error === 'string' ? error : error?.message;
  if (error?.param === 'voice') return true;
  if (typeof code === 'string' && /^(?:invalid_voice|unsupported_voice|unknown_voice|voice_not_found|voice_not_supported|voice_invalid)$/iu.test(code)) return true;
  if (typeof message !== 'string') return false;
  return /\b(?:invalid|unsupported|unknown)\s+voice\b|\bvoice(?:\s+["'`][^"'`\r\n]{1,100}["'`])?\s+(?:is\s+)?(?:invalid|not supported|not found)\b|(?:音色|发音人)(?:名称)?(?:无效|不支持|不存在)|不支持(?:该|此|的)?音色/iu.test(message);
}

const providerParameters = {
  image: { prompt: 'prompt', size: 'size', quality: 'quality', output_format: 'format', image: 'references', 'image[]': 'references', mask: 'mask' },
  video: { prompt: 'prompt', size: 'size', seconds: 'seconds', input_reference: 'references' },
  audio: { input: 'prompt', voice: 'voice', response_format: 'format' },
};

export function mediaProviderRejectedField(kind, error) {
  const fields = providerParameters[kind], param = error?.param;
  if (typeof param !== 'string') return;
  if (param === 'model') return 'model';
  return Object.hasOwn(fields, param) ? fields[param] : undefined;
}

export async function readImage(response, route, fetcher, signal, requestedFormat) {
  const maxBytes = 32 * 1024 * 1024;
  const row = (await mediaJson(response, signal, Math.ceil(maxBytes * 4 / 3) + 1024 * 1024))?.data?.[0];
  let bytes;
  const encoded = row?.b64_json;
  if (typeof encoded === 'string' && encoded.length && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    bytes = Buffer.from(encoded, 'base64');
  } else if (typeof row?.url === 'string') {
    // Keep provider-origin downloads separate from requests carrying the API key.
    let url;
    try { url = new URL(row.url, route.baseURL + '/'); } catch {}
    if (!url || url.username || url.password || url.hash) {
      throw mediaFailure('供应商返回了无效的图片地址', 502, 'MEDIA_IMAGE_URL_INVALID');
    }
    if (url.origin !== new URL(route.baseURL).origin) {
      const externalUrl = externalImageUrl(row.url);
      if (!externalUrl) throw mediaFailure('供应商返回了无效的外部图片地址', 502, 'MEDIA_IMAGE_URL_INVALID');
      const extension = /\.([a-z]+)$/iu.exec(url.pathname)?.[1].toLowerCase();
      const format = extension === 'jpg' ? 'jpeg' : extension;
      const mimeType = Object.hasOwn(imageTypes, format) ? imageTypes[format] : imageTypes[requestedFormat] ?? 'image/*';
      return { externalUrl, mimeType };
    }
    const download = await fetcher(url, { redirect: 'error', signal });
    if (!download.ok) { await discard(download); throw mediaFailure('生成图片下载失败', 502, 'MEDIA_DOWNLOAD_FAILED'); }
    bytes = await readLimited(download, maxBytes, signal).catch(async error => { await discard(download); throw error; });
  }
  const format = bytes && bytes.length <= maxBytes && imageFormat(bytes);
  if (!format) throw mediaFailure('媒体供应商未返回支持的图片内容', 502, 'MEDIA_IMAGE_INVALID');
  if (requestedFormat && requestedFormat !== format) throw mediaFailure('供应商生成的图片格式与请求不一致', 502, 'MEDIA_FORMAT_MISMATCH');
  return { bytes, format, mimeType: imageTypes[format] };
}

export function videoDocument(value) {
  if (typeof value?.id !== 'string' || !value.id || value.id.length > 512 || ['.', '..'].includes(value.id) || /[/\\\u0000-\u001f\u007f]/u.test(value.id)) {
    throw mediaFailure('媒体供应商未返回有效的视频任务 ID', 502, 'MEDIA_VIDEO_ID_INVALID');
  }
  if (!['queued', 'in_progress', 'completed', 'failed', 'cancelled', 'canceled'].includes(value.status)) {
    throw mediaFailure('媒体供应商返回了未知的视频任务状态', 502, 'MEDIA_VIDEO_STATUS_INVALID');
  }
  const progress = Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 100 ? value.progress : undefined;
  return { jobId: value.id, status: value.status === 'canceled' ? 'cancelled' : value.status, ...(progress === undefined ? {} : { progress }) };
}

export function validateStreamType(response, expected) {
  const actual = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const aliases = {
    'audio/mpeg': ['audio/mp3'], 'audio/wav': ['audio/wave', 'audio/x-wav', 'audio/vnd.wave'],
    'audio/ogg': ['audio/opus', 'application/ogg'], 'audio/flac': ['audio/x-flac'], 'audio/pcm': ['audio/l16', 'audio/pcm16', 'audio/x-pcm'],
  };
  if (!response.body || actual && actual !== expected && actual !== 'application/octet-stream' && !aliases[expected]?.includes(actual)) {
    throw mediaFailure('媒体供应商返回了不符合要求的文件格式', 502, 'MEDIA_FORMAT_MISMATCH');
  }
  return response.body;
}

export function checkStreamPrefix(bytes, mimeType, size) {
  const frameSync = bytes[0] === 255 && (bytes[1] & 224) === 224;
  const supported = {
    'audio/mpeg': () => matches(bytes, 0, 'ID3') || frameSync,
    'audio/wav': () => matches(bytes, 0, 'RIFF') && matches(bytes, 8, 'WAVE'),
    'audio/ogg': () => matches(bytes, 0, 'OggS'),
    'audio/aac': () => bytes[0] === 255 && (bytes[1] & 246) === 240 || matches(bytes, 0, 'ADIF'),
    'audio/flac': () => matches(bytes, 0, 'fLaC'),
    'audio/pcm': () => size % 2 === 0,
    'video/mp4': () => matches(bytes, 4, 'ftyp'),
  };
  if (!supported[mimeType]?.()) throw mediaFailure('媒体供应商返回的文件内容与格式不符', 502, 'MEDIA_FORMAT_MISMATCH');
}
