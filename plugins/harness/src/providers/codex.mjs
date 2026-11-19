import { LineProcess } from '../line-process.mjs';
import { createHash } from 'node:crypto';
import { commandCatalog, compactCommand } from '../commands.mjs';
import { fullNativePermission, nativePermission } from '../permissions.mjs';

function mediaMcpArguments(delegation) {
  const server = 'mcp_servers.benchgo_media.';
  return Object.entries({
    command: delegation.command,
    args: [delegation.script, '--media-only'],
    env_vars: ['COMMANDER_DELEGATE_URL', 'COMMANDER_DELEGATE_TOKEN'],
    tool_timeout_sec: 240,
  }).flatMap(([key, value]) => ['-c', server + key + '=' + JSON.stringify(value)]);
}

export class CodexProvider {
  static capabilities = { stream: true, resume: true, steer: true, approvals: true, discover: true, permissions: true };
  constructor(config = {}) { this.config = config; }

  async connect(session, host) {
    let permission = session.permission ? nativePermission(session.permission) : !session.nativeId ? fullNativePermission : undefined;
    const threadPermission = () => permission ? { approvalPolicy: permission.approval === 'ask' ? 'on-request' : 'never', sandbox: permission.sandbox } : {};
    const turnPermission = () => permission ? { approvalPolicy: permission.approval === 'ask' ? 'on-request' : 'never', sandboxPolicy: permission.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' } : permission.sandbox === 'read-only' ? { type: 'readOnly' } : { type: 'workspaceWrite', writableRoots: [session.cwd, ...(permission.additionalWritableRoots ?? [])] } } : {};
    const media = host.delegation?.media ? host.delegation : undefined;
    const mediaArgs = media ? mediaMcpArguments(media) : [];
    const env = media ? { ...this.config.env, COMMANDER_DELEGATE_URL: media.url, COMMANDER_DELEGATE_TOKEN: media.token } : this.config.env;
    const wire = new LineProcess(this.config.command ?? 'codex', [...(this.config.commandArgs ?? []), ...mediaArgs, 'app-server', '--listen', 'stdio://'], { cwd: session.cwd, env });
    let previousUsage, previousUsageKey;
    const driver = {
      nativeId: session.nativeId,
      async setModel(model) { session.model = model || undefined; },
      async setPermission(value) { permission = nativePermission(value); },
      turnId: undefined,
      compacting: false,
      async commands() {
        const result = await wire.request('skills/list', { cwds: [session.cwd] });
        driver.skills = (result.data ?? []).flatMap(entry => entry.skills ?? []).filter(skill => skill.enabled !== false);
        return commandCatalog(driver.skills.map(skill => ({ ...skill, kind: 'skill' })), [compactCommand]);
      },
      validateCommand({ name, arguments: args }) {
        if (name === 'compact' && args) throw new Error('Codex compact does not accept arguments');
      },
      async command({ name, arguments: args }) {
        driver.validateCommand({ name, arguments: args });
        if (name === 'compact') {
          driver.compacting = true;
          try { await wire.request('thread/compact/start', { threadId: driver.nativeId }); }
          catch (error) { driver.compacting = false; throw error; }
          return;
        }
        const skill = driver.skills?.find(entry => entry.name === name);
        if (!skill?.path) throw new Error(`Unsupported native Codex command: /${name}`);
        const response = await wire.request('turn/start', { threadId: driver.nativeId, ...turnPermission(), ...(session.model ? { model: session.model } : {}), input: [{ type: 'skill', name: skill.name, path: skill.path }, { type: 'text', text: `$${name}${args ? ` ${args}` : ''}` }] });
        driver.turnId = response.turn.id;
      },
      async submit(text) {
        const response = await wire.request('turn/start', {
          threadId: driver.nativeId, ...turnPermission(), ...(session.model ? { model: session.model } : {}), input: [{ type: 'text', text }],
        });
        driver.turnId = response.turn.id;
      },
      async steer(text) {
        if (!driver.turnId) throw new Error('No native Codex turn to steer');
        await wire.request('turn/steer', { threadId: driver.nativeId, expectedTurnId: driver.turnId, input: [{ type: 'text', text }] });
      },
      async interrupt() {
        if (!driver.turnId) throw new Error('Codex has not published an active turn');
        await wire.request('turn/interrupt', { threadId: driver.nativeId, turnId: driver.turnId });
      },
      async history() { return wire.request('thread/read', { threadId: driver.nativeId, includeTurns: true }); },
      async discover() { return wire.request('thread/list', { cwd: session.cwd, limit: 50 }); },
      close: () => wire.close(),
    };
    wire.on('failure', error => host.failure(error));
    wire.on('notification', message => {
      const p = message.params ?? {};
      if (p.threadId && driver.nativeId && p.threadId !== driver.nativeId) return;
      switch (message.method) {
        case 'thread/tokenUsage/updated': {
          const total = p.tokenUsage?.total, last = p.tokenUsage?.last;
          if (!last || !driver.turnId) break;
          const key = JSON.stringify(total ?? last);
          if (key === previousUsageKey) break;
          const usage = previousUsage && total ? Object.fromEntries(Object.entries(total).map(([name, value]) => [name, Number.isSafeInteger(value) && Number.isSafeInteger(previousUsage[name]) && value >= previousUsage[name] ? value - previousUsage[name] : undefined])) : last;
          const nativeTurnId = p.turnId ?? driver.turnId;
          const signature = createHash('sha256').update(key).digest('hex').slice(0, 24);
          host.event('usage', { id: 'request:' + nativeTurnId + ':' + signature, scope: 'request', nativeTurnId, usage: { ...usage, cacheReadTokens: usage.cachedInputTokens, contextTokens: last.inputTokens, contextWindow: p.tokenUsage.modelContextWindow }, convention: 'inclusive' });
          previousUsage = total; previousUsageKey = key;
          break;
        }
        case 'thread/compacted':
          if (driver.compacting) { driver.compacting = false; host.event('turn.completed', { status: 'completed', command: 'compact' }); }
          break;
        case 'turn/started': driver.turnId = p.turn.id; host.event('turn.started', { nativeTurnId: p.turn.id, model: session.model ?? null }); break;
        case 'turn/completed':
          driver.turnId = undefined;
          driver.compacting = false;
          host.event('turn.completed', { status: p.turn.status, error: p.turn.error ?? null }); break;
        case 'item/agentMessage/delta': host.event('text.delta', { text: p.delta, itemId: p.itemId }); break;
        case 'item/started': case 'item/completed':
          host.event('item', { phase: message.method, item: p.item });
          if (driver.compacting && message.method === 'item/completed' && p.item?.type === 'contextCompaction') { driver.compacting = false; host.event('turn.completed', { status: 'completed', command: 'compact' }); }
          break;
        case 'item/commandExecution/outputDelta': host.event('tool.output', { text: p.delta, itemId: p.itemId }); break;
        case 'error': host.event('provider.error', p); break;
        default: break;
      }
    });
    wire.on('request', message => {
      void (async () => {
        const { method, params: p = {}, id } = message;
        if (p.threadId && p.threadId !== driver.nativeId) return wire.reject(id, 'Wrong thread');
        if (method === 'item/tool/call' && p.tool === 'commander_delegate' && host.delegate) {
          try { wire.respond(id, { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(await host.delegate(p.arguments)) }] }); }
          catch (error) { wire.respond(id, { success: false, contentItems: [{ type: 'inputText', text: error.message }] }); }
        } else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
          const answer = await host.approval({ kind: 'permission', method, nativeRequestId: id, details: p });
          const available = p.availableDecisions;
          let decision = answer.allow ? 'accept' : 'decline';
          if (Array.isArray(available) && !available.includes(decision)) {
            if (!answer.allow && available.includes('cancel')) decision = 'cancel';
            else throw new Error(`Unsupported Codex approval decisions: ${JSON.stringify(available)}`);
          }
          wire.respond(id, { decision });
        } else if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') {
          const answer = await host.approval({ kind: 'question', method, nativeRequestId: id, details: p });
          wire.respond(id, { answers: answer.answers ?? {} });
        } else {
          wire.reject(id, `BenchGo does not support server request ${method}`);
          host.event('unsupported.request', { method });
        }
      })().catch(error => { try { wire.reject(message.id, error.message); } catch {} host.failure(error); });
    });
    try {
      await wire.request('initialize', { clientInfo: { name: 'dowork_commander', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      wire.notify('initialized', {});
      const params = { cwd: session.cwd, ...threadPermission(), ...(session.model ? { model: session.model } : {}) };
      const result = await wire.request(session.nativeId ? 'thread/resume' : 'thread/start', {
        ...params, ...(session.nativeId ? { threadId: session.nativeId } : {}),
        ...(!session.nativeId && host.delegation ? { dynamicTools: [{ name: 'commander_delegate', description: 'Delegate in the same project using the tool provider, API supplier providerId, exact model, and text. If pending, query operation=result with the returned sessionId.', inputSchema: host.delegation.schema }] } : {}),
      });
      if (!result?.thread?.id) throw new Error('Codex returned no native thread identity');
      if (session.nativeId && result.thread.id !== session.nativeId) throw new Error('Codex resumed a different thread');
      driver.nativeId = result.thread.id;
      return driver;
    } catch (error) { await wire.close(); throw error; }
  }
}
