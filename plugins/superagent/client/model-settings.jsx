import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Switch, Tooltip, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
import { auxiliaryCapabilities, auxiliaryModelPatch, auxiliaryCapabilityPatch, validateModelSettings } from './model-settings.mjs';
import css from './model-settings.css';
import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import { Tooltip as Hint } from '../../shared/client/ui/tooltip.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';

function InfoIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></svg>; }

export function ModelSettings({ config, onChange, ModelFields, IconButton, validationError }) {
  const primaryModels = config.models || [];
  const workerModels = config.workerModels || [];
  const [expanded, setExpanded] = useState({ router: true, worker: false, auxiliary: false });
  const [catalogErrors, setCatalogErrors] = useState({}), [details, setDetails] = useState(null), [copied, setCopied] = useState(''), [copyError, setCopyError] = useState('');
  const root = useRef(null), keys = useRef(new WeakMap()), serial = useRef(0), callbacks = useRef(new Map()), focus = useRef(null), copyTimer = useRef(null);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  useLayoutEffect(() => {
    if (!focus.current) return;
    const row = root.current?.querySelector(`[data-model-row="${focus.current.key}"]`);
    const button = row?.querySelector(`[aria-label="${focus.current.label}"]:not(:disabled)`) || row?.querySelector('.ba-row-actions button[aria-label="提高优先级"]:not(:disabled),.ba-row-actions button[aria-label="降低优先级"]:not(:disabled)');
    button?.focus({ preventScroll: true }); focus.current = null;
  }, [primaryModels, workerModels, config.auxiliary?.models]);
  const keyFor = (model, role) => {
    if (!keys.current.has(model)) keys.current.set(model, `${role}-${++serial.current}`);
    return keys.current.get(model);
  };
  const statusFor = key => {
    if (!callbacks.current.has(key)) callbacks.current.set(key, status => {
      setCatalogErrors(value => (value[key] || '') === (status.error || '') ? value : { ...value, [key]: status.error || '' });
      if (status.error) setExpanded(value => ({ ...value, [key.split('-')[0]]: true }));
    });
    return callbacks.current.get(key);
  };
  async function copy(value, id) {
    setCopyError(''); setCopied(''); clearTimeout(copyTimer.current);
    try {
      if (!await writeClipboard(value)) throw Error('复制失败，请选择下方完整 ID 手动复制。');
      setCopied(id); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(''), 1600);
    } catch (cause) { setCopyError(cause.message || '复制失败，请选择完整 ID 手动复制。'); }
  }
  function queue(models, update, role) {
    const move = (index, offset) => {
      focus.current = { key: keyFor(models[index], role), label: offset < 0 ? '提高优先级' : '降低优先级' };
      const next = [...models]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; update(next);
    };
    return <div className="ba-stack">{models.map((model, index) => {
      const key = keyFor(model, role);
      return <article className="ba-model-card" data-model-row={key} aria-label={`${role === 'router' ? 'Router' : role === 'worker' ? 'Worker' : '辅助'}${index ? '备用 ' + index : '首选'}模型`} key={key}>
      <div className="ba-model-priority"><span className="ba-model-order" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><strong>{index ? '备用 ' + index : '首选'}</strong><span className="ba-model-status">{model.providerId && model.modelId ? '已填写' : '待完善'}</span></div>
      <div className="ba-model-inputs"><ModelFields value={model} onStatusChange={statusFor(key)} onChange={next => { keys.current.set(next, key); update(models.map((item, at) => at === index ? next : item)); }} /></div><div className="ba-row-actions">
        <IconButton icon="more" label={details === key ? '收起完整 ID' : '查看完整 ID'} aria-expanded={details === key} aria-controls={`ba-model-ids-${key}`} onClick={() => { setDetails(details === key ? null : key); setCopyError(''); }} />
        <IconButton icon="arrow-up" label="提高优先级" disabled={!index} onClick={() => move(index, -1)} />
        <IconButton icon="arrow-down" label="降低优先级" disabled={index === models.length - 1} onClick={() => move(index, 1)} />
        <IconButton icon="trash" label="移除模型" onClick={() => update(models.filter((_, at) => at !== index))} />
      </div>
      {details === key && <div className="ba-model-ids" id={`ba-model-ids-${key}`}>
        {[['providerId', '供应商 ID'], ['modelId', '模型 ID']].map(([field, label]) => <div key={field}><span>{label}</span><code tabIndex={0}>{model[field] || '未填写'}</code><Tooltip label={copied === `${key}-${field}` ? '已复制' : `复制${label}`} delayMs={250} portal><Button variant="ghost" size="icon" disabled={!model[field]} aria-label={`复制${label}`} onClick={() => copy(model[field], `${key}-${field}`)}><UIIcon name={copied === `${key}-${field}` ? 'check' : 'copy'} size={16} /></Button></Tooltip></div>)}
        {copyError && <p className="ba-model-copy-error" role="alert">{copyError}</p>}
        {copied.startsWith(`${key}-`) && <span className="ba-model-copy-status" role="status">已复制完整 ID</span>}
      </div>}
    </article>; })}</div>;
  }
  const auxiliary = config.auxiliary, models = auxiliary?.models || [];
  const updateAuxiliary = next => onChange(auxiliaryModelPatch(auxiliary, next));
  const summary = items => items[0]?.modelId ? `${items[0].providerId || '未选择供应商'} / ${items[0].modelId}${items.length > 1 ? ` · ${items.length - 1} 个备用` : ''}` : '尚未配置首选模型';
  const issues = Object.fromEntries([['router', primaryModels], ['worker', workerModels], ['auxiliary', models]].map(([role, items]) => [role, validateModelSettings({ [role === 'router' ? 'models' : role === 'worker' ? 'workerModels' : 'auxiliary']: role === 'auxiliary' ? { models: items } : items })?.message || '']));
  useEffect(() => {
    const affected = ['router', 'worker', 'auxiliary'].filter(role => issues[role] || validationError?.role === role);
    if (affected.length) setExpanded(value => affected.every(role => value[role]) ? value : { ...value, ...Object.fromEntries(affected.map(role => [role, true])) });
  }, [issues.router, issues.worker, issues.auxiliary, validationError?.role]);
  const hasCatalogError = (items, role) => items.some(model => catalogErrors[keyFor(model, role)]);
  const isOpen = (role, items) => expanded[role] || !!issues[role] || validationError?.role === role || hasCatalogError(items, role);
  const description = (items, role) => issues[role] ? '配置待完善，请补全下方项目' : hasCatalogError(items, role) ? '模型目录读取失败，可重试或手填完整 ID' : items.length ? summary(items) : role === 'router' ? '尚未配置首选模型' : '跟随身份模型 Router';
  const title = (label, icon, role) => <span className="ba-model-section-title"><UIIcon name={icon} size={18} />{label}{role !== 'router' && <span className="ba-model-optional">可选</span>}</span>;
  const issue = role => issues[role] && <p className="ba-model-validation" role="alert">{issues[role]}</p>;
  return <div className="ba-model-settings" ref={root}><style>{css}</style>
    <Disclosure className="ba-model-section" open={isOpen('router', primaryModels)} onOpenChange={open => setExpanded(value => ({ ...value, router: open }))} title={title('身份模型 Router', 'atom', 'router')} description={description(primaryModels, 'router')}><section aria-label="身份模型 Router 配置"><div className="ba-group-head"><p>负责对话与调度，按顺序尝试首选和备用。</p><Button variant="ghost" size="sm" type="button" onClick={() => onChange({ models: [...primaryModels, { providerId: '', modelId: '' }] })}><UIIcon name="plus" size={16} />添加模型</Button></div>
      {!primaryModels.length && <div className="ba-model-empty"><UIIcon name="atom" size={28} /><strong>为助手选择一个模型</strong><p>添加首选文本模型后，即可开始对话。</p></div>}
      {queue(primaryModels, next => onChange({ models: next }), 'router')}{issue('router')}
      <p className="ba-model-footnote"><InfoIcon /><span>保存后用于后续请求；会话中手动选择的模型优先。</span></p>
    </section></Disclosure>
    <Disclosure className="ba-model-section" open={isOpen('worker', workerModels)} onOpenChange={open => setExpanded(value => ({ ...value, worker: open }))} title={title('工作模型 Worker', 'cpu', 'worker')} description={description(workerModels, 'worker')}><section aria-label="工作模型 Worker 配置"><div className="ba-group-head"><p>{workerModels.length ? '负责任务执行，可独立设置模型顺序。' : '当前跟随 Router，可单独配置执行模型。'}</p><Button variant="ghost" size="sm" type="button" onClick={() => onChange({ workerModels: [...workerModels, { providerId: '', modelId: '' }] })}><UIIcon name="plus" size={16} />{workerModels.length ? '添加备用' : '配置工作模型'}</Button></div>
      {queue(workerModels, next => onChange({ workerModels: next }), 'worker')}{issue('worker')}
      {!!workerModels.length && <p className="ba-model-footnote"><InfoIcon /><span>用于新建执行；已有执行保留原模型队列。移除全部后恢复跟随 Router。</span></p>}
    </section></Disclosure>
    <Disclosure className="ba-model-section" open={isOpen('auxiliary', models)} onOpenChange={open => setExpanded(value => ({ ...value, auxiliary: open }))} title={title('辅助模型', 'bulb', 'auxiliary')} description={description(models, 'auxiliary')}><section aria-label="辅助模型配置"><div className="ba-group-head"><p>{models.length ? '按用途处理看图、压缩、总结与复盘。' : '当前由 Router 处理，可按用途配置辅助模型。'}</p><Button variant="ghost" size="sm" type="button" onClick={() => updateAuxiliary([...models, { providerId: '', modelId: '' }])}><UIIcon name="plus" size={16} />{models.length ? '添加备用' : '配置辅助模型'}</Button></div>
      {queue(models, updateAuxiliary, 'auxiliary')}{issue('auxiliary')}
      {!!models.length && <><fieldset className="ba-auxiliary-uses"><legend>交给辅助模型的用途</legend><div className="ba-auxiliary-grid">{auxiliaryCapabilities.map(([key, label, description]) => {
        const checked = !!auxiliary?.capabilities?.includes(key);
        const route = checked && models[0]?.providerId && models[0]?.modelId ? `${models[0].providerId} / ${models[0].modelId}` : '跟随 Router';
        return <div className="ba-auxiliary-use" key={key}><span><strong>{label}<Hint label={`首选：${route}`} portal><small tabIndex={0} className="ba-auxiliary-route" data-auxiliary={!!(checked && models[0]?.providerId && models[0]?.modelId)}>{route === '跟随 Router' ? route : '辅助模型'}</small></Hint></strong><small>{description}</small></span><Hint label={issues.auxiliary ? '请先补全辅助模型' : ''} portal><span style={{ display: 'inline-flex', flex: 'none' }} tabIndex={issues.auxiliary ? 0 : undefined}><Switch label={label} disabled={!!issues.auxiliary} checked={checked} onChange={enabled => onChange(auxiliaryCapabilityPatch(auxiliary, key, enabled))} /></span></Hint></div>;
      })}</div></fieldset>
      <p className="ba-model-footnote"><InfoIcon /><span>开启用途不会赋予额外能力，不支持的请求会明确报错。辅助模型不可用时尝试备用，再回 Router。绘画使用独立的图像生成配置。</span></p></>}
    </section></Disclosure>
  </div>;
}
