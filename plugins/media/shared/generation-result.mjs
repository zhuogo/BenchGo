export const NATIVE_MEDIA_RESULT = 'plugin:benchgo-plugin/media-result';
export const MEDIA_PRESENTATION = 'benchgoMedia';
const artifactPath = 'api/benchgo/media/artifact?file=';

export const mediaArtifactUrl = filename => artifactPath + encodeURIComponent(filename);

export function mediaModelResult(result) {
  if (!mediaResultFile(result)) return result;
  const { url, externalUrl, ...receipt } = result;
  return { ...receipt, delivery: 'Shown in the conversation. Do not embed or link it again.' };
}

export function externalImageUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || !/^https:\/\//iu.test(value)
    || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  try {
    const { hostname, username, password } = new URL(value);
    const host = hostname.replace(/\.$/u, '');
    if (username || password || !host.includes('.') || /^[\d.]+$/u.test(host)
      || /\.(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/u.test(host)) return null;
    return value;
  } catch { return null; }
}

export function mediaResultFile(value) {
  const { url, filename, mimeType, externalUrl, modelId } = value ?? {};
  const modelName = [value?.modelName, modelId].find(name => typeof name === 'string' && name.trim() && name.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(name));
  const imageMetadata = modelName && /^image\//iu.test(mimeType) ? { modelName } : {};
  const external = externalImageUrl(externalUrl);
  if (external && (url === undefined || url === external) && typeof mimeType === 'string'
    && /^image\/(?:[a-z0-9.+-]+|\*)$/iu.test(mimeType)) {
    return { url: external, name: '生成图片', mimeType: mimeType.toLowerCase(), external: true, ...imageMetadata };
  }
  if (typeof filename !== 'string' || !/^[a-z0-9_-]+\.[a-z0-9]+$/iu.test(filename) || filename.length > 200
    || url !== mediaArtifactUrl(filename) || typeof mimeType !== 'string'
    || !/^(?:image|video|audio)\/[a-z0-9.+-]+$/iu.test(mimeType)) return null;
  return { url, name: filename, mimeType: mimeType.toLowerCase(), ...imageMetadata };
}
