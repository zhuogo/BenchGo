/** IDENTITY.md is the preferred name source; config.name remains a display fallback. */
export function validateIdentityName(value) {
  if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Invalid assistant name');
  return value.trim();
}

export function identityName(content) {
  const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!header) return null;
  const rows = header[1].split(/\r?\n/u).filter(line => /^name\s*:/u.test(line));
  if (!rows.length) return null;
  if (rows.length !== 1) throw new Error('IDENTITY.md contains duplicate name fields');
  const raw = rows[0].replace(/^name\s*:\s*/u, '').trim();
  const value = raw.startsWith('"') ? JSON.parse(raw) : raw;
  return validateIdentityName(value);
}

export function withIdentityName(content, name) {
  name = validateIdentityName(name);
  // Validate the old field before editing; ambiguous headers must be repaired explicitly.
  identityName(content);
  const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  const field = `name: ${JSON.stringify(name)}`;
  if (!header) return `---\n${field}\n---\n\n${content}`;
  const lines = header[1].split(/\r?\n/u);
  const index = lines.findIndex(line => /^name\s*:/u.test(line));
  if (index < 0) lines.push(field); else lines[index] = field;
  return `---\n${lines.join('\n')}\n---\n${content.slice(header[0].length)}`;
}

export function createAssistantIdentity({ documents }) {
  async function rename(name, { expectedHash, source = { type: 'user-edit', field: 'identity-name' } } = {}) {
    name = validateIdentityName(name);
    const document = await documents.mutate('IDENTITY.md', content => withIdentityName(content, name), { expectedHash, source });
    return { name, expectedHash: document.hash, authority: 'IDENTITY.md' };
  }
  return { rename };
}
