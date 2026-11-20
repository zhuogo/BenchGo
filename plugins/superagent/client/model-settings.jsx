import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import { auxiliaryCapabilities, auxiliaryModelPatch, auxiliaryCapabilityPatch, validateModelSettings } from './model-settings.mjs';
import css from './model-settings.css';
import effortCss from '../../base/client/model-effort-slider.css';
import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import { Tooltip as Hint } from '../../shared/client/ui/tooltip.jsx';
import { UIIcon } from '../../base/client/iconsax.jsx';

function InfoIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></svg>; }

function settleModelRows(positions) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const moves = positions.map(([row, top]) => [row, top - row.getBoundingClientRect().top]);
  for (const [row, offset] of moves) {
    if (row.isConnected && Math.abs(offset) >= 1) row.animate([{ transform: `translateY(${offset}px)` }, { transform: 'none' }], {
      duration: 180, easing: 'cubic-bezier(.23,1,.32,1)',
    });
  }
}

export function ModelSettings({ config, onChange, ModelFields, IconButton, validationError }) {
  const primaryModels = config.models || [];
  const workerModels = config.workerModels || [];
  const externalWorker = ['codex', 'claude'].includes(config.workerHarness);
  const [expanded, setExpanded] = useState({ router: true, worker: false, auxiliary: false });
  const [announcement, setAnnouncement] = useState('');
  const root = useRef(null), keys = useRef(new WeakMap()), serial = useRef(0);
  const drag = useRef(null), focus = useRef(null), settling = useRef(null);
  useLayoutEffect(() => {
    if (focus.current) {
      root.current?.querySelector(`[data-model-row="${focus.current}"] .ba-model-handle`)?.focus({ preventScroll: true });
      focus.current = null;
    }
    if (settling.current) {
      settleModelRows(settling.current);
      settling.current = null;
    }
  }, [primaryModels, workerModels, config.auxiliary?.models]);
  useLayoutEffect(() => () => finishDrag(false, false), []);
  const keyFor = (model, role) => {
    if (!keys.current.has(model)) keys.current.set(model, `${role}-${++serial.current}`);
    return keys.current.get(model);
  };
  function positionDrag(state) {
    const { rows, index, startY, pointerY, list, listTop } = state;
    const active = rows[index];
    const delta = pointerY - startY + listTop - list.getBoundingClientRect().top;
    const center = active.center + delta;
    let target = index;
    while (target > 0 && center < rows[target - 1].center) target--;
    while (target < rows.length - 1 && center > rows[target + 1].center) target++;
    active.node.style.transform = `translateY(${delta}px)`;
    if (target === state.target) return;
    state.target = target;
    rows.forEach(({ node }, at) => {
      if (at === index) return;
      const offset = target > index && at > index && at <= target ? -active.height
        : target < index && at >= target && at < index ? active.height : 0;
      node.style.transform = offset ? `translateY(${offset}px)` : '';
    });
  }
  function scrollWhileDragging(state) {
    if (!state.scroller) return;
    const top = Math.max(state.scroller.getBoundingClientRect().top, 0);
    const bottom = Math.min(state.scroller.getBoundingClientRect().bottom, window.innerHeight);
    const edge = 44;
    const pressure = state.pointerY < top + edge ? state.pointerY - top - edge
      : state.pointerY > bottom - edge ? state.pointerY - bottom + edge : 0;
    if (!pressure) return;
    const before = state.scroller.scrollTop;
    state.scroller.scrollTop += Math.sign(pressure) * Math.min(16, Math.max(2, Math.abs(pressure) / 3));
    if (before !== state.scroller.scrollTop) {
      positionDrag(state);
      state.frame = requestAnimationFrame(() => scrollWhileDragging(state));
    }
  }
  function startDrag(event, index, move) {
    if (!event.isPrimary || event.button !== 0 || drag.current) return;
    const handle = event.currentTarget, card = handle.closest('[data-model-row]'), list = card.parentElement;
    const nodes = Array.from(list.children);
    const visualTop = card.getBoundingClientRect().top;
    for (const node of nodes) node.getAnimations().forEach(animation => animation.cancel());
    const rows = nodes.map(node => {
      const { top, height } = node.getBoundingClientRect();
      return { node, top, height, center: top + height / 2 };
    });
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    drag.current = { handle, pointer: event.pointerId, rows, list, listTop: list.getBoundingClientRect().top,
      scroller: list.closest('.ba-studio-body'), index, target: index, move,
      startY: event.clientY - visualTop + rows[index].top, pointerY: event.clientY, frame: 0 };
    card.dataset.dragging = 'true';
    list.dataset.sorting = 'true';
    positionDrag(drag.current);
  }
  function moveDrag(event) {
    const state = drag.current;
    if (state?.pointer !== event.pointerId) return;
    state.pointerY = event.clientY;
    positionDrag(state);
    cancelAnimationFrame(state.frame);
    state.frame = requestAnimationFrame(() => scrollWhileDragging(state));
  }
  function finishDrag(commit, animate = true) {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    cancelAnimationFrame(state.frame);
    const { rows, index, target, handle, pointer, list } = state;
    const positions = animate ? rows.map(({ node }) => [node, node.getBoundingClientRect().top]) : [];
    delete list.dataset.sorting;
    delete rows[index].node.dataset.dragging;
    for (const { node } of rows) node.style.transform = '';
    if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
    if (commit && target !== index) {
      settling.current = positions;
      state.move(index, target);
    } else if (animate) settleModelRows(positions);
  }
  function queue(models, update, role) {
    const roleLabel = role === 'router' ? 'Router' : role === 'worker' ? 'Worker' : '辅助';
    const priority = index => index ? `备用 ${index}` : '首选';
    const move = (index, target) => {
      if (target < 0 || target >= models.length || index === target) return;
      focus.current = keyFor(models[index], role);
      const next = [...models];
      next.splice(target, 0, next.splice(index, 1)[0]);
      setAnnouncement(`${roleLabel} 模型已移动到第 ${target + 1} 项，${priority(target)}`);
      update(next);
    };
    const sortable = models.length > 1;
    return <div className="ba-stack">{models.map((model, index) => {
      const key = keyFor(model, role);
      const label = `${roleLabel}${priority(index)}模型`;
      const order = <span className="ba-model-order" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>;
      return <article className="ba-model-card" data-model-row={key} aria-label={label} key={key} onLostPointerCapture={event => {
        if (drag.current?.pointer === event.pointerId) finishDrag(false);
      }}>
      <div className="ba-model-priority">{sortable ? <Button variant="ghost" className="ba-model-handle" aria-label={`调整模型优先级 · ${label}`} aria-keyshortcuts="ArrowUp ArrowDown" title="拖动排序，也可用上下方向键" onPointerDown={event => startDrag(event, index, move)} onPointerMove={moveDrag} onPointerUp={event => {
        if (drag.current?.pointer !== event.pointerId) return;
        moveDrag(event);
        finishDrag(true);
      }} onPointerCancel={event => { if (drag.current?.pointer === event.pointerId) finishDrag(false); }} onKeyDown={event => {
        if (event.key === 'Escape' && drag.current) {
          event.preventDefault(); event.stopPropagation(); finishDrag(false);
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          if (!drag.current) move(index, index + (event.key === 'ArrowUp' ? -1 : 1));
        }
      }}><span className="ba-model-grip" aria-hidden="true" />{order}</Button> : order}<strong>{priority(index)}</strong><span className="ba-model-status">{model.providerId && model.modelId ? '已填写' : '待完善'}</span></div>
      <div className="ba-model-inputs"><ModelFields value={model} harness={role === 'worker' ? config.workerHarness || 'official' : 'official'}
        canChangeHarness={role === 'worker' && index === 0} onChange={(next, harness) => {
          keys.current.set(next, key);
          if (role === 'worker' && harness !== (config.workerHarness || 'official')) onChange({ workerHarness: harness, workerModels: [next] });
          else update(models.map((item, at) => at === index ? next : item));
        }} /></div><div className="ba-row-actions">
        <IconButton icon="trash" label="移除模型" onClick={() => update(models.filter((_, at) => at !== index))} />
      </div>
    </article>; })}</div>;
  }
  const auxiliary = config.auxiliary, models = auxiliary?.models || [];
  const updateAuxiliary = next => onChange(auxiliaryModelPatch(auxiliary, next));
  const summary = items => items[0]?.modelId ? `${items[0].providerId || '未选择供应商'} / ${items[0].modelId}${items.length > 1 ? ` · ${items.length - 1} 个备用` : ''}` : '尚无首选模型';
  const issues = Object.fromEntries([['router', primaryModels], ['worker', workerModels], ['auxiliary', models]].map(([role, items]) => [role, validateModelSettings({ ...(role === 'worker' ? { workerHarness: config.workerHarness || 'official' } : {}), [role === 'router' ? 'models' : role === 'worker' ? 'workerModels' : 'auxiliary']: role === 'auxiliary' ? { models: items } : items })?.message || '']));
  useEffect(() => {
    const affected = ['router', 'worker', 'auxiliary'].filter(role => issues[role] || validationError?.role === role);
    if (affected.length) setExpanded(value => affected.every(role => value[role]) ? value : { ...value, ...Object.fromEntries(affected.map(role => [role, true])) });
  }, [issues.router, issues.worker, issues.auxiliary, validationError?.role]);
  const isOpen = role => expanded[role] || !!issues[role] || validationError?.role === role;
  const description = (items, role) => issues[role] ? '配置待完善，请补全下方项目' : !items.length && role !== 'router' ? '跟随身份模型 Router' : summary(items);
  const title = (label, icon, role) => <span className="ba-model-section-title"><UIIcon name={icon} size={18} />{label}{role !== 'router' && <span className="ba-model-optional">可选</span>}</span>;
  const issue = role => issues[role] && <p className="ba-model-validation" role="alert">{issues[role]}</p>;
  return <div className="ba-model-settings" ref={root}><style>{css + effortCss}</style><span className="ba-model-announcement" role="status">{announcement}</span>
    <Disclosure className="ba-model-section" open={isOpen('router', primaryModels)} onOpenChange={open => setExpanded(value => ({ ...value, router: open }))} title={title('身份模型 Router', 'atom', 'router')} description={description(primaryModels, 'router')}><section aria-label="身份模型 Router 配置"><div className="ba-group-head"><p>负责对话与调度，按顺序尝试首选和备用。</p><Button variant="ghost" size="sm" type="button" onClick={() => onChange({ models: [...primaryModels, { providerId: '', modelId: '' }] })}><UIIcon name="plus" size={16} />添加模型</Button></div>
      {!primaryModels.length && <div className="ba-model-empty"><UIIcon name="atom" size={28} /><strong>为助手选择一个模型</strong><p>添加首选文本模型后，即可开始对话。</p></div>}
      {queue(primaryModels, next => onChange({ models: next }), 'router')}{issue('router')}
      <p className="ba-model-footnote"><InfoIcon /><span>保存后用于后续请求；会话中手动选择的模型优先。</span></p>
    </section></Disclosure>
    <Disclosure className="ba-model-section" open={isOpen('worker', workerModels)} onOpenChange={open => setExpanded(value => ({ ...value, worker: open }))} title={title('工作模型 Worker', 'cpu', 'worker')} description={description(workerModels, 'worker')}><section aria-label="工作模型 Worker 配置"><div className="ba-group-head"><p>{workerModels.length ? '用于新建任务执行；已有执行按冻结配置继续。' : externalWorker ? '外部 Harness 需要配置一个兼容的 API 模型。' : '当前跟随 Router 的首选和备用模型。'}</p><Button variant="ghost" size="sm" type="button" disabled={externalWorker && workerModels.length > 0} onClick={() => onChange({ workerModels: [...workerModels, { providerId: '', modelId: '' }] })}><UIIcon name="plus" size={16} />{workerModels.length ? '添加备用' : '配置工作模型'}</Button></div>
      {queue(workerModels, next => onChange({ workerModels: next }), 'worker')}{issue('worker')}
      {!!workerModels.length && <p className="ba-model-footnote"><InfoIcon /><span>已有执行保留创建时的 Harness 和模型。Router 与辅助模型始终使用官方 Harness。</span></p>}
    </section></Disclosure>
    <Disclosure className="ba-model-section" open={isOpen('auxiliary', models)} onOpenChange={open => setExpanded(value => ({ ...value, auxiliary: open }))} title={title('辅助模型', 'bulb', 'auxiliary')} description={description(models, 'auxiliary')}><section aria-label="辅助模型配置"><div className="ba-group-head"><p>{models.length ? '未开启的用途跟随 Router。' : '当前各用途跟随 Router。'}</p><Button variant="ghost" size="sm" type="button" onClick={() => updateAuxiliary([...models, { providerId: '', modelId: '' }])}><UIIcon name="plus" size={16} />{models.length ? '添加备用' : '配置辅助模型'}</Button></div>
      {queue(models, updateAuxiliary, 'auxiliary')}{issue('auxiliary')}
      {!!models.length && <><fieldset className="ba-auxiliary-uses"><legend>交给辅助模型的用途</legend><div className="ba-auxiliary-grid">{auxiliaryCapabilities.map(([key, label, description]) => {
        const checked = !!auxiliary?.capabilities?.includes(key);
        const route = checked && models[0]?.providerId && models[0]?.modelId ? `${models[0].providerId} / ${models[0].modelId}` : '跟随 Router';
        return <div className="ba-auxiliary-use" key={key}><span><strong>{label}<Hint label={`首选：${route}`} portal><small tabIndex={0} className="ba-auxiliary-route" data-auxiliary={!!(checked && models[0]?.providerId && models[0]?.modelId)}>{route === '跟随 Router' ? route : '辅助模型'}</small></Hint></strong><small>{description}</small></span><Hint label={issues.auxiliary ? '请先补全辅助模型' : ''} portal><span style={{ display: 'inline-flex', flex: 'none' }} tabIndex={issues.auxiliary ? 0 : undefined}><Switch label={label} disabled={!!issues.auxiliary} checked={checked} onChange={enabled => onChange(auxiliaryCapabilityPatch(auxiliary, key, enabled))} /></span></Hint></div>;
      })}</div></fieldset>
      <p className="ba-model-footnote"><InfoIcon /><span>不支持的请求会明确报错。执行进展摘要启用专用模型后仅使用辅助队列。绘画使用独立的图像生成配置。</span></p></>}
    </section></Disclosure>
  </div>;
}
