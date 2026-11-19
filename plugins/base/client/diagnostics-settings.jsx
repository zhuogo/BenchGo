import React, { useState, useSyncExternalStore } from 'react';
import { Switch, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
import { Button, Disclosure } from '../../shared/client/ui/index.jsx';
import { perfTrace } from '../../shared/client/perf-trace.mjs';
import css from './diagnostics-settings.css';

const duration = ms => ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : ms < 1 ? '<1 毫秒' : `${Math.round(ms)} 毫秒`;
const PulseIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>;

function saveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  try {
    const link = document.createElement('a');
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  } finally { setTimeout(() => URL.revokeObjectURL(url), 10_000); }
}
function unavailable(supported) {
  const missing = [];
  if (!supported['long-animation-frame']) missing.push(supported.longtask ? '长帧（已改用长任务，不含脚本来源）' : '长帧与长任务');
  if (!supported.event) missing.push('慢交互');
  if (!supported.visibilitychange) missing.push('窗口切换');
  return missing;
}

export function DiagnosticsSettings({ trace = perfTrace, save = saveFile, copy = writeClipboard }) {
  const snapshot = useSyncExternalStore(trace.subscribe, trace.getSnapshot);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const { frames, interactions, labels } = snapshot.summary;
  const requests = Object.entries(labels).sort((a, b) => b[1].maxDuration - a[1].maxDuration).slice(0, 5);
  const hasData = frames.count > 0 || interactions.count > 0 || requests.length > 0;
  const missing = unavailable(snapshot.supported);
  const report = (message = '', failure = '') => { setNotice(message); setError(failure); };
  const exportRecord = async () => {
    report();
    const name = `benchgo-perf-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.json`;
    try {
      const text = JSON.stringify(trace.export(), null, 2);
      try { save(name, text); report(`已导出 ${name}，请在下载位置查看。`); }
      catch (failure) {
        if (!await copy(text)) throw failure;
        report('无法下载文件，已将记录复制到剪贴板，可粘贴后发给开发者。');
      }
    } catch (failure) { report('', `导出失败：下载与剪贴板均不可用（${failure?.message || '未知原因'}）。请重试。`); }
  };
  return <section className="cmd-diagnostics" aria-label="性能诊断">
    <p className="cmd-diagnostics-intro">遇到卡顿时开启记录，复现后导出给开发者。只记录耗时与来源，不记录对话内容。</p>
    <div className="cmd-diagnostics-row">
      <div className="cmd-diagnostics-copy"><h3>记录性能</h3><p>记录仅保存在内存，刷新窗口会清空；开关状态会保留。</p></div>
      <Switch label="开启性能记录" checked={snapshot.enabled} onChange={next => { report(); trace.setEnabled(next); }} />
    </div>
    {missing.length > 0 && <p className="cmd-diagnostics-warning" role="status">当前环境无法观察：{missing.join('、')}。其余项目照常记录。</p>}
    {!hasData ? <div className="cmd-diagnostics-empty">
      <PulseIcon />
      <strong>{snapshot.enabled ? '正在记录，暂未发现卡顿' : '尚未开始记录'}</strong>
      <p>{snapshot.enabled ? '回到卡顿的界面复现操作，再回来查看与导出。' : '开启后回到卡顿的界面复现操作，再回来导出记录。'}</p>
      {!snapshot.enabled && <Button variant="outline" size="sm" onClick={() => { report(); trace.setEnabled(true); }}>开始记录</Button>}
    </div> : <>
      <p className="cmd-diagnostics-state" role="status">{snapshot.enabled ? '正在记录' : '已停止记录，现有记录仍可导出'}</p>
      <dl className="cmd-diagnostics-stats">
        <div><dt>{frames.type === 'longtask' ? '长任务' : '长帧'}</dt><dd>{frames.type ? `${frames.count} 次` : '不可用'}</dd><dd>{frames.count ? `最长 ${duration(frames.maxDuration)}` : '未出现'}</dd></div>
        <div><dt>慢交互</dt><dd>{snapshot.supported.event ? `${interactions.count} 次` : '不可用'}</dd><dd>{interactions.count ? `最慢 ${duration(interactions.maxDuration)}` : '未出现'}</dd></div>
      </dl>
      {requests.length > 0 && <table className="cmd-diagnostics-requests">
        <caption>耗时最高的请求</caption>
        <thead><tr><th scope="col">请求</th><th scope="col">次数</th><th scope="col">最长</th></tr></thead>
        <tbody>{requests.map(([label, item]) => <tr key={label}><th scope="row">{label}</th><td>{item.count}</td><td>{duration(item.maxDuration)}</td></tr>)}</tbody>
      </table>}
      <div className="cmd-diagnostics-actions">
        <Button variant="outline" size="sm" onClick={exportRecord}>导出记录</Button>
        <Button variant="ghost" size="sm" onClick={() => { trace.clear(); report('记录已清空。'); }}>清空记录</Button>
      </div>
    </>}
    {error ? <p className="cmd-diagnostics-error" role="alert">{error}</p> : <p className="cmd-diagnostics-notice" role="status" aria-live="polite">{notice}</p>}
  </section>;
}

export function DiagnosticsItem({ trace = perfTrace, ...props }) {
  const enabled = useSyncExternalStore(trace.subscribe, () => trace.getSnapshot().enabled);
  return <Disclosure className="cmd-diagnostics-disclosure" title={<>性能诊断{enabled && <span className="cmd-diagnostics-recording">正在记录</span>}</>}>
    <DiagnosticsSettings trace={trace} {...props} />
  </Disclosure>;
}

export function mountDiagnosticsSettings(ctx) {
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  ctx.effect(() => () => style.remove());
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({ name: 'settings.general.item', id: 'benchgo-diagnostics', order: 110 }, DiagnosticsItem));
}
