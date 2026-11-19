import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, workingDirectory } from './store.mjs';
import { CodexProvider } from './providers/codex.mjs';
import { ClaudeProvider } from './providers/claude.mjs';
import { PiProvider } from './providers/pi.mjs';
import { OpenCodeProvider } from './providers/opencode.mjs';
import { normalizeCommand } from './commands.mjs';
import { acpProviderClasses, ACP_TOOL_DEFAULTS } from './providers/acp.mjs';
import { prepareDefaultDataDirectory } from '../../base/src/data-directory.mjs';
import { fullNativePermission, isFullNativePermission, nativePermission, nativePermissionError } from './permissions.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const terminal = new Set(['idle', 'failed', 'disconnected', 'closed']);
export const providerClasses = { codex: CodexProvider, claude: ClaudeProvider, pi: PiProvider, opencode: OpenCodeProvider, gemini: acpProviderClasses.gemini, grok: acpProviderClasses.grok, mcode: acpProviderClasses.mcode };

export class Commander extends EventEmitter {
  constructor({ dataDir, providers = {}, approvalTimeout = 120_000, eventLimit = 2000, routeService } = {}) {
    super();
    this.defaultDataDirectory = dataDir === undefined;
    this.store = new Store(dataDir ?? join(homedir(), '.benchgo'));
    this.routeService = routeService;
    this.sessions = new Map(); this.drivers = new Map(); this.pending = new Map(); this.connecting = new Map();
    this.providers = new Map(Object.entries(providerClasses).map(([name, Type]) => [name, new Type(providers[name])]));
    this.approvalTimeout = approvalTimeout; this.eventLimit = eventLimit;
    this.fault = undefined; this.closing = false;
    this.generations = new Map();
    this.submissions = new Map(); this.activeSubmissions = new Set();
    this.removals = new Map();
    this.archiving = new Set();
    this.interruptedTurns = new Map();
    this.executionHandlers = new Map();
    this.preparingExecutions = new Map();
  }

  async open() {
    if (this.defaultDataDirectory) await prepareDefaultDataDirectory();
    const data = await this.store.open();
    try {
      if (!data || data.version !== 1 || !Array.isArray(data.sessions)) throw new Error('Unsupported BenchGo state format');
      for (const record of data.sessions) {
        if (['running', 'waiting', 'connecting'].includes(record.status)) {
          for (const entry of Object.values(record.receipts)) {
            if (entry.receipt.turnId === record.turnId) entry.receipt.status = 'uncertain';
          }
        }
        record.status = record.archived ? 'closed' : 'disconnected';
        record.pendingApprovals = [];
        this.sessions.set(record.id, record);
      }
      return this;
    } catch (error) {
      this.sessions.clear();
      await this.store.close();
      throw error;
    }
  }

  healthy() {
    if (this.closing) throw new Error('BenchGo is shutting down');
    if (this.fault) throw new Error(`BenchGo persistence failed: ${this.fault.message}`);
  }
  get(id) { const session = this.sessions.get(id); if (!session) throw new Error(`Unknown BenchGo session: ${id}`); return session; }
  list() { return [...this.sessions.values()].map(s => this.snapshot(s.id)); }
  snapshot(id) { const { events, receipts, ...value } = this.get(id); return copy(value); }
  catalog() { return [...this.providers].map(([name, provider]) => ({ name, capabilities: provider.constructor.capabilities })); }
  async providerConfig(name, session) {
    const base = this.providers.get(name)?.config ?? {};
    const installed = base.command ? { command: base.command, args: base.commandArgs ?? [] } : await this.toolInstaller?.resolveLaunch(name);
    const route = session?.route;
    if (route && !this.routeService) throw new Error('会话绑定服务不可用，拒绝回退到本机配置。');
    const launch = route ? await this.routeService.launch({ tool: name, route, sessionId: session.id }) : {};
    if (!installed) throw Object.assign(new Error(`${name} CLI is not installed or cannot be launched`), { code: 'TOOL_UNAVAILABLE' });
    return { ...base, ...launch, command: installed.command, commandArgs: [...(installed.args ?? []), ...(launch.commandArgs ?? [])],
      args: [...(installed.args ?? []), ...(base.args ?? [])],
      env: { ...installed.env, ...base.env, ...launch.env },
    };
  }
  async advancedConfig(tool) { return await this.runtimeSettings?.get(tool) ?? {}; }
  async permissionFor(session) {
    const selected = await this.resolvePermission?.(copy(session));
    let permission = selected !== undefined ? nativePermission(selected) : session.permission ? nativePermission(session.permission) : undefined;
    if (!permission && session.parentId) permission = await this.permissionFor(this.get(session.parentId));
    if (!permission && (session.executionId || !session.parentId && !session.nativeId && !session.nativeEstablished)) permission = { ...fullNativePermission };
    if (permission && !isFullNativePermission(permission) && !this.providers.get(session.provider)?.constructor.capabilities?.permissions) throw nativePermissionError(`${session.provider} 原生适配器无法精确同步 ${permission.sandbox} + ${permission.approval} 权限，请使用支持此限制的 Codex 或官方 API 会话。`);
    return permission;
  }
  async syncPermission(id) {
    const session = this.get(id), permission = await this.permissionFor(session);
    if (!permission) return;
    if (JSON.stringify(permission) === JSON.stringify(session.permission)) return;
    const driver = this.drivers.get(id);
    if (typeof driver?.setPermission === 'function') await driver.setPermission(permission);
    else if (!isFullNativePermission(permission) || this.providers.get(session.provider)?.constructor.capabilities?.permissions) throw nativePermissionError(`${session.provider} 当前连接不支持同步会话权限，请重新连接。`);
    session.permission = permission;
    await this.persist();
  }
  async doctor() {
    const run = promisify(execFile);
    return Promise.all([...this.providers].map(async ([name, provider]) => {
      try {
        const config = await this.providerConfig(name);
        const { stdout } = await run(config.command, [...(config.commandArgs ?? []), '--version'], { env: { ...process.env, ...config.env }, timeout: 8000, maxBuffer: 32_768, windowsHide: true });
        return { name, available: true, version: stdout.trim().slice(0, 200) };
      } catch (error) { return { name, available: false, error: ['ENOENT', 'TOOL_UNAVAILABLE'].includes(error.code) ? 'not-installed' : 'version-check-failed' }; }
    }));
  }
  persist() {
    clearTimeout(this.flushTimer); this.flushTimer = undefined;
    return this.store.save([...this.sessions.values()]);
  }

  event(id, type, data = {}) {
    const session = this.get(id);
    if (type === 'turn.started' && session.status !== 'closed' && session.status !== 'waiting') session.status = 'running';
    if (type === 'turn.completed') {
      session.status = data.status === 'failed' ? 'failed' : 'idle';
      this.denyPending(id);
    }
    const event = copy({ seq: ++session.cursor, time: new Date().toISOString(), sessionId: id, turnId: session.turnId ?? null, type, data });
    session.events.push(event);
    if (session.events.length > this.eventLimit) session.events.splice(0, session.events.length - this.eventLimit);
    session.updatedAt = event.time;
    // Save snapshots in order. A failed write prevents subsequent mutations;
    // it is observable and never silently reported as durable acceptance.
    if (!this.flushTimer) this.flushTimer = setTimeout(() => {
      this.persist().catch(error => { this.fault = error; this.emit('fault', error); });
    }, 50);
    this.emit('event', copy(event));
    return event;
  }

  events(id, after = 0, limit = 200) {
    const session = this.get(id);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid event cursor');
    const first = session.events[0]?.seq ?? session.cursor + 1;
    const selected = session.events.filter(e => e.seq > after).slice(0, Math.min(Math.max(limit, 1), 500));
    return copy({ events: selected, cursor: selected.at(-1)?.seq ?? after, latest: session.cursor, truncated: after < first - 1 });
  }

  async create({ id, provider, cwd, parentId, ownerSessionId, projectId, title, route, executionId, executionMetadata, delegationRequestId, delegationFingerprint, parentTurnId } = {}) {
    this.healthy();
    if (!this.providers.has(provider)) throw new Error(`Unknown provider: ${provider}`);
    if (!route) throw new Error('An explicit API provider and model are required');
    if (parentId) this.get(parentId);
    if (typeof route.model !== 'string' || !route.model) throw new Error('An explicit API model selection is required');
    if (!this.routeService) throw new Error('会话绑定服务不可用');
    const binding = route.fingerprint ? copy(route) : await this.routeService.capture({ ...route, tool: provider });
    const session = {
      route: binding, routeMode: binding.mode,
      id: id ?? randomUUID(), provider, cwd: await workingDirectory(cwd), model: binding.model,
      ...(parentId ? { parentId } : {}),
      ...(ownerSessionId ? { ownerSessionId } : {}),
      ...(executionId ? { executionId, executionMetadata: copy(executionMetadata ?? {}) } : {}),
      ...(delegationRequestId ? { delegationRequestId, delegationFingerprint, parentTurnId } : {}),
      ...(projectId ? { projectId } : {}), ...(title ? { title: String(title).slice(0, 120) } : {}),
      status: 'disconnected', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      cursor: 0, events: [], receipts: {}, pendingApprovals: [], nativeEstablished: false,
    };
    if (executionId && [...this.sessions.values()].some(record => record.executionId === executionId)) throw new Error('Execution already owns a Commander session');
    if (this.sessions.has(session.id)) throw new Error('Requested BenchGo sessionId already exists');
    this.sessions.set(session.id, session);
    await this.persist();
    await this.connect(session.id);
    return this.snapshot(session.id);
  }

  executionSession(executionId) {
    if (typeof executionId !== 'string' || !executionId) throw new Error('Invalid executionId');
    const session = [...this.sessions.values()].find(row => row.executionId === executionId);
    return session ? this.snapshot(session.id) : undefined;
  }

  async prepareExecution({ executionId, sessionId, provider, cwd, route, projectId, title, metadata, advancedConfig } = {}) {
    this.healthy();
    if (typeof executionId !== 'string' || !executionId || executionId.length > 200) throw new Error('Invalid executionId');
    if (!sessionId || !/^[a-f0-9-]{36}$/iu.test(sessionId)) throw new Error('A stable BenchGo sessionId is required');
    route = { ...route, ...(advancedConfig === undefined ? {} : { advancedConfig }) };
    if (!route || typeof route.providerId !== 'string' || !route.providerId || typeof route.model !== 'string' || !route.model) throw new Error('An explicit API provider and model are required');
    const normalizedCwd = await workingDirectory(cwd);
    const previous = this.preparingExecutions.get(executionId);
    const preparation = (async () => {
      await previous?.catch(() => {});
      const existing = [...this.sessions.values()].find(row => row.executionId === executionId);
      if (existing) {
        const same = existing.id === sessionId && existing.provider === provider && existing.cwd === normalizedCwd && existing.projectId === projectId
          && existing.route?.providerId === route.providerId && existing.route?.model === route.model
          && (route.fingerprint ? existing.route?.fingerprint === route.fingerprint
            : route.advancedConfig === undefined || JSON.stringify(existing.route?.advancedConfig ?? {}) === JSON.stringify(route.advancedConfig));
        if (!same) throw new Error('Execution binding changed; start a new execution identity');
        if (['disconnected', 'closed', 'connecting'].includes(existing.status) ||
            existing.status === 'failed' && !Object.keys(existing.receipts).length) await this.connect(existing.id);
        return this.snapshot(existing.id);
      }
      return this.create({ id: sessionId, executionId, executionMetadata: metadata, provider, cwd: normalizedCwd,
        projectId, title, ownerSessionId: `commander-execution:${executionId}`, route });
    })();
    this.preparingExecutions.set(executionId, preparation);
    try { return await preparation; }
    finally { if (this.preparingExecutions.get(executionId) === preparation) this.preparingExecutions.delete(executionId); }
  }

  registerExecutionHandler(sessionId, handler) {
    if (!this.get(sessionId).executionId || typeof handler !== 'function') throw new Error('Execution handler requires a Worker-owned Commander session');
    this.executionHandlers.set(sessionId, handler);
    return () => {
      if (this.executionHandlers.get(sessionId) !== handler) return;
      this.executionHandlers.delete(sessionId);
      this.denyPending(sessionId);
    };
  }

  async stopExecution(id) {
    const session = this.get(id);
    if (this.connecting.has(id)) await this.connecting.get(id);
    if (!session.turnId && session.status === 'idle') return this.snapshot(id);
    if (['running', 'waiting'].includes(session.status)) {
      await this.interrupt(id);
      await this.wait(id, { timeout: 60_000 });
    }
    if (!session.events.some(event => event.turnId === session.turnId && event.type === 'turn.completed' &&
        ['interrupted', 'cancelled', 'completed'].includes(event.data.status))) {
      throw Object.assign(new Error('Native stop has not been confirmed'), { code: 'NATIVE_STOP_UNVERIFIED' });
    }
    return this.snapshot(id);
  }

  async connect(id) {
    this.healthy();
    if (this.removals.has(id)) throw new Error('Session is being deleted');
    if (this.archiving.has(id)) throw new Error('Session is being archived');
    if (this.connecting.has(id)) return this.connecting.get(id);
    if (this.drivers.has(id)) {
      if (this.get(id).status !== 'failed') return this.snapshot(id);
      await this.disconnect(id);
    }
    const task = this.connectInternal(id);
    this.connecting.set(id, task);
    try { return await task; } finally { this.connecting.delete(id); }
  }

  async connectInternal(id) {
    const session = this.get(id);
    if (session.archived) throw new Error('Unarchive session before connecting');
    if (!session.route) throw Object.assign(new Error('Session does not have an explicit API binding'), { code: 'SESSION_ROUTE' });
    if ((session.nativeEstablished ?? (session.cursor > 0 && !(session.events.length === session.cursor && session.events.every(event => event.type === 'session.error')))) && !session.nativeId) throw new Error('No durable native handle; refusing to create a replacement session');
    if (session.nativeId && [...this.sessions.values()].some(s => s.id !== id && s.provider === session.provider && s.nativeId === session.nativeId && (this.drivers.has(s.id) || this.connecting.has(s.id)))) throw new Error('Native session already owned by BenchGo');
    session.status = 'connecting';
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    const current = () => this.generations.get(id) === generation && !this.closing && session.status !== 'closed';
    let failed;
    const host = {
      ...(!session.executionId && this.delegationBridge ? { delegation: this.delegationBridge.forSession(id), delegate: args => { if (!current()) throw new Error('Native connection was released'); return this.delegate(id, args); } } : {}),
      event: (type, data) => { if (current()) this.event(id, type, data); },
      nativeId: value => { if (current()) { session.nativeId = value; this.event(id, 'session.native', { nativeId: value }); if (ACP_TOOL_DEFAULTS[session.provider]) return this.persist(); } },
      failure: error => {
        failed = session.route && error.code !== 'NATIVE_PERMISSION' ? new Error('隔离工具连接失败，请检查工具运行状态。') : error;
        if (current()) {
          session.status = 'failed'; this.denyPending(id); this.event(id, 'session.error', { message: failed.message });
        }
      },
      approval: async (request, signal) => {
        const turnId = session.turnId;
        const live = () => current() && !signal?.aborted && turnId && session.turnId === turnId && this.interruptedTurns.get(id) !== turnId && ['running', 'waiting'].includes(session.status);
        if (!live()) return { allow: false };
        if (request.kind === 'permission') {
          const permission = await this.permissionFor(session);
          if (!live()) return { allow: false };
          if (isFullNativePermission(permission)) return { allow: true };
        }
        if (session.executionId) {
          const handler = this.executionHandlers.get(id);
          return handler ? this.ask(id, request, signal, handler) : { allow: false };
        }
        return this.ask(id, request, signal);
      },
    };
    let driver;
    try {
      const original = this.providers.get(session.provider), config = await this.providerConfig(session.provider, session);
      const provider = Object.assign(Object.create(Object.getPrototypeOf(original)), original, { config });
      const nativeSession = copy(session), managed = config.managedProfile;
      const permission = await this.permissionFor(session);
      if (permission) nativeSession.permission = session.permission = permission;
      if (managed?.configured && !nativeSession.model && !ACP_TOOL_DEFAULTS[session.provider]) nativeSession.model = managed.provider ? managed.provider + '/' + managed.model : managed.model;
      driver = await provider.connect(nativeSession, host);
      if (failed) throw failed;
      if (driver.nativeId) session.nativeId = driver.nativeId;
      session.nativeEstablished = true;
      this.drivers.set(id, driver); session.status = 'idle';
      this.event(id, 'session.connected', { nativeId: session.nativeId ?? null });
      await this.persist();
      return this.snapshot(id);
    } catch (error) {
      await driver?.close();
      this.delegationBridge?.revoke(id);
      const safe = session.route ? Object.assign(new Error(['SESSION_ROUTE', 'NATIVE_PERMISSION'].includes(error.code) ? error.message : '隔离工具启动失败，请检查安装、协议和供应商配置。'), { code: error.code }) : error;
      session.status = 'failed'; this.event(id, 'session.error', { message: safe.message });
      throw safe;
    }
  }

  async submit(id, text, { requestId = randomUUID() } = {}) {
    if (!this.get(id).route) throw new Error('This session has no explicit API route; create a new session with a selected provider and model');
    return this.acceptInput(id, text, requestId, () => this.drivers.get(id).submit(text), 'prompt');
  }

  async commands(id) {
    this.healthy(); this.get(id);
    const driver = this.drivers.get(id);
    if (!driver?.commands) throw new Error('Native command discovery is unavailable; connect a supported provider first');
    return driver.commands();
  }

  async command(id, { name, arguments: args = '', requestId = randomUUID() } = {}) {
    this.healthy();
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) throw new Error('Invalid requestId');
    const command = normalizeCommand(name, args);
    const prompt = `/${command.name}${command.arguments ? ` ${command.arguments}` : ''}`;
    const session = this.get(id);
    // Durable retries never need a native connection or another catalog read.
    if (Object.hasOwn(session.receipts, requestId)) return this.acceptInput(id, prompt, requestId, undefined, 'command');
    if (session.status !== 'idle' || this.activeSubmissions.has(id)) throw new Error(`Session is ${session.status}; connect or wait for idle and native acknowledgement first`);
    const driver = this.drivers.get(id);
    if (!driver?.command) throw new Error('Native command execution is unavailable; connect a supported provider first');
    const catalog = await this.commands(id);
    if (!catalog.some(entry => entry.name === command.name)) throw new Error(`Unsupported native command: /${command.name}`);
    driver.validateCommand?.(command);
    if (this.drivers.get(id) !== driver) throw new Error('Native connection changed while discovering commands; retry');
    return this.acceptInput(id, prompt, requestId, () => driver.command(command), 'command');
  }

  async acceptInput(id, text, requestId, dispatch, kind) {
    this.healthy();
    if (this.removals.has(id)) throw new Error('Session is being deleted');
    if (this.archiving.has(id)) throw new Error('Session is being archived');
    if (typeof text !== 'string' || !text.trim()) throw new Error('Prompt must not be empty');
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) throw new Error('Invalid requestId');
    const session = this.get(id);
    if (Object.hasOwn(session.receipts, requestId)) {
      const previous = session.receipts[requestId];
      if (previous.text !== text || (previous.kind ?? 'prompt') !== kind) throw new Error('requestId was already used for a different prompt or command');
      const inFlight = this.submissions.get(`${id}:${requestId}`);
      if (inFlight) return inFlight;
      return copy(previous.receipt);
    }
    if (session.status !== 'idle' || !this.drivers.has(id) || this.activeSubmissions.has(id)) throw new Error(`Session is ${session.status}; connect or wait for idle and native acknowledgement first`);
    if (Object.keys(session.receipts).length >= 10_000) throw new Error('Session input receipt limit reached; create another session');
    session.turnId = randomUUID(); session.status = 'running';
    const receipt = { requestId, sessionId: id, turnId: session.turnId, status: 'accepted' };
    let resolveSubmission, rejectSubmission;
    const acceptance = new Promise((resolve, reject) => { resolveSubmission = resolve; rejectSubmission = reject; });
    acceptance.catch(() => {});
    this.submissions.set(`${id}:${requestId}`, acceptance); this.activeSubmissions.add(id);
    session.receipts[requestId] = { text, receipt, kind };
    this.event(id, 'input.accepted', { text, requestId, kind });
    // Persist BEFORE the irreversible native submission. A crash can produce
    // an uncertain receipt, but retries never blindly execute it twice.
    try {
      try { await this.persist(); }
      catch (error) { this.fault = error; session.status = 'failed'; throw error; }
      try { await this.syncPermission(id); await dispatch(); }
      catch (error) {
        receipt.status = 'uncertain'; session.status = 'failed';
        this.denyPending(id);
        this.event(id, 'input.uncertain', { requestId, message: error.message });
        await this.persist(); throw error;
      }
      await this.persist();
      resolveSubmission(copy(receipt)); return copy(receipt);
    } catch (error) { rejectSubmission(error); throw error; }
    finally { this.submissions.delete(`${id}:${requestId}`); this.activeSubmissions.delete(id); }
  }

  async steer(id, text) {
    this.healthy(); const session = this.get(id);
    const driver = this.drivers.get(id);
    if (session.status !== 'running' || !driver?.steer) throw new Error('Steering is unavailable for this session');
    await driver.steer(text); this.event(id, 'input.steer', { text });
  }
  async interrupt(id) {
    this.healthy(); const session = this.get(id);
    if (!['running', 'waiting'].includes(session.status)) throw new Error('No active turn to interrupt');
    this.interruptedTurns.set(id, session.turnId);
    this.denyPending(id);
    const driver = this.drivers.get(id);
    if (this.activeSubmissions.has(id)) await Promise.allSettled(Object.values(session.receipts)
      .filter(entry => entry.receipt.turnId === session.turnId)
      .map(entry => this.submissions.get(`${id}:${entry.receipt.requestId}`)));
    const children = [...this.sessions.values()].filter(child => child.parentId === id && child.parentTurnId === session.turnId &&
      ['running', 'waiting', 'connecting'].includes(child.status));
    const operations = children.map(child => this.stopExecution(child.id));
    if (['running', 'waiting'].includes(session.status)) operations.push(driver.interrupt());
    const outcomes = await Promise.allSettled(operations);
    this.event(id, 'turn.interrupt-requested', {});
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure) throw failure.reason;
  }

  ask(id, request, signal, handler) {
    if (this.closing || signal?.aborted) return Promise.resolve({ allow: false });
    const session = this.get(id), approvalId = randomUUID();
    const ownerSignal = handler ? new AbortController() : undefined;
    return new Promise((resolve, reject) => {
      const finish = (answer, error) => {
        if (!this.pending.delete(approvalId)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        ownerSignal?.abort();
        if (!handler) session.pendingApprovals = session.pendingApprovals.filter(p => p.id !== approvalId);
        if (session.status === 'waiting' && ![...this.pending.values()].some(p => p.sessionId === id)) session.status = 'running';
        if (!handler) this.event(id, 'approval.resolved', { id: approvalId, answer });
        if (error) reject(error);
        else resolve(answer);
      };
      const abort = () => finish({ allow: false });
      const timer = handler ? undefined : setTimeout(abort, this.approvalTimeout);
      this.pending.set(approvalId, { sessionId: id, finish, workerOwned: !!handler });
      session.status = 'waiting';
      signal?.addEventListener('abort', abort, { once: true });
      if (handler) {
        Promise.resolve().then(() => {
          ownerSignal.signal.throwIfAborted();
          return handler(request, ownerSignal.signal);
        }).then(answer => finish(answer ?? { allow: false }), error => finish({ allow: false }, error));
      } else {
        const approval = copy({ id: approvalId, sessionId: id, turnId: session.turnId ?? null, ...request });
        session.pendingApprovals.push(approval);
        this.event(id, 'approval.requested', approval);
      }
    });
  }

  // Trusted human/controller API only: deliberately NOT exposed as a model tool.
  approve(id, approvalId, answer) {
    this.healthy(); const pending = this.pending.get(approvalId);
    if (!pending || pending.workerOwned || pending.sessionId !== id) throw new Error('Approval expired, already answered, or belongs to another session');
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('Approval answer must be an object');
    if (Object.hasOwn(answer, 'allow') && typeof answer.allow !== 'boolean') throw new Error('Approval allow must be boolean');
    pending.finish(copy(answer));
  }
  denyPending(id) { for (const pending of [...this.pending.values()]) if (pending.sessionId === id) pending.finish({ allow: false }); }

  async history(id) {
    const driver = this.drivers.get(id); if (!driver?.history) throw new Error('Native history unavailable; use BenchGo events');
    return driver.history();
  }
  async discover(id) {
    const driver = this.drivers.get(id); if (!driver?.discover) throw new Error('Native session discovery unavailable for this provider');
    return driver.discover();
  }

  async wait(id, { timeout = 30_000, signal } = {}) {
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 60_000) throw new Error('wait timeout must be 0..60000 ms');
    signal?.throwIfAborted();
    if (terminal.has(this.get(id).status)) return this.snapshot(id);
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off('event', listener); signal?.removeEventListener('abort', abort); };
      const listener = event => { if (event.sessionId === id && terminal.has(this.get(id).status)) { cleanup(); resolve(this.snapshot(id)); } };
      const abort = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => { cleanup(); resolve(this.snapshot(id)); }, timeout);
      this.on('event', listener); signal?.addEventListener('abort', abort, { once: true });
    });
  }

  async disconnect(id) {
    if (this.connecting.has(id)) await this.connecting.get(id).catch(() => {});
    const session = this.get(id); session.status = 'closed';
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.delegationBridge?.revoke(id);
    this.executionHandlers.delete(id);
    this.denyPending(id);
    const driver = this.drivers.get(id); this.drivers.delete(id);
    await driver?.close();
    this.event(id, 'session.closed', {}); await this.persist();
    return this.snapshot(id);
  }
  async archive(id, archived = true) {
    this.healthy();
    if (this.removals.has(id)) throw new Error('Session is being deleted');
    if (this.archiving.has(id)) throw new Error('Session is being archived');
    if (archived && (['running', 'waiting', 'connecting'].includes(this.get(id).status) || this.activeSubmissions.has(id) || this.connecting.has(id))) throw new Error('Finish or interrupt the active native session before archiving it');
    this.archiving.add(id);
    try {
      if (archived) await this.disconnect(id);
      this.get(id).archived = archived;
      await this.persist(); return this.snapshot(id);
    } finally { this.archiving.delete(id); }
  }

  async remove(id) {
    this.healthy();
    if (this.removals.has(id)) return this.removals.get(id);
    if (this.archiving.has(id)) throw new Error('Session is being archived');
    const session = this.get(id);
    if (['running', 'waiting', 'connecting'].includes(session.status) || this.activeSubmissions.has(id) || this.connecting.has(id)) throw new Error('Finish or interrupt the active native session before deleting it');
    const task = (async () => {
      await this.disconnect(id);
      // Descendants remain independent conversations. Do not leave references
      // to a parent record that no longer exists, and never delete their work.
      const children = [...this.sessions.values()].filter(record => record.parentId === id);
      const childOwners = children.map(child => ({ child, ownerSessionId: child.ownerSessionId, hadOwner: Object.hasOwn(child, 'ownerSessionId') }));
      for (const child of children) {
        delete child.parentId;
        // A delegated child shared its parent's Harness owner. Once orphaned,
        // it must not masquerade as that owner's primary native conversation.
        // Independently adopted children keep their explicit Harness binding.
        if (!child.harnessAdopted && child.ownerSessionId === session.ownerSessionId) child.ownerSessionId = `commander-web:detached:${child.id}`;
      }
      this.sessions.delete(id);
      try { await this.persist(); }
      catch (error) {
        this.sessions.set(id, session);
        for (const { child, ownerSessionId, hadOwner } of childOwners) {
          child.parentId = id;
          if (hadOwner) child.ownerSessionId = ownerSessionId;
          else delete child.ownerSessionId;
        }
        this.fault = error;
        throw error;
      }
      this.generations.delete(id);
      this.interruptedTurns.delete(id);
      return { id, removed: true };
    })();
    this.removals.set(id, task);
    try { return await task; } finally { this.removals.delete(id); }
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    await Promise.allSettled([...this.removals.values()]);
    await Promise.allSettled([...this.connecting.values()]);
    const results = await Promise.allSettled([...this.drivers.keys()].map(id => this.disconnect(id)));
    await Promise.allSettled([...this.submissions.values()]);
    try { await this.persist(); } finally { clearTimeout(this.flushTimer); await this.store.close(); }
    const failure = results.find(r => r.status === 'rejected'); if (failure) throw failure.reason;
  }
}
