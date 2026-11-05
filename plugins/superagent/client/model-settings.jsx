import React from 'react';
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import { auxiliaryCapabilities, auxiliaryModelPatch, auxiliaryCapabilityPatch } from './model-settings.mjs';
import css from './model-settings.css';
import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';

function InfoIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></svg>; }

export function ModelSettings({ config, onChange, ModelFields, IconButton }) {
  const primaryModels = config.models || [];
  function queue(models, update, auxiliary = false) {
    const move = (index, offset) => { const next = [...models]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; update(next); };
    return <div className="ba-stack">{models.map((model, index) => <article className="ba-surface ba-model-card" key={index}>
      <div className="ba-model-meta"><span className="ba-model-priority"><span className="ba-model-order" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><strong>{index ? '备用 ' + index : auxiliary ? '辅助首选' : '主模型首选'}</strong><span className="ba-model-status" data-configured={!!(model.providerId && model.modelId)}>{model.providerId && model.modelId ? '已填写' : '待完善'}</span></span><div className="ba-row-actions">
        <IconButton icon="arrow-up" label="提高优先级" disabled={!index} onClick={() => move(index, -1)} />
        <IconButton icon="arrow-down" label="降低优先级" disabled={index === models.length - 1} onClick={() => move(index, 1)} />
        <IconButton icon="trash" label="移除模型" onClick={() => update(models.filter((_, at) => at !== index))} />
      </div></div><ModelFields value={model} onChange={next => update(models.map((item, at) => at === index ? next : item))} />
    </article>)}</div>;
  }
  const auxiliary = config.auxiliary, models = auxiliary?.models || [];
  const updateAuxiliary = next => onChange(auxiliaryModelPatch(auxiliary, next));
  const summary = items => items[0]?.modelId ? `${items[0].providerId || '未选择供应商'} / ${items[0].modelId}${items.length > 1 ? ` · ${items.length - 1} 个备用` : ''}` : '尚未配置首选模型';
  return <div className="ba-model-settings"><style>{css}</style>
    <Disclosure className="ba-model-section" defaultOpen title={<span className="ba-model-section-title"><UIIcon name="atom" size={18} />主模型</span>} description={summary(primaryModels)}><section aria-label="主模型配置"><div className="ba-group-head"><div><h3>首选与备用</h3><p>按排列顺序使用，首选不可用时尝试备用。</p></div><Button variant="secondary" type="button" onClick={() => onChange({ models: [...primaryModels, { providerId: '', modelId: '' }] })}><UIIcon name="plus" size={16} />添加模型</Button></div>
      {!primaryModels.length && <div className="ba-model-empty"><UIIcon name="atom" size={28} /><strong>为助手选择一个模型</strong><p>添加首选文本模型后，即可开始对话。</p></div>}
      {queue(primaryModels, next => onChange({ models: next }))}
      <p className="ba-model-footnote"><InfoIcon /><span>保存后用于后续请求；会话中手动选择的模型优先。</span></p>
    </section></Disclosure>
    <Disclosure className="ba-model-section" defaultOpen title={<span className="ba-model-section-title"><UIIcon name="bulb" size={18} />辅助模型<span className="ba-model-optional">可选</span></span>} description={models.length ? summary(models) : '未配置时跟随主模型'}><section aria-label="辅助模型配置"><div className="ba-group-head"><div><h3>理解与整理</h3><p>将看图、压缩、总结与复盘交给合适的模型。</p></div><Button variant="secondary" type="button" onClick={() => updateAuxiliary([...models, { providerId: '', modelId: '' }])}><UIIcon name="plus" size={16} />{models.length ? '添加备用' : '配置辅助模型'}</Button></div>
      {!models.length && <div className="ba-model-empty ba-model-empty-compact"><UIIcon name="bulb" size={24} /><strong>当前由主模型处理</strong><p>配置辅助模型后，可以为下方用途单独开启。</p></div>}
      {queue(models, updateAuxiliary, true)}
      <fieldset className="ba-auxiliary-uses"><legend>交给辅助模型的用途</legend>{auxiliaryCapabilities.map(([key, label, description]) => {
        const checked = !!auxiliary?.capabilities?.includes(key);
        const route = checked && models[0]?.providerId && models[0]?.modelId ? `${models[0].providerId} / ${models[0].modelId}` : '跟随当前主模型';
        return <div className="ba-auxiliary-use" key={key}><span><strong>{label}</strong><small>{description}</small><small className="ba-auxiliary-route" data-auxiliary={!!(checked && models[0]?.providerId && models[0]?.modelId)}><i aria-hidden="true" />首选：{route}</small></span><Switch label={label} title={!models.length ? '请先配置辅助模型' : undefined} disabled={!models.length} checked={checked} onChange={enabled => onChange(auxiliaryCapabilityPatch(auxiliary, key, enabled))} /></div>;
      })}</fieldset>
      <p className="ba-model-footnote"><InfoIcon /><span>开启用途不会赋予额外能力，不支持的请求会明确报错。辅助模型不可用时尝试备用，再回主模型。绘画使用独立的图像生成配置。</span></p>
    </section></Disclosure>
  </div>;
}
