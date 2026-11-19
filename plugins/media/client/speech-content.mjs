const DRIVE = /^[a-z]:[\\/]/iu;
const END = /[\s<>"'“”‘’`，。！？；（）\[\]{}!?;]/u;

/** Only a complete, literal local path is converted; never infer a missing drive or folder. */
export function spokenWindowsPath(value) {
  let path = String(value || '').trim();
  if (/^file:\/\/\/[a-z]:[\\/]/iu.test(path)) {
    try { path = decodeURIComponent(path.slice(8)); } catch { return null; }
  }
  if (!DRIVE.test(path) || /[\u0000-\u001f<>"|?*]/u.test(path) || path.length > 2048) return null;
  const line = /:(\d+)$/u.exec(path); if (line) path = path.slice(0, line.index);
  const drive = path[0].toUpperCase(), folders = path.slice(3).split(/[\\/]+/u).filter(Boolean);
  const name = part => part.replace(/_/gu, ' 下划线 ').replace(/\./gu, ' 点 ');
  let spoken = `${drive} 盘`;
  if (folders.length) {
    const leaf = folders.pop();
    spoken += '的' + folders.map(part => `${name(part)}文件夹下，`).join('');
    spoken += `${name(leaf)}${/[\\/]$/u.test(path) ? '文件夹' : ''}`;
  }
  if (line) spoken += `第 ${line[1]} 行`;
  return spoken;
}

/** Retain an unfinished path until its boundary is known, including an idle flush. */
export function readWindowsPath(raw, final = false) {
  const quote = /^["'“‘]/u.test(raw) ? raw[0] : '';
  const offset = quote ? 1 : 0, text = raw.slice(offset);
  if (!/^(?:[a-z]:[\\/]|file:\/\/\/[a-z]:[\\/])/iu.test(text)) {
    const candidate = text.toLowerCase();
    if (!final && (/^[a-z](?::)?$/u.test(candidate) || 'file:///'.startsWith(candidate) || /^file:\/\/\/(?:[a-z](?::)?)?$/u.test(candidate))) return { pending: true };
    return null;
  }
  let end;
  if (quote) {
    const close = ({ '“': '”', '‘': '’' })[quote] || quote;
    end = raw.indexOf(close, 1);
    if (end < 0) return !final && raw.length <= 2048 ? { pending: true } : { length: raw.length, spoken: '' };
  } else {
    end = offset;
    while (end < raw.length && !END.test(raw[end])) end++;
    if (end === raw.length && !final && raw.length <= 2048) return { pending: true };
  }
  const path = raw.slice(offset, end);
  return { length: end + (quote ? 1 : 0), spoken: spokenWindowsPath(path) || '', overflow: end === raw.length && raw.length > 2048 };
}

/** Markdown destinations may contain balanced parentheses or a quoted title. */
export function markdownDestinationEnd(raw, open) {
  let depth = 1, quote = '';
  for (let i = open + 1; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && /[\\()"']/u.test(raw[i + 1] || '')) { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if ((ch === '"' || ch === "'") && /\s/u.test(raw[i - 1] || '')) { quote = ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Labels are speech, destinations are not. A path used as a label stays a path. */
export function spokenLinkLabel(label) {
  const inline = /^`+[\s\S]*`+$/u.test(String(label || '').trim());
  const clean = String(label || '').replace(/`+/gu, '').replace(/[*~]/gu, '').trim();
  return spokenWindowsPath(clean) || (inline ? '代码' : /^(?:https?:\/\/|www\.)/iu.test(clean) ? '这个链接' : clean);
}
