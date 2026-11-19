import React, { useEffect, useState } from 'react';
import { Button } from '../../shared/client/ui/index.jsx';
import { Loading } from '../../shared/client/ui/loading.jsx';
import { modelCapabilityLabels } from '../shared/model-capabilities.mjs';

const providerWrites = new Map();

async function request(action, args, signal) {
  const response = await fetch(new URL('api/commander/tooling', document.baseURI), {
    method: 'POST', credentials: 'same-origin', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...args }),
  });
  const value = await response.json();
  if (!response.ok || !value || typeof value !== 'object') throw Error(value?.error || '无法读取模型能力');
  return value;
}

export function useModelCapabilities(providerId) {
  const [state, setState] = useState(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!providerId) return;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(23000)]);
    Promise.allSettled([
      Promise.allSettled(providerWrites.get(providerId)?.values() ?? [])
        .then(() => request('modelCapabilities', { providerId }, signal)),
      request('models', { providerId }, signal),
    ]).then(([overrides, directory]) => {
      if (abort.signal.aborted) return;
      const saved = overrides.status === 'fulfilled' && Array.isArray(overrides.value.overrides) ? overrides.value.overrides : undefined;
      const models = directory.status === 'fulfilled' && Array.isArray(directory.value.models) ? directory.value.models : undefined;
      setState({
        providerId, revision,
        overrides: new Map(saved?.map(row => [row.modelId, row.capabilities])),
        models: new Map(models?.map(row => [row.id, row])),
        error: saved ? '' : '无法加载已保存的能力标签',
        directoryError: models ? '' : '暂时无法获取供应商能力，可手动选择标签。',
      });
    });
    return () => abort.abort();
  }, [providerId, revision]);
  if (!providerId) return null;
  return {
    current: state?.providerId === providerId ? state : null,
    refreshing: state?.revision !== revision,
    retry: () => setRevision(value => value + 1),
    async save(modelId, capabilities) {
      const writes = providerWrites.get(providerId) ?? new Map();
      providerWrites.set(providerId, writes);
      const write = (writes.get(modelId) ?? Promise.resolve()).catch(() => {}).then(() =>
        request('saveModelCapabilities', { providerId, modelId, capabilities }, AbortSignal.timeout(10000)));
      writes.set(modelId, write);
      const result = await write.finally(() => {
        if (writes.get(modelId) === write) writes.delete(modelId);
        if (!writes.size) providerWrites.delete(providerId);
      });
      setState(value => {
        if (value?.providerId !== providerId) return value;
        const overrides = new Map(value.overrides);
        overrides.set(modelId, result.capabilities);
        return { ...value, overrides };
      });
    },
  };
}

export function ModelCapabilityEditor({ modelId, catalog, disabled, styles }) {
  if (typeof modelId !== 'string' || !modelId.trim() || !catalog) return null;
  const { current, retry, refreshing } = catalog;
  return <fieldset className={styles.modelInputTypes}>
    <legend className={styles.modelFieldLabel}>能力标签</legend>
    {!current ? <Loading compact label="正在加载能力标签…" />
      : current.error ? <div role="alert" className="cmd-model-capability-actions">{current.error}<Button variant="ghost" size="sm" aria-busy={refreshing} disabled={refreshing} onClick={retry}>重试</Button></div>
        : <CapabilityTags key={JSON.stringify([current.providerId, modelId])} modelId={modelId} catalog={catalog} disabled={disabled || refreshing} styles={styles} />}
  </fieldset>;
}

function CapabilityTags({ modelId, catalog, disabled, styles }) {
  const { current, retry, refreshing } = catalog;
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');
  const remote = current.models.get(modelId);
  const inherited = remote?.providerCapabilities ?? remote?.capabilities ?? [];
  const override = current.overrides.get(modelId);
  const selected = draft ?? override ?? inherited;
  const displayed = [...new Set([...Object.keys(modelCapabilityLabels), ...inherited, ...selected])];
  const toggle = async capability => {
    const next = selected.includes(capability) ? selected.filter(item => item !== capability) : [...selected, capability];
    setDraft(next);
    setError('');
    try {
      await catalog.save(modelId, next);
    } catch (error) { setError(error.message); }
    finally { setDraft(null); }
  };
  return <>
    <div className="cmd-model-capabilities" aria-busy={draft !== null}>
      {displayed.map(capability => <Button key={capability} variant="ghost" size="sm" disabled={disabled || draft !== null}
        aria-pressed={selected.includes(capability)} onClick={() => toggle(capability)}>
        {Object.hasOwn(modelCapabilityLabels, capability) ? modelCapabilityLabels[capability] : capability}
      </Button>)}
    </div>
    {current.directoryError && <div className="cmd-model-capability-actions"><span className={styles.advancedHint}>{current.directoryError}</span><Button variant="ghost" size="sm" aria-busy={refreshing} disabled={draft !== null || refreshing} onClick={retry}>刷新目录</Button></div>}
    {error && <span role="alert" className={styles.error}>{error}</span>}
  </>;
}
