/** Redact free-text requirements before any background-model request or audit. */
export function redactExecutionText(value, limit = 600) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/-----BEGIN[\s\S]*?-----END[^\r\n]*-----/g, '[秘密已隐藏]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>]+/gi, '[认证已隐藏]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|authorization|credential|secret|token|密码|密钥|凭据)\s*["']?\s*[:=：]\s*)(["'])[\s\S]*?\2/gi, '$1[秘密已隐藏]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|authorization|credential|secret|token|密码|密钥|凭据)\s*["']?\s*[:=：]\s*)["']?[^\s,;，；"'<>]+["']?/gi, '$1[秘密已隐藏]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[秘密已隐藏]')
    .replace(/https?:\/\/[^\s<>"']+/gi, value => { try { const url = new URL(value); return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}${url.search ? '?[参数已隐藏]' : ''}`; } catch { return '[链接已隐藏]'; } })
    .replace(/\b[A-Za-z]:[\\/][^\s<>"']+|(?:^|\s)\/(?:[^\s/]+\/)+[^\s<>"']*/g, ' [路径已隐藏]')
    .replace(/\b[a-f0-9]{40,64}\b/gi, '[散列已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
