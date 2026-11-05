/** Bound UTF-8 payloads without splitting surrogate pairs or changing content. */
export function channelMessageChunks(text, limit = 1800) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 256000) throw new Error('渠道正文为空或超过 256 KB，请在工作台查看完整产物');
  const chunks = []; let value = '', bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > limit) { chunks.push(value); value = ''; bytes = 0; }
    value += char; bytes += size;
  }
  if (value) chunks.push(value);
  return chunks;
}
