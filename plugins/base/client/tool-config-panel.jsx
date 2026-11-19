import React, { useEffect, useState } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { Loading } from '../../shared/client/ui/loading.jsx';
import { readRuntimeSetting, runtimeSettingFields, writeRuntimeSetting } from '../shared/runtime-setting-fields.mjs';
import css from './tool-config-panel.css';

export function mountToolConfigPanelStyle(ctx) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  ctx.effect(() => () => style.remove());
}

const formValue = (config, field) => String(readRuntimeSetting(config, field.path) ?? '');

function settingValue(field, value) {
  if (value === '') return undefined;
  if (field.kind === 'number') return Number(value);
  if (field.kind === 'boolean') return value === 'true';
  return value;
}

function SettingField({ field, value, onChange }) {
  const input = { name: field.key, value, onChange: event => onChange(field, event.target.value) };
  return <label className="cmd-tool-config-field">
    <span>{field.label}</span>
    {field.kind === 'number' ?
      <input {...input} type="number" min={field.min} max={field.max} step={1} placeholder="工具默认" /> :
      <select {...input}>
        <option value="">工具默认</option>
        {Object.entries(field.choices ?? { true: '开启', false: '关闭' }).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>}
  </label>;
}

export function ToolConfigPanel({ tool, onConfig }) {
  const [config, setConfig] = useState(null);
  const [edits, setEdits] = useState({});
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fields = runtimeSettingFields[tool.id];
  const changedFields = Object.keys(edits);

  useEffect(() => {
    if (!fields) return;
    const controller = new AbortController();
    setConfig(null);
    setEdits({});
    setError('');
    setNotice('');
    setLoading(true);
    async function load() {
      try {
        const value = await onConfig('toolConfig', { tool: tool.id }, controller.signal);
        if (!controller.signal.aborted) setConfig(value.config ?? {});
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason.message || '无法读取工具配置。');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [fields, onConfig, revision, tool.id]);

  const change = (field, value) => {
    setEdits(current => {
      const next = { ...current };
      if (value === formValue(config, field)) delete next[field.key];
      else next[field.key] = value;
      return next;
    });
    setError('');
    setNotice('');
  };

  const save = async event => {
    event.preventDefault();
    if (!changedFields.length || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    const next = structuredClone(config);
    for (const field of fields) {
      if (Object.hasOwn(edits, field.key)) writeRuntimeSetting(next, field.path, settingValue(field, edits[field.key]));
    }
    try {
      const value = await onConfig('saveToolConfig', { tool: tool.id, config: next, changedFields });
      setConfig(value.config ?? next);
      setEdits({});
      setNotice('配置已保存');
    } catch (reason) {
      setError(reason.message || '无法保存工具配置。');
    } finally {
      setSaving(false);
    }
  };

  return <section className="cmd-tool-config" aria-label={tool.name + '工具选项'}>
    {!fields ? <p role="status">此工具暂无可配置选项。</p> : loading ? <Loading label="正在读取配置" compact /> : config === null ? <>
      <p className="cmd-tool-error" role="alert">{error}</p>
      <Button type="button" variant="ghost" onClick={() => setRevision(value => value + 1)}>重试</Button>
    </> : <form onSubmit={save}>
      <fieldset disabled={saving} aria-label={tool.name + '配置字段'}>
        {fields.map(field => <SettingField key={field.key} field={field} value={edits[field.key] ?? formValue(config, field)} onChange={change} />)}
      </fieldset>
      {error && <p className="cmd-tool-error" role="alert">{error}</p>}
      <div className="cmd-tool-config-actions">
        {notice && <p className="cmd-tool-config-notice" role="status">{notice}</p>}
        <Button type="submit" disabled={saving || !changedFields.length}>{saving ? '保存中…' : '保存'}</Button>
      </div>
    </form>}
  </section>;
}
