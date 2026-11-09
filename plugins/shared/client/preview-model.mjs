export const TEXT_LIMIT = 2 * 1024 * 1024;
export const BINARY_LIMIT = 25 * 1024 * 1024;
export function previewKind(name = '') {
  const ext = name.split('.').at(-1).toLowerCase();
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (ext === 'json') return 'json';
  if (['xlsx', 'xls', 'csv', 'tsv'].includes(ext)) return 'sheet';
  if (ext === 'docx') return 'docx';
  if (['ppt', 'pptx', 'doc', 'odt', 'rtf'].includes(ext)) return 'office';
  if (ext === 'pdf') return 'pdf';
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  return 'text';
}
export function fileUrl(value, base = globalThis.document?.baseURI || globalThis.location?.href) {
  const url = new URL(value, base), baseUrl = base ? new URL(base) : null;
  const sameOrigin = !baseUrl || (url.origin === baseUrl.origin && (url.origin !== 'null' || (url.protocol === baseUrl.protocol && url.host === baseUrl.host)));
  const webUrl = ['http:', 'https:'].includes(url.protocol);
  const desktopUrl = url.protocol === 'dsh-app:' && baseUrl?.protocol === 'dsh-app:' && url.host === baseUrl.host;
  if ((!webUrl && !desktopUrl) || !sameOrigin) throw new Error('文件地址无效');
  return url;
}
export function pdfUrl(value, base) { const url = fileUrl(value, base); url.searchParams.set('preview', 'pdf'); url.searchParams.delete('download'); return url.href; }
export async function readPreview(response, limit, signal) {
  if (!response.ok) {
    let message = (await response.text()).slice(0, 1000);
    try { message = JSON.parse(message).error || message; } catch { /* Plain text endpoints. */ }
    throw new Error(message.slice(0, 500) || `读取失败 (${response.status})`);
  }
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('文件超过快览大小限制，请下载查看'); }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) throw new Error('文件超过快览大小限制，请下载查看');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
export function decodeText(bytes) {
  if (bytes.includes(0)) throw new Error('此文件不是 UTF-8 文本，请下载原文件查看');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('文本编码不受支持，请使用 UTF-8 或下载原文件查看'); }
}
export function frameDocument(content, colorScheme) {
  return `<!doctype html><html${['light', 'dark'].includes(colorScheme) ? ` data-theme="${colorScheme}"` : ''}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light dark;--preview-ink:#242424;--preview-paper:#fff;--preview-line:#ddd}@media(prefers-color-scheme:dark){:root{--preview-ink:#ededee;--preview-paper:#19191b;--preview-line:#3b3b40}}html[data-theme=light]{color-scheme:light;--preview-ink:#242424;--preview-paper:#fff;--preview-line:#ddd}html[data-theme=dark]{color-scheme:dark;--preview-ink:#ededee;--preview-paper:#19191b;--preview-line:#3b3b40}body{font:15px/1.7 system-ui,sans-serif;color:var(--preview-ink);background:var(--preview-paper);margin:24px;overflow-wrap:anywhere}body>:first-child{margin-top:0}img{max-width:100%}pre{overflow:auto;padding:12px;border-radius:8px;background:color-mix(in srgb,var(--preview-ink) 6%,transparent)}table{border-collapse:collapse;max-width:100%}td,th{padding:6px 10px;border:1px solid var(--preview-line)}blockquote{margin-inline:0;padding-left:16px;border-left:3px solid var(--preview-line)}hr{border:0;border-top:1px solid var(--preview-line)}@media(max-width:480px){body{margin:16px;font-size:14px}}a{color:inherit;pointer-events:none}.docx-wrapper{padding:0!important;background:transparent!important}.docx{box-shadow:none!important;max-width:100%;box-sizing:border-box}</style></head><body>${content}</body></html>`;
}
export function visibleRows(rows, query) {
  const needle = query.trim().toLocaleLowerCase();
  return rows.map((row, index) => ({ row, index })).filter(({ row }) => !needle || row.some(value => String(value).toLocaleLowerCase().includes(needle)));
}
// Reject oversized ZIP containers before Office libraries allocate their expanded content.
export function checkOfficeArchive(bytes) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65557); pos--) {
    if (view.getUint32(pos, true) === 0x06054b50) { end = pos; break; }
  }
  if (end < 0) throw new Error('Office 文件不完整');
  const entries = view.getUint16(end + 10, true); let offset = view.getUint32(end + 16, true), expanded = 0;
  if (entries > 4096) throw new Error('Office 文件过于复杂，请下载查看');
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('Office 文件结构无效');
    expanded += view.getUint32(offset + 24, true);
    if (expanded > 64 * 1024 * 1024) throw new Error('Office 文件展开后超过 64 MiB，请下载查看');
    if (view.getUint16(offset + 8, true) & 1) throw new Error('加密文档请下载后打开');
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
}
