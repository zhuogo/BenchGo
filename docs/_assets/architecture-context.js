'use strict';
(() => {
  const button = document.getElementById('context-open');
  if (!button) return;
  const data = JSON.parse(document.getElementById('architecture-data').textContent);
  const config = data.context;
  if (!config) return;
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const panel = make('aside', undefined, 'context-panel');
  panel.id = 'context-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', '上下文分层与检索');
  const top = make('div', undefined, 'panel-top');
  top.append(make('h2', '上下文分层'));
  const close = make('button', '×', 'btn icon');
  close.type = 'button'; close.setAttribute('aria-label', '关闭上下文分层');
  top.append(close); panel.append(top, make('p', config.intro, 'context-intro'));
  for (const [index, group] of config.groups.entries()) {
    const details = make('details'); details.open = index === 0;
    const summary = make('summary'); summary.append(make('small', group.mode), make('span', group.title));
    const content = make('dl');
    for (const row of group.rows) content.append(make('dt', row[0]), make('dd', row[1]));
    details.append(summary, content); panel.append(details);
  }
  panel.append(make('p', config.note, 'context-footer'));
  const links = make('nav', undefined, 'context-links'); links.setAttribute('aria-label', '上下文设计与源码');
  const root = new URL('../../', document.currentScript.src);
  for (const item of config.links) {
    const link = make('a', item.label + ' ↗'); link.href = new URL(item.path, root); links.append(link);
  }
  panel.append(links); document.body.append(panel);
  const hide = () => { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); button.focus(); };
  const show = () => {
    panel.hidden = false; button.setAttribute('aria-expanded', 'true'); panel.scrollTop = 0; close.focus();
  };
  button.onclick = () => panel.hidden ? show() : hide(); close.onclick = hide;
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) hide(); });
  if (location.hash === '#context') show();
  window.addEventListener('hashchange', () => { if (location.hash === '#context') show(); });
})();
