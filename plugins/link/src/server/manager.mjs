import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { createServer, isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import ssh2 from 'ssh2';
import { request } from 'node:https';
import { remoteAgent, remoteJson, upstreamOrigin } from '../devices/remote.mjs';
import { deployRelay, relayManagementCommand, validateRelayDeployment } from './relay-deployment.mjs';
import { ensureServerResources } from '../../../base/shared/server-resources.mjs';
import { ownerCommand, ownerDiscoverCommand, ownerScript } from './owner-command.mjs';
import { openDeviceRegistry } from '../devices/registry.mjs';
const { Client, OpenSSHAgent } = ssh2;
const operationError = (message, code, status = 409) => Object.assign(new Error(message), { code, status });
const sshAgent = () => process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
export const fingerprintOf = key => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function validateSshInput(input, { credentials = false } = {}) {
  const host = typeof input?.host === 'string' ? input.host.trim().replace(/^\[|\]$/g, '') : '';
  const username = typeof input?.username === 'string' ? input.username.trim() : '';
  const port = input?.port === undefined || input.port === '' ? 22 : Number(input.port);
  if (!host || host.length > 253 || !(isIP(host) || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))) throw new Error('请输入有效的服务器 IP 或域名');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须为 1–65535');
  if (!username || username.length > 64 || /[\x00-\x20\x7f]/.test(username)) throw new Error('请输入有效的 SSH 用户名');
  if (credentials && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(input.fingerprint ?? '')) throw new Error('请先确认服务器 SSH 指纹');
  if (credentials && !input.password && !input.privateKey && !sshAgent()) throw operationError('请在设备中心重新连接 SSH，输入密码或私钥', 'SSH_AUTH_REQUIRED');
  for (const field of ['password', 'privateKey', 'passphrase']) if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > (field === 'privateKey' ? 65536 : 4096))) throw new Error('SSH 认证信息无效');
  const source = input.source ?? 'mirror'; if (!['mirror', 'github'].includes(source)) throw new Error('不支持的下载源');
  return { host, port, username, source };
}
const publicRecord = device => ({ id: device.id, name: device.name, kind: 'ssh', url: device.ssh.host, status: device.status, ...(device.warning ? { warning: device.warning } : {}), ...(device.lastError ? { lastError: device.lastError } : {}) });
export function redactServerLog(text, secrets = []) {
  let result = String(text).replace(/([?&](?:token|code)=)[^\s&]+/gi, '$1[redacted]').replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]').replace(/("(?:password|passphrase|privateKey|token)"\s*:\s*")[^"]*/gi, '$1[redacted]');
  for (const value of secrets.filter(Boolean)) result = result.split(value).join('[redacted]');
  return result.slice(-12000);
}
const friendlyError = error => /host denied|hostkey|fingerprint/i.test(error?.message ?? '') ? 'SSH 主机指纹不匹配，已阻止认证' : /authentication|auth|password/i.test(error?.message ?? '') ? 'SSH 认证失败，请检查用户名、密码或私钥' : /timed out|timeout/i.test(error?.message ?? '') ? 'SSH 连接超时，请检查地址和网络' : error?.message ?? '服务器连接失败';
function sshConnect(input, factory, probe = false) {
  const base = validateSshInput(input, { credentials: !probe });
  return new Promise((resolve, reject) => {
    const client = factory(); let settled = false, mismatch = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { finish(operationError('SSH 连接超时', 'ETIMEDOUT', 503)); client.destroy(); }, 25000); timer.unref?.();
    client.on('error', error => finish(operationError(mismatch ? 'SSH 主机指纹不匹配，已阻止认证' : friendlyError(error), mismatch ? 'IDENTITY_CHANGED' : error.level === 'client-authentication' || /agent|authentication/i.test(error.message) ? 'SSH_AUTH_REQUIRED' : error.code || 'OFFLINE', 503)));
    client.on('close', () => { if (!settled) finish(operationError('SSH 连接已关闭', 'OFFLINE', 503)); });
    client.on('ready', () => finish(null, client));
    try {
      client.connect({ ...base, readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3,
        ...(probe ? { authHandler: () => false } : { password: input.password, privateKey: input.privateKey, passphrase: input.passphrase,
          agent: input.password || input.privateKey ? undefined : sshAgent(),
          authHandler: input.privateKey ? ['publickey'] : input.password ? ['password', 'keyboard-interactive'] : ['agent'], tryKeyboard: Boolean(input.password) }),
        hostVerifier(key) {
          const fingerprint = fingerprintOf(key);
          if (probe) { finish(null, { fingerprint }); queueMicrotask(() => client.destroy()); return false; }
          mismatch = fingerprint !== input.fingerprint; return !mismatch;
        },
      });
      if (!probe && input.password) client.on('keyboard-interactive', (_name, _instructions, _language, prompts, done) => done(prompts.map(() => input.password)));
    } catch (error) { finish(error); client.destroy(); }
  });
}
export async function execute(client, command, { timeout = 60000, stdin, maximum = 2 * 1024 * 1024, onData, signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) { reject(error); return; }
      let output = '', stderr = '', settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      const abort = () => { finish(signal.reason); stream.close(); };
      const timer = setTimeout(() => { stream.close(); finish(new Error('服务器操作超时')); }, timeout); timer.unref?.();
      const append = (text, data) => { const value = text + data; if (Buffer.byteLength(value) > maximum) { stream.close(); finish(new Error('服务器返回内容过大')); } return value; };
      stream.on('data', data => { output = append(output, data); onData?.(data.toString(), 'stdout'); });
      stream.stderr.on('data', data => { stderr = append(stderr, data); onData?.(data.toString(), 'stderr'); });
      stream.once('error', error => finish(error)); stream.once('close', code => finish(null, { code, stdout: output, stderr }));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      stream.end(stdin);
    });
  });
}
export async function upload(client, local, remote) {
  const sftp = await new Promise((resolve, reject) => client.sftp((error, value) => error ? reject(error) : resolve(value)));
  try { await new Promise((resolve, reject) => sftp.fastPut(local, remote, { mode: 0o600 }, error => error ? reject(error) : resolve())); }
  finally { sftp.end(); }
}
export async function openSshTunnel(client, remotePort) {
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error('服务器端口无效');
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    client.forwardOut('127.0.0.1', socket.localPort || 0, '127.0.0.1', remotePort, (error, stream) => {
      if (error || socket.destroyed) { stream?.destroy(); socket.destroy(); return; }
      stream.on('error', () => socket.destroy()); socket.on('close', () => stream.destroy()); stream.on('close', () => socket.destroy()); socket.pipe(stream).pipe(socket);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: 'https://127.0.0.1:' + server.address().port, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
/** Verify TLS identity, authorization and the actual workbench before registration. */
export async function verifyServerWorkbench(target) {
  const agent = remoteAgent(target);
  try {
    const { value, headers } = await remoteJson(target, '/link/api/workbench', {}, { agent });
    const cookie = headers['set-cookie']?.find(value => value.startsWith('dsh_link_workbench='))?.split(';')[0];
    if (value?.url !== '/link/workbench/' || !cookie) throw new Error('服务器未返回有效工作台授权');
    await new Promise((resolve, reject) => {
      const req = request(new URL('/link/workbench/', upstreamOrigin(target)), { agent, timeout: 20000, headers: { cookie } }, res => {
        let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) req.destroy(new Error('服务器工作台响应过大')); });
        res.once('error', reject);
        res.once('end', () => res.statusCode === 200 && /text\/html/i.test(res.headers['content-type'] ?? '') && bytes > 0 ? resolve() : reject(new Error('服务器工作台尚未就绪')));
      });
      req.once('error', reject); req.once('timeout', () => req.destroy(new Error('服务器工作台验证超时'))); req.end();
    });
  } finally { agent.destroy(); }
}
export function createServerManager({ directory, registry: sharedRegistry, onDevice = async () => {}, runtimeRoot, assetsRoot, relayAssetsRoot, resourceFetcher = ensureServerResources, onRelay = async () => { throw new Error('本机中继接入未配置'); }, clientFactory = () => new Client() } = {}) {
  if (!directory) throw new Error('服务器管理目录未配置');
  const clients = new Set(), terminals = new Map(), commands = new Map(), reconnecting = new Map(), sshErrors = new Map(), pairings = new Map();
  const revisions = new WeakMap();
  const records = new Map(), sessions = new Map(), jobs = new Map(), controls = new Map(), connecting = new Set();
  let registry, closed = false;
  const assets = assetsRoot ?? (runtimeRoot ? (runtimeRoot instanceof URL ? fileURLToPath(runtimeRoot) : runtimeRoot) : fileURLToPath(new URL('../../../dist/server/', import.meta.url)));
  const ready = Promise.resolve(sharedRegistry ?? openDeviceRegistry(directory)).then(value => {
    registry = value;
    for (const device of registry.sshRecords()) records.set(device.id, device);
  });
  const ensure = () => { if (closed) throw new Error('服务器管理已关闭'); };
  const open = async (input, probe = false) => { const client = await sshConnect(input, () => { const value = clientFactory(); clients.add(value); value.once('close', () => clients.delete(value)); return value; }, probe); ensure(); return client; };
  async function resources(input, job, step, signal) {
    const labels = { checking: '检查固定版本部署资源', downloading: '下载服务器部署资源', verifying: '校验部署资源', extracting: '准备服务器部署资源', 'verifying-offline': '校验离线部署资源', 'verifying-cache': '校验缓存部署资源', 'repairing-cache': '重新获取损坏的部署资源', ready: '部署资源已就绪' };
    let previous;
    job.cancellable = true;
    try {
      return await resourceFetcher({ assetsRoot: assets, cacheRoot: join(directory, 'server-resources'), source: input.source ?? 'mirror', signal,
        onProgress(progress) {
          if (progress.stage !== previous) { step(labels[progress.stage] ?? '准备服务器部署资源'); previous = progress.stage; }
          job.progress = { ...progress };
          if (progress.stage === 'downloading' && Number.isFinite(progress.total) && progress.total > 0 && Number.isFinite(progress.transferred))
            job.steps.at(-1).message = `${(progress.transferred / 1_000_000).toFixed(1)} / ${(progress.total / 1_000_000).toFixed(1)} MB · ${Math.min(100, Math.floor(progress.transferred * 100 / progress.total))}%`;
        },
      });
    } finally { job.cancellable = false; }
  }
  async function install(client, input, operation, job, step, signal) {
    const material = await resources(input, job, step, signal);
    signal.throwIfAborted();
    ensure();
    if (material.manifest.bootstrapCheck === true) {
      step('检查服务器环境');
      const checked = await execute(client, 'bash -s -- ' + shellQuote(input.source ?? 'mirror') + ' check', {
        stdin: await readFile(join(material.directory, 'bootstrap.sh')), timeout: 30_000,
      });
      if (checked.code !== 0) throw new Error(redactServerLog(checked.stderr || '服务器环境检查失败', [input.password, input.privateKey, input.passphrase]));
    }
    signal.throwIfAborted();
    step('上传服务器安装资源');
    const nonce = randomBytes(16).toString('hex');
    const command = 'umask 077; directory="$HOME/.cache/benchgo-bootstrap-' + nonce + '"; mkdir -p -- "$directory"; printf "%s\n" "$directory"';
    const created = await execute(client, command); const path = created.stdout.trim();
    if (created.code !== 0 || !path.startsWith('/') || /[\r\n\0]/.test(path) || !path.endsWith('benchgo-bootstrap-' + nonce)) throw new Error('无法创建服务器安装目录');
    try {
      for (const name of ['bootstrap.sh', 'bootstrap.mjs', 'manifest.json', 'server-seed.tar.gz']) await upload(client, join(material.directory, name), path + '/' + name);
      step(operation === 'update' ? '升级服务器工作台' : '检查与安装工作台');
      let progress = '';
      const result = await execute(client, 'bash ' + shellQuote(path + '/bootstrap.sh') + ' ' + shellQuote(input.source ?? 'mirror') + ' ' + shellQuote(operation), {
        timeout: 20 * 60 * 1000,
        onData(data, source) {
          if (source !== 'stderr') return;
          progress = (progress + data).slice(-1024);
          if (progress.includes('下载并校验 Node.js')) { step('安装 Node.js'); progress = ''; }
          else if (progress.includes('安装固定版本 Harness')) { step('安装 BenchGo'); progress = ''; }
          else if (progress.includes('复用已安装的 BenchGo')) { step('启动 BenchGo'); progress = ''; }
        },
      });
      if (result.code !== 0) throw new Error(redactServerLog(result.stderr || '服务器安装失败', [input.password, input.privateKey, input.passphrase]));
      let value; try { value = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); } catch { throw new Error('服务器安装器未返回有效结果'); }
      if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[A-Za-z0-9+/]{43}=$/.test(value.pin ?? '') || (operation !== 'update' && !/^[A-Za-z0-9_-]{20,256}$/.test(value.token ?? ''))) throw new Error('服务器授权结果无效');
      return value;
    } finally { await execute(client, 'rm -rf -- ' + shellQuote(path), { timeout: 10000 }).catch(() => {}); }
  }
  function startJob(work, kind = 'server') {
    ensure(); if (jobs.size >= 64) for (const [id, job] of jobs) { if (job.state !== 'running') jobs.delete(id); if (jobs.size < 32) break; }
    const controller = new AbortController();
    const job = { id: randomUUID(), kind, state: 'running', cancellable: false, steps: [{ name: kind === 'server-prefetch' ? '准备部署资源' : '连接 SSH', state: 'running' }] }; jobs.set(job.id, job); controls.set(job.id, controller);
    const step = name => { for (const old of job.steps) if (old.state === 'running') old.state = 'done'; job.steps.push({ name, state: 'running' }); };
    Promise.resolve().then(() => work(job, step, controller.signal)).then(device => { controller.signal.throwIfAborted(); job.state = 'done'; for (const step of job.steps) if (step.state === 'running') step.state = 'done'; if (device?.resources) job.resources = device.resources; else if (device?.relay) job.relay = device.relay; else job.device = publicRecord(device); }).catch(error => { job.state = controller.signal.aborted ? 'cancelled' : 'error'; job.error = controller.signal.aborted ? '部署资源获取已取消，可重新尝试' : friendlyError(error); for (const step of job.steps) if (step.state === 'running') step.state = controller.signal.aborted ? 'cancelled' : 'error'; }).finally(() => { job.cancellable = false; controls.delete(job.id); });
    return { jobId: job.id };
  }
  async function closeTunnel(session) { await session.tunnel?.then(tunnel => tunnel.close()).catch(() => {}); }
  async function attach(client, device, { register = false } = {}) {
    ensure();
    if (!clients.has(client)) throw operationError('SSH 连接已关闭', 'OFFLINE', 503);
    const previous = sessions.get(device.id), previousDevice = records.get(device.id);
    const session = { client }; sessions.set(device.id, session); sshErrors.delete(device.id);
    const disconnect = () => {
      if (sessions.get(device.id) !== session) return;
      sessions.delete(device.id);
      void closeTunnel(session);
      if (session.tunnel && records.has(device.id)) Promise.resolve(onDevice({ id: device.id, status: 'offline' })).catch(() => {});
    };
    client.once('close', disconnect);
    if (register) {
      records.set(device.id, device);
      try { await registry.upsert({ ...device, kind: 'ssh' }); }
      catch (error) {
        if (records.get(device.id) === device) {
          if (previousDevice) records.set(device.id, previousDevice); else records.delete(device.id);
        }
        if (sessions.get(device.id) === session) {
          if (previous && clients.has(previous.client)) sessions.set(device.id, previous); else sessions.delete(device.id);
        }
        throw error;
      }
      await onDevice({ id: device.id, status: 'online' });
      if (previousDevice && previousDevice !== device) {
        for (const controller of commands.get(device.id) ?? []) controller.abort();
      }
    }
    if (previous) { await closeTunnel(previous); if (previous.client !== client) previous.client.end(); }
    return { ...device, status: register ? 'online' : 'unknown' };
  }
  async function connected(id) {
    ensure(); await ready;
    const device = records.get(id);
    if (!device) throw operationError('此设备尚未绑定 SSH', 'SSH_NOT_CONFIGURED');
    if (sessions.has(id)) return sessions.get(id);
    if (reconnecting.has(id)) return reconnecting.get(id);
    const opening = (async () => {
      let client;
      try { client = await open(device.ssh); }
      catch (error) { if (records.get(id) === device && !sessions.has(id)) sshErrors.set(id, error.code); throw error; }
      try {
        if (records.get(id) !== device) throw operationError('服务器登记已变化，请重试', 'IDENTITY_CHANGED');
        await attach(client, device);
        return sessions.get(id);
      } catch (error) { client.end(); throw error; }
    })().finally(() => reconnecting.delete(id));
    reconnecting.set(id, opening);
    return opening;
  }
  async function owner(client, input) {
    const result = await execute(client, ownerCommand, { stdin: ownerScript(input), timeout: 25000 });
    let response;
    try { response = JSON.parse(result.stdout.trim()); } catch { throw new Error('服务器管理入口尚未就绪'); }
    if (result.code !== 0) throw new Error(redactServerLog(response.error || '服务器管理请求失败'));
    return response;
  }
  async function verify(client, device) {
    const tunnel = await openSshTunnel(client, device.ssh.remotePort);
    try { await verifyServerWorkbench({ ...device, kind: 'ssh', url: tunnel.url }); }
    finally { await tunnel.close(); }
  }
  async function authorizeExisting(client, status, name) {
    const pin = status.hostId?.slice('sha256:'.length);
    if (!status.enabled || !/^sha256:[A-Za-z0-9+/]{43}=$/.test(status.hostId)) throw new Error('服务器 Link 身份或监听配置不兼容');
    const tunnel = await openSshTunnel(client, status.port);
    const target = { kind: 'ssh', url: tunnel.url, pin, ssh: { remotePort: status.port } };
    let deviceId;
    try {
      const pair = await owner(client, { action: 'pairing', mode: 'lan', expectedHostId: status.hostId });
      const { value: pending } = await remoteJson(target, '/link/api/pair', { code: pair.code, name });
      await owner(client, { action: 'confirm', id: pending.requestId, expectedHostId: status.hostId });
      const { value: approved } = await remoteJson(target, '/link/api/pair/status', pending);
      if (approved.hostId !== status.hostId || approved.status !== 'approved' || !approved.deviceId || !approved.token) throw new Error('服务器未返回可核验的设备授权');
      deviceId = approved.deviceId;
      await verifyServerWorkbench({ ...target, token: approved.token });
      return { port: status.port, pin, token: approved.token, deviceId };
    } catch (error) {
      if (deviceId) await owner(client, { action: 'revoke', id: deviceId, expectedHostId: status.hostId }).catch(() => {});
      throw error;
    } finally { await tunnel.close(); }
  }
  async function pairing({ deviceId, operation, requestId, publicUrl }) {
    const { client } = await connected(deviceId);
    const record = records.get(deviceId);
    const expectedHostId = record.hostId || 'sha256:' + record.pin;
    const request = (action, args = {}) => owner(client, { action, expectedHostId, ...args });
    if (operation === 'configure') {
      let endpoint;
      try { endpoint = new URL(publicUrl); } catch { throw operationError('请输入公网 HTTPS 地址', 'PAIRING_ROUTE_INVALID', 400); }
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw operationError('请输入公网 HTTPS 主机地址', 'PAIRING_ROUTE_INVALID', 400);
      await request('configure', { publicUrl: endpoint.origin });
      return { ok: true };
    }
    if (operation !== 'generate') {
      const pairing = pairings.get(deviceId);
      if (!pairing || pairing.expiresAt <= Date.now()) {
        if (operation === 'status') return { pending: [] };
        throw new Error('配对申请已过期或不存在');
      }
      if (operation === 'status') return request('status', { code: pairing.code });
      if (typeof requestId !== 'string') throw new Error('配对申请无效');
      await request(operation, { id: requestId, code: pairing.code });
      return { ok: true };
    }
    const status = await request('status');
    if (!status.scopedPairing) throw operationError('请先更新服务器的 BenchGo，再生成手机连接码', 'PAIRING_UPDATE_REQUIRED');
    const candidates = [status.publicUrl && ['public', status.publicUrl], status.relay?.connected && ['relay', status.relay.url]].filter(Boolean);
    for (const [mode, url] of candidates) {
      try {
        const endpoint = new URL(url);
        if (endpoint.protocol !== 'https:' || endpoint.origin !== url || ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)) continue;
        const probe = await request('pairing-probe');
        if (typeof probe.id !== 'string' || typeof probe.proof !== 'string') continue;
        const response = await remoteJson({ url }, '/link/api/info?probe=' + encodeURIComponent(probe.id), undefined, { timeout: 3500 });
        if (response.value?.proof !== probe.proof) continue;
        const page = await fetch(new URL('/link/', endpoint), { redirect: 'error', signal: AbortSignal.timeout(3500) });
        await page.body?.cancel();
        if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) continue;
      } catch { continue; }
      const result = await request('pairing', { mode });
      if (result.url !== url) throw new Error('服务器配对地址已变化，请重新生成');
      pairings.set(deviceId, { code: result.code, expiresAt: result.expiresAt });
      return result;
    }
    throw operationError('手机待配置。请填写服务器可达的公网 HTTPS 地址，或连接服务器中继后重试', 'PAIRING_ROUTE_REQUIRED');
  }
  function getTerminal({ deviceId, id }) {
    const terminal = terminals.get(id);
    if (!terminal || terminal.deviceId !== deviceId) throw operationError('终端会话已关闭', 'SSH_TERMINAL_CLOSED');
    return terminal;
  }
  function closeTerminal(id) {
    const terminal = terminals.get(id);
    if (!terminal) return;
    terminals.delete(id);
    clearTimeout(terminal.timer);
    terminal.stream.close();
  }
  function watchTerminal(id, terminal) {
    clearTimeout(terminal.timer);
    terminal.timer = setTimeout(() => closeTerminal(id), 60_000);
    terminal.timer.unref?.();
  }
  async function sshTarget({ deviceId }) {
    ensure(); await ready;
    const device = records.get(deviceId);
    if (!device) throw operationError('此设备尚未绑定 SSH', 'SSH_NOT_CONFIGURED');
    if (!revisions.has(device)) revisions.set(device, randomUUID());
    const { host, port, username, fingerprint } = device.ssh;
    return { deviceId, name: registry.get(deviceId).name, host, port, username, fingerprint, revision: revisions.get(device) };
  }
  return {
    sshTarget,
    pairing,
    ready,
    agentAvailable: () => {
      const socket = sshAgent();
      if (!socket) return false;
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 750);
        new OpenSSHAgent(socket).getIdentities((error, keys) => { clearTimeout(timer); resolve(!error && Boolean(keys?.length)); });
      });
    },
    state(id) {
      const record = records.get(id);
      if (!record) return;
      const code = sshErrors.get(id);
      const sshStatus = sessions.has(id) ? 'connected' : code === 'SSH_AUTH_REQUIRED' ? 'auth-required' : code === 'IDENTITY_CHANGED' ? 'failed' : code ? 'offline' : 'disconnected';
      return { sshManaged: true, sshStatus };
    },
    async workbenchTarget(id) {
      const session = await connected(id);
      const device = records.get(id);
      session.tunnel ??= openSshTunnel(session.client, device.ssh.remotePort).catch(error => { session.tunnel = undefined; throw error; });
      const tunnel = await session.tunnel;
      if (sessions.get(id) !== session) { await closeTunnel(session); throw operationError('SSH 连接已关闭', 'OFFLINE', 503); }
      const saved = registry.get(id);
      return { ...device, ...saved, kind: 'ssh', pin: device.hostId ? device.hostId.slice('sha256:'.length) : device.pin, url: tunnel.url };
    },
    async sshCommand({ deviceId, command, expectedRevision, signal }) {
      if (typeof command !== 'string' || !command.trim() || command.length > 16384 || command.includes('\0')) throw new Error('SSH 命令无效');
      signal?.throwIfAborted();
      const initial = await sshTarget({ deviceId });
      if (initial.revision !== expectedRevision) throw operationError('SSH 登记已变化，请重新确认', 'IDENTITY_CHANGED');
      const { client } = await connected(deviceId);
      if ((await sshTarget({ deviceId })).revision !== expectedRevision) throw operationError('SSH 登记已变化，请重新确认', 'IDENTITY_CHANGED');
      const controller = new AbortController();
      const running = commands.get(deviceId) ?? new Set();
      commands.set(deviceId, running); running.add(controller);
      const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
      try {
        const result = await execute(client, command, { signal: combined, maximum: 256 * 1024 });
        return { code: result.code ?? null, stdout: redactServerLog(result.stdout), stderr: redactServerLog(result.stderr), status: Number.isInteger(result.code) ? 'completed' : 'unknown' };
      } catch (error) {
        return { code: null, status: 'unknown', reason: redactServerLog(error.message) };
      } finally {
        running.delete(controller);
        if (!running.size) commands.delete(deviceId);
      }
    },
    async openTerminal(deviceId) {
      const { client } = await connected(deviceId);
      if (terminals.size >= 12) throw new Error('已打开的 SSH 终端过多');
      const stream = await new Promise((resolve, reject) => client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (error, channel) => error ? reject(error) : resolve(channel)));
      if (closed || !records.has(deviceId)) { stream.close(); throw new Error('服务器连接已关闭'); }
      const device = records.get(deviceId), id = randomUUID();
      const terminal = { deviceId, stream, output: '', start: 0, closed: false };
      const decoder = new StringDecoder('utf8');
      const append = data => {
        terminal.output += data;
        const excess = Math.max(0, terminal.output.length - 256 * 1024);
        terminal.start += excess;
        terminal.output = terminal.output.slice(excess);
      };
      stream.on('data', chunk => append(decoder.write(chunk)));
      stream.on('error', () => { terminal.closed = true; });
      stream.once('close', () => { append(decoder.end()); terminal.closed = true; });
      terminals.set(id, terminal);
      watchTerminal(id, terminal);
      return { id, title: `${registry.get(deviceId).name} · ${device.ssh.username}@${device.ssh.host}` };
    },
    readTerminal(input) {
      const terminal = getTerminal(input), offset = input.offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > terminal.start + terminal.output.length) throw new Error('终端读取位置无效');
      watchTerminal(input.id, terminal);
      const start = Math.max(terminal.start, offset);
      const output = terminal.output.slice(start - terminal.start, start - terminal.start + 32768);
      const next = start + output.length;
      return { output: (offset < terminal.start ? '\r\n[部分终端输出已省略]\r\n' : '') + output, offset: next, closed: terminal.closed && next === terminal.start + terminal.output.length };
    },
    writeTerminal(input) {
      const terminal = getTerminal(input);
      if (terminal.closed || typeof input.data !== 'string' || input.data.length > 16384) throw new Error('终端输入无效');
      terminal.stream.write(input.data);
      return { ok: true };
    },
    resizeTerminal(input) {
      const terminal = getTerminal(input);
      if (!terminal.closed && [input.rows, input.cols].every(value => Number.isInteger(value) && value > 0 && value <= 1000)) terminal.stream.setWindow(input.rows, input.cols, 0, 0);
      return { ok: true };
    },
    closeTerminal(input) {
      if (terminals.get(input.id)?.deviceId === input.deviceId) closeTerminal(input.id);
      return { ok: true };
    },
    async prefetch(input = {}) {
      ensure();
      if (!['mirror', 'github'].includes(input.source ?? 'mirror')) throw new Error('不支持的下载源');
      return startJob(async (job, step, signal) => {
        const result = await resources(input, job, step, signal);
        return { resources: { cached: true, origin: result.origin, version: result.manifest.pluginVersion } };
      }, 'server-prefetch');
    },
    cancelJob(input) {
      ensure(); const id = typeof input === 'string' ? input : input?.jobId ?? input?.id, job = jobs.get(id);
      if (!job) throw new Error('任务已过期');
      if (job.state !== 'running') return { ok: true };
      if (!job.cancellable) throw new Error('当前阶段不能取消；远端安装开始后请等待安全完成');
      controls.get(id)?.abort(); return { ok: true };
    },
    async relayProbe(input) { return this.probe(input); },
    async deployRelay(input) {
      ensure(); validateSshInput(input, { credentials: true }); validateRelayDeployment(input);
      const key = 'relay|' + [input.host, input.port ?? 22, input.username].join('|');
      if (connecting.has(key)) throw new Error('此中继正在部署'); connecting.add(key);
      return startJob(async (_job, step) => { let client; try {
        client = await open(input);
        let relayAssets = relayAssetsRoot;
        if (!relayAssets) {
          const candidates = [fileURLToPath(new URL('../relay/', import.meta.url)), fileURLToPath(new URL('../../../base/lib/relay/', import.meta.url)), join(assets, '..', 'relay')];
          for (const candidate of candidates) { try { await access(join(candidate, 'run-relay-server.cjs')); await access(join(candidate, 'ip-certificate.mjs')); relayAssets = candidate; break; } catch {} }
        }
        if (!relayAssets) throw new Error('未找到打包的中继部署工具');
        return await deployRelay({ client, input, execute, upload, assets: relayAssets, step, onRelay });
      } catch(error) { throw new Error(redactServerLog(error.message, [input.password,input.privateKey,input.passphrase])); } finally { client?.end(); connecting.delete(key); } }, 'relay');
    },
    async manageRelay(input) {
      ensure(); validateSshInput(input, { credentials: true }); const command = relayManagementCommand(input.operation);
      const client = await open(input);
      try { const result = await execute(client, 'if [ "$(id -u)" = 0 ]; then bash -s; else sudo -n bash -s; fi', { stdin: command });
        if(result.code !== 0 && !['status', 'renew-status', 'diagnose'].includes(input.operation)) throw new Error('中继管理失败：' + redactServerLog(result.stderr, [input.password,input.privateKey,input.passphrase]));
        return {
          operation: input.operation,
          ...(['status', 'renew-status'].includes(input.operation) ? { status: result.code === 0 ? result.stdout.trim() : 'inactive' } : {}),
          ...(input.operation === 'logs' || input.operation === 'diagnose' ? { logs: redactServerLog(result.stdout + (result.stderr || '')) } : {}),
        };
      } finally { client.end(); }
    },
    async probe(input) { ensure(); validateSshInput(input); return open(input, true); },
    async connect(input) {
      ensure(); await ready; const target = validateSshInput(input, { credentials: true });
      const name = String(input.name || target.host).trim(); if (!name || name.length > 100) throw new Error('设备名称须为 1–100 个字符');
      const key = [target.host, target.port, target.username].join('|');
      const known = [...records.values()].find(device => [device.ssh.host, device.ssh.port, device.ssh.username].join('|') === key);
      if (known) {
        if (input.device && input.device.id !== known.id) throw new Error('此 SSH 账号已绑定其他设备，请核对登记');
        if (known.ssh.fingerprint !== input.fingerprint) throw new Error('SSH 主机指纹已改变，已保留原连接');
        return this.reconnect({ ...input, id: known.id });
      }
      if (connecting.has(key)) throw new Error('此服务器正在连接'); connecting.add(key);
      return startJob(async (job, step, signal) => {
        let client;
        try {
          client = await open(input); ensure();
          step('检查已有 BenchGo 安装');
          const discovery = await execute(client, ownerDiscoverCommand);
          const installed = discovery.stdout.trim();
          if (discovery.code !== 0 || !['present', 'absent'].includes(installed)) throw new Error('无法识别已有 BenchGo 安装，请通过终端检查该账号的服务');
          let result, existing;
          if (installed === 'present') {
            step('核验已有设备身份');
            const status = await owner(client, { action: 'status', expectedHostId: input.device?.hostId });
            existing = input.device || registry.findByHostId(status.hostId);
            result = existing ? { port: status.port, pin: status.hostId.slice('sha256:'.length), token: existing.token, deviceId: existing.authorizationId } : await authorizeExisting(client, status, name);
          } else {
            if (input.device) throw new Error('此 SSH 账号下没有找到已配对的 BenchGo 实例');
            result = await install(client, input, 'connect', job, step, signal);
          }
          ensure(); step('验证安全工作台');
          const ssh = { ...target, fingerprint: input.fingerprint, remotePort: result.port };
          const device = { id: existing?.id ?? randomUUID(), name: existing?.name ?? name, kind: 'ssh', hostId: 'sha256:' + result.pin,
            authorizationId: result.deviceId, pin: result.pin, token: result.token, ssh,
            ...(result.warning ? { warning: result.warning } : {}) };
          if (existing || installed === 'absent') await verify(client, device);
          if (existing && registry.findByHostId(existing.hostId) !== existing) throw operationError('原设备登记已变化，请重新打开设备中心', 'IDENTITY_CHANGED');
          return await attach(client, device, { register: true });
        } catch (error) { client?.end(); throw error; }
        finally { connecting.delete(key); }
      });
    },
    async reconnect(input) {
      ensure(); await ready; const device = records.get(input.id); if (!device) throw new Error('未找到此服务器');
      const value = { ...device.ssh, password: input.password, privateKey: input.privateKey, passphrase: input.passphrase }; validateSshInput(value, { credentials: true });
      return startJob(async () => { const client = await open(value).catch(error => { if (!sessions.has(input.id)) sshErrors.set(input.id, error.code); throw error; }); try { if (records.get(input.id) !== device) throw new Error('服务器登记已变化'); return await attach(client, device); } catch (error) { client.end(); throw error; } });
    },
    async job(id) { ensure(); const job = jobs.get(typeof id === 'string' ? id : id?.id); if (!job) throw new Error('任务已过期'); return structuredClone(job); },
    activeRelayJob() { ensure(); const job = [...jobs.values()].reverse().find(item => item.kind === 'relay'); return job ? structuredClone(job) : null; },
    dismissRelayJob(id) { ensure(); const job = jobs.get(id); if (!job || job.kind !== 'relay') return { ok: true }; if (job.state === 'running') throw new Error('部署仍在进行，暂时不能关闭任务'); jobs.delete(id); return { ok: true }; },
    async manage(input) {
      ensure(); await ready; const device = records.get(input.id);
      const session = await connected(input.id);
      const operation = input.operation;
      if (operation === 'update') return startJob(async (job, step, signal) => {
        const result = await install(session.client, { source: device.ssh.source }, 'update', job, step, signal);
        const pin = device.hostId ? device.hostId.slice('sha256:'.length) : device.pin;
        if (records.get(device.id) !== device || result.pin !== pin || sessions.get(device.id) !== session) throw operationError('服务器登记或主机身份已变化', 'IDENTITY_CHANGED');
        const updated = { ...device, ...registry.get(device.id), pin, ssh: { ...device.ssh, remotePort: result.port } };
        await verify(session.client, updated);
        return attach(session.client, updated, { register: true });
      });
      const prefix = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"; export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; ';
      const commands = { status: 'systemctl --user is-active benchgo.service', start: 'systemctl --user start benchgo.service', stop: 'systemctl --user stop benchgo.service', restart: 'systemctl --user restart benchgo.service', logs: 'journalctl --user -u benchgo.service --no-pager -n 80 -o cat' };
      if (!Object.hasOwn(commands, operation)) throw new Error('不支持的服务器操作');
      const result = await execute(session.client, prefix + commands[operation]); if (result.code !== 0 && operation !== 'status') throw new Error('服务器服务操作失败');
      return { operation, status: operation === 'status' ? result.stdout.trim() : operation === 'stop' ? 'stopped' : undefined, ...(operation === 'logs' ? { logs: redactServerLog(result.stdout) } : {}) };
    },
    async disconnect(id) { await ready; if (!records.delete(id)) return; sshErrors.delete(id); pairings.delete(id); for (const controller of commands.get(id) ?? []) controller.abort(); for (const [key, terminal] of terminals) if (terminal.deviceId === id) closeTerminal(key); const session = sessions.get(id); sessions.delete(id); if (session) { await closeTunnel(session); session.client.end(); } if (!sharedRegistry) await registry.remove(id); },
    async close() { if (closed) return; closed = true; for (const controller of controls.values()) controller.abort(); for (const id of terminals.keys()) closeTerminal(id); for (const client of clients) client.destroy(); await ready; for (const session of sessions.values()) { await closeTunnel(session); session.client.end(); } sessions.clear(); await registry.flush(); },
  };
}
