import { marked } from 'marked';
import { safeImageUrl } from '../../shared/client/image-gallery-model.mjs';

const deliverableKinds = Object.fromEntries(Object.entries({
  image: 'png jpg jpeg webp gif avif svg bmp tif tiff ico',
  document: 'pdf doc docx xls xlsx ppt pptx odt ods odp rtf txt md markdown csv tsv json yaml yml log epub',
  audio: 'mp3 wav ogg opus m4a aac flac aiff wma',
  video: 'mp4 webm mov mkv avi m4v mpeg mpg',
  archive: 'zip rar 7z tar gz tgz bz2 xz zst',
  file: 'js mjs cjs jsx ts tsx py ipynb java c cpp h hpp cs rs go rb sh ps1 bat cmd sql css scss less xml toml ini conf vue svelte wasm exe msi apk dmg iso',
}).flatMap(([kind, extensions]) => extensions.split(' ').map(extension => [extension, kind])));

const decodePath = value => { try { return decodeURIComponent(value); } catch { return value; } };
const leafName = value => decodePath(value).split(/[\\/]/).at(-1) || '';
const extensionKind = value => { const name = leafName(value); return name.includes('.') ? deliverableKinds[name.split('.').at(-1)?.toLowerCase()] : undefined; };

function fileReference(href) {
  if (typeof href !== 'string' || !href || href !== href.trim() || /[\u0000-\u001f\u007f]/.test(href) || /^(?:\/\/|\/\\)/.test(href)) return null;
  const browserRelative = /^(?:\/api\/|api\/)/i.test(href);
  if (browserRelative || /^https?:\/\//i.test(href)) {
    if (!safeImageUrl(href)) return null;
    const url = new URL(href, 'https://benchgo.invalid/');
    const target = url.searchParams.get('file') || url.searchParams.get('path') || url.pathname;
    const kind = extensionKind(target);
    const api = /(?:^|\/)api\//i.test(url.pathname);
    const fileRoute = api && /\/(?:artifact|file)(?:\/|$)/i.test(url.pathname);
    if (!kind && !fileRoute) return null;
    return { url: href, name: leafName(target), kind: kind || 'file' };
  }
  // Local destinations remain opaque file references, never browser requests.
  if (!/^[a-z]:[\\/]/i.test(href) && /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  const path = decodePath(href.split('#')[0]).replace(/:\d+(?::\d+|-\d+)?$/, '');
  if (!path || /[?\u0000-\u001f\u007f]/.test(path) || !/\.[\p{L}\p{N}]{1,16}$/u.test(leafName(path))) return null;
  const location = /(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?:-\d+|:\d+)?)$/.exec(href);
  const line = Number(location?.[1] || location?.[2]);
  return { url: href, path, ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}), name: leafName(path), kind: extensionKind(path) || (/\.html?$/i.test(path) ? 'web' : 'file'), local: true };
}

function labelText(token) {
  if (token.type === 'image') return token.text || token.title || '';
  if (token.tokens) return token.tokens.map(labelText).join('');
  return token.type === 'html' ? '' : token.text || '';
}
const ordinaryText = text => text.replace(/[\\`*_[\]<>!|]/g, '\\$&');

/** Map a normalized nested token back through list/blockquote indentation. */
function tokenLocation(source, raw, cursor) {
  if (!raw) return null;
  const exact = source.indexOf(raw, cursor);
  if (exact >= 0) return { start: exact, end: exact + raw.length, at: index => exact + index };
  const lines = raw.split('\n');
  if (lines.length < 2 || !lines[0]) return null;
  for (let start = source.indexOf(lines[0], cursor); start >= 0; start = source.indexOf(lines[0], start + 1)) {
    const positions = []; let sourceAt = start, valid = true;
    for (let line = 0; line < lines.length; line++) {
      const value = lines[line];
      if (line) {
        const end = source.indexOf('\n', sourceAt), bound = end < 0 ? source.length : end;
        const at = value ? source.indexOf(value, sourceAt) : sourceAt;
        if (at < sourceAt || at > bound || !/^[ \t>]*$/.test(source.slice(sourceAt, at))) { valid = false; break; }
        sourceAt = at;
      }
      if (!source.startsWith(value, sourceAt)) { valid = false; break; }
      for (let i = 0; i < value.length; i++) positions.push(sourceAt++);
      if (line < lines.length - 1) {
        if (source[sourceAt] !== '\n') { valid = false; break; }
        positions.push(sourceAt++);
      }
    }
    if (valid) return { start, end: sourceAt, at: index => positions[index] ?? sourceAt };
  }
  return null;
}

function childTokens(token) {
  if (token.type === 'list') return token.items;
  if (token.type === 'table') return [...token.header, ...token.rows.flat()].map(cell => ({ ...cell, type: 'cell', raw: cell.text }));
  return token.tokens || [];
}

/** Detach one reply's deliverables; source links, code and definitions stay Markdown. */
export function extractReplyDeliverables(text = '') {
  if (!text) return { text, images: [], files: [] };
  const source = text.replace(/\r\n?/g, '\n'), tokens = marked.lexer(source);
  const images = [], files = [], imageUrls = new Set(), fileUrls = new Set();
  const addImage = (url, alt) => { if (!imageUrls.has(url)) { imageUrls.add(url); images.push({ url, alt }); } };
  const addFile = file => { if (!fileUrls.has(file.url)) { fileUrls.add(file.url); files.push(file); } };
  function editsFor(token) {
    const raw = token.raw || '';
    if (['code', 'codespan', 'html', 'def'].includes(token.type) || /^\[\^[^\]]+\]:/.test(raw.trimStart())) return [];
    if (token.type === 'image' || token.type === 'link') {
      const label = labelText(token), file = fileReference(token.href);
      if (token.type === 'image' && !file?.local && safeImageUrl(token.href)) {
        addImage(token.href, label);
        return [{ start: 0, end: raw.length, text: ordinaryText(label), delivery: true }];
      }
      if (file) {
        if (file.kind === 'image' && !file.local) addImage(file.url, label || file.name);
        else addFile({ ...file, filename: file.name, name: label || file.name });
        return [{ start: 0, end: raw.length, text: ordinaryText(label || file.name), delivery: true }];
      }
      if (token.type === 'image') return [];
    }
    const edits = []; let cursor = 0, htmlDepth = 0;
    for (const child of childTokens(token)) {
      const location = tokenLocation(raw, child.raw, cursor);
      if (!location) continue;
      cursor = location.end;
      if (child.type === 'html') {
        for (const tag of child.raw.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)) {
          if (/^<\//.test(tag[0])) htmlDepth = Math.max(0, htmlDepth - 1);
          else if (!/\/\s*>$/.test(tag[0]) && !/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag[1])) htmlDepth++;
        }
        continue;
      }
      if (htmlDepth) continue;
      for (const edit of editsFor(child)) edits.push({ ...edit, start: location.at(edit.start), end: edit.end > edit.start ? location.at(edit.end - 1) + 1 : location.at(edit.end) });
    }
    if (['paragraph', 'text', 'list_item', 'blockquote'].includes(token.type) && edits.length && edits.every(edit => edit.delivery)) {
      let rest = raw;
      for (const edit of [...edits].reverse()) rest = rest.slice(0, edit.start) + rest.slice(edit.end);
      if (!rest.replace(/^[ \t]*(?:>|[-+*]|\d+[.)])[ \t]*/gm, '').trim()) return [{ start: 0, end: raw.length, text: '', delivery: true }];
    }
    return edits;
  }
  const edits = []; let offset = 0;
  for (const token of tokens) {
    for (const edit of editsFor(token)) edits.push({ ...edit, start: offset + edit.start, end: offset + edit.end });
    offset += token.raw.length;
  }
  if (!edits.length) return { text, images, files };
  let result = source;
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return { text: result, images, files: files.filter(file => !imageUrls.has(file.url)) };
}

