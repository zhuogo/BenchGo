import React, { useState } from 'react';
import { Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { ModelsSection } from '../../../deepseek-harness/packages/client/ui-settings-models/src/client/ModelsSection.tsx';
import { mountOfficialModelsStyle } from '../../../deepseek-harness/packages/client/ui-settings-models/src/client/ModelsSection.module.css';
import { adaptProviderStore } from './provider-store.mjs';
import { UIIcon } from './iconsax.jsx';
import { ProviderBrandIcon } from './provider-brand-icon.jsx';
import { isRouterGo, prioritizeRouterGo } from './provider-options.mjs';
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
import { routerGo } from '../shared/builtin-providers.mjs';
export { routerGo } from '../shared/builtin-providers.mjs';

/** Receives official addable rows; selection returns to the official draft. */
export function ProviderSelect({ value, options, disabled, label, customEnabled, taken = [], onChange, onPreset }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const current = isRouterGo(value) ? routerGo : value === '__custom' ? { name: '自定义供应商' } : options.find(option => option.id === value);
  const routerAvailable = customEnabled && !taken.includes(routerGo.id);
  const entries = prioritizeRouterGo([
    ...options.map(option => ({ ...option, ...(isRouterGo(option.id) ? { name: routerGo.name } : {}), preset: false })),
    ...(customEnabled ? [{ id: '__custom', name: '自定义供应商', preset: true }] : []),
  ].sort((a, b) => a.name.localeCompare(b.name, 'zh')), { ...routerGo, preset: true, disabled: !routerAvailable, reason: customEnabled ? '当前不可编辑' : '当前无法配置自定义供应商' });
  const matches = entries.filter(entry => isRouterGo(entry.id) || (entry.name + ' ' + entry.id).toLowerCase().includes(query.trim().toLowerCase()));
  const close = () => { setOpen(false); setQuery(''); };
  return <>
    <button type="button" className="cmd-provider-select" disabled={disabled} aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><ProviderBrandIcon id={current?.id} name={current?.name} declared={current?.declared} /><span>{current?.name || label}</span><UIIcon name="chevronDown" size={14} /></button>
    <Modal open={open} onClose={close} title={label} closeLabel="关闭" className="cmd-provider-dialog" contentClassName="cmd-provider-content">
      <label className="cmd-provider-search"><UIIcon name="search" size={16} /><input data-modal-autofocus aria-label="搜索供应商" placeholder="搜索供应商" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="cmd-provider-grid">{matches.map(entry => <button key={entry.id} type="button" className="cmd-provider-card" disabled={entry.disabled} aria-pressed={value === entry.id} onClick={() => { close(); if (entry.preset) onPreset(isRouterGo(entry.id) ? routerGo : undefined); else onChange(entry.id); }}><ProviderBrandIcon id={entry.id} name={entry.name} declared={entry.declared} /><span>{entry.name}{entry.disabled && <small>{entry.reason}</small>}</span>{value === entry.id ? <UIIcon name="check" size={16} /> : <UIIcon name="chevronDown" size={14} />}</button>)}</div>
    </Modal>
  </>;
}
