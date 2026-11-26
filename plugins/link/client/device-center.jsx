import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import { Select } from '../../shared/client/select.jsx';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { UIIcon } from '../../base/client/iconsax.jsx';
import { deviceRuntime } from './device-runtime.mjs';
import { deviceIcon, deviceKind, deviceStatus, jobFailed, jobFinished, sshCredentials, sshInput, workbenchUrl } from './device-state.mjs';
import { workbenchNavigationMessage } from './device-navigation.mjs';
import { deviceSwitchFrameMessage } from './device-switch.mjs';
import { observeHostTheme, sendWorkbenchTheme, themedWorkbenchUrl } from './device-theme.mjs';
import { LinkSettings, PairingDialog, useLinkStyle } from './app.jsx';
import css from './device-center.css';
import { DeviceLoading } from './device-loading.jsx';
import { LocalAppUpdates } from './local-app-updates.jsx';
import { ServerTerminal } from './server-terminal.jsx';
import { BrandLogo } from './brand.jsx';
import { Loading, LoadingText } from '../../shared/client/ui/loading.jsx';

function Button({ children, icon, primary, danger, title, className = '', ...props }) { return <Tooltip label={title}><button type="button" className={`dc-button ${primary ? 'dc-primary' : ''} ${danger ? 'dc-danger' : ''} ${className}`.trim()} {...props}>{icon === 'terminal' ? <span className="dc-terminal-icon" aria-hidden="true">&gt;_</span> : icon && <UIIcon name={icon} size={16} />}{children}</button></Tooltip>; }
function ErrorLine({ error }) { return error ? <p className="dc-error" role="alert">{error}</p> : null; }
const relayDataClosed = '中继数据通道已关闭';
const serverStatusIcons = { online: 'check', connected: 'check', connecting: 'refresh', offline: 'close', failed: 'close', disconnected: 'close', 'auth-required': 'key' };
function ServerStatus({ device, opening }) {
  const status = opening ? 'connecting' : device.status;
  const label = opening ? '正在打开' : deviceStatus(device) || '待检查';
  const icon = serverStatusIcons[status];
  return <span className="dc-server-status" data-status={status} role="img" aria-label={label} title={label}>
    {icon && <UIIcon name={icon} size={14} />}
  </span>;
}
function ConnectionTest({ result }) { return result ? <p className={`dc-test-result ${result.ok ? 'is-success' : 'is-failed'}`} role="status"><UIIcon name={result.ok ? 'check' : 'close'} size={15} />{result.message || result.error}{result.ok && Number.isFinite(result.latencyMs) && <span>{result.latencyMs} ms</span>}</p> : null; }
function Field({ label, children, full }) { return <label className={`dc-field ${full ? 'dc-field-full' : ''}`}><span>{label}</span>{children}</label>; }

function Sheet({ title, children, onClose, busy, terminal = false }) {
  const box = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    box.current?.querySelector('input,button,textarea,select')?.focus();
    const key = event => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' && !busy && !event.target.closest?.('.xterm')) { event.preventDefault(); onClose(); }
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
  return <div className="dc-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className={terminal ? 'dc-sheet dc-terminal-sheet' : 'dc-sheet'} role="dialog" aria-modal="true" aria-labelledby="dc-dialog-title" ref={box}><header><h2 id="dc-dialog-title">{title}</h2><Button icon="close" aria-label="关闭" onClick={onClose} disabled={busy} /></header>{children}</section></div>;
}

function AddComputer({ runtime, onAdded }) {
  const [uri, setUri] = useState(''), [error, setError] = useState(''), [phase, setPhase] = useState('idle');
  const operation = useRef(0), timer = useRef(), mounted = useRef(true), lastScan = useRef(''), inFlight = useRef(''), request = useRef(null);
  const complete = useRef(onAdded);
  useEffect(() => { complete.current = onAdded; }, [onAdded]);
  const connect = useCallback(async input => {
    if (!input.trim()) { setError('请粘贴目标设备的连接信息'); return; }
    if (inFlight.current === input.trim()) return;
    inFlight.current = input.trim();
    const generation = ++operation.current; clearTimeout(timer.current); setError(''); setPhase('sending'); setUri(input);
    try {
      const current = request.current;
      const result = current?.input === input.trim() && (current.expiresAt === undefined || current.expiresAt > Date.now()) ? current : await runtime.call('pair', { uri: input.trim(), name: runtime.clientName(), joinGroup: !runtime.isNative() });
      if (!mounted.current || operation.current !== generation) return;
      request.current = { ...result, input: input.trim() };
      setPhase('pending');
      const poll = async () => {
        if (!mounted.current || operation.current !== generation) return;
        try {
          const status = await runtime.call('pairStatus', { requestId: result.requestId });
          if (!mounted.current || operation.current !== generation) return;
          if (status.status === 'approved') { request.current = null; setPhase('approved'); await complete.current(status.device); return; }
          if (['rejected', 'expired', 'revoked'].includes(status.status)) { request.current = null; throw new Error(status.status === 'rejected' ? '目标设备未允许连接，请生成新的连接信息' : '配对已过期，请重新扫码或粘贴地址'); }
          timer.current = setTimeout(poll, 1500);
        } catch (reason) { if (mounted.current && operation.current === generation) { inFlight.current = ''; setError(reason.message); setPhase('failed'); } }
      };
      timer.current = setTimeout(poll, 700);
    } catch (reason) { if (mounted.current && operation.current === generation) { inFlight.current = ''; setError(reason.message); setPhase('failed'); } }
  }, [runtime]);
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
  return <><form onSubmit={event => { event.preventDefault(); if (!waiting) void connect(uri); }}><Field label="连接信息"><textarea autoCapitalize="off" autoCorrect="off" spellCheck={false} rows={3} placeholder="benchgo://pair?…" value={uri} disabled={waiting} onChange={event => { setUri(event.target.value); setError(''); }} /></Field><ErrorLine error={error} />{waiting && <Loading className="dc-progress-message" compact label={phase === 'sending' ? '正在发送连接请求…' : phase === 'approved' ? '已允许，正在打开…' : '请在目标设备上允许连接'} />}<div className="dc-actions">{runtime.isNative() && <Button icon="scan" onClick={() => runtime.scan()} disabled={phase === 'sending'}>扫码连接</Button>}<Button type="submit" primary disabled={waiting || !uri.trim()}>{phase === 'failed' ? '重试连接' : '连接设备'}</Button></div></form></>;
}

const emptyServer = () => ({ name: '', host: '', port: '22', username: '', auth: 'password', password: '', privateKey: '', passphrase: '', source: 'mirror' });
const relayDomainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
function relayAdvancedError({ relayPort, email, webroot, sslMode, challengeMode }) {
  if (!Number.isInteger(relayPort) || relayPort < 20000 || relayPort > 49151) return '中继端口须为 20000–49151';
  if (email && !/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/.test(email)) return '请输入有效联系邮箱';
  if (challengeMode !== 'webroot') return '';
  if (!webroot && sslMode === 'domain') return '';
  if (!webroot.startsWith('/') || /[\x00-\x1f]/.test(webroot) || webroot.split('/').includes('..')) return '请填写现有反向代理的绝对 webroot 路径';
  return '';
}
function Credentials({ form, setForm, disabled, agentAvailable = false }) {
  const field = key => ({ value: form[key], disabled, onChange: event => setForm(value => ({ ...value, [key]: event.target.value })) });
  return <><Field label="认证方式" full><Select {...field('auth')}>{agentAvailable && <option value="agent">本机 SSH agent</option>}<option value="password">密码</option><option value="key">SSH 私钥</option></Select></Field>{form.auth === 'password' ? <Field label="密码" full><input type="password" autoComplete="off" {...field('password')} /></Field> : form.auth === 'key' && <><Field label="SSH 私钥" full><textarea rows={4} autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" {...field('privateKey')} /></Field><Field label="私钥口令（可选）" full><input type="password" autoComplete="off" {...field('passphrase')} /></Field></>}</>;
}
function JobProgress({ job, label = '正在准备服务器工作台…', pollingError = '' }) {
  return <div className="dc-job" aria-live="polite"><ol>{(job.steps || []).map((step, index) => { const item = typeof step === 'string' ? { label: step } : step; return <li key={item.id || index} data-state={item.state || item.status || 'pending'}><span className="dc-step-icon">{['done', 'completed', 'success'].includes(item.state || item.status) ? <UIIcon name="check" size={14} /> : index + 1}</span><div>{item.label || item.name || item.title || item.id}{item.message && <small>{item.message}</small>}</div></li>; })}</ol>{!jobFinished(job) && !pollingError && <Loading className="dc-progress-message" compact label={label} />}{pollingError && <Loading className="dc-progress-message" compact label="进度获取失败，正在重试…" />}{job.state === 'cancelled' ? <p className="dc-note" role="status">资源准备已取消</p> : <ErrorLine error={job.error} />}</div>;
}
function useJob(runtime, job, setJob, setError, attempt = 0) {
  useEffect(() => {
    if (!job?.id || jobFinished(job)) return;
    let closed = false, timer;
    const poll = async () => {
      try {
        const next = await runtime.call('job', { jobId: job.id });
        if (!closed) { setError(''); setJob({ ...job, ...next, id: next.id || job.id }); if (!jobFinished(next)) timer = setTimeout(poll, 1000); }
      } catch (reason) { if (!closed) { setError(reason.message); timer = setTimeout(poll, 3000); } }
    };
    timer = setTimeout(poll, 400); return () => { closed = true; clearTimeout(timer); };
  }, [runtime, job?.id, job?.state, setJob, setError, attempt]);
}
function AddDevice({ runtime, onAdded, sshAvailable, agentAvailable }) {
  const [path, setPath] = useState('existing');
  return <><SegmentedControl label="添加方式" value={path} onChange={setPath} tabIdPrefix="dc-add" options={[{ value: 'existing', label: '连接已有设备', panelId: 'dc-add-existing-panel' }, { value: 'server', label: '添加服务器', panelId: 'dc-add-server-panel' }]} /><div id="dc-add-existing-panel" role="tabpanel" aria-labelledby="dc-add-existing" hidden={path !== 'existing'}><AddComputer runtime={runtime} onAdded={onAdded} /></div><div id="dc-add-server-panel" role="tabpanel" aria-labelledby="dc-add-server" hidden={path !== 'server'}><ServerInstall runtime={runtime} onAdded={onAdded} sshAvailable={sshAvailable} agentAvailable={agentAvailable} /></div></>;
}
const serverInstallDownload = 'https://benchgo.cn/api/x/install/linux.sh';
const serverInstallCommand = `installer=$(curl -fsSL '${serverInstallDownload}') && bash -c "$installer"`;
function ServerInstall({ runtime, onAdded, sshAvailable, agentAvailable }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  const copy = async () => {
    try { await navigator.clipboard.writeText(serverInstallCommand); setCopied(true); setError(''); }
    catch { setError('复制失败，请选中命令复制'); }
  };
  return <>
    {sshAvailable && <AddServer runtime={runtime} onAdded={onAdded} agentAvailable={agentAvailable} />}
    <Disclosure title="手动安装" className="dc-management" defaultOpen={!sshAvailable}>
      <p className="dc-note">在 Linux x64 服务器上以普通用户运行。</p>
      <pre className="dc-install-command"><code>{serverInstallCommand}</code></pre>
      <ErrorLine error={error} />
      <div className="dc-actions">
        <Button onClick={copy}>{copied ? '已复制' : '复制'}</Button>
        <a className="dc-button" href={serverInstallDownload} download="install-server.sh">下载</a>
      </div>
    </Disclosure>
  </>;
}
function AddServer({ runtime, onAdded, device, agentAvailable }) {
  const [form, setForm] = useState(() => ({ ...emptyServer(), ...(device ? { name: device.name } : {}) })), [job, setJob] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const gate = useRef(false), mounted = useRef(true);
  const [pollAttempt, setPollAttempt] = useState(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useJob(runtime, job, setJob, setError, pollAttempt);
  const submit = async () => {
    if (gate.current) return; gate.current = true; setBusy(true); setError('');
    try {
      const input = sshInput(form);
      if (form.auth === 'password' && !input.password) throw new Error('请输入密码');
      if (form.auth === 'key' && !input.privateKey?.trim()) throw new Error('请输入 SSH 私钥');
      const result = await runtime.call('sshConnect', { ...input, ...(device ? { deviceId: device.id } : {}) });
      if (mounted.current) {
        setJob({ id: result.jobId, state: 'running', steps: [] });
        setForm(value => ({ ...value, password: '', privateKey: '', passphrase: '' }));
      }
    } catch (reason) { if (mounted.current) setError(reason.message); }
    finally { gate.current = false; if (mounted.current) setBusy(false); }
  };
  const prepareResources = async () => {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError('');
    try {
      const result = await runtime.call('serverPrefetch', { source: form.source });
      if (mounted.current) setJob({ id: result.jobId, kind: 'server-prefetch', state: 'running', steps: [], cancellable: true });
    } catch (reason) { if (mounted.current) setError(reason.message); }
    finally { gate.current = false; if (mounted.current) setBusy(false); }
  };
  const cancelJob = async () => {
    if (gate.current || !job?.cancellable || jobFinished(job)) return;
    gate.current = true; setBusy(true); setError('');
    try {
      await runtime.call('jobCancel', { jobId: job.id });
      if (mounted.current) { setJob(value => ({ ...value, cancellable: false })); setPollAttempt(value => value + 1); }
    } catch (reason) { if (mounted.current) setError(reason.message); }
    finally { gate.current = false; if (mounted.current) setBusy(false); }
  };
  const resetJob = () => { setJob(null); setError(''); };
  const field = key => ({ value: form[key], disabled: busy, onChange: event => { setForm(value => ({ ...value, [key]: event.target.value })); setError(''); } });
  if (job) {
    const prefetch = job.kind === 'server-prefetch', cancelled = job.state === 'cancelled';
    const ready = jobFinished(job) && !jobFailed(job) && !cancelled;
    return <>
      <p className="dc-note">{prefetch ? '准备部署资源' : form.name || form.host}</p>
      <JobProgress job={job} pollingError={!jobFinished(job) ? error : ''} label={prefetch ? '正在准备部署资源…' : undefined} />
      {prefetch && ready && <p className="dc-note" role="status">部署资源已就绪</p>}
      {job.device?.warning && <p className="dc-note" role="status">{job.device.warning}</p>}
      <ErrorLine error={error} />
      <div className="dc-actions">
        {!jobFinished(job) && job.cancellable === true && <Button disabled={busy} onClick={cancelJob}>{busy ? '正在取消…' : '取消'}</Button>}
        {jobFailed(job) && prefetch && <Button primary disabled={busy} onClick={prepareResources}>重试</Button>}
        {(jobFailed(job) || cancelled) && <Button disabled={busy} onClick={resetJob}>返回</Button>}
        {ready && <Button primary onClick={prefetch ? resetJob : () => onAdded(job.device)}>{prefetch ? '继续安装' : device ? '完成绑定' : '打开工作台'}</Button>}
        {!jobFinished(job) && error && <Button disabled={busy} onClick={() => { setError(''); setPollAttempt(value => value + 1); }}>刷新进度</Button>}
      </div>
    </>;
  }
  return <><form onSubmit={event => { event.preventDefault(); void submit(); }}><div className="dc-form-grid">{!device && <Field label="名称（可选）" full><input placeholder="例如：开发服务器" maxLength={100} {...field('name')} /></Field>}<Field label="服务器地址"><input required placeholder="IP 或域名" autoCapitalize="off" autoCorrect="off" {...field('host')} /></Field><Field label="SSH 端口"><input required inputMode="numeric" type="number" min="1" max="65535" {...field('port')} /></Field><Field label="用户名" full><input required placeholder="root / ubuntu" autoCapitalize="off" autoCorrect="off" autoComplete="off" {...field('username')} /></Field><Credentials form={form} setForm={setForm} disabled={busy} agentAvailable={agentAvailable} />{!device && <Field label="下载源" full><Select {...field('source')}><option value="mirror">国内加速（默认）</option><option value="github">官方直连</option></Select></Field>}</div>
    <ErrorLine error={error} />
    <div className="dc-actions">{!device && <Button title="准备离线部署资源" disabled={busy} onClick={prepareResources}>准备部署资源</Button>}<Button primary type="submit" disabled={busy}>{busy ? '正在连接…' : device ? '连接 SSH' : '添加服务器'}</Button></div>
  </form></>;
}

function RelayWizard({ runtime, onChanged, onPoolChanged, onClose, canDeploy = true, agentAvailable = false, job: savedJob, setJob: saveJob }) {
  const [tab, setTab] = useState(canDeploy ? 'deploy' : 'connect');
  const [advanced, setAdvanced] = useState(false);
  const [localJob, setLocalJob] = useState(null);
  const job = saveJob ? savedJob : localJob, setJob = saveJob || setLocalJob;
  const [form, setForm] = useState(() => ({ ...emptyServer(), username: 'root', ...(agentAvailable ? { auth: 'agent' } : {}), sslMode: 'auto', domain: '', publicIp: '', email: '', relayPort: '24680', challengeMode: 'standalone', webroot: '' }));
  const [fingerprint, setFingerprint] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0), [confirm, setConfirm] = useState(false);
  const [connection, setConnection] = useState({ url: '', token: '' }), [connectionTest, setConnectionTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const mounted = useRef(true), gate = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useJob(runtime, job, setJob, setError, attempt);
  const working = busy || Boolean(job && !jobFinished(job));
  const serverAddress = form.host.trim();
  const sslMode = form.sslMode === 'auto' ? (relayDomainPattern.test(serverAddress) ? 'domain' : 'ip') : form.sslMode;
  const challengeMode = sslMode === 'domain' ? 'webroot' : form.challengeMode;
  const dismissJob = async () => {
    const current = job;
    setJob(null); setFingerprint(''); setError('');
    if (current?.id) try { await runtime.call('relayJobDismiss', { jobId: current.id }); } catch (reason) { if (mounted.current) setError(reason.message); }
  };
  const field = key => ({ value: form[key], disabled: working, onChange: event => { setForm(value => ({ ...value, [key]: event.target.value })); if (['host', 'port', 'username'].includes(key)) setFingerprint(''); setError(''); } });
  const deploy = async () => {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError('');
    try {
      const domain = sslMode === 'domain' ? (form.sslMode === 'auto' ? serverAddress : form.domain.trim()) : '';
      if (sslMode === 'domain' && (domain.length > 253 || !relayDomainPattern.test(domain))) {
        setAdvanced(true);
        throw new Error('请输入有效域名，例如 relay.example.com');
      }
      const relayPort = Number(form.relayPort);
      const email = form.email.trim();
      const webroot = form.webroot.trim();
      const advancedError = relayAdvancedError({ relayPort, email, webroot, sslMode, challengeMode });
      if (advancedError) {
        setAdvanced(true);
        throw new Error(advancedError);
      }
      const publicIp = form.publicIp.trim() || (relayDomainPattern.test(serverAddress) ? '' : serverAddress.replace(/^\[|\]$/g, ''));
      const input = { ...sshInput(form), sslMode, domain, publicIp, email, relayPort, challengeMode, ...(challengeMode === 'webroot' ? { webroot } : {}) };
      if (!fingerprint) {
        const value = await runtime.call('relayProbe', { host: input.host, port: input.port, username: input.username });
        if (mounted.current) setFingerprint(value.fingerprint);
        return;
      }
      const value = await runtime.call('relayDeploy', { ...input, fingerprint });
      const nextJob = { id: value.jobId, operation: 'deploy', state: 'running', steps: [] };
      if (!mounted.current) {
        if (saveJob) saveJob(nextJob);
        return;
      }
      setConfirm(false);
      setForm(value => ({ ...value, password: '', privateKey: '', passphrase: '' }));
      setJob(nextJob);
    } catch (reason) {
      if (mounted.current) {
        if (reason.message === '请输入服务器实际公网 IP') setAdvanced(true);
        setError(reason.message);
      }
    }
    finally { gate.current = false; if (mounted.current) setBusy(false); }
  };
  const deployedUrl = job && jobFinished(job) && !jobFailed(job) ? job.relay?.url : '';
  const [host, setHost] = useState(null), [pairing, setPairing] = useState(null), [hostAttempt, setHostAttempt] = useState(0);
  const [pairingAction, setPairingAction] = useState('');
  const deployedNode = host?.relay?.nodes?.find(node => node.url === deployedUrl);
  useEffect(() => {
    if (!deployedUrl) return;
    let closed = false, timer, checks = 0;
    const poll = async () => {
      checks++;
      try {
        const value = await runtime.hostCall('hostStatus');
        if (closed) return;
        setHost(value);
        const node = value.relay?.nodes?.find(item => item.url === deployedUrl);
        if (pairing || (!node?.connected && node?.enabled !== false && checks < 20)) timer = setTimeout(poll, 1500);
      }
      catch (reason) { if (!closed) setError(reason.message); }
    };
    void poll(); return () => { closed = true; clearTimeout(timer); };
  }, [runtime, deployedUrl, hostAttempt, !!pairing]);
  const confirmPairing = async (id, action) => {
    if (gate.current) return;
    gate.current = true; setPairingAction(action); setError('');
    try { const value = await runtime.call(action === 'confirm' ? 'hostConfirm' : 'hostReject', { id }); if (mounted.current) setHost(value); }
    catch (reason) { if (mounted.current) setError(reason.message); }
    finally { gate.current = false; if (mounted.current) setPairingAction(''); }
  };
  const toggleHost = async () => {
    if (!deployedNode || gate.current) return;
    gate.current = true; setBusy(true); setError('');
    try {
      const value = await runtime.hostCall('hostRelayPoolConfigure', { operation: 'update', id: deployedNode.id, enabled: deployedNode.enabled === false, expected: { fingerprint: host.relay.fingerprint } });
      onPoolChanged?.();
      if (mounted.current) { setHost(value); setPairing(null); setConfirm(false); setHostAttempt(value => value + 1); }
    }
    catch (reason) { if (mounted.current) setError(reason.message); }
    finally { gate.current = false; if (mounted.current) setBusy(false); }
  };
  const pair = async () => {
    if (!deployedNode?.connected || gate.current) return;
    gate.current = true; setBusy(true); setError('');
    try { const value = await runtime.call('hostPairing', { mode: 'relay', relayId: deployedNode.id }); if (mounted.current) setPairing(value); }
    catch (reason) { if (mounted.current) setError(reason.message); }
    finally { gate.current = false; if (mounted.current) setBusy(false); }
  };
  const connectRelay = async event => {
    event.preventDefault();
    if (gate.current) return;
    gate.current = true; setBusy(true); setError('');
    try {
      const current = await runtime.hostCall('hostStatus');
      await runtime.hostCall('hostRelayPoolConfigure', {
        operation: 'add', id: 'relay-' + globalThis.crypto.randomUUID(), url: connection.url.trim(),
        token: connection.token.trim(), expected: { fingerprint: current.relay.fingerprint },
      });
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
  return <>{canDeploy && <div className="dc-relay-tabs" role="group" aria-label="中继添加方式"><Button primary={tab === 'connect'} aria-pressed={tab === 'connect'} disabled={working} onClick={() => { setTab('connect'); setError(''); }}>连接</Button><Button primary={tab === 'deploy'} aria-pressed={tab === 'deploy'} disabled={working} onClick={() => { setTab('deploy'); setError(''); }}>部署</Button></div>}
    {tab === 'connect' ? <><p className="dc-note">已有中继服务？填写中继地址和主机密钥，让本机直接接入。</p><form onSubmit={connectRelay}><div className="dc-form-grid"><Field label="中继 HTTPS 地址" full><input name="url" required type="url" placeholder="https://relay.example.com:24680" autoCapitalize="off" autoCorrect="off" {...connectionField('url')} /></Field><Field label="中继主机密钥" full><input name="token" required type="password" autoComplete="off" placeholder="粘贴中继服务生成的密钥" {...connectionField('token')} /></Field></div><p className="dc-footnote">主机密钥只用于本机接入，不会显示在中继列表中。</p>{testing && <Loading className="dc-progress-message" compact label="正在测试连接…" />}<ConnectionTest result={connectionTest} /><ErrorLine error={error} /><div className="dc-actions"><Button icon="refresh" onClick={testConnection} disabled={busy || !connection.url.trim() || !connection.token.trim()}>测试</Button><Button primary type="submit" disabled={busy}>{busy ? '处理中…' : '接入'}</Button></div></form></> : <><p className="dc-note">在你信任的 Linux 服务器安装连接中继，让当前主机主动接入。中继可读取转发的工作台内容，请仅使用自己的服务器。</p>
     {job && !deployedUrl && <><JobProgress job={job} pollingError={!jobFinished(job) ? error : ''} label="正在后台部署中继…" />{!jobFinished(job) && <><p className="dc-footnote">关闭窗口后，部署会在后台继续。</p><div className="dc-actions">{error && <Button onClick={() => { setError(''); setAttempt(value => value + 1); }}>刷新进度</Button>}{onClose && <Button onClick={onClose}>后台执行</Button>}</div></>}{jobFailed(job) && <div className="dc-actions"><Button primary onClick={() => void dismissJob()}>返回</Button></div>}</>}
     {deployedUrl && <div className="dc-relay-success">
       <strong>中继已部署</strong><code>{deployedUrl}</code>
       <p className="dc-note" role="status">{!host ? '正在检查本机接入…' : !deployedNode ? '本机未登记此节点' : deployedNode.enabled === false ? '本机已停用此节点' : deployedNode.connected ? '本机已接入此节点' : deployedNode.lastError && deployedNode.lastError !== relayDataClosed ? '本机接入失败 · ' + deployedNode.lastError : '本机正在接入此节点…'}</p>
       <p className="dc-note">跨网访问待验证。请从另一网络打开工作台。</p>
       <div className="dc-actions">
         <Button disabled={busy} onClick={() => { setError(''); setHostAttempt(value => value + 1); }}>刷新状态</Button>
         {deployedNode && <Button disabled={busy} onClick={() => deployedNode.enabled === false ? void toggleHost() : setConfirm(true)}>{deployedNode.enabled === false ? '启用' : '停用'}</Button>}
         <Button primary disabled={busy || !deployedNode?.connected} onClick={pair}>生成连接信息</Button>
       </div>
       {confirm && <div className="dc-confirm"><p>停用此节点将断开经此节点访问本机的连接。</p><div className="dc-actions"><Button disabled={busy} onClick={() => setConfirm(false)}>取消</Button><Button danger disabled={busy} onClick={toggleHost}>确认停用</Button></div></div>}
       {pairing && <PairingDialog pairing={pairing} pending={host?.pending || []} onClose={() => { if (!pairingAction) setPairing(null); }} onConfirm={confirmPairing} busy={pairingAction} error={error} />}
     </div>}
     {!job && <form onSubmit={event => { event.preventDefault(); void deploy(); }}><div className="dc-form-grid">
      <Field label="服务器地址" full><input required placeholder="公网 IP 或域名" autoCapitalize="off" autoCorrect="off" {...field('host')} /></Field>
      <Credentials form={form} setForm={setForm} disabled={working} agentAvailable={agentAvailable} />
    </div>
    <Disclosure className="dc-relay-advanced" title="高级设置" open={advanced} onOpenChange={setAdvanced}>
      <div className="dc-form-grid">
        <Field label="SSH 用户名"><input required placeholder="例如 root 或 ubuntu" autoCapitalize="off" autoComplete="off" {...field('username')} /></Field>
        <Field label="SSH 端口"><input required type="number" min="1" max="65535" {...field('port')} /></Field>
        <Field label="证书模式" full><Select {...field('sslMode')}><option value="auto">自动</option><option value="ip">IP SSL</option><option value="domain">域名 SSL</option></Select></Field>
        {form.sslMode === 'domain' && <Field label="中继域名" full><input required placeholder="relay.example.com" autoCapitalize="off" {...field('domain')} /></Field>}
        <Field label="服务器公网 IP"><input placeholder="默认使用服务器地址" autoCapitalize="off" {...field('publicIp')} /></Field>
        <Field label="中继业务端口"><input required type="number" min="20000" max="49151" {...field('relayPort')} /></Field>
        <Field label="证书通知邮箱（选填）" full><input type="email" autoComplete="email" placeholder="用于接收证书续期通知" {...field('email')} /></Field>
        {sslMode === 'ip' && <Field label="证书验证方式" full><Select {...field('challengeMode')}><option value="standalone">自动验证</option><option value="webroot">使用已有站点目录</option></Select></Field>}
        {challengeMode === 'webroot' && <Field label="证书验证目录" full><input required={sslMode === 'ip'} placeholder={sslMode === 'domain' ? `/www/wwwroot/${form.domain || serverAddress || 'relay.example.com'}` : '/var/www/acme'} {...field('webroot')} /></Field>}
      </div>
    </Disclosure>
    <p className="dc-footnote">BenchGo 会申请证书、生成中继密钥，并在启用的 UFW 中放行 {form.relayPort}/TCP。证书验证需要公网 80 端口可达。</p>
    {fingerprint && <div className="dc-fingerprint"><strong role="status">请核对服务器的 SSH 指纹</strong><code>{fingerprint}</code></div>}
    <ErrorLine error={error} />
    <div className="dc-actions"><a className="dc-button" href="https://benchgo.cn/docs/linux-server" target="_blank" rel="noreferrer">部署指南</a><Button primary type="submit" disabled={working}>{busy ? '正在连接…' : fingerprint ? '确认并部署' : '检查服务器'}</Button></div>
    </form>}
     {job && <ErrorLine error={error} />}</>}
  </>;
}

function RelayPool({ runtime, refreshToken = 0, active = true, currentDevice, onAdd, onChanged }) {
  const [status, setStatus] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [editing, setEditing] = useState(null);
  const [statusError, setStatusError] = useState(''), [refreshing, setRefreshing] = useState(false);
  const [tests, setTests] = useState({});
  const [draftTest, setDraftTest] = useState(null);
  const [testing, setTesting] = useState('');
  const [receipt, setReceipt] = useState(null), [feedback, setFeedback] = useState('');
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
  const fingerprint = status?.relay?.fingerprint;
  const applyReceipt = value => {
    if (value.state === 'applying' || value.state === 'unknown') {
      setError(value.state === 'applying' ? '修改正在保存，请稍后查询。' : '保存结果待核实，请刷新中继状态核对。');
      return false;
    }
    setReceipt(null);
    if (value.state !== 'applied') { setError(value.error?.message || '未能保存中继设置'); return false; }
    setFeedback(value.result?.application?.reason || '中继设置已保存');
    return true;
  };
  const checkReceipt = async () => {
    if (gate.current || !receipt) return;
    gate.current = true; setBusy(true); setError('');
    try { applyReceipt(await runtime.hostCall('hostRelayOperation', { requestId: receipt })); await load(); }
    catch (reason) {
      if (reason.code === 'NOT_FOUND') { setReceipt(null); await load(); }
      setError(reason.message);
    } finally { gate.current = false; setBusy(false); }
  };
  const save = async (change, expected = fingerprint) => {
    if (gate.current || receipt) return false;
    gate.current = true; setBusy(true); setError(''); setFeedback('');
    const requestId = runtime.paired ? crypto.randomUUID() : undefined;
    try {
      const value = await runtime.hostCall('hostRelayPoolConfigure', { ...change, expected: { fingerprint: expected }, ...(requestId ? { requestId } : {}) });
      if (requestId) {
        const saved = applyReceipt(value);
        if (value.state === 'applying') setReceipt(requestId);
        await load();
        if (!saved) return false;
      } else { ++request.current; setStatus(value); }
      onChanged?.(); return true;
    } catch (reason) {
      if (requestId && (!reason.status || reason.status >= 500)) { setReceipt(requestId); setError('连接中断，保存结果待查询。'); }
      else setError(reason.message);
      return false;
    }
    finally { gate.current = false; setBusy(false); }
  };
  const refreshStatus = async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  };
  const closeEdit = useCallback(() => { if (!gate.current) setEditing(null); }, []);
  const edit = node => { setError(''); setDraftTest(null); setEditing({ id: node.id, baseUrl: node.url, url: node.url, token: '', fingerprint }); };
  const newAddress = Boolean(editing && editing.baseUrl !== editing.url.trim());
  const latestNode = editing && nodes.find(node => node.id === editing.id);
  const staleEdit = Boolean(editing && editing.fingerprint !== fingerprint);
  const testNode = async (node, draft = false) => {
    if (gate.current) return;
    gate.current = true; setBusy(true); setTesting(draft ? 'draft' : node.id);
    const updateTest = (result, checkedAt = null) => {
      if (draft) setDraftTest(result);
      else setTests(value => ({ ...value, [node.id]: { url: node.url, result, checkedAt } }));
    };
    updateTest(null);
    try {
      const input = draft ? { ...(newAddress ? {} : { id: node.id }), url: node.url.trim(), ...(node.token.trim() ? { token: node.token.trim() } : {}) } : { id: node.id };
      updateTest(await runtime.hostCall('relayTest', input), Date.now());
    } catch (reason) { updateTest({ ok: false, error: reason.message }); }
    finally { gate.current = false; setBusy(false); setTesting(''); }
  };
  const saveEdit = async event => {
    event.preventDefault();
    const { id, token, url } = editing;
    if (!url.trim() || staleEdit || (newAddress && !token.trim())) return;
    if (!newAddress && !token.trim()) { closeEdit(); return; }
    if (await save({ operation: 'update', id, ...(newAddress ? { url: url.trim() } : {}), ...(token.trim() ? { token: token.trim() } : {}) }, editing.fingerprint)) {
      setTests(value => Object.fromEntries(Object.entries(value).filter(([nodeId]) => nodeId !== id)));
      setEditing(null);
    }
  };
  const editField = key => ({ value: editing[key], disabled: busy, onChange: event => { setEditing(value => ({ ...value, [key]: event.target.value })); setDraftTest(null); setError(''); } });
  const remove = async id => {
    if (await save({ operation: 'remove', id })) setTests(value => Object.fromEntries(Object.entries(value).filter(([nodeId]) => nodeId !== id)));
  };
  return <section className="dc-relay-pool" aria-label="中继">
    <div className="dc-section-heading"><h2>中继 {status && <span className="dc-count">{nodes.length}</span>}</h2><div className="dc-service-actions">
      <Button icon="refresh" title="刷新中继" aria-label="刷新中继" disabled={busy || refreshing} onClick={() => void refreshStatus()} />
      {onAdd && (nodes.length > 0 || !status) && <Button onClick={onAdd}>添加中继</Button>}
    </div></div>
    {refreshing && <Loading className="dc-progress-message" compact label="正在刷新中继…" />}
    {!editing && <ErrorLine error={error} />}
    {feedback && <p className="dc-note" role="status">{feedback}</p>}
    {receipt && <Button disabled={busy} onClick={() => void checkReceipt()}>查询保存结果</Button>}
    {statusError && <div className="dc-relay-status-error"><ErrorLine error={'无法读取中继状态 · ' + statusError} /><Button disabled={refreshing} onClick={() => void refreshStatus()}>重试读取</Button></div>}
    {currentDevice?.currentPath === 'relay' && currentDevice.currentRelayUrl && <p className="dc-note dc-relay-current">当前工作台使用 · <strong>{currentDevice.currentRelayUrl}</strong></p>}
    {!status && !statusError ? <DeviceLoading label="正在读取中继…" /> : nodes.length ? <div className="dc-device-list dc-relay-list">{nodes.map(node => {
      const preferred = status.relay.preferredId === node.id;
      const disabled = node.enabled === false;
      const connectionError = !disabled && node.lastError !== relayDataClosed ? node.lastError : null;
      const test = tests[node.id]?.url === node.url ? tests[node.id] : null;
      const checkedAt = Math.max(node.checkedAt || 0, test?.checkedAt || 0);
      const inspected = checkedAt ? new Date(checkedAt) : null;
      return <article key={node.id} className="dc-device dc-relay-card">
        <div className="dc-device-open">
          <span className="dc-device-symbol"><UIIcon name="server" size={22} /></span>
          <div className="dc-device-copy">
            <div className="dc-relay-identity"><strong>{new URL(node.url).host}</strong>{preferred && <span>首选中继</span>}</div>
            <small data-status={disabled ? 'disabled' : node.connected ? 'connected' : connectionError ? 'offline' : 'connecting'}>
              {disabled ? '已停用' : node.connected ? '通道已连接' : connectionError ? '通道连接失败' : '正在连接…'}
            </small>
            {connectionError && <span className="dc-device-error">{connectionError}</span>}
            {inspected && <time dateTime={inspected.toISOString()}>最近检测 {inspected.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}
          </div>
        </div>
        <div className="dc-service-actions">
          <Button icon="refresh" disabled={busy} onClick={() => void testNode(node)}>{connectionError ? '重试检测' : '测试连接'}</Button>
          {!runtime.paired && <Button icon="settings" disabled={busy} onClick={() => edit(node)}>编辑</Button>}
          <Button disabled={busy || !!receipt} onClick={() => void save({ operation: 'update', id: node.id, enabled: disabled })}>{disabled ? '启用' : '停用'}</Button>
          {!preferred && !disabled && <Button disabled={busy || !!receipt} onClick={() => void save({ operation: 'prefer', id: node.id })}>设为首选</Button>}
          {!runtime.paired && <Button icon="trash" title="删除中继" aria-label={'删除中继 ' + new URL(node.url).host} danger disabled={busy || !disabled} onClick={() => void remove(node.id)} />}
        </div>
        {testing === node.id && <Loading className="dc-progress-message" compact label="正在测试连接…" />}
        <ConnectionTest result={test?.result} />
      </article>;
    })}</div> : status && <div className="dc-empty">
      <span className="dc-empty-symbol"><UIIcon name="server" size={24} /></span>
      <h2>尚未添加中继</h2><p>添加中继后，可从其他网络连接此工作台。</p>
      {onAdd && <Button primary onClick={onAdd}>添加中继</Button>}
    </div>}
    {editing && <Sheet title="编辑中继" onClose={closeEdit} busy={busy}><form className="dc-relay-edit-form" onSubmit={saveEdit}>
      <Field label="中继 HTTPS 地址"><input type="url" required {...editField('url')} /></Field>
      <Field label="主机密钥"><input type="password" required={newAddress} placeholder={newAddress ? '填写新地址的主机密钥' : '留空以保留当前密钥'} autoComplete="new-password" {...editField('token')} /></Field>
      {staleEdit && <ErrorLine error={latestNode ? `中继配置已更新，当前地址为 ${latestNode.url}。请核对后继续。` : '该中继已被移除，请返回列表。'} />}
      {testing === 'draft' && <Loading className="dc-progress-message" compact label="正在测试连接…" />}<ConnectionTest result={draftTest} /><ErrorLine error={error} />
      <div className="dc-actions">
        {staleEdit && latestNode && <Button disabled={busy} onClick={() => {
          setEditing(value => ({ ...value, url: value.url === value.baseUrl ? latestNode.url : value.url, baseUrl: latestNode.url, fingerprint }));
          setDraftTest(null); setError('');
        }}>按最新配置继续</Button>}
        <Button icon="refresh" disabled={busy || staleEdit || !editing.url.trim() || (newAddress && !editing.token.trim())} onClick={() => void testNode(editing, true)}>测试连接</Button>
        <Button primary type="submit" disabled={busy || staleEdit || (newAddress && !editing.token.trim())}>保存更改</Button>
      </div>
    </form></Sheet>}
  </section>;
}

function ReconnectServer({ runtime, device, agentAvailable, onConnected }) {
  const [form, setForm] = useState(() => ({ ...emptyServer(), auth: agentAvailable ? 'agent' : 'password' }));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [job, setJob] = useState(null);
  useJob(runtime, job, setJob, setError);
  const working = busy || Boolean(job && !jobFinished(job));
  const submit = async event => {
    event.preventDefault();
    if (working) return;
    setBusy(true); setJob(null); setError('');
    try {
      const result = await runtime.call('reconnect', { deviceId: device.id, ...sshCredentials(form) });
      if (result.jobId) setJob({ id: result.jobId, state: 'running', steps: [] });
      else await onConnected();
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); setForm(value => ({ ...value, password: '', privateKey: '', passphrase: '' })); }
  };
  const ready = jobFinished(job) && !jobFailed(job) && job.state !== 'cancelled';
  return <>
    {!ready && <form onSubmit={submit}>
      <div className="dc-form-grid"><Credentials form={form} setForm={setForm} disabled={working} agentAvailable={agentAvailable} /></div>
      <div className="dc-actions"><Button primary type="submit" disabled={working}>连接 SSH</Button></div>
    </form>}
    <ErrorLine error={error} />
    {job && <JobProgress job={job} label="正在连接 SSH…" />}
    {ready && <div className="dc-actions"><Button primary onClick={() => void Promise.resolve(onConnected()).catch(reason => setError(reason.message))}>继续</Button></div>}
  </>;
}

function ServerPairing({ runtime, device, onClose, onReconnect }) {
  const [pairing, setPairing] = useState(null), [pending, setPending] = useState([]), [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(null), [decision, setDecision] = useState('');
  const [publicUrl, setPublicUrl] = useState(''), [saving, setSaving] = useState(false);
  const gate = useRef(false);
  const readStatus = useCallback(() => runtime.call('serverPairingStatus', { deviceId: device.id }), [device.id, runtime]);
  useEffect(() => {
    let cancelled = false;
    runtime.call('serverPairing', { deviceId: device.id }).then(value => { if (!cancelled) setPairing(value); }, reason => { if (!cancelled) setError(reason); });
    return () => { cancelled = true; };
  }, [runtime, device.id, attempt]);
  useEffect(() => {
    if (!pairing) return;
    let disposed = false, timer;
    const poll = async () => {
      try {
        if (!gate.current) {
          const status = await readStatus();
          if (!disposed && !gate.current) setPending(status.pending || []);
        }
      } catch (reason) { if (!disposed && !gate.current) setError(reason); }
      if (!disposed) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [pairing, readStatus]);
  const decide = async (id, value) => {
    if (gate.current) return;
    gate.current = true; setDecision(value); setError(null);
    try {
      await runtime.call('serverPairingDecide', { deviceId: device.id, id, decision: value });
      const status = await readStatus();
      setPending(status.pending || []);
    }
    catch (reason) { setError(reason); }
    finally { gate.current = false; setDecision(''); }
  };
  if (pairing) return <PairingDialog pairing={pairing} pending={pending} onClose={() => { if (!gate.current) onClose(); }} onConfirm={decide} busy={decision} error={error?.message} />;
  if (!error) return <DeviceLoading label="正在生成连接码…" />;
  const retry = () => { setError(null); setAttempt(value => value + 1); };
  const savePublicUrl = async event => {
    event.preventDefault();
    if (gate.current) return;
    gate.current = true; setSaving(true);
    try { await runtime.call('serverPairingConfigure', { deviceId: device.id, publicUrl }); retry(); }
    catch (reason) { setError(reason); }
    finally { gate.current = false; setSaving(false); }
  };
  return <><ErrorLine error={error.message} /><div className="dc-actions">
    {error.code === 'SSH_AUTH_REQUIRED' ? <Button primary onClick={onReconnect}>重新认证 SSH</Button> : <Button disabled={saving} onClick={retry}>重试</Button>}
    {error.code === 'PAIRING_UPDATE_REQUIRED' && <Button primary onClick={onClose}>打开服务器管理</Button>}
  </div>
  {(error.code === 'PAIRING_ROUTE_REQUIRED' || error.code === 'PAIRING_ROUTE_INVALID') && <form onSubmit={savePublicUrl}>
    <Field label="公网 HTTPS 地址"><input type="url" required placeholder="https://benchgo.example.com" value={publicUrl} onChange={event => setPublicUrl(event.target.value)} disabled={saving} /></Field>
    <div className="dc-actions"><Button type="submit" primary disabled={saving}>{saving ? '正在保存…' : '保存并检查'}</Button></div>
  </form>}
  </>;
}

function ManageDevice({ device, runtime, onChanged, onRemoved, onCloseWorkbench, onOpenWorkbench, serverManagement, agentAvailable, onServerAction, membership, canRemoveMember }) {
  const [savedName, setSavedName] = useState(device.name);
  const [editingName, setEditingName] = useState(false);
  const nameInput = useRef(null), editNameButton = useRef(null), composingName = useRef(false), wasEditingName = useRef(false);
  const [name, setName] = useState(device.name), [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState(''), [confirm, setConfirm] = useState(''), [reconnecting, setReconnecting] = useState(false);
  const gate = useRef(false);
  const [job, setJob] = useState(null), [pollAttempt, setPollAttempt] = useState(0);
  useJob(runtime, job, setJob, setError, pollAttempt);
  const working = busy || Boolean(job && !jobFinished(job));
  const managed = serverManagement && device.sshManaged;
  const nameLabel = membership ? '设备名称' : device.kind === 'local' ? '本机名称' : '备注名称';
  const nameAction = membership ? 'groupRename' : 'rename';
  useEffect(() => { setSavedName(device.name); }, [device.name]);
  const cancelName = () => { if (gate.current) return; setName(savedName); setEditingName(false); composingName.current = false; setError(''); };
  useEffect(() => { if (editingName) { nameInput.current?.focus(); nameInput.current?.select(); } else if (wasEditingName.current) editNameButton.current?.focus(); wasEditingName.current = editingName; }, [editingName]);
  useEffect(() => { if (job && jobFinished(job) && !jobFailed(job) && job.state !== 'cancelled') void Promise.resolve(onChanged()).catch(reason => setError(reason.message)); }, [job?.state, onChanged]);
  const execute = async (action, args = {}) => {
    if (gate.current) return; gate.current = true; setBusy(true); setError(''); setResult('');
    try {
      const value = await runtime.call(action, action === 'groupLeave' ? undefined : { deviceId: device.id, ...args });
      if (action === 'rename' || action === 'groupRename') { const next = value.device?.name || args.name; setSavedName(next); setName(next); setEditingName(false); await onChanged(); return; }
      if (['remove', 'groupRemove', 'groupLeave'].includes(action)) { onRemoved(device.id); return; }
      if (action === 'jobCancel') { setJob(value => ({ ...value, cancellable: false })); setPollAttempt(value => value + 1); return; }
      if (value.jobId) { setJob({ id: value.jobId, state: 'running', steps: [] }); setConfirm(''); setResult(''); return; }
      setResult(typeof value === 'string' ? value : value.logs || value.output || value.message || (value.status ? `服务状态：${value.status}` : '操作已完成')); setConfirm(''); await onChanged();
    } catch (reason) { setError(reason.message); } finally { gate.current = false; setBusy(false); }
  };
  const nameEditor = <div className="dc-name-field"><span>{nameLabel}</span><div className="dc-name-line">
    <Tooltip label={'编辑' + nameLabel}><button ref={editNameButton} type="button" className="dc-name-edit" aria-label={'编辑' + nameLabel} hidden={editingName} disabled={working} onClick={() => { setName(savedName); setEditingName(true); setError(''); }}><UIIcon name="edit" size={14} /></button></Tooltip>
    {editingName ? <form className="dc-name-form" onSubmit={event => { event.preventDefault(); if (!composingName.current && !working && name.trim()) { if (name.trim() === savedName) cancelName(); else void execute(nameAction, { name: name.trim(), ...(membership && { deviceId: membership.id }) }); } }} onKeyDown={event => { if (composingName.current || event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); event.stopPropagation(); return; } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelName(); } }}>
      <input ref={nameInput} aria-label={nameLabel} value={name} maxLength={100} onCompositionStart={() => { composingName.current = true; }} onCompositionEnd={() => { composingName.current = false; }} onChange={event => setName(event.target.value)} disabled={working} />
      <Tooltip label="取消"><button type="button" className="dc-name-cancel" aria-label="取消修改名称" disabled={working} onClick={cancelName}><UIIcon name="close" size={15} /></button></Tooltip>
      <Tooltip label="确认"><button type="submit" className="dc-name-save" aria-label="确认修改名称" disabled={working || !name.trim()}><UIIcon name="check" size={15} /></button></Tooltip>
    </form> : <strong>{savedName}</strong>}
  </div></div>;
  const serviceActions = [['status', '状态'], ['start', '启动'], ['restart', '重启'], ['stop', '停止'], ['logs', '日志'], ['update', '更新插件']];
  const pendingAction = serviceActions.find(([operation]) => operation === confirm);
  const canRemove = membership ? canRemoveMember : device.kind !== 'local';
  const removeAction = membership?.local ? '退出设备组' : '移除连接';
  const remove = () => membership?.local ? execute('groupLeave') : membership ? execute('groupRemove', { deviceId: membership.id }) : execute('remove');
  return <>
    {deviceIcon(device) === 'server'
      ? <p className="dc-note dc-server-tag">{deviceKind(device)}<ServerStatus device={device} /></p>
      : <p className="dc-note">{[deviceKind(device), deviceStatus(device)].filter(Boolean).join(' · ')}</p>}
    {(!membership || canRemoveMember) && nameEditor}
    {managed && <section className="dc-management">
      <h3>服务器</h3>
      <div className="dc-service-actions">
        <Button icon="scan" disabled={working} onClick={() => onServerAction('pairing', device)}>生成连接码</Button>
      </div>
    </section>}
    {serverManagement && !membership && device.kind !== 'local' && !managed && device.kind !== 'ssh' && <div className="dc-management"><Button icon="link" onClick={() => onServerAction('bind', device)}>补绑 SSH</Button></div>}
    {(managed || device.kind === 'ssh') && <section className="dc-management">
      <h3>服务操作</h3>
      <div className="dc-service-actions">{serviceActions.map(([operation, label]) => <Button key={operation} disabled={working} onClick={() => ['stop', 'restart', 'update'].includes(operation) ? setConfirm(operation) : void execute('serverAction', { operation })}>{label}</Button>)}</div>
      <Button icon="refresh" disabled={working} onClick={() => setReconnecting(value => !value)}>重新连接 SSH</Button>
      {reconnecting && <ReconnectServer runtime={runtime} device={device} agentAvailable={agentAvailable} onConnected={async () => { await onChanged(); setReconnecting(false); setResult('SSH 已连接'); }} />}
    </section>}
    {pendingAction && <div className="dc-confirm">
      <p>{confirm === 'stop' ? '停止服务器服务会中断远程工作台。' : confirm === 'restart' ? '重启时工作台会短暂断开。' : '更新服务器插件时工作台可能短暂断开。'}</p>
      <Button disabled={working} onClick={() => setConfirm('')}>取消</Button>
      <Button primary disabled={working} onClick={() => execute('serverAction', { operation: confirm })}>确认{confirm === 'update' ? '更新' : pendingAction[1]}</Button>
    </div>}
    {result && <pre className="dc-result" role="status">{String(result)}</pre>}
    <ErrorLine error={error} />
    {job && <>
      <JobProgress job={job} />
      {!jobFinished(job) && job.cancellable === true && <div className="dc-actions"><Button disabled={busy} onClick={() => execute('jobCancel', { jobId: job.id })}>{busy ? '正在取消…' : '取消准备'}</Button></div>}
      {jobFinished(job) && !jobFailed(job) && job.state !== 'cancelled' && onOpenWorkbench && <div className="dc-actions"><Button primary onClick={() => onOpenWorkbench(job.device || device, { reopen: true })}>重新打开工作台</Button></div>}
      {error && !jobFinished(job) && <Button onClick={() => { setError(''); setPollAttempt(value => value + 1); }}>重新检查进度</Button>}
    </>}
    {confirm === 'remove' && membership && <p className="dc-note">{membership.local ? '退出后，本机会从其他成员的列表中消失，其他成员仍可互通。' : '移除后，该设备将从所有成员的列表中消失，并失去组内访问权限。'}</p>}
    {confirm === 'remove' && managed && <p className="dc-note">本机保存的 SSH 凭据也会清除。</p>}
    {(onCloseWorkbench || canRemove) && <div className="dc-management dc-actions">
      {onCloseWorkbench && <Button onClick={onCloseWorkbench}>关闭工作台</Button>}
      {canRemove && (confirm === 'remove' ? <><Button disabled={working} onClick={() => setConfirm('')}>取消</Button><Button danger disabled={working} onClick={remove}>{membership?.local ? '确认退出' : '确认移除'}</Button></> : <Button danger icon="trash" disabled={working} onClick={() => setConfirm('remove')}>{removeAction}</Button>)}
    </div>}
  </>;
}

export function DeviceCenter({ runtime = deviceRuntime }) {
  useLinkStyle();
  const [data, setData] = useState({ devices: [], capabilities: {} }), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(''), [modal, setModal] = useState(null), [showDevices, setShowDevices] = useState(true), [frames, setFrames] = useState([]), [activeId, setActiveId] = useState(null);
  const gate = useRef(false), frameElements = useRef(new Map());
  const [navigationReady, setNavigationReady] = useState([]);
  const [switchReady, setSwitchReady] = useState([]);
  const [readyFrames, setReadyFrames] = useState([]);
  const [relayRevision, setRelayRevision] = useState(0);
  const [relayJob, setRelayJob] = useState(null);
  const [directoryTab, setDirectoryTab] = useState('devices'), [detailsTarget, setDetailsTarget] = useState(null);
  const [refreshingDevices, setRefreshingDevices] = useState(false);
  const listRequest = useRef(0);
  const group = data.group;
  const memberFor = device => group?.enabled ? group.members.find(member => !member.removed && (member.id === device?.id || member.id === device?.hostId || (device?.kind === 'local' && member.local))) : undefined;
  const relayManagement = data.capabilities?.hostAdmin || data.capabilities?.relayManagement;
  const directoryReady = loaded && (!runtime.paired || relayManagement || group?.enabled);
  const mobile = runtime.isNative();
  const canUpdateApp = mobile && runtime.bootstrap?.()?.capabilities?.appUpdates === true;
  const showDirectoryTabs = !mobile || relayManagement;
  const serverManagement = !runtime.isNative() && data.capabilities?.serverManagement === true;
  const agentAvailable = serverManagement && data.capabilities?.sshAgent === true;
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
      else if (message.id === activeId && (navigationReady.includes(message.id) || switchReady.includes(message.id))) { setShowDevices(true); setError(''); }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [frames, data.devices, activeId, navigationReady, switchReady]);
  const integratedNavigation = !showDevices && !modal && !error && navigationReady.includes(activeId);
  const switchNavigation = !showDevices && !modal && !error && switchReady.includes(activeId);
  useEffect(() => {
    const parentOrigin = globalThis.__DSH_DEVICE_PARENT_ORIGIN__;
    if (parentOrigin && parent !== window) parent.postMessage({ type: 'dsh-devices:workbench-navigation', ready: integratedNavigation }, parentOrigin);
    return () => { if (parentOrigin && parent !== window) parent.postMessage({ type: 'dsh-devices:workbench-navigation', ready: false }, parentOrigin); };
  }, [integratedNavigation]);
  const frameLoaded = frame => {
    sendWorkbenchTheme(frameElements.current.get(frame.id), frame.url);
    setReadyFrames(items => items.includes(frame.id) ? items : [...items, frame.id]);
    setNavigationReady(items => items.filter(id => id !== frame.id));
    setSwitchReady(items => items.filter(id => id !== frame.id));
    frameElements.current.get(frame.id)?.contentWindow?.postMessage({ type: 'dsh-devices:probe' }, new URL(frame.url).origin);
    frameElements.current.get(frame.id)?.contentWindow?.postMessage({ type: 'benchgo:device-switch:probe' }, new URL(frame.url).origin);
  };
  useEffect(() => {
    if (frames.length) return observeHostTheme(theme => {
      for (const frame of frames) sendWorkbenchTheme(frameElements.current.get(frame.id), frame.url, theme);
    });
  }, [frames]);
  useEffect(() => { const node = document.createElement('style'); node.textContent = css; document.head.append(node); return () => node.remove(); }, []);
  const refresh = useCallback(async () => {
    const request = ++listRequest.current;
    const next = await runtime.call('list');
    if (request === listRequest.current) {
      setData(next);
      if (next.relayJob) setRelayJob(next.relayJob);
      setLoaded(true);
    }
    return next;
  }, [runtime]);
  useEffect(() => {
    let stopped = false, timer;
    const poll = async () => {
      if (document.visibilityState !== 'hidden') await refresh().catch(() => {});
      if (!stopped) timer = setTimeout(poll, 4000);
    };
    if (group?.enabled) timer = setTimeout(poll, 4000);
    const changed = () => { void refresh().catch(() => {}); };
    window.addEventListener('link:device-directory', changed);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener('link:device-directory', changed); };
  }, [group?.enabled, refresh]);
  useEffect(() => {
    if (!loaded) return;
    const available = new Set(data.devices.map(device => device.id));
    const removed = new Set(frames.filter(frame => !available.has(frame.id)).map(frame => frame.id));
    if (removed.size) {
      setFrames(items => items.filter(frame => !removed.has(frame.id)));
      setReadyFrames(items => items.filter(id => !removed.has(id)));
      setNavigationReady(items => items.filter(id => !removed.has(id)));
      setSwitchReady(items => items.filter(id => !removed.has(id)));
      if (removed.has(activeId)) { setActiveId(null); setShowDevices(true); }
    }
    if (modal?.device && !available.has(modal.device.id)) setModal(null);
  }, [loaded, data.devices, frames, activeId, modal]);
  useEffect(() => {
    const parentOrigin = globalThis.__DSH_DEVICE_PARENT_ORIGIN__;
    if (!parentOrigin || parent === window) return;
    let pending;
    const receive = event => {
      if (event.origin !== parentOrigin || event.source !== parent) return;
      if (event.data?.type === 'dsh-devices:closed') { pending = null; setModal(null); return; }
      if (event.data?.type !== 'dsh-devices:reconnect' || typeof event.data.deviceId !== 'string') return;
      const request = event.data;
      pending = request;
      setShowDevices(true); setDirectoryTab('devices'); setError('');
      void refresh().then(next => {
        if (pending !== request) return;
        const device = next.devices.find(item => item.id === request.deviceId && item.sshManaged);
        if (next.capabilities?.serverManagement && device) setModal({ type: 'reconnect', device, returnTo: 'workbench' });
        else setError('此设备的 SSH 配置已不可用，请检查设备设置');
      }).catch(reason => { if (pending === request) setError(reason.message); });
    };
    window.addEventListener('message', receive);
    parent.postMessage({ type: 'dsh-devices:actions-ready' }, parentOrigin);
    return () => { pending = null; window.removeEventListener('message', receive); };
  }, [refresh]);
  const relayChanged = useCallback(() => setRelayRevision(value => value + 1), []);
  const refreshDevices = async () => {
    if (refreshingDevices) return;
    setRefreshingDevices(true); setError('');
    try { await refresh(); relayChanged(); }
    catch (reason) { setError(reason.message); }
    finally { setRefreshingDevices(false); }
  };
  const openAdd = () => {
    setError('');
    setModal({ type: 'add' });
  };
  useJob(runtime, modal?.type === 'relay' ? null : relayJob, setRelayJob, setError);
  const completedRelay = useRef('');
  useEffect(() => {
    if (!relayJob?.id || !jobFinished(relayJob) || completedRelay.current === relayJob.id) return;
    completedRelay.current = relayJob.id; relayChanged();
  }, [relayJob?.id, relayJob?.state, relayChanged]);
  useEffect(() => { const scanned = () => { const identity = runtime.bootstrap?.(); if (identity?.code && !identity.token) setModal({ type: 'add' }); }; window.addEventListener('link:bootstrap', scanned); scanned(); return () => window.removeEventListener('link:bootstrap', scanned); }, [runtime]);
  useEffect(() => {
    let closed = false;
    void refresh().catch(reason => { if (!closed) { setError(reason.message); setLoaded(true); } });
    return () => { closed = true; listRequest.current++; };
  }, [refresh]);
  const closeModal = useCallback(() => setModal(null), []);
  const canReturn = showDevices && !modal && !!(globalThis.__DSH_DEVICE_PARENT_ORIGIN__ || new URLSearchParams(location.search).get('parentOrigin'));
  const returnToWorkbench = useCallback(() => {
    const parentOrigin = globalThis.__DSH_DEVICE_PARENT_ORIGIN__ || new URLSearchParams(location.search).get('parentOrigin');
    if (parentOrigin && parent !== window) parent.postMessage({ type: 'dsh-devices:return-local' }, parentOrigin);
  }, []);
  const select = useCallback(async (device, { reopen = false } = {}) => {
    if (!device?.id || gate.current) return;
    if (runtime.isNative() && device.kind === 'local') { setModal({ type: 'manage', device }); return; }
    const parentOrigin = globalThis.__DSH_DEVICE_PARENT_ORIGIN__ || new URLSearchParams(location.search).get('parentOrigin');
    if (!runtime.isNative() && parentOrigin && parent !== window && new URLSearchParams(location.hash.slice(1)).get('reuseWorkbench') === '1') {
      parent.postMessage({ type: 'dsh-devices:select', deviceId: device.id, reopen }, parentOrigin);
      setModal(null); setError(''); return;
    }
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
          const url = themedWorkbenchUrl(workbenchUrl(value.url, location.origin));
          if (reopen || !frames.some(frame => frame.id === device.id && new URL(frame.url).origin === new URL(url).origin)) setReadyFrames(items => items.filter(id => id !== device.id));
          setFrames(items => items.some(item => item.id === device.id) ? items.map(item => item.id === device.id && (reopen || new URL(item.url).origin !== new URL(url).origin) ? { ...item, name: device.name, url } : item) : [...items, { id: device.id, name: device.name, url }]);
          setActiveId(device.id); setShowDevices(false);
        }
      }
      setModal(null); await refresh();
      return true;
    } catch (reason) {
      if (serverManagement && device.sshManaged && reason.code === 'SSH_AUTH_REQUIRED') {
        setModal({ type: 'reconnect', device, returnTo: 'workbench' });
      } else {
        setError(reason.code === 'OFFLINE' || reason.message === relayDataClosed
          ? `暂时无法连接「${device.name}」，请重试`
          : reason.message);
        setModal(null);
      }
      if (openHere) setShowDevices(true);
    } finally { gate.current = false; setBusy(''); }
  }, [runtime, refresh, frames, serverManagement]);
  useEffect(() => {
    const publicDevices = data.devices.map(({ id, name, kind, status, deviceType }) => ({ id, name, kind, status, ...(deviceType ? { deviceType } : {}) }));
    const publish = frame => {
      const child = frameElements.current.get(frame.id)?.contentWindow;
      const origin = new URL(frame.url).origin;
      child?.postMessage({ type: 'benchgo:device-switch:init', devices: publicDevices, activeId: frame.id, busy, error }, origin);
      // Keep the existing Link button available as the route back to this directory.
      child?.postMessage({ type: 'dsh-devices:init', name: data.devices.find(item => item.id === frame.id)?.name || frame.name }, origin);
    };
    const receive = event => {
      const message = deviceSwitchFrameMessage(event, frames.map(frame => ({ ...frame, window: frameElements.current.get(frame.id)?.contentWindow })));
      if (!message) return;
      if (message.type === 'benchgo:device-switch:ready') {
        setSwitchReady(items => items.includes(message.id) ? items : [...items, message.id]);
        publish(frames.find(frame => frame.id === message.id));
      } else if (message.id === activeId && switchReady.includes(message.id)) {
        const device = data.devices.find(item => item.id === message.deviceId);
        if (device) void select(device);
      }
    };
    for (const frame of frames) if (switchReady.includes(frame.id)) publish(frame);
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [frames, data.devices, activeId, busy, error, select, switchReady]);
  const added = useCallback(async device => {
    if (device?.id && !device.pairingNotice) {
      if (!await select(device)) await refresh();
    } else {
      setModal(null);
      setShowDevices(true);
      await refresh();
    }
  }, [refresh, select]);
  const modalDevice = data.devices.find(item => item.id === modal?.device?.id) || modal?.device;
  const active = data.devices.find(item => item.id === activeId);
  // Keep the owner device in the same list so every device shares one scan path.
  const devices = [...data.devices].sort((left, right) => Number(right.kind === 'local') - Number(left.kind === 'local'));
  const directoryKey = event => {
    const tabs = [...event.currentTarget.parentElement.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(event.currentTarget);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : -1;
    if (next < 0) return;
    event.preventDefault(); tabs[next].focus(); setDirectoryTab(tabs[next].dataset.tab);
  };
  const renderDevice = device => {
    const membership = memberFor(device);
    const opening = busy === device.id;
    const status = opening ? '正在打开…' : device.kind === 'local' ? (runtime.paired || runtime.isNative() ? '' : '本机工作台') : deviceStatus(device);
    const icon = deviceIcon(device);
    const server = icon === 'server';
    const managed = serverManagement && device.sshManaged;
    const canOpen = !runtime.paired && device.kind !== 'paired' && !(device.groupAsset && device.kind === 'ssh' && !device.hostId);
    const Open = canOpen ? 'button' : 'div';
    return <article key={device.id} className="dc-device" data-device-icon={icon}>
      <Open className="dc-device-open" {...(canOpen ? { disabled: !!busy, onClick: () => select(device) } : {})}>
        <span className="dc-device-symbol"><UIIcon name={icon} size={22} /></span>
        <span className="dc-device-copy"><Tooltip label={device.name}><strong>{device.name}</strong></Tooltip>
          {server ? <small className="dc-server-tag"><span>{deviceKind(device)}</span><ServerStatus device={device} opening={opening} /></small> : <small>
            <span>{deviceKind(device)}</span>
            {status && <span className={opening ? undefined : 'dc-device-status'} data-status={opening ? undefined : device.status}>{opening ? <LoadingText label={status} /> : status}</span>}
            {membership || device.groupMember ? <span className="dc-device-status">组成员</span> : runtime.paired && device.kind === 'paired' && <span className="dc-device-status">已配对</span>}
          </small>}
          {device.ownerName && <span className="dc-note">由 {device.ownerName} 连接</span>}
          {device.pairingNotice && <span className="dc-note">{device.pairingNotice}</span>}
          {device.warning && <span className="dc-device-error">{device.warning}</span>}
          {!server && device.lastError && device.lastError !== relayDataClosed && <span className="dc-device-error">{device.lastError}</span>}
        </span>
      </Open>
      {(managed || device.sharedTerminal) && <Button icon="terminal" title="打开 SSH 终端" aria-label={`打开 ${device.name} 的 SSH 终端`} onClick={() => setModal({ type: 'terminal', device: device.terminalAssetId ? { ...device, id: device.terminalAssetId } : device })} disabled={!!busy} />}
      {!runtime.paired && !device.groupAsset && !(mobile && device.groupMember) && (!membership || membership.local || group.manageable) && <Button icon="more" title="设备设置" aria-label={`${device.name}设置`} onClick={() => setModal({ type: 'manage', device })} disabled={!!busy} />}
    </article>;
  };
  const closeWorkbench = device => {
    if (runtime.isNative()) void runtime.call('closeWorkbench', { deviceId: device.id }).catch(reason => setError(reason.message));
    setFrames(items => items.filter(frame => frame.id !== device.id));
    if (activeId === device.id) { setActiveId(null); setShowDevices(true); }
    setModal(null);
  };
  const renderModal = () => {
    if (!modal) return null;
    const { type, returnTo } = modal;
    if (type === 'app-update') return <Sheet key={type} title="应用更新" onClose={closeModal}><LocalAppUpdates runtime={runtime} checkOnOpen /></Sheet>;
    const device = modalDevice;
    const move = next => setModal({ type: next, device });
    const reconnect = () => setModal({ type: 'reconnect', device, returnTo: type });
    const canCloseWorkbench = device?.kind !== 'local' && (runtime.isNative() || frames.some(frame => frame.id === device?.id));
    const titles = { add: '添加设备', relay: '添加中继', bind: '补绑 SSH', reconnect: '重新认证 SSH', pairing: '生成连接码', terminal: `${device?.name} · SSH 终端` };
    let content;
    if (type === 'relay') content = <RelayWizard canDeploy={data.capabilities?.relayDeploy === true} agentAvailable={agentAvailable} runtime={runtime} onClose={closeModal} job={relayJob} setJob={setRelayJob} onPoolChanged={relayChanged} onChanged={() => { relayChanged(); setDirectoryTab('relay'); setModal(null); setShowDevices(true); }} />;
    if (type === 'add') content = <AddDevice runtime={runtime} onAdded={added} sshAvailable={data.capabilities?.ssh !== false} agentAvailable={agentAvailable} />;
    if (type === 'bind') content = <AddServer runtime={runtime} device={device} agentAvailable={agentAvailable} onAdded={async () => { await refresh(); move('manage'); }} />;
    if (type === 'reconnect') content = <ReconnectServer runtime={runtime} device={device} agentAvailable={agentAvailable} onConnected={async () => { await refresh(); if (returnTo === 'workbench') await select(device); else move(returnTo); }} />;
    if (type === 'terminal') content = <ServerTerminal key={device.id} runtime={runtime} device={device} allowResize={device.sharedTerminal || data.capabilities?.serverTerminalResize === true} onReconnect={device.sharedTerminal ? undefined : reconnect} />;
    if (type === 'pairing') content = <ServerPairing runtime={runtime} device={device} onClose={() => move('manage')} onReconnect={reconnect} />;
    if (type === 'manage') content = <ManageDevice device={device} runtime={runtime} onChanged={refresh} serverManagement={serverManagement} agentAvailable={agentAvailable} onServerAction={move} onOpenWorkbench={select} membership={memberFor(device)} canRemoveMember={group?.manageable} onCloseWorkbench={canCloseWorkbench ? () => closeWorkbench(device) : undefined} onRemoved={id => { setFrames(items => items.filter(frame => frame.id !== id)); if (activeId === id) { setActiveId(null); setShowDevices(true); } setModal(null); void refresh().catch(reason => setError(reason.message)); }} />;
    return <Sheet key={type} title={titles[type] || device?.name} onClose={closeModal} busy={!!busy} terminal={type === 'terminal'}>{content}</Sheet>;
  };
  return <main className="dc-root" data-native={mobile || undefined}>
    <header className={'dc-topbar' + (integratedNavigation ? ' dc-topbar-integrated' : '') + (switchNavigation ? ' dc-topbar-switch' : '')}>
      <div className="dc-topbar-main">
        {canReturn && <Button className="dc-back" icon="chevronLeft" aria-label="返回工作台" onClick={returnToWorkbench} />}
        {!showDevices && <Button className="dc-back" icon="chevronLeft" aria-label="返回设备中心" title="返回设备中心" onClick={() => { setShowDevices(true); setError(''); }} />}
        <span className="dc-center-home"><UIIcon name="devices" size={16} />设备中心</span>
      </div>
      {showDevices && canUpdateApp && <Button className="dc-app-update-trigger" icon="appUpdate" title="检查应用更新" aria-label="检查应用更新" aria-haspopup="dialog" onClick={() => setModal({ type: 'app-update' })} />}
    </header>
    <div className="dc-surface" hidden={!showDevices}>
      <section className="dc-content">
        <ErrorLine error={error} />
        {!loaded && <DeviceLoading label="正在读取设备…" />}
        {loaded && data.capabilities?.hostAdmin && <section id="dc-panel-connection" className="dc-connection-panel" aria-label="连接">
          <div className="dc-section-heading"><h1>连接</h1></div><LinkSettings embedded management={runtime.hostCall} refreshToken={relayRevision} detailsTarget={detailsTarget} />
        </section>}
        {loaded && !directoryReady && <Button disabled={refreshingDevices} onClick={refreshDevices}>{refreshingDevices ? <LoadingText label="正在重试…" /> : '重试读取设备'}</Button>}
        {directoryReady && showDirectoryTabs && <div className="dc-directory-header"><div className="dc-directory-tabs" role="tablist" aria-label="设备与中继">
          <button type="button" id="dc-tab-devices" className="dc-directory-tab" role="tab" data-tab="devices" aria-controls="dc-panel-devices" aria-selected={directoryTab === 'devices'} tabIndex={directoryTab === 'devices' ? 0 : -1} onClick={() => setDirectoryTab('devices')} onKeyDown={directoryKey}>设备</button>
          {relayManagement && <button type="button" id="dc-tab-relay" className="dc-directory-tab" role="tab" data-tab="relay" aria-controls="dc-panel-relay" aria-selected={directoryTab === 'relay'} tabIndex={directoryTab === 'relay' ? 0 : -1} onClick={() => setDirectoryTab('relay')} onKeyDown={directoryKey}>中继池</button>}
        </div></div>}
        <section id="dc-panel-devices" className="dc-device-directory" role={showDirectoryTabs ? 'tabpanel' : undefined} aria-labelledby={showDirectoryTabs ? 'dc-tab-devices' : 'dc-devices-heading'} hidden={!directoryReady || directoryTab !== 'devices'}>
          <div className="dc-directory-title">
            <div className="dc-section-heading">
              <h2 id="dc-devices-heading">我的设备 {!mobile && <span className="dc-count">{devices.length}</span>}</h2>
              <div className="dc-service-actions">
                <Button icon="refresh" title="刷新设备" aria-label="刷新设备" disabled={!!busy || refreshingDevices} onClick={refreshDevices} />
                {!runtime.paired && <Button primary icon={mobile ? 'plus' : undefined} onClick={openAdd}>添加设备</Button>}
              </div>
            </div>
            <div className="dc-directory-mark" aria-hidden="true"><BrandLogo size={60} decorative /></div>
          </div>
          {refreshingDevices && <Loading className="dc-refresh-status" compact label="正在刷新设备…" />}
          <div className="dc-device-list">{devices.map(renderDevice)}</div>
          {!devices.some(device => device.kind !== 'local') && (!mobile || runtime.paired) && <p className="dc-empty-devices">{runtime.paired ? '没有其他已配对设备' : '添加一台电脑或服务器，即可在这里打开它的工作台。'}</p>}
          {data.capabilities?.ssh === false && <p className="dc-footnote">此客户端支持连接已有设备。SSH 安装请使用新版桌面或 Android 客户端。</p>}
          {loaded && data.capabilities?.hostAdmin && <div className="dc-connection-details link-settings" ref={setDetailsTarget} />}
        </section>
        {loaded && relayManagement && <section id="dc-panel-relay" className="dc-relay-section" role="tabpanel" aria-labelledby="dc-tab-relay" hidden={directoryTab !== 'relay'}>
          <RelayPool runtime={runtime} refreshToken={relayRevision} active={showDevices && directoryTab === 'relay'} currentDevice={active ?? data.devices.find(item => item.id === data.activeId)} onChanged={relayChanged} onAdd={data.capabilities?.hostAdmin ? () => setModal({ type: 'relay' }) : undefined} />
          {relayJob && <div className="dc-relay-job-status"><span role="status">{jobFailed(relayJob) ? '中继部署失败' : jobFinished(relayJob) ? '中继部署完成' : '中继正在后台部署'}</span><Button onClick={() => setModal({ type: 'relay', progress: true })}>查看部署进度</Button></div>}
        </section>}
      </section>
    </div>
    <div className="dc-workbenches" hidden={showDevices} aria-busy={!!busy || !!(activeId && !readyFrames.includes(activeId))}>
      {frames.map(frame => <iframe key={frame.id} ref={element => { if (element) frameElements.current.set(frame.id, element); else frameElements.current.delete(frame.id); }} onLoad={() => frameLoaded(frame)} src={frame.url} title={frame.name + '工作台'} hidden={activeId !== frame.id} allow="clipboard-read; clipboard-write; microphone" referrerPolicy="no-referrer" />)}
      {!showDevices && !error && (!!busy || (activeId && !readyFrames.includes(activeId))) && <div className="dc-workbench-loading"><DeviceLoading label={busy ? '正在连接设备…' : '正在加载工作台…'} /></div>}
    </div>
    {!showDevices && error && <div className="dc-workbench-error"><ErrorLine error={error} /><Button onClick={() => setShowDevices(true)}>返回设备</Button></div>}
    {renderModal()}
  </main>;
}
