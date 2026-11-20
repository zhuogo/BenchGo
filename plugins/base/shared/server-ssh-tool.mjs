function directMessage(ctx, agent) {
  const agents = ctx.get?.('agents') ?? ctx.agents;
  if (!agent || agents?.get(agent.id) !== agent || agent.status !== 'running'
    || agents.currentInitiator() !== agent || agent.session.header.origin === 'subagent'
    || agent.session.header.parentSession) return;
  const start = agents.turnBoundaryOf(agent.session).openTurnStartSeq;
  if (!Number.isSafeInteger(start) || start < 0) return;
  const events = agent.session.snapshotEvents().slice(start + 1);
  if (events.some(event => event.type === 'turn/end')) return;
  const message = events.findLast(event => event.type === 'user/message' && event.data?.source?.kind === 'user')?.data;
  if (!message?.id || !message.content?.some(block => block.type === 'text' && block.text?.trim())) return;
  return { start, message };
}

export function serverSshTool(ctx, getLink, authorize = () => {}, shutdown) {
  return {
    name: 'assistant_server_ssh',
    description: 'List SSH servers registered on this BenchGo host by calling with no arguments. To carry out the current user’s server maintenance request, supply an exact listed deviceId and command. This works even if the target workbench is offline. If execution is uncertain, inspect remote state before considering a retry. Manage authentication in the device center.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      deviceId: { type: 'string', minLength: 1, maxLength: 128 },
      command: { type: 'string', minLength: 1, maxLength: 16384 },
    } },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute({ deviceId, command }, { agent, signal: caller }) {
      const signal = AbortSignal.any([shutdown, caller].filter(Boolean));
      signal.throwIfAborted();
      const stamp = JSON.stringify(directMessage(ctx, agent));
      if (!stamp) throw new Error('SSH 运维需要当前会话的真实用户文字指令');
      await authorize(agent);
      const current = () => {
        signal.throwIfAborted();
        if (JSON.stringify(directMessage(ctx, agent)) !== stamp) throw new Error('操作期间当前用户消息已变化，请重试');
      };
      current();
      const link = getLink();
      if (!link?.sshTarget || !link?.sshCommand) throw Object.assign(new Error('当前工作台的 SSH 运维服务不可用'), { code: 'SSH_UNAVAILABLE' });
      if (deviceId === undefined && command === undefined) {
        const { devices } = await link.devices();
        current();
        return { devices: devices.filter(device => device.sshManaged).map(({ id, name, sshStatus }) => ({ id, name, sshStatus })) };
      }
      if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 128 || deviceId === 'local'
        || typeof command !== 'string' || !command.trim() || command.length > 16384 || command.includes('\0'))
        throw new Error('请选择已登记的服务器并提供有效 SSH 命令');
      const target = await link.sshTarget({ deviceId, signal });
      if (typeof target?.revision !== 'string' || !target.revision)
        throw Object.assign(new Error('服务器 SSH 登记信息不完整，请在设备中心核对'), { code: 'SSH_TARGET_INVALID' });
      current();
      return link.sshCommand({ deviceId, command, expectedRevision: target.revision, signal });
    },
  };
}

export function registerOrdinaryServerSshTool(ctx, link) {
  ctx.inject(['tools', 'agents'], scope => {
    const shutdown = new AbortController();
    const ordinary = async agent => {
      const assistant = scope.get('assistant');
      if (!assistant) return true;
      return typeof assistant.readSessionRole === 'function' && (await assistant.readSessionRole(agent.id)) === null;
    };
    const authorize = async agent => {
      if (!await ordinary(agent)) throw new Error('此会话须通过所属角色使用 SSH 运维');
    };
    const dispose = scope.tools.register(serverSshTool(scope, () => link, authorize, shutdown.signal), {
      when: ({ agent }) => agent.session.header.origin !== 'subagent' && !agent.session.header.parentSession && ordinary(agent),
    });
    scope.effect(() => () => { shutdown.abort(); dispose(); });
  });
}
