import React from 'react';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { Button } from '../../shared/client/ui/button.jsx';
import { Loading } from '../../shared/client/ui/loading.jsx';
import { loadPublicModelProfiles } from './model-profile.jsx';
import { useCatalogModelProfiles } from './model-catalog-filter.jsx';
import { suggestContextWindows } from '../shared/model-context-optimization.mjs';

const formatTokens = new Intl.NumberFormat('en-US');
const contextTitle = '上下文窗口优化';

export function DeepSeekCatalogSync({ providerId, models, onChange, disabled }) {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState();
  const latest = React.useRef({ models, onChange });
  latest.current = { models, onChange };
  async function sync() {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(new URL('api/commander/tooling', document.baseURI), {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'deepSeekModels', providerId }), signal: AbortSignal.timeout(20000),
      });
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.models)) throw Error('暂时无法同步 DeepSeek 模型');
      const current = latest.current.models;
      const seen = new Set(current.map(({ id }) => id));
      const added = [];
      for (const { id, name, inputModalities } of result.models) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        added.push({ id, ...(name && { name }), ...(inputModalities?.includes('image') && { inputModalities: ['text', 'image'] }) });
      }
      if (added.length) latest.current.onChange([...current, ...added]);
      setMessage({ text: added.length ? `已添加 ${added.length} 个模型，请保存` : result.models.length ? '模型目录已是最新' : '未找到可同步的模型' });
    } catch {
      setMessage({ text: '暂时无法同步 DeepSeek 模型，请重试', error: true });
    } finally {
      setBusy(false);
    }
  }
  return <>
    {message && <span className="cmd-model-sync-status" role={message.error ? 'alert' : 'status'}>{message.text}</span>}
    <Button variant="outline" size="sm" disabled={disabled || busy || !providerId} aria-busy={busy} onClick={() => void sync()}>
      {busy ? '正在同步…' : '同步模型'}
    </Button>
  </>;
}

export function ContextOptimization({ models, onChange, disabled, baseURL, defaultMaxTokens, discoveredModels }) {
  const [open, setOpen] = React.useState(false);
  const [directory, setDirectory] = React.useState({});
  const request = React.useRef(0);
  const profiles = useCatalogModelProfiles(models, directory.rows);
  const suggestions = directory.rows ? suggestContextWindows(models, profiles, { baseURL, defaultMaxTokens, discoveredModels }) : [];
  const load = async () => {
    const sequence = ++request.current;
    setDirectory({});
    try {
      const rows = await loadPublicModelProfiles();
      if (sequence === request.current) setDirectory({ rows });
    } catch {
      if (sequence === request.current) setDirectory({ failed: true });
    }
  };
  const close = () => { request.current++; setOpen(false); };
  const apply = () => {
    const windows = new Map(suggestions.map(({ index, after }) => [index, after]));
    onChange(models.map((model, index) => windows.has(index) ? { ...model, contextWindow: windows.get(index) } : model));
    close();
  };
  return <>
    <Button className="cmd-context-optimization-button" variant="ghost" size="icon" title={contextTitle} aria-haspopup="dialog"
      disabled={disabled || !models.some(model => model.id)} onClick={() => { setOpen(true); void load(); }}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 13.5 12 21a2 2 0 0 1-2.8 0L3 14.8a2 2 0 0 1 0-2.8l7.5-8H20v9.5Z" /><circle cx="15.7" cy="8.3" r="1" /></svg>
    </Button>
    {open && <Modal open title={contextTitle} closeLabel="关闭" onClose={close} className="cmd-context-optimization-dialog"
      description="预览当前连接的建议。应用后，请在模型目录保存。"
      footer={<>
        <Button variant="ghost" onClick={close}>关闭</Button>
        {suggestions.length > 0 && <Button disabled={disabled} onClick={apply}>应用到草稿</Button>}
      </>}>
      {directory.failed ? <div className="cmd-context-optimization-error" role="alert">
        <span>暂时无法读取公开模型目录。</span><Button variant="secondary" onClick={() => void load()}>重试</Button>
      </div> : !directory.rows ? <Loading label="正在读取公开模型目录…" />
        : suggestions.length === 0 ? <p role="status">当前模型没有可应用的上下文调整。</p>
        : <ul className="cmd-context-suggestions" aria-label="建议调整的模型">
          {suggestions.map(({ index, id, name, before, after, reason, source }) => <li key={index}>
            <div className="cmd-context-change"><strong>{name}</strong><span>{formatTokens.format(before)} → {formatTokens.format(after)}</span></div>
            {name !== id && <small>{id}</small>}
            <p>{reason === 'pricing' ? 'OpenAI 直连 API 超过 272K 后进入长上下文计费档。' : '百万级窗口按标称容量的 50% 使用，减少长对话的输入用量。'}
              {source && <> <a href={source} target="_blank" rel="noreferrer">计费说明</a></>}</p>
          </li>)}
        </ul>}
    </Modal>}
  </>;
}
