import React, { useEffect, useId, useState } from 'react';
import { IconInspectOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { Loading } from '../../shared/client/ui/loading.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import { useConfirmation } from '../../shared/client/ui/confirmation.jsx';
import { readJsonResponse } from './http-response.mjs';
import { invalidateModelCatalogs } from './model-catalog.mjs';
import { ToolBrandIcon } from './tool-brand-icon.jsx';
import { UIIcon } from './iconsax.jsx';
import { ToolConfigPanel, mountToolConfigPanelStyle } from './tool-config-panel.jsx';
import css from './tool-settings.css';

export function mountToolSettingsStyle(ctx) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  ctx.effect(() => () => style.remove());
  mountToolConfigPanelStyle(ctx);
}

async function request(action, fields = {}, signal) {
  const url = new URL('api/commander/tooling', document.baseURI);
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...fields }),
    signal,
  });
  const value = await readJsonResponse(response, url);
  if (value.error) throw Error(typeof value.error === 'string' ? value.error : value.error.message || '工具操作失败');
  return value;
}

const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const actionLabel = { install: '安装', update: '更新', uninstall: '卸载' };
const jobLabel = {
  queued: action => '等待' + action,
  running: action => '正在' + action + '…',
  succeeded: action => action + '完成',
  failed: action => action + '失败',
  cancelled: action => '已取消' + action,
};
const genericJobMessage = {
  queued: '等待执行',
  running: '正在执行',
  failed: '操作失败',
  cancelled: '已取消',
};

function ToolCard({ tool, onOperation, onConfig }) {
  const [expanded, setExpanded] = useState(false);
  const [loadingAction, setLoadingAction] = useState('');
  const [operationError, setOperationError] = useState('');
  const [confirm, confirmation] = useConfirmation();
  const optionsId = useId();
  const operation = tool.job;
  const active = !!operation && !terminal.has(operation.status);
  const blocked = active || !!loadingAction;
  const busyHint = blocked && '工具操作进行中';
  const available = tool.available === true;
  const stateLabel = available ? '可用' : tool.installed ? '不可用' : '未安装';
  const stateDetail = [available && tool.version ? null : stateLabel, tool.version].filter(Boolean).join(' · ');
  const reason = tool.installed && !available && (tool.availabilityReason || (tool.routeSupported && tool.routeReason));
  const action = actionLabel[operation?.action] || '操作';
  const status = jobLabel[operation?.status]?.(action) || operation?.message || operation?.status;
  const detail = operation?.message && operation.message !== status && operation.message !== genericJobMessage[operation.status] ? operation.message : '';
  const pendingLabel = loadingAction === 'uninstallPreview' ? '正在检查卸载目标…'
    : loadingAction === 'cancel' ? '正在取消…'
    : actionLabel[loadingAction] ? '正在提交' + actionLabel[loadingAction] + '…' : '';

  const runOperation = async (action, fields) => {
    setOperationError('');
    setLoadingAction(action);
    try {
      if (action === 'uninstallPreview') {
        const { preview } = await onOperation(action, fields);
        setLoadingAction('confirm');
        const accepted = await confirm({
          title: '确认卸载 ' + tool.name,
          description: [preview.description || 'BenchGo 配置和会话记录会保留。', preview.path].filter(Boolean).join(' '),
          confirmLabel: '确认卸载',
          destructive: true,
        });
        if (!accepted) return;
        setLoadingAction('uninstall');
        await onOperation('uninstall', { ...fields, snapshot: preview.snapshot });
      } else {
        await onOperation(action, fields);
      }
    } catch (error) {
      setOperationError(error.message);
    } finally {
      setLoadingAction('');
    }
  };
  const start = action => void runOperation(action, { tool: tool.id });

  return <article className="cmd-tool-card" data-available={available} aria-label={tool.name}>
    <header className="cmd-tool-card-header">
      <span className="cmd-tool-card-mark" data-tool={tool.id}><ToolBrandIcon tool={tool.id} size={22} muted={!available} /></span>
      <div className="cmd-tool-card-identity">
        <h3>{tool.name}</h3>
        <p>{available && tool.version && <span className="cmd-tool-sr-only">{stateLabel}，</span>}{stateDetail}</p>
      </div>
      <div className="cmd-tool-card-actions">
        {!tool.installed
          ? <Button size="sm" disabled={!tool.canInstall || blocked} onClick={() => start('install')}>安装</Button>
          : <>
            <Button variant="ghost" size="icon" aria-label="更新" title={busyHint || (!tool.canUpdate && tool.updateReason) || '更新'} disabled={!tool.canUpdate || blocked} onClick={() => start('update')}><UIIcon name="refresh" size={16} /></Button>
            <Button variant="ghost" size="icon" aria-label="卸载" title={busyHint || (!tool.canUninstall && tool.uninstallReason) || '卸载'} disabled={!tool.canUninstall || blocked} onClick={() => start('uninstallPreview')}><UIIcon name="trash" size={16} /></Button>
          </>}
        {tool.configSupported && <Button variant="ghost" size="icon" aria-label="工具选项" title={active && !expanded ? busyHint : '工具选项'} aria-expanded={expanded} aria-controls={expanded ? optionsId : undefined} disabled={active && !expanded} onClick={() => setExpanded(value => !value)}><IconInspectOutlineRegular size={16} /></Button>}
      </div>
    </header>
    {reason && <p className="cmd-tool-card-note">{reason}</p>}
    {pendingLabel && <p className="cmd-tool-card-note" role="status">{pendingLabel}</p>}
    {operationError && <p className="cmd-tool-card-note cmd-tool-error" role="alert">{operationError}</p>}
    {operation && <div className="cmd-tool-card-job" role="group" aria-label={tool.name + '操作状态'}>
      <div className="cmd-tool-card-job-line">
        <div role="status"><strong>{status}</strong>{detail && <p>{detail}</p>}</div>
        {active && <Button variant="ghost" size="sm" disabled={!!loadingAction} onClick={() => void runOperation('cancel', { id: operation.id })}>取消</Button>}
      </div>
      {active && <div className="cmd-tool-progress" aria-hidden="true" />}
      {operation.error && <p className="cmd-tool-error" role="alert">{operation.error}</p>}
      {active && tool.pollError && <p className="cmd-tool-card-note" role="status">暂时无法读取操作进度，正在重试。</p>}
    </div>}
    {confirmation}
    {expanded && <div id={optionsId} className="cmd-tool-card-options"><ToolConfigPanel tool={tool} onConfig={onConfig} /></div>}
  </article>;
}

export function ToolSettingsSection() {
  const [tools, setTools] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    request('catalog', {}, controller.signal).then(value => {
      if (!Array.isArray(value.tools)) throw Error('工具目录格式异常');
      if (!controller.signal.aborted) setTools(current => value.tools.map(tool => {
        const previous = current?.find(item => item.id === tool.id);
        if (!previous?.job) return tool;
        const stale = !tool.job || previous.job.createdAt > tool.job.createdAt
          || (previous.job.id === tool.job.id && terminal.has(previous.job.status));
        return stale ? { ...tool, job: previous.job, pollError: previous.pollError } : tool;
      }));
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [revision]);

  const refresh = () => setRevision(value => value + 1);
  const operate = async (action, fields) => {
    const value = await request(action, fields);
    if (action === 'uninstallPreview') {
      if (!value.preview?.available) throw Error(value.preview?.reason || value.preview?.description || '无法核验卸载目标');
      return value;
    }
    if (value.job) {
      setTools(current => (current || []).map(tool => {
        if (tool.id !== value.job.toolId) return tool;
        const job = { ...value.job, action: value.job.action || (action === 'cancel' ? tool.job?.action : action) };
        return { ...tool, job, pollError: false };
      }));
      if (terminal.has(value.job.status)) { invalidateModelCatalogs(); refresh(); }
    } else {
      refresh();
    }
    return value;
  };
  useEffect(() => {
    const jobs = (tools || []).filter(tool => tool.job && !terminal.has(tool.job.status));
    if (!jobs.length) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const updated = new Map(await Promise.all(jobs.map(async ({ job: { id } }) => {
        try { return [id, (await request('job', { id }, controller.signal)).job]; }
        catch { return [id, null]; }
      })));
      if (controller.signal.aborted) return;
      setTools(current => (current || []).map(tool => {
        const id = tool.job?.id;
        if (!updated.has(id) || terminal.has(tool.job.status)) return tool;
        const job = updated.get(id);
        return job?.id === id
          ? { ...tool, job: { ...job, action: job.action || tool.job.action }, pollError: false }
          : { ...tool, pollError: true };
      }));
      if ([...updated.values()].some(job => job && terminal.has(job.status))) { invalidateModelCatalogs(); refresh(); }
    }, 800);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [tools]);

  return <section className="cmd-tool-settings" aria-busy={loading}>
    <header className="cmd-tool-heading"><h2>Harness 工具</h2>
      <div className="cmd-tool-heading-actions">
        {loading && tools && <Loading label="正在检测" compact />}
        <Button variant="ghost" size="icon" aria-label="重新检测工具" title={loading ? '正在检测工具…' : '重新检测工具'} disabled={loading} onClick={refresh}><UIIcon name="refresh" size={16} /></Button>
      </div>
    </header>
    {error && <div className="cmd-tool-catalog-error"><p className="cmd-tool-error" role="alert">{error}</p><Button variant="ghost" size="sm" onClick={refresh}>重试</Button></div>}
    {loading && !tools && <Loading label="正在检测 Harness 工具" />}
    {tools?.length > 0 && <div className="cmd-tool-cards">{tools.map(tool => <ToolCard key={tool.id} tool={tool} onOperation={operate} onConfig={request} />)}</div>}
    {tools?.length === 0 && !error && <div className="cmd-tool-empty"><UIIcon name="cpu" size={26} /><strong>没有可管理的 CLI 工具</strong><Button variant="ghost" size="sm" disabled={loading} onClick={refresh}>重新检测</Button></div>}
  </section>;
}
