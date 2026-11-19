// Runs on the registered Linux account through SSH. Owner credentials stay on the server.
async function ownerRequest(input) {
  const { readFile } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = join(homedir(), '.local/share/benchgo/server');
  const state = await readFile(join(directory, 'installation.json'), 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!state || state.schemaVersion !== 1) throw new Error('服务器安装记录不兼容');
  const { url } = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'));
  const owner = new URL(url);
  if (owner.protocol !== 'http:' || owner.hostname !== '127.0.0.1' || Number(owner.port) !== state.webPort || owner.username || owner.password || owner.pathname !== '/') throw new Error('服务器启动授权地址无效');
  const login = await fetch(owner, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error('服务器管理入口尚未就绪');
  const call = async request => {
    const response = await fetch(new URL('/api/commander-link', owner.origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { cookie, origin: owner.origin, 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '服务器管理请求失败');
    return value;
  };
  const status = await call({ action: 'status' });
  if (input.expectedHostId && input.expectedHostId !== status.hostId) throw new Error('BenchGo 实例身份已变化');
  if (input.action === 'status' && !input.code) return status;
  if (input.action === 'configure') return call({ action: 'configure', publicUrl: input.publicUrl });
  return call({ action: input.action, ...(input.id ? { id: input.id } : {}), ...(input.mode ? { mode: input.mode } : {}), ...(input.code ? { pairingCode: input.code } : {}) });
}

export const ownerDiscoverCommand = 'if [ -f "$HOME/.local/share/benchgo/server/installation.json" ]; then printf present; elif [ -e "$HOME/.local/share/benchgo/server" ]; then printf unknown; else printf absent; fi';
export const ownerCommand = 'if [ -x "$HOME/.local/share/benchgo/node/bin/node" ]; then exec "$HOME/.local/share/benchgo/node/bin/node" --input-type=module -; else exec node --input-type=module -; fi';

export function ownerScript(input) {
  return `(${ownerRequest.toString()})(${JSON.stringify(input)}).then(value => console.log(JSON.stringify(value))).catch(error => { console.log(JSON.stringify({error: error.message})); process.exitCode = 1; });`;
}
