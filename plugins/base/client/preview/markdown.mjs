import { marked } from 'marked';
import DOMPurify from 'dompurify';
export function render(text) {
  return DOMPurify.sanitize(marked.parse(text, { gfm: true }), { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style', 'href', 'srcset'] });
}
export function sanitizeHtml(text) {
  return DOMPurify.sanitize(text, { WHOLE_DOCUMENT: true, USE_PROFILES: { html: true }, ADD_TAGS: ['style'], FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link'], FORBID_ATTR: ['href', 'srcset'] });
}
