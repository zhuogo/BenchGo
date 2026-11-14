/** Keep browser media URLs explicit; never turn local filesystem paths into requests. */
export function safeImageUrl(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\u0000-\u0020\\]/.test(value)) return null;
  if (/^(?:\/(?!\/)|api\/)/i.test(value)) return value;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch { return null; }
}

export function galleryImages(images = []) {
  return images.flatMap((image, index) => {
    const url = safeImageUrl(image?.url);
    return url ? [{ ...image, url, alt: image.alt || image.prompt || image.name || `图片 ${index + 1}` }] : [];
  });
}

/** Old records without an origin stay separate instead of mixing unrelated replies. */
export function groupReplyImages(images = []) {
  const groups = new Map();
  for (const image of galleryImages(images)) {
    const id = image.groupId || image.id || image.url;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(image);
  }
  return [...groups].map(([id, images]) => ({ id, images }));
}
