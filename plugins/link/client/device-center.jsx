import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { Select } from '../../shared/client/select.jsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { deviceRuntime } from './device-runtime.mjs';
import { deviceIcon, deviceKind, deviceStatus, jobFailed, jobFinished, sshInput, workbenchUrl } from './device-state.mjs';
import { workbenchNavigationMessage } from './device-navigation.mjs';
import { LinkSettings, PairingDialog, useLinkStyle } from './app.jsx';
import css from './device-center.css';
import { DeviceLoading } from './device-loading.jsx';

function Button({ children, icon, primary, danger, title, className = '', ...props }) { return <Tooltip label={title}><button type="button" className={`dc-button ${primary ? 'dc-primary' : ''} ${danger ? 'dc-danger' : ''} ${className}`.trim()} {...props}>{icon && <UIIcon name={icon} size={16} />}{children}</button></Tooltip>; }
function ErrorLine({ error }) { return error ? <p className="dc-error" role="alert">{error}</p> : null; }
function ConnectionTest({ result }) { return result ? <p className={`dc-test-result ${result.ok ? 'is-success' : 'is-failed'}`} role="status"><UIIcon name={result.ok ? 'check' : 'close'} size={15} />{result.message || result.error}{result.ok && Number.isFinite(result.latencyMs) && <span>{result.latencyMs} ms</span>}</p> : null; }
function Field({ label, children, full }) { return <label className={`dc-field ${full ? 'dc-field-full' : ''}`}><span>{label}</span>{children}</label>; }

function Sheet({ title, children, onClose, busy }) {
  const box = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    box.current?.querySelector('input,button,textarea,select')?.focus();
    const key = event => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const items = [...box.current.querySelectorAll('button,input,textarea,select,a[href]')].filter(item => !item.disabled && item.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus?.(); };
  }, [onClose, busy]);
  return <div className="dc-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="dc-sheet" role="dialog" aria-modal="true" aria-labelledby="dc-dialog-title" ref={box}><header><h2 id="dc-dialog-title">{title}</h2><Button icon="close" aria-label="关闭" onClick={onClose} disabled={busy} /></header>{children}</section></div>;
}

function AddComputer({ runtime, onAdded }) {
  const [uri, setUri] = useState(''), [error, setError] = useState(''), [phase, setPhase] = useState('idle');
  const operation = useRef(0), timer = useRef(), mounted = useRef(true), lastScan = useRef(''), inFlight = useRef('');
  const connect = useCallback(async input => {
    if (!input.trim()) { setError('请粘贴目标设备的连接信息'); return; }
    if (inFlight.current === input.trim()) return;
    inFlight.current = input.trim();
    const generation = ++operation.current; clearTimeout(timer.current); setError(''); setPhase('sending'); setUri(input);
    try {
      const result = await runtime.call('pair', { uri: input.trim(), name: runtime.clientName() });
      if (!mounted.current || operation.current !== generation) return;
      setPhase('pending');
      const poll = async () => {
        try {
          const status = await runtime.call('pairStatus', { requestId: result.requestId });
          if (!mounted.current || operation.current !== generation) return;
          if (status.status === 'approved') { setPhase('approved'); await onAdded(status.device); return; }
          if (['rejected', 'expired', 'revoked'].includes(status.status)) throw new Error(status.status === 'rejected' ? '目标设备未允许连接，请生成新的连接信息' : '配对已过期，请重新扫码或粘贴地址');
          timer.current = setTimeout(poll, 1500);
        } catch (reason) { if (mounted.current && operation.current === generation) { inFlight.current = ''; setError(reason.message); setPhase('failed'); } }
      };
      timer.current = setTimeout(poll, 700);
    } catch (reason) { if (mounted.current && operation.current === generation) { inFlight.current = ''; setError(reason.message); setPhase('failed'); } }
  }, [runtime, onAdded]);
  useEffect(() => {
    mounted.current = true;
    const scanned = () => {
      const identity = runtime.bootstrap?.();
      if (!identity?.code || identity.token) return;
      const next = runtime.contextUri(identity);
      if (!next || lastScan.current === next) return;
      lastScan.current = next; void connect(next);
    };
    window.addEventListener('link:bootstrap', scanned); scanned();
    return () => { mounted.current = false; operation.current++; clearTimeout(timer.current); window.removeEventListener('link:bootstrap', scanned); };
  }, [connect, runtime]);
  const waiting = ['sending', 'pending', 'approved'].includes(phase);
  return <><p className="dc-note">连接需由目标设备批准。</p><form onSubmit={event => { event.preventDefault(); if (!waiting) void connect(uri); }}><Field label="连接信息"><textarea autoCapitalize="off" autoCorrect="off" spellCheck={false} rows={3} placeholder="benchgo://pair?…" value={uri} disabled={waiting} onChange={event => { setUri(event.target.value); setError(''); }} /></Field><ErrorLine error={error} />{waiting && <p className="dc-progress-message" role="status"><i className="dc-spinner" />{phase === 'sending' ? '正在发送连接请求…' : phase === 'approved' ? '已允许，正在打开…' : '请在目标设备上允许连接'}</p>}<div className="dc-actions">{runtime.isNative() && <Button icon="scan" onClick={() => runtime.scan()} disabled={phase === 'sending'}>扫码连接</Button>}<Button type="submit" primary disabled={waiting || !uri.trim()}>{phase === 'failed' ? '重试连接' : '连接设备'}</Button></div></form></>;
}

const emptyServer = () => ({ name: '', host: '', port: '22', username: '', auth: 'password', password: '', privateKey: '', passphrase: '', source: 'mirror' });
function Credentials({ form, setForm, disabled }) {
  const field = key => ({ value: form[key], disabled, onChange: event => setForm(value => ({ ...value, [key]: event.target.value })) });
  return <><Field label="认证方式" full><Select {...field('auth')}><option value="password">密码</option><option value="key">SSH 私钥</option></Select></Field>{form.auth === 'password' ? <Field label="密码" full><input type="password" autoComplete="off" {...field('password')} /></Field> : <><Field label="SSH 私钥" full><textarea rows={4} autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" {...field('privateKey')} /></Field><Field label="私钥口令（可选）" full><input type="password" autoComplete="off" {...field('passphrase')} /></Field></>}</>;
}
function JobProgress({ job, label = '正在准备服务器工作台…', pollingError = '' }) {
  return <div className="dc-job" aria-live="polite"><ol>{(job.steps || []).map((step, index) => { const item = typeof step === 'string' ? { label: step } : step; return <li key={item.id || index} data-state={item.state || item.status || 'pending'}><span className="dc-step-icon">{['done', 'completed', 'success'].includes(item.state || item.status) ? <UIIcon name="check" size={14} /> : index + 1}</span><div>{item.label || item.name || item.title || item.id}{item.message && <small>{item.message}</small>}</div></li>; })}</ol>{!jobFinished(job) && !pollingError && <p className="dc-progress-message"><i className="dc-spinner" />{label}</p>}{pollingError && <p className="dc-progress-message" role="status">暂时无法获取后台进度</p>}<ErrorLine error={job.error} /></div>;
}
function useJob(runtime, job, setJob, setError, attempt = 0) {
  useEffect(() => {
    if (!job?.id || jobFinished(job)) return;
    let closed = false, timer;
    const poll = async () => {
      try {
        const next = await runtime.call('job', { jobId: job.id });
        if (!closed) { setError(''); setJob({ ...job, ...next, id: next.id || job.id }); if (!jobFinished(next)) timer = setTimeout(poll, 1000); }
      } catch (reason) { if (!closed) setError(reason.message); }
    };
    timer = setTimeout(poll, 400); return () => { closed = true; clearTimeout(timer); };
  }, [runtime, job?.id, job?.state, setJob, setError, attempt]);
}
function AddDevice({ runtime, onAdded, sshAvailable }) {
  const [path, setPath] = useState('existing');
  return <><div className="dc-add-actions" role="group" aria-label="添加方式"><Button primary={path === 'existing'} onClick={() => setPath('existing')}>连接已有设备</Button><Button primary={path === 'server'} disabled={!sshAvailable} onClick={() => setPath('server')}>安装到服务器</Button></div>{!sshAvailable && <p className="dc-footnote">此客户端暂不支持 SSH 安装，请使用桌面客户端。</p>}{path === 'existing' ? <AddComputer runtime={runtime} onAdded={onAdded} /> : <AddServer runtime={runtime} onAdded={onAdded} />}</>;
}
function AddServer({ runtime, onAdded }) {
  const [form, setForm] = useState(emptyServer), [fingerprint, setFingerprint] = useState(''), [job, setJob] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const gate = useRef(false), mounted = useRef(true);
  const [pollAttempt, setPollAttempt] = useState(0);
  useEffect(() => () => { mounted.current = false; }, []);
  useJob(runtime, job, setJob, setError, pollAttempt);
  const submit = async () => {
    if (gate.current) return; gate.current = true; setBusy(true); setError('');
    try {
      const input = sshInput(form);
      if (!fingerprint) { const result = await runtime.call('sshProbe', { host: input.host, port: input.port, username: input.username }); if (mounted.current) setFingerprint(result.fingerprint); }
      else { const result = await runtime.call('sshConnect', { ...input, fingerprint }); if (mounted.current) { setJob({ id: result.jobId, state: 'running', steps: [] }); setForm(value => ({ ...value, password: '', privateKey: '', passphrase: '' })); } }
    } catch (reason) { if (mounted.current) setError(reason.message); }
    finally { gate.current = false; if (mounted.current) setBusy(false); }
  };
  const field = key => ({ value: form[key], disabled: busy, onChange: event => { setForm(value => ({ ...value, [key]: event.target.value })); setFingerprint(''); setError(''); } });
  if (job) return <><p className="dc-note">{form.name || form.host} · SSH 加密隧道</p><JobProgress job={job} />{job.device?.warning && <p className="dc-note" role="status">{job.device.warning}</p>}<ErrorLine error={error} /><p className="dc-footnote">关闭此面板不会中断安装。</p><div className="dc-actions">{jobFailed(job) ? <Button onClick={() => { setJob(null); setFingerprint(''); setError(''); }}>返回重试</Button> : jobFinished(job) ? <Button primary onClick={() => onAdded(job.device)}>打开工作台</Button> : error ? <Button onClick={() => { setError(''); setPollAttempt(value => value + 1); }}>重新检查进度</Button> : null}</div></>;
  return <><p className="dc-note">通过 SSH 安装或连接BenchGo。默认使用加密隧道，无需开放工作台端口。</p><form onSubmit={event => { event.preventDefault(); void submit(); }}><div className="dc-form-grid"><Field label="名称（可选）" full><input placeholder="例如：开发服务器" maxLength={100} {...field('name')} /></Field><Field label="服务器地址"><input required placeholder="IP 或域名" autoCapitalize="off" autoCorrect="off" {...field('host')} /></Field><Field label="SSH 端口"><input required inputMode="numeric" type="number" min="1" max="65535" {...field('port')} /></Field><Field label="用户名" full><input required placeholder="例如：ubuntu" autoCapitalize="off" autoCorrect="off" autoComplete="off" {...field('username')} /></Field><Credentials form={form} setForm={setForm} disabled={busy} /><Field label="下载源" full><Select {...field('source')}><option value="mirror">国内加速（默认）</option><option value="github">官方直连</option></Select></Field></div><p className="dc-footnote">密码与私钥仅用于本次连接，不保存在设备列表。</p>{fingerprint && <div className="dc-fingerprint"><strong>确认服务器身份</strong><code>{fingerprint}</code><p>请核对服务器的 SSH 主机指纹。确认后才会认证和安装。</p></div>}<ErrorLine error={error} /><div className="dc-actions"><Button primary type="submit" disabled={busy}>{busy ? '处理中…' : fingerprint ? '确认指纹并连接' : '检查服务器'}</Button></div></form></>;
}

function RelayWizard({ runtime, onChanged, onClose, job: savedJob, setJob: saveJob, initialTab = 'connect' }) {
  const [tab, setTab] = useState(initialTab);
  const [advanced, setAdvanced] = useState(false);
  const [localJob, setLocalJob] = useState(null);
  const job = saveJob ? savedJob : localJob, setJob = saveJob || setLocalJob;
  const [form, setForm] = useState(() => ({ ...emptyServer(), username: 'root', sslMode: 'ip', domain: '', publicIp: '', email: '', relayPort: '24680', challengeMode: 'standalone', webroot: '' }));
  const [fingerprint, setFingerprint] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0), [result, setResult] = useState(''), [confirm, setConfirm] = useState('');
  const [connection, setConnection] = useState({ url: '', token: '' }), [connectionTest, setConnectionTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const mounted = useRef(true), gate = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useJob(runtime, job, setJob, setError, attempt);
  const working = busy || Boolean(job && !jobFinished(job));
  const dismissJob = async () => {
    const current = job;
    setJob(null); setFingerprint(''); setError('');
    if (current?.id) try { await runtime.call('relayJobDismiss', { jobId: current.id }); } catch (reason) { if (mounted.current) setError(reason.message); }
  };
  const field = key => ({ value: form[key], disabled: working, onChange: event => { setForm(value => ({ ...value, [key]: event.target.value })); if (['host', 'port', 'username'].includes(key)) setFingerprint(''); setError(''); } });
  const run = async (operation = 'deploy') => {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError(''); setResult('');
    try {
      const domain = form.domain.trim();
      if (form.sslMode === 'domain') {
        // Fail early so a typo never starts an SSH deployment.
        if (!domain || domain.length > 253 || domain.includes('://') || domain.includes('/') || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(domain)) {
          throw new Error('请输入有效域名，例如 relay.example.com');
        }
      }
      const challengeMode = form.sslMode === 'domain' ? 'webroot' : form.challengeMode;
      const input = { ...sshInput(form), sslMode: form.sslMode, domain: form.sslMode === 'domain' ? form.domain.trim() : '', publicIp: form.publicIp.trim() || form.host.trim(), email: form.email.trim(), relayPort: Number(form.relayPort), challengeMode, ...(challengeMode === 'webroot' ? { webroot: form.webroot.trim() } : {}) };
      let verifiedFingerprint = fingerprint;
      if (!verifiedFingerprint) {
        const value = await runtime.call('relayProbe', { host: input.host, port: input.port, username: input.username });
        verifiedFingerprint = value.fingerprint;
        if (mounted.current) setFingerprint(verifiedFingerprint);
      }
      const value = await runtime.call(operation === 'deploy' ? 'relayDeploy' : 'relayAction', { ...input, fingerprint: verifiedFingerprint, ...(operation !== 'deploy' ? { operation } : {}) });
      if (!mounted.current) {
        if (value.jobId && saveJob) saveJob({ id: value.jobId, operation, state: 'running', steps: [] });
        return;
      }
      setConfirm('');
      setForm(value => ({ ...value, password: '', privateKey: '', passphrase: '' }));
      if (value.jobId) setJob({ id: value.jobId, operation, state: 'running', steps: [] });
      else { setResult(value.logs || value.output || value.message || (value.status ? `服务状态：${value.status}` : '操作已完成')); }
    } catch (reason) { if (mounted.current) setError(reason.message); }
    finally { gate.current = false; if (mounted.current) setBusy(false); }
  };
  const done = (!job?.operation || job.operation === 'deploy') && job && jobFinished(job) && !jobFailed(job);
  const [host, setHost] = useState(null), [pairing, setPairing] = useState(null), [hostAttempt, setHostAttempt] = useState(0);
  const [pairingAction, setPairingAction] = useState('');
  useEffect(() => {
    if (!done) return;
    let closed = false, timer, checks = 0;
    const poll = async () => {
      checks++;
      try { const value = await runtime.call('hostStatus'); if (!closed) { setHost(value); if (pairing || (!value.relay?.connected && value.relay?.enabled !== false && checks < 20)) timer = setTimeout(poll, 1500); } }
      catch (reason) { if (!closed) setError(reason.message); }
    };
    void poll(); return () => { closed = true; clearTimeout(timer); };
  }, [runtime, done, hostAttempt, !!pairing]);
  const confirmPairing = async (id, action) => {
    if (gate.current) return;
    gate.current = true; setPairingAction(action); setError('');
    try { const value = await runtime.call(action === 'confirm' ? 'hostConfirm' : 'hostReject', { id }); if (mounted.current) setHost(value); }
    catch (reason) { if (mounted.current) setError(reason.message); }
    finally { gate.current = false; if (mounted.current) setPairingAction(''); }
  };
  const toggleHost = async () => {
    if (gate.current) return; gate.current = true; setBusy(true); setError('');
    try { const value = await runtime.call('hostRelayConfigure', { enabled: host?.relay?.enabled === false }); if (mounted.current) { setHost(value); setPairing(null); setConfirm(''); setHostAttempt(value => value + 1); } }
    catch (reason) { if (mounted.current) setError(reason.message); }
    finally { gate.current = false; if (mounted.current) setBusy(false); }
  };
  const pair = async () => {
    if (gate.current) return; gate.current = true; setBusy(true); setError('');
    try { const value = await runtime.call('hostPairing', { mode: 'relay' }); if (mounted.current) setPairing(value); }
    catch (reason) { if (mounted.current) setError(reason.message); }
    finally { gate.current = false; if (mounted.current) setBusy(false); }
  };
  const connectRelay = async event => {
    event.preventDefault();
    if (gate.current) return;
    gate.current = true; setBusy(true); setError('');
    try {
      const current = await runtime.hostCall('hostStatus');
      const nodes = current.relay?.nodes || [];
      if (nodes.some(node => node.url === connection.url.trim())) throw new Error('此中继已在列表中，请编辑现有中继');
      await runtime.hostCall('relayPoolConfigure', { nodes: [...nodes, { id: 'relay-' + Date.now().toString(36), url: connection.url.trim(), token: connection.token.trim(), enabled: true, priority: nodes.length }] });
      if (mounted.current) await onChanged();
    } catch (reason) { if (mounted.current) setError(reason.message); }
    finally { gate.current = false; if (mounted.current) setBusy(false); }
  };
  const testConnection = async () => {
    if (gate.current) return;
    gate.current = true; setBusy(true); setTesting(true); setError(''); setConnectionTest(null);
    try { const value = await runtime.hostCall('relayTest', { url: connection.url.trim(), token: connection.token.trim() }); if (mounted.current) setConnectionTest(value); }
    catch (reason) { if (mounted.current) setConnectionTest({ ok: false, error: reason.message }); }
    finally { gate.current = false; if (mounted.current) { setBusy(false); setTesting(false); } }
  };
  const connectionField = key => ({ value: connection[key], disabled: working, onChange: event => { setConnection(value => ({ ...value, [key]: event.target.value })); setConnectionTest(null); setError(''); } });
  return <><div className="dc-relay-tabs" role="tablist" aria-label="中继添加方式"><Button primary={tab === 'connect'} disabled={working} onClick={() => { setTab('connect'); setError(''); }}>连接</Button><Button primary={tab === 'deploy'} disabled={working} onClick={() => { setTab('deploy'); setError(''); }}>部署</Button></div>
    {tab === 'connect' ? <><p className="dc-note">已有中继服务？填写中继地址和主机密钥，让本机直接接入。</p><form onSubmit={connectRelay}><div className="dc-form-grid"><Field label="中继 HTTPS 地址" full><input name="url" required type="url" placeholder="https://relay.example.com:24680" autoCapitalize="off" autoCorrect="off" {...connectionField('url')} /></Field><Field label="中继主机密钥" full><input name="token" required type="password" autoComplete="off" placeholder="粘贴中继服务生成的密钥" {...connectionField('token')} /></Field></div><p className="dc-footnote">主机密钥只用于本机接入，不会显示在中继列表中。</p>{testing && <p className="dc-progress-message" role="status"><i className="dc-spinner" />正在测试连接…</p>}<ConnectionTest result={connectionTest} /><ErrorLine error={error} /><div className="dc-actions"><Button icon="refresh" onClick={testConnection} disabled={busy || !connection.url.trim() || !connection.token.trim()}>测试连接</Button><Button primary type="submit" disabled={busy}>{busy ? '处理中…' : '连接中继'}</Button></div></form></> : <><p className="dc-note">在你信任的 Linux 服务器安装连接中继，让当前主机主动接入。中继可读取转发的工作台内容，请仅使用自己的服务器。</p>
    {job && <><JobProgress job={job} pollingError={!jobFinished(job) ? error : ''} label={job.operation && job.operation !== 'deploy' ? '正在管理中继服务…' : '正在后台部署，通常需要 2–10 分钟…'} /><p className="dc-footnote">可以关闭此窗口，任务会在后台继续；重新打开即可查看进度。SSH 凭据不会保存。</p><div className="dc-actions">{!jobFinished(job) && error && <Button onClick={() => { setError(''); setAttempt(value => value + 1); }}>重新检查进度</Button>}{!jobFinished(job) && onClose && <Button onClick={onClose}>后台执行</Button>}{jobFailed(job) && <Button primary onClick={() => void dismissJob()}>返回修改</Button>}</div></>}
    {done && <div className="dc-relay-success"><strong>中继 HTTPS 已验证</strong><code>{job.relay?.url}</code><p className="dc-note">当前主机已自动启用中继接入。从其他设备完成配对和工作台验证后，才确认跨网访问可用。</p><p className="dc-progress-message" role="status">{host?.relay?.enabled === false ? '当前主机中继已停用' : host?.relay?.connected ? '当前主机通道已连接' : host?.relay?.lastError || '当前主机尚未接入，可检查网络后重试'}</p><div className="dc-actions"><Button disabled={busy} onClick={() => setHostAttempt(value => value + 1)}>检查接入状态</Button><Button primary disabled={busy || !host?.relay?.connected} onClick={pair}>生成中继连接信息</Button><Button disabled={busy} onClick={() => host?.relay?.enabled === false ? void toggleHost() : setConfirm('disconnect')}>{host?.relay?.enabled === false ? '启用当前主机中继' : '停用当前主机中继'}</Button><Button onClick={() => { setJob(null); setPairing(null); }}>管理服务器</Button></div>{confirm === 'disconnect' && <div className="dc-confirm"><p>停用后经此中继访问当前主机的连接将断开，服务器中继服务保留。</p><div className="dc-actions"><Button disabled={busy} onClick={() => setConfirm('')}>取消</Button><Button danger disabled={busy} onClick={toggleHost}>确认停用</Button></div></div>}{pairing && <PairingDialog pairing={pairing} pending={host?.pending || []} onClose={() => { if (!pairingAction) setPairing(null); }} onConfirm={confirmPairing} busy={pairingAction} error={error} />}</div>}
    {!job && <form onSubmit={event => { event.preventDefault(); void run(); }}><div className="dc-form-grid">
      <Field label="服务器地址"><input required placeholder="公网 IP 或域名" autoCapitalize="off" autoCorrect="off" {...field('host')} /></Field><Field label="SSH 端口"><input required type="number" min="1" max="65535" {...field('port')} /></Field>
      <Field label="SSH 用户名" full><input required placeholder="例如 root 或 ubuntu" autoCapitalize="off" autoComplete="off" {...field('username')} /></Field><Credentials form={form} setForm={setForm} disabled={working} />
    </div><div className="dc-form-grid"><Field label="证书模式" full><Select value={form.sslMode} disabled={working} onChange={event => { const sslMode = event.target.value; setForm(value => ({ ...value, sslMode, ...(sslMode === 'domain' ? { challengeMode: 'webroot', webroot: value.webroot || (value.domain.trim() ? `/www/wwwroot/${value.domain.trim()}` : '') } : { challengeMode: 'standalone' }) })); setError(''); }}><option value="ip">IP SSL</option><option value="domain">域名 SSL</option></Select></Field>{form.sslMode === 'domain' && <Field label="中继域名" full><input required placeholder="relay.example.com" autoCapitalize="off" {...field('domain')} /><small className="dc-field-hint">部署时会自动检查网络并完成证书验证。</small></Field>}</div><button type="button" className="dc-advanced-toggle" onClick={() => setAdvanced(value => !value)} aria-expanded={advanced}>{advanced ? '收起高级设置' : '高级设置（公网 IP、端口、证书）'}</button>{advanced && <div className="dc-form-grid dc-advanced-fields">
      <Field label="服务器公网 IP"><input placeholder="默认使用服务器地址" autoCapitalize="off" {...field('publicIp')} /></Field><Field label="中继业务端口"><input required type="number" min="20000" max="49151" {...field('relayPort')} /></Field>
      <Field label="证书通知邮箱（选填）" full><input type="email" autoComplete="email" placeholder="用于接收证书续期通知" {...field('email')} /></Field>
      {form.sslMode === 'ip' && <Field label="证书验证方式" full><Select {...field('challengeMode')}><option value="standalone">自动验证</option><option value="webroot">使用已有站点目录</option></Select></Field>}
      {form.challengeMode === 'webroot' && <Field label="challenge webroot 绝对路径" full><input required={form.sslMode !== 'domain'} placeholder={form.sslMode === 'domain' ? `/www/wwwroot/${form.domain || 'relay.example.com'}` : '/var/www/acme'} {...field('webroot')} /></Field>}
    </div>}<p className="dc-footnote">{form.sslMode === 'domain' ? '部署前会校验域名解析，并自动完成证书验证。' : 'IP SSL 需要公网 80 端口可达。'}中继业务端口使用 24680。</p>
      <div className="dc-actions"><Button primary type="submit" disabled={working}>{busy ? '正在连接…' : '一键部署'}</Button></div>
    </form>}
    {result && <pre className="dc-result" role="status">{String(result)}</pre>}{!job && <section className="dc-management dc-manual-deploy"><h3>手动部署</h3><p className="dc-note">如果你希望自行控制服务器环境，可按官方文档手动安装中继服务。GitHub 一键部署脚本上线后，会在这里提供复制命令。</p><code>GitHub 部署脚本即将提供</code></section>}<ErrorLine error={error} /></>}
  </>;
}

function RelayPool({ runtime, refreshToken = 0, active = true, onAdd, onChanged }) {
  const [status, setStatus] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [editing, setEditing] = useState(null);
  const [statusError, setStatusError] = useState('');
  const [tests, setTests] = useState({});
  const [testing, setTesting] = useState('');
  const gate = useRef(false), request = useRef(0);
  const load = useCallback(async () => {
    const generation = ++request.current;
    try { const next = await runtime.hostCall('hostStatus'); if (generation === request.current) { setStatusError(''); setStatus(next); } }
    catch (reason) { if (generation === request.current) setStatusError(reason.message); }
  }, [runtime]);
  useEffect(() => {
    if (!active) return;
    let closed = false, timer;
    const poll = async () => { await load(); if (!closed) timer = setTimeout(poll, 3000); };
    void poll();
    return () => { closed = true; clearTimeout(timer); ++request.current; };
  }, [load, refreshToken, active]);
  const nodes = status?.relay?.nodes || [];
  const configure = async next => {
    if (gate.current) return false;
    gate.current = true; setBusy(true); setError('');
    try {
      const value = await runtime.hostCall('hostRelayPoolConfigure', { nodes: next.map((item, index) => ({ id: item.id, url: item.url, token: item.token || '', priority: index, enabled: item.enabled !== false })) });
      ++request.current; setStatus(value); onChanged?.(); return true;
    } catch (reason) { setError(reason.message); return false; }
    finally { gate.current = false; setBusy(false); }
  };
  const closeEdit = useCallback(() => { if (!gate.current) setEditing(null); }, []);
  const edit = node => { setError(''); setEditing({ id: node.id, url: node.url, token: '' }); };
  const test = async node => {
    if (gate.current) return;
    gate.current = true; setBusy(true); setTesting(node.id);
    setTests(value => ({ ...value, [node.id]: null }));
    try { const result = await runtime.hostCall('relayTest', { id: node.id, url: node.url.trim(), token: node.token?.trim() || '' }); setTests(value => ({ ...value, [node.id]: result })); }
    catch (reason) { setTests(value => ({ ...value, [node.id]: { ok: false, error: reason.message } })); }
    finally { gate.current = false; setBusy(false); setTesting(''); }
  };
  const saveEdit = async event => {
    event.preventDefault();
    const current = editing, url = current?.url.trim();
    if (!url) return;
    if (await configure(nodes.map(item => item.id === current.id ? { ...item, url, token: current.token.trim() } : item))) setEditing(null);
  };
  const editField = key => ({ value: editing[key], disabled: busy, onChange: event => { setEditing(value => ({ ...value, [key]: event.target.value })); setTests(value => ({ ...value, [editing.id]: null })); } });
  return <section className="dc-relay-pool" aria-label="中继">
    <div className="dc-section-heading"><h2>中继 <span className="dc-count">{nodes.length}</span></h2><div className="dc-service-actions"><Button icon="refresh" aria-label="刷新中继" disabled={busy} onClick={() => void load()} />{onAdd && <Button onClick={onAdd}>添加中继</Button>}</div></div>
    {!editing && <ErrorLine error={error || statusError} />}
    {!status && !statusError ? <DeviceLoading label="正在读取中继…" /> : nodes.length ? <div className="dc-device-list dc-relay-list">{nodes.map((node, index) => <article key={node.id} className="dc-device dc-relay-card">
      <div className="dc-device-open"><span className="dc-device-symbol"><UIIcon name="server" size={22} /></span><span className="dc-device-copy"><strong>{new URL(node.url).host} {index === 0 && <em>主中继</em>}</strong><small data-status={node.enabled === false ? 'disabled' : node.connected ? 'connected' : 'offline'}>{node.enabled === false ? '已停用' : node.connected ? '通道已连接' : node.lastError ? '连接失败 · ' + node.lastError : '正在连接…'}</small><span className="dc-relay-address">{node.url}</span></span></div>
      <div className="dc-service-actions"><Button icon="refresh" disabled={busy} onClick={() => void test(node)}>测试连接</Button><Button icon="settings" disabled={busy} onClick={() => edit(node)}>编辑</Button><Button disabled={busy} onClick={() => void configure(nodes.map(item => item.id === node.id ? { ...item, enabled: item.enabled === false } : item))}>{node.enabled === false ? '启用' : '停用'}</Button>{index > 0 && <Button disabled={busy} onClick={() => void configure([node, ...nodes.filter(item => item.id !== node.id)])}>设为主中继</Button>}<Button icon="trash" aria-label={'删除中继 ' + node.id} danger disabled={busy || node.enabled !== false} onClick={() => void configure(nodes.filter(item => item.id !== node.id))} /></div>
      {testing === node.id && <p className="dc-progress-message" role="status"><i className="dc-spinner" />正在测试连接…</p>}<ConnectionTest result={tests[node.id]} />
    </article>)}</div> : <p className="dc-note">尚未添加中继</p>}
    {editing && <Sheet title="编辑中继" onClose={closeEdit} busy={busy}><form className="dc-relay-edit-form" onSubmit={saveEdit}>
      <Field label="中继 HTTPS 地址"><input type="url" required {...editField('url')} /></Field>
      <Field label="主机密钥"><input type="password" placeholder="留空以保留当前密钥" autoComplete="new-password" {...editField('token')} /></Field>
      {testing === editing.id && <p className="dc-progress-message" role="status"><i className="dc-spinner" />正在测试连接…</p>}<ConnectionTest result={tests[editing.id]} /><ErrorLine error={error} />
      <div className="dc-actions"><Button icon="refresh" disabled={busy || !editing.url.trim()} onClick={() => void test(editing)}>测试连接</Button><Button primary type="submit" disabled={busy}>{busy ? '处理中…' : '保存更改'}</Button></div>
    </form></Sheet>}
  </section>;
}

function ManageDevice({ device, runtime, onChanged, onRemoved, onCloseWorkbench, onOpenWorkbench }) {
  const [savedName, setSavedName] = useState(device.name);
  const [editingName, setEditingName] = useState(false);
  const nameInput = useRef(null), editNameButton = useRef(null), composingName = useRef(false), wasEditingName = useRef(false);
  const [name, setName] = useState(device.name), [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState(''), [confirm, setConfirm] = useState(''), [credentials, setCredentials] = useState(emptyServer), [reconnecting, setReconnecting] = useState(false);
  const gate = useRef(false);
  const [job, setJob] = useState(null), [pollAttempt, setPollAttempt] = useState(0);
  useJob(runtime, job, setJob, setError, pollAttempt);
  const working = busy || Boolean(job && !jobFinished(job));
  const nameLabel = device.kind === 'local' ? '本机名称' : '备注名称';
  const cancelName = () => { if (gate.current) return; setName(savedName); setEditingName(false); composingName.current = false; setError(''); };
  useEffect(() => { if (editingName) { nameInput.current?.focus(); nameInput.current?.select(); } else if (wasEditingName.current) editNameButton.current?.focus(); wasEditingName.current = editingName; }, [editingName]);
  useEffect(() => { if (job && jobFinished(job) && !jobFailed(job)) void Promise.resolve(onChanged()).catch(reason => setError(reason.message)); }, [job?.state, onChanged]);
  const execute = async (action, args = {}) => {
    if (gate.current) return; gate.current = true; setBusy(true); setError(''); setResult('');
    try {
      const value = await runtime.call(action, { deviceId: device.id, ...args });
      if (action === 'rename') { const next = value.device?.name || args.name; setSavedName(next); setName(next); setEditingName(false); await onChanged(); return; }
      if (action === 'remove') { onRemoved(device.id); return; }
      if (value.jobId) { setJob({ id: value.jobId, state: 'running', steps: [] }); setConfirm(''); setResult(''); return; }
      setResult(typeof value === 'string' ? value : value.logs || value.output || value.message || (value.status ? `服务状态：${value.status}` : '操作已完成')); setConfirm(''); await onChanged();
    } catch (reason) { setError(reason.message); } finally { gate.current = false; setBusy(false); }
  };
  const nameEditor = <div className="dc-name-field"><span>{nameLabel}</span><div className="dc-name-line">
    <Tooltip label={'编辑' + nameLabel}><button ref={editNameButton} type="button" className="dc-name-edit" aria-label={'编辑' + nameLabel} hidden={editingName} disabled={working} onClick={() => { setName(savedName); setEditingName(true); setError(''); }}><UIIcon name="edit" size={14} /></button></Tooltip>
    {editingName ? <form className="dc-name-form" onSubmit={event => { event.preventDefault(); if (!composingName.current && !working && name.trim()) { if (name.trim() === savedName) cancelName(); else void execute('rename', { name: name.trim() }); } }} onKeyDown={event => { if (composingName.current || event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); event.stopPropagation(); return; } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelName(); } }}>
      <input ref={nameInput} aria-label={nameLabel} value={name} maxLength={100} onCompositionStart={() => { composingName.current = true; }} onCompositionEnd={() => { composingName.current = false; }} onChange={event => setName(event.target.value)} disabled={working} />
      <Tooltip label="取消"><button type="button" className="dc-name-cancel" aria-label="取消修改名称" disabled={working} onClick={cancelName}><UIIcon name="close" size={15} /></button></Tooltip>
      <Tooltip label="确认"><button type="submit" className="dc-name-save" aria-label="确认修改名称" disabled={working || !name.trim()}><UIIcon name="check" size={15} /></button></Tooltip>
    </form> : <strong>{savedName}</strong>}
  </div></div>;
  return <><p className="dc-note">{deviceKind(device)} · {deviceStatus(device)}</p>{nameEditor}{device.kind === 'ssh' && <section className="dc-management"><h3>服务器</h3><div className="dc-service-actions">{[['status', '状态'], ['start', '启动'], ['restart', '重启'], ['stop', '停止'], ['logs', '日志'], ['update', '更新插件']].map(([operation, label]) => <Button key={operation} disabled={working} onClick={() => ['stop', 'restart', 'update'].includes(operation) ? setConfirm(operation) : void execute('serverAction', { operation })}>{label}</Button>)}</div><Button icon="refresh" disabled={working} onClick={() => setReconnecting(value => !value)}>重新连接隧道</Button>{reconnecting && <form onSubmit={event => { event.preventDefault(); void execute('reconnect', credentials.auth === 'key' ? { privateKey: credentials.privateKey, passphrase: credentials.passphrase } : { password: credentials.password }); setCredentials(emptyServer()); }}><div className="dc-form-grid"><Credentials form={credentials} setForm={setCredentials} disabled={working} /></div><div className="dc-actions"><Button primary type="submit" disabled={working}>连接</Button></div></form>}</section>}{confirm && confirm !== 'remove' && <div className="dc-confirm"><p>{confirm === 'stop' ? '停止服务器服务会中断远程工作台。' : confirm === 'restart' ? '重启时工作台会短暂断开。' : '更新服务器插件时工作台可能短暂断开。'}</p><Button disabled={working} onClick={() => setConfirm('')}>取消</Button><Button primary disabled={working} onClick={() => execute('serverAction', { operation: confirm })}>确认{confirm === 'stop' ? '停止' : confirm === 'restart' ? '重启' : '更新'}</Button></div>}{result && <pre className="dc-result" role="status">{String(result)}</pre>}<ErrorLine error={error} />{job && <><JobProgress job={job} />{jobFinished(job) && !jobFailed(job) && onOpenWorkbench && <div className="dc-actions"><Button primary onClick={() => onOpenWorkbench(job.device || device)}>重新打开工作台</Button></div>}{error && !jobFinished(job) && <Button onClick={() => { setError(''); setPollAttempt(value => value + 1); }}>重新检查进度</Button>}</>}{onCloseWorkbench && <section className="dc-management"><h3>工作台</h3><p className="dc-note">关闭页面会清除该页面尚未发送的内容，主机任务继续运行。</p><div className="dc-actions"><Button onClick={onCloseWorkbench}>关闭工作台页面</Button></div></section>}{device.kind !== 'local' && <section className="dc-remove"><h3>移除保存连接</h3><p className="dc-note">仅从此设备移除，不撤销授权，也不卸载或停止服务器。</p>{confirm === 'remove' ? <div className="dc-actions"><Button disabled={working} onClick={() => setConfirm('')}>取消</Button><Button danger disabled={working} onClick={() => execute('remove')}>确认移除</Button></div> : <Button danger icon="trash" disabled={working} onClick={() => setConfirm('remove')}>移除连接</Button>}</section>}</>;
}

export function DeviceCenter({ runtime = deviceRuntime }) {
  useLinkStyle();
  const [data, setData] = useState({ devices: [], capabilities: {} }), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(''), [modal, setModal] = useState(null), [showDevices, setShowDevices] = useState(true), [frames, setFrames] = useState([]), [activeId, setActiveId] = useState(null);
  const gate = useRef(false), frameElements = useRef(new Map());
  const [navigationReady, setNavigationReady] = useState([]);
  const [readyFrames, setReadyFrames] = useState([]);
  const [relayRevision, setRelayRevision] = useState(0);
  const [relayJob, setRelayJob] = useState(null);
  const [directoryTab, setDirectoryTab] = useState('devices'), [detailsTarget, setDetailsTarget] = useState(null);
  useEffect(() => {
    const receive = event => {
      const message = workbenchNavigationMessage(event, frames.map(frame => ({ ...frame, window: frameElements.current.get(frame.id)?.contentWindow })));
      if (!message) return;
      if (message.type === 'dsh-devices:ready') {
        const frame = frames.find(item => item.id === message.id);
        const name = data.devices.find(item => item.id === message.id)?.name || frame.name;
        event.source.postMessage({ type: 'dsh-devices:init', name }, new URL(frame.url).origin);
        setNavigationReady(items => items.includes(message.id) ? items : [...items, message.id]);
      } else if (message.type === 'dsh-devices:unready') setNavigationReady(items => items.filter(id => id !== message.id));
      else if (message.id === activeId && navigationReady.includes(message.id)) { setShowDevices(true); setError(''); }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [frames, data.devices, activeId, navigationReady]);
  const integratedNavigation = !showDevices && !modal && !error && navigationReady.includes(activeId);
  useEffect(() => {
    const parentOrigin = globalThis.__DSH_DEVICE_PARENT_ORIGIN__;
    if (parentOrigin && parent !== window) parent.postMessage({ type: 'dsh-devices:workbench-navigation', ready: integratedNavigation }, parentOrigin);
    return () => { if (parentOrigin && parent !== window) parent.postMessage({ type: 'dsh-devices:workbench-navigation', ready: false }, parentOrigin); };
  }, [integratedNavigation]);
  const frameLoaded = frame => {
    setReadyFrames(items => items.includes(frame.id) ? items : [...items, frame.id]);
    setNavigationReady(items => items.filter(id => id !== frame.id));
    frameElements.current.get(frame.id)?.contentWindow?.postMessage({ type: 'dsh-devices:probe' }, new URL(frame.url).origin);
  };
  useEffect(() => { const node = document.createElement('style'); node.textContent = css; document.head.append(node); return () => node.remove(); }, []);
  const refresh = useCallback(async () => { const next = await runtime.call('list'); setData(next); if (next.relayJob) setRelayJob(next.relayJob); setLoaded(true); return next; }, [runtime]);
  const relayChanged = useCallback(() => setRelayRevision(value => value + 1), []);
  useJob(runtime, modal?.type === 'relay' ? null : relayJob, setRelayJob, setError);
  const completedRelay = useRef('');
  useEffect(() => {
    if (!relayJob?.id || !jobFinished(relayJob) || completedRelay.current === relayJob.id) return;
    completedRelay.current = relayJob.id; relayChanged();
  }, [relayJob?.id, relayJob?.state, relayChanged]);
  useEffect(() => { const scanned = () => { const identity = runtime.bootstrap?.(); if (identity?.code && !identity.token) setModal({ type: 'add' }); }; window.addEventListener('link:bootstrap', scanned); scanned(); return () => window.removeEventListener('link:bootstrap', scanned); }, [runtime]);
  useEffect(() => { let closed = false; runtime.call('list').then(next => { if (!closed) { setData(next); if (next.relayJob) setRelayJob(next.relayJob); setLoaded(true); } }).catch(reason => { if (!closed) { setError(reason.message); setLoaded(true); } }); return () => { closed = true; }; }, [runtime]);
  const closeModal = useCallback(() => setModal(null), []);
  const canReturn = showDevices && !modal && !!(globalThis.__DSH_DEVICE_PARENT_ORIGIN__ || new URLSearchParams(location.search).get('parentOrigin'));
  const returnToWorkbench = useCallback(() => {
    const parentOrigin = globalThis.__DSH_DEVICE_PARENT_ORIGIN__ || new URLSearchParams(location.search).get('parentOrigin');
    if (parentOrigin && parent !== window) parent.postMessage({ type: 'dsh-devices:return-local' }, parentOrigin);
  }, []);
  const select = useCallback(async device => {
    if (!device?.id || gate.current) return;
    if (runtime.isNative() && device.kind === 'local') { setModal({ type: 'manage', device }); return; }
    if (!runtime.isNative() && device.kind !== 'local' && !frames.some(frame => frame.id === device.id) && frames.length >= 4) { setError('已保留 4 个工作台。请在设备设置中关闭暂不用的工作台页面，再打开新设备。'); return; }
    gate.current = true; setBusy(device.id); setError('');
    const openHere = !runtime.isNative() && device.kind !== 'local' && !frames.some(item => item.id === device.id);
    if (openHere) setShowDevices(false);
    try {
      const value = await runtime.call('select', { deviceId: device.id });
      if (!runtime.isNative()) {
        if (value.device?.kind === 'local') {
          const parentOrigin = globalThis.__DSH_DEVICE_PARENT_ORIGIN__ || new URLSearchParams(location.search).get('parentOrigin');
          if (parentOrigin && parent !== window) parent.postMessage({ type: 'dsh-devices:return-local' }, parentOrigin);
          setActiveId(null); setShowDevices(true);
        } else {
          if (!value.url) throw new Error('设备未返回工作台地址，请重新连接');
          const url = workbenchUrl(value.url, location.origin);
          if (!frames.some(frame => frame.id === device.id && new URL(frame.url).origin === new URL(url).origin)) setReadyFrames(items => items.filter(id => id !== device.id));
          setFrames(items => items.some(item => item.id === device.id) ? items.map(item => item.id === device.id && new URL(item.url).origin !== new URL(url).origin ? { ...item, name: device.name, url } : item) : [...items, { id: device.id, name: device.name, url }]);
          setActiveId(device.id); setShowDevices(false);
        }
      }
      setModal(null); await refresh();
    } catch (reason) { setError(reason.message); setModal(null); if (openHere) setShowDevices(true); } finally { gate.current = false; setBusy(''); }
  }, [runtime, refresh, frames]);
  const added = useCallback(async device => { const next = await refresh(); if (device?.id) await select(device); else { setModal(null); setShowDevices(true); setData(next); } }, [refresh, select]);
  const active = data.devices.find(item => item.id === activeId);
  // Keep the owner device in the same list so every device shares one scan path.
  const devices = [...data.devices].sort((left, right) => Number(right.kind === 'local') - Number(left.kind === 'local'));
  const currentLabel = device => activeId === device.id ? '当前打开的工作台' : device.kind === 'local' ? (runtime.isNative() ? '本机' : '本机工作台') : deviceStatus(device);
  const directoryKey = event => {
    const tabs = [...event.currentTarget.parentElement.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(event.currentTarget);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : -1;
    if (next < 0) return;
    event.preventDefault(); tabs[next].focus(); setDirectoryTab(tabs[next].dataset.tab);
  };
  const renderDevice = device => <article key={device.id} className={`dc-device ${activeId === device.id ? 'dc-selected' : ''}`}><button className="dc-device-open" disabled={!!busy} onClick={() => select(device)}><span className="dc-device-symbol"><UIIcon name={deviceIcon(device)} size={22} /></span><span className="dc-device-copy"><Tooltip label={device.name}><strong>{device.name}</strong></Tooltip><small>{deviceKind(device)}<span aria-hidden="true"> · </span><span data-status={device.status}>{busy === device.id ? '正在打开…' : currentLabel(device)}</span></small>{device.currentPath && <span className="dc-footnote">{device.currentPath === 'relay' ? '经我的中继' : '直连'}</span>}{device.warning && <span className="dc-device-error">{device.warning}</span>}{device.lastError && <span className="dc-device-error">{device.lastError}</span>}</span><UIIcon name={runtime.isNative() && device.kind === 'local' ? 'settings' : 'external'} size={16} /></button><Button icon="more" aria-label={`${device.name}设置`} onClick={() => setModal({ type: 'manage', device })} disabled={!!busy} /></article>;
  return <main className="dc-root">
    <header className={'dc-topbar' + (integratedNavigation ? ' dc-topbar-integrated' : '')}>
      <div className="dc-topbar-main">
        {canReturn && <Button className="dc-back" icon="chevronLeft" aria-label="返回工作台" onClick={returnToWorkbench} />}
        {!showDevices && <Button className="dc-back" icon="chevronLeft" aria-label="返回设备中心" title="返回设备中心" onClick={() => { setShowDevices(true); setError(''); }} />}
        <span className="dc-center-home"><UIIcon name="devices" size={16} />设备中心</span>
      </div>
      {activeId && <div className="dc-topbar-workbench"><Button icon="external" onClick={() => { setShowDevices(false); setError(''); }} aria-label={'返回' + (active?.name || '当前') + '工作台'}>{active?.name || '工作台'}</Button>{active && <Button icon="more" aria-label="当前设备设置" onClick={() => setModal({ type: 'manage', device: active })} />}</div>}
    </header>
    <div className="dc-surface" hidden={!showDevices}>
      <section className="dc-content">
        <ErrorLine error={error} />
        {!loaded && <DeviceLoading label="正在读取设备…" />}
        {loaded && data.capabilities?.hostAdmin && <section id="dc-panel-connection" className="dc-connection-panel" aria-label="连接">
          <div className="dc-section-heading"><h1>连接</h1></div><LinkSettings embedded management={runtime.hostCall} refreshToken={relayRevision} detailsTarget={detailsTarget} />
        </section>}
        {loaded && <div className="dc-directory-header"><div className="dc-directory-tabs" role="tablist" aria-label="设备与中继">
          <button type="button" id="dc-tab-devices" className="dc-directory-tab" role="tab" data-tab="devices" aria-controls="dc-panel-devices" aria-selected={directoryTab === 'devices'} tabIndex={directoryTab === 'devices' ? 0 : -1} onClick={() => setDirectoryTab('devices')} onKeyDown={directoryKey}>设备</button>
          {data.capabilities?.hostAdmin && <button type="button" id="dc-tab-relay" className="dc-directory-tab" role="tab" data-tab="relay" aria-controls="dc-panel-relay" aria-selected={directoryTab === 'relay'} tabIndex={directoryTab === 'relay' ? 0 : -1} onClick={() => setDirectoryTab('relay')} onKeyDown={directoryKey}>中继池</button>}
        </div></div>}
        <section id="dc-panel-devices" className="dc-device-directory" role="tabpanel" aria-labelledby="dc-tab-devices" hidden={!loaded || directoryTab !== 'devices'}>
          <div className="dc-section-heading"><h2>我的设备 <span className="dc-count">{devices.length}</span></h2><div className="dc-service-actions"><Button icon="refresh" aria-label="刷新设备" disabled={!!busy} onClick={() => { setError(''); refresh().catch(reason => setError(reason.message)); relayChanged(); }} /><Button primary onClick={() => setModal({ type: 'add' })}>添加设备</Button></div></div>
          <div className="dc-device-list">{devices.map(renderDevice)}</div>
          {loaded && !devices.length && !error && <p className="dc-note">尚未添加设备</p>}
          {data.capabilities?.ssh === false && <p className="dc-footnote">此客户端支持连接已有设备。SSH 安装请使用新版桌面或 Android 客户端。</p>}
          {loaded && data.capabilities?.hostAdmin && <div className="dc-connection-details link-settings" ref={setDetailsTarget} />}
        </section>
        {loaded && data.capabilities?.hostAdmin && <section id="dc-panel-relay" className="dc-relay-section" role="tabpanel" aria-labelledby="dc-tab-relay" hidden={directoryTab !== 'relay'}>
          <RelayPool runtime={runtime} refreshToken={relayRevision} active={showDevices && directoryTab === 'relay'} onChanged={relayChanged} onAdd={data.capabilities?.relayDeploy ? () => setModal({ type: 'relay' }) : undefined} />
          {relayJob && <div className="dc-relay-job-status"><span role="status">{jobFailed(relayJob) ? '中继部署失败' : jobFinished(relayJob) ? '中继部署完成' : '中继正在后台部署'}</span><Button onClick={() => setModal({ type: 'relay', progress: true })}>查看部署进度</Button></div>}
        </section>}
      </section>
    </div>
    <div className="dc-workbenches" hidden={showDevices} aria-busy={!!busy || !!(activeId && !readyFrames.includes(activeId))}>
      {frames.map(frame => <iframe key={frame.id} ref={element => { if (element) frameElements.current.set(frame.id, element); else frameElements.current.delete(frame.id); }} onLoad={() => frameLoaded(frame)} src={frame.url} title={frame.name + '工作台'} hidden={activeId !== frame.id} allow="clipboard-read; clipboard-write; microphone" referrerPolicy="no-referrer" />)}
      {!showDevices && !error && (!!busy || (activeId && !readyFrames.includes(activeId))) && <div className="dc-workbench-loading"><DeviceLoading label={busy ? '正在连接设备…' : '正在加载工作台…'} /></div>}
    </div>
    {!showDevices && error && <div className="dc-workbench-error"><ErrorLine error={error} /><Button onClick={() => setShowDevices(true)}>返回设备</Button></div>}
    {modal && <Sheet title={modal.type === 'add' ? '添加设备' : modal.type === 'relay' ? '添加中继' : modal.device.name} onClose={closeModal} busy={!!busy}>{modal.type === 'relay' ? <RelayWizard initialTab={modal.progress ? 'deploy' : 'connect'} runtime={runtime} onClose={closeModal} job={relayJob} setJob={setRelayJob} onChanged={async () => { relayChanged(); setDirectoryTab('relay'); setModal(null); setShowDevices(true); }} /> : modal.type === 'add' ? <AddDevice runtime={runtime} onAdded={added} sshAvailable={data.capabilities?.ssh !== false} /> : <ManageDevice device={modal.device} runtime={runtime} onChanged={refresh} onOpenWorkbench={select} onCloseWorkbench={(runtime.isNative() || frames.some(frame => frame.id === modal.device.id)) && modal.device.kind !== 'local' ? () => { if (runtime.isNative()) { void runtime.call('closeWorkbench', { deviceId: modal.device.id }).catch(reason => setError(reason.message)); } setFrames(items => items.filter(frame => frame.id !== modal.device.id)); if (activeId === modal.device.id) { setActiveId(null); setShowDevices(true); } setModal(null); } : undefined} onRemoved={id => { setFrames(items => items.filter(frame => frame.id !== id)); if (activeId === id) { setActiveId(null); setShowDevices(true); } setModal(null); void refresh().catch(reason => setError(reason.message)); }} />}</Sheet>}
  </main>;
}
