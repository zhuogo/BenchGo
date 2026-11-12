import React, { useMemo } from 'react';
import { PetAvatar } from '../../shared/client/pet-avatar.jsx';
import { petImageUrl } from './pet-state.mjs';
import css from './card.css';


const tags = new Set(['DIV', 'SPAN', 'P', 'B', 'STRONG', 'I', 'EM', 'SMALL', 'BR', 'STYLE', 'S', 'U', 'SUB', 'SUP']);

export function inspectCardHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = typeof html === 'string' ? html : '';
  const issues = new Set();
  const blocked = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE', 'IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'LINK', 'META', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT']);
  const clean = parent => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === 3) continue;
      if (node.nodeType !== 1) { node.remove(); continue; }
      if (blocked.has(node.tagName)) { issues.add(`不支持 ${node.tagName.toLowerCase()} 元素，已移除`); node.remove(); continue; }
      clean(node);
      if (!tags.has(node.tagName)) {
        issues.add(`${node.tagName.toLowerCase()} 容器已转为安全内容`);
        node.replaceWith(...node.childNodes); continue;
      }
      for (const attribute of [...node.attributes]) if (!['style', 'class', 'title'].includes(attribute.name)) {
        issues.add(`不支持 ${attribute.name} 属性，已移除`); node.removeAttribute(attribute.name);
      }
      if (node.tagName !== 'STYLE' && (node.style.display === 'none' || ['hidden', 'collapse'].includes(node.style.visibility) || node.style.opacity === '0' || node.style.fontSize === '0px' || node.style.color === 'transparent' || ['0px', '0'].includes(node.style.height) || ['0px', '0'].includes(node.style.width))) {
        issues.add('隐藏内容已移除'); node.remove();
      }
    }
  };
  clean(template.content);
  const content = template.content.cloneNode(true);
  content.querySelectorAll('style').forEach(node => node.remove());
  const hiddenRule = /(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\.0+)?\s*(?:!important\s*)?[;} ]|font-size\s*:\s*0(?:px|rem|em)?\s*(?:!important\s*)?[;} ]|color\s*:\s*transparent)/i;
  const hiddenStyles = [...template.content.querySelectorAll('style')].some(node => hiddenRule.test(node.textContent.replace(/\/\*[\s\S]*?\*\//g, '')));
  // A style attribute alone is not visible content (e.g. <div style="">).
  // Keep intentional CSS-only marks only when they declare both area and paint.
  const paintedMark = [...content.querySelectorAll('[style]')].some(node => {
    const style = node.style;
    const area = parseFloat(style.width) > 0 && parseFloat(style.height) > 0;
    const background = style.backgroundColor && !['transparent', 'rgba(0, 0, 0, 0)'].includes(style.backgroundColor);
    const border = parseFloat(style.borderWidth) > 0 && !['none', 'hidden', ''].includes(style.borderStyle);
    return area && (background || border);
  });
  const hasContent = !hiddenStyles && (!!content.textContent.trim() || paintedMark);
  if (hiddenStyles) issues.add('样式包含隐藏规则，已使用默认名片；移除隐藏规则后可恢复预览');
  if (typeof html === 'string' && html.trim() && !hasContent) issues.add('没有可显示的内容，将使用默认名片');
  if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\s*[;}])|position\s*:\s*(?:absolute|fixed)|(?:height|min-height)\s*:\s*(?:[5-9]\d|\d{3,})px/i.test(template.innerHTML)) issues.add('样式可能隐藏或超出 160 × 40 px 名片区域，请检查预览');
  return { html: template.innerHTML, issues: [...issues], hasContent };
}

export function cardDocument(html, color, motion = true) {
  const safe = inspectCardHtml(html);
  const textColor = /^rgba?\([\d.,%\s]+\)$/.test(color) || /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#222222';
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{display:flex;align-items:center;font:600 12px/1.4 system-ui,sans-serif;color:${textColor};background:transparent;overflow-wrap:anywhere}*{box-sizing:border-box;max-width:100%}p{margin:0}</style></head><body>${safe.html}<style>html,body{margin:0!important;padding:0!important;width:160px!important;height:40px!important;min-width:0!important;min-height:0!important;overflow:hidden!important;position:static!important}html{display:block!important}body{display:flex!important}${motion ? '' : '*,*::before,*::after{animation-play-state:paused!important;transition:none!important}'}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}</style></body></html>`;
}

export function AssistantCard({ name, pet, html, motion = true, onOpen, action = 'idle', expression, ariaLabel, current, status, avatarSize = 40 }) {
  const inspection = useMemo(() => inspectCardHtml(html), [html]);
  const custom = inspection.hasContent;
  const [active, setActive] = React.useState(false);
  const [color, setColor] = React.useState('');
  const host = React.useRef(null);
  React.useEffect(() => {
    if (!host.current) return;
    let visible = true;
    const read = () => { if (!host.current) return; setColor(getComputedStyle(host.current).color); setActive(visible && !document.hidden); };
    const intersection = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? false; read(); });
    intersection?.observe(host.current);
    document.addEventListener('visibilitychange', read);
    read();
    const observer = new MutationObserver(read);
    for (let node = host.current; node; node = node.parentElement) observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-ds-dark-theme'] });
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', read);
    return () => { observer.disconnect(); intersection?.disconnect(); document.removeEventListener('visibilitychange', read); scheme.removeEventListener('change', read); };
  }, []);
  const source = useMemo(() => custom ? cardDocument(inspection.html, color, motion && active) : '', [inspection.html, color, custom, motion, active]);
  const Tag = onOpen ? 'button' : 'span';
  return <Tag ref={host} className={`ba-card${custom ? ' ba-card-custom' : ' ba-card-brand'}`} {...(onOpen ? { type: 'button', onClick: onOpen, 'aria-label': ariaLabel || `编辑${name}的名片`, 'aria-current': current ? 'page' : undefined } : { role: 'img', 'aria-label': `${name}的名片` })} data-motion={motion && active ? 'on' : 'off'} data-status={status}>
    <style>{css}</style>
    {custom ? <iframe title={`${name}的名片`} sandbox="" referrerPolicy="no-referrer" srcDoc={source} tabIndex={-1} aria-hidden="true" /> : <><PetAvatar pet={pet} src={petImageUrl(pet, document.baseURI, expression)} expression={expression} action={action} size={avatarSize} motion={motion} /><span className="ba-card-name">{name}</span></>}
    {status && status !== 'idle' && <span className="ba-card-status" aria-hidden="true">{status === 'waiting' ? '?' : status === 'error' ? '!' : '·'}</span>}
  </Tag>;
}
