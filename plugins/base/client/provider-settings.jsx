import React, { useEffect, useRef, useState } from 'react';
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { ModelsSection } from '../../../deepseek-harness/packages/client/ui-settings-models/src/client/ModelsSection.tsx';
import { mountOfficialModelsStyle } from '../../../deepseek-harness/packages/client/ui-settings-models/src/client/ModelsSection.module.css';
import { adaptProviderStore } from './provider-store.mjs';
import { UIIcon } from './iconsax.jsx';
import { ProviderBrandIcon } from './provider-brand-icon.jsx';
import { providerTemplates, templateProviderId } from '../shared/provider-templates.mjs';
import { routerGo, routerGoConnectionId } from '../shared/builtin-providers.mjs';
export { isRouterGo } from '../shared/builtin-providers.mjs';
export { ProviderBrandIcon } from './provider-brand-icon.jsx';
export { prioritizeRouterGo } from './provider-options.mjs';
import css from './provider-settings.css';

export function ModelSettingsNotice({ message }) {
  const [visible, setVisible] = useState(true);
  return visible ? <Toast text={message} icon={<UIIcon name="close" size={16} />} onDone={() => setVisible(false)} /> : null;
}

/** Mount the adapted official models page with its original controller and operations. */
export function mountProviderSettings(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    const disposeOfficialStyle = mountOfficialModelsStyle();
    return () => { style.remove(); disposeOfficialStyle(); };
  });
  // Child slots have one declaration owner. Adapt the official entry's view
  // reversibly, retaining its original inject, controller and render authority.
  ctx.effect(() => {
    const entry = ctx.slots.entries('settings.section').find(item => item.options.id === 'models' && item.children?.['settings.models.provider-card']);
    if (!entry) throw new Error('Official Models settings entry is unavailable');
    const restoreStore = adaptProviderStore(entry.inject().controller);
    const original = entry.component; entry.component = ModelsSection;
    return () => { restoreStore(); if (entry.component === ModelsSection) entry.component = original; };
  });
}
export { routerGo } from '../shared/builtin-providers.mjs';

export function ProviderAddForm({ selection, protocols, onSelect, onBack, onClose, busy, children }) {
  const [query, setQuery] = useState('');
  const focusTarget = useRef(null);
  useEffect(() => {
    focusTarget.current?.focus();
  }, [selection]);
  const term = query.trim().toLowerCase();
  const matches = ({ kind, name, keywords = [] }) => [kind, name, ...keywords].join(' ').toLowerCase().includes(term);
  const templates = providerTemplates.filter(template => protocols.includes(template.protocol) && matches(template));
  const custom = protocols.length > 0 && matches({ kind: 'custom', name: '自定义供应商' });
  const router = protocols.includes(routerGo.protocol) && matches({ kind: routerGo.id, name: routerGo.name });
  const tile = (kind, name, brand, select) => <button key={kind} type="button" className="cmd-provider-choice" onClick={() => {
    setQuery('');
    onSelect(select());
  }}>
    <ProviderBrandIcon id={brand} name={name} size={22} />
    <span>{name}</span>
  </button>;

  return <>
    <header className="cmd-provider-add-heading">
      <h3>添加供应商</h3>
      <button className="cmd-provider-add-close" type="button" aria-label="关闭添加供应商" disabled={busy} onClick={onClose}>
        <UIIcon name="close" size={17} />
      </button>
    </header>
    {selection ? <>
      <div className="cmd-provider-add-selection">
        <ProviderBrandIcon id={selection.id} name={selection.name} size={22} />
        <span tabIndex={-1} ref={focusTarget}>{selection.name}</span>
        <button type="button" onClick={onBack} disabled={busy}>更换厂商</button>
      </div>
      {children}
    </> : <>
      <label className="cmd-provider-search">
        <UIIcon name="search" size={16} />
        <input ref={focusTarget} type="search" aria-label="搜索厂商" placeholder="搜索厂商" value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      {(router || templates.length > 0 || custom) && <div className="cmd-provider-choices" role="group" aria-label="厂商模板">
        {router && tile(routerGo.id, routerGo.name, routerGo.id, () => ({ type: 'routergo', ...routerGo, id: routerGoConnectionId() }))}
        {templates.map(template => tile(template.kind, template.name, template.brand, () => ({
          type: 'template', id: templateProviderId(template.kind), name: template.name, template,
        })))}
        {custom && tile('custom', '自定义供应商', null, () => ({ type: 'custom', id: 'custom', name: '自定义供应商' }))}
      </div>}
      {!router && !templates.length && !custom && <div className="cmd-provider-no-results" role="status">
        <UIIcon name="search" size={20} />
        <strong>没有匹配的厂商</strong>
        <span>试试厂商名称或平台简称。</span>
      </div>}
    </>}
  </>;
}
