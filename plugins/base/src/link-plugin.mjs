import { mountLink } from '../lib/link.mjs';
import { serverSshTool } from '../shared/server-ssh-tool.mjs';

export const name = 'benchgo-link';
export const inject = [
  'benchgo',
  'connection',
  'workspaceRegistry',
  'typertGateway',
  'sessionController',
  'webServer',
  'clientModules',
];

export async function apply(ctx, config = {}) {
  const link = await mountLink(ctx, {
    ...ctx.get('benchgo').config.link,
    ...config,
    webRoot: new URL('../lib/link-web/', import.meta.url),
  });
  ctx.provide('benchgoLink', link);
  ctx.inject(['tools', 'agents'], scope => {
    const shutdown = new AbortController();
    const ordinary = agent => !scope.get('assistant')?.database?.getSessionRole(agent.id);
    const authorize = agent => {
      if (!ordinary(agent)) throw new Error('此会话须通过所属角色使用 SSH 运维');
    };
    const dispose = scope.tools.register(serverSshTool(scope, () => link, authorize, shutdown.signal), {
      when: ({ agent }) => agent.session.header.origin !== 'subagent' && !agent.session.header.parentSession && ordinary(agent),
    });
    scope.effect(() => () => { shutdown.abort(); dispose(); });
  });
}
