import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../shared/client/ui/index.jsx';
import { readJsonResponse } from './http-response.mjs';
import css from './efficiency-settings.css';

const descriptions = {
  ops: { title: '执行工具', text: '按需提供原生文件与批处理工具，复用官方 Harness 的工具权限。', detail: '保留现有 Shell 与工具；外部 Codex、Claude Code 等仍使用各自的执行能力。' },
  compaction: { title: '上下文管理', text: '让 Agent 查询真实上下文用量，并在合适时机主动压缩。', detail: '复用官方摘要与辅助模型配置；不启用额外的自动压缩阈值。' },
};
const states = { disabled: '已关闭', waiting_services: '等待宿主服务', loading: '正在加载', unavailable: '暂不可用', error: '加载失败', ready: '可用', active: '可用' };
async function request(body, signal) {
  const url = new URL('api/benchgo/efficiency', document.baseURI);
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch(url, { credentials: 'same-origin', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  return readJsonResponse(response, url);
}

export function EfficiencySettings({ read = request }) {
  const [value, setValue] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(''), [notice, setNotice] = useState('');
  const lifetime = useRef(null), saving = useRef(false);
  const refresh = async signal => {
    try { const next = await read(undefined, signal); if (!signal?.aborted) { setValue(current => current?.revision > next.revision ? current : next); setError(''); } }
    catch (failure) { if (!signal?.aborted) setError(failure.message); }
  };
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void refresh(controller.signal);
    // Mounting external services can finish after a configuration receipt.
    const timer = setInterval(() => { if (!document.hidden && !saving.current) void refresh(controller.signal); }, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [read]);
  const update = async (name, enabled) => {
    if (saving.current || !value) return;
    saving.current = true; setBusy(name); setError(''); setNotice('');
    try {
      const next = await read({ revision: value.revision, features: { [name]: { enabled } } }, lifetime.current?.signal);
      if (!lifetime.current?.signal.aborted) { setValue(next); setNotice('设置已保存'); }
    } catch (failure) { if (!lifetime.current?.signal.aborted) { setError(failure.message); await refresh(lifetime.current?.signal); setError(failure.message); } }
    finally { saving.current = false; if (!lifetime.current?.signal.aborted) setBusy(''); }
  };
  return <section className="cmd-efficiency" aria-label="执行增强">
    <h2>执行增强</h2>
    <p className="cmd-efficiency-intro">为官方 Harness 会话提供工具与上下文能力，设置保存后即时生效。</p>
    {error && <div className="cmd-efficiency-error" role="alert"><span>{error}</span><Button variant="outline" size="sm" disabled={!!busy} onClick={() => refresh(lifetime.current?.signal)}>重试</Button></div>}
    {!value && !error && <p role="status">正在读取执行能力…</p>}
    {value && !value.features && <p role="status">宿主尚未提供执行增强状态。</p>}
    {value?.features && Object.entries(descriptions).map(([name, item]) => {
      const feature = value.features[name];
      if (!feature) return <div className="cmd-efficiency-feature" key={name}><h3>{item.title}</h3><p>此版本暂未提供该能力。</p></div>;
      const status = feature.available ? '可用' : feature.enabled ? states[feature.state] || '暂不可用' : '已关闭';
      return <div className="cmd-efficiency-feature" key={name}>
        <div className="cmd-efficiency-heading"><h3>{item.title}</h3><span className="cmd-efficiency-status" data-available={feature.available === true}>{status}</span>
          <label className="cmd-efficiency-toggle"><input type="checkbox" role="switch" aria-label={`启用${item.title}`} checked={!!feature.enabled} disabled={!!busy} onChange={event => void update(name, event.target.checked)} /><span>{busy === name ? '保存中…' : feature.enabled ? '开启' : '关闭'}</span></label>
        </div>
        <p>{item.text}</p><p className="cmd-efficiency-detail">{item.detail}</p>
        {feature.error && <p role="alert" className="cmd-efficiency-error">{typeof feature.error === 'string' ? feature.error : feature.error.message || '加载失败，请重试。'}</p>}
      </div>;
    })}
    <p role="status" aria-live="polite" className="cmd-efficiency-notice">{notice}</p>
  </section>;
}

export function mountEfficiencySettings(ctx) {
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  ctx.effect(() => () => style.remove());
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'benchgo-efficiency', order: 34, label: () => '执行增强' }, EfficiencySettings));
}
