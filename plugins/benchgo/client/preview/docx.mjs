import { renderAsync } from 'docx-preview';
import DOMPurify from 'dompurify';
export async function render(bytes) {
  const body = document.createElement('div');
  await renderAsync(bytes, body, undefined, { useBase64URL: true, renderAltChunks: false, ignoreFonts: true, breakPages: true });
  return DOMPurify.sanitize(body.innerHTML, { WHOLE_DOCUMENT: true, ADD_TAGS: ['style'], FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'], FORBID_ATTR: ['href', 'srcset'] });
}
