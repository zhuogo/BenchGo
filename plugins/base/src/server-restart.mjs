import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Stop admitting work, then drain requests already accepted by either carrier. */
export function createRestartAdmission() {
  let locked = false;
  const pending = new Set();
  const check = () => {
    if (locked) throw Object.assign(new Error('服务器正在重启，请等待连接恢复'), { status: 503 });
  };
  return {
    check,
    async run(work) {
      check();
      let finish;
      const completed = new Promise(resolve => { finish = resolve; });
      pending.add(completed);
      try { return await work(); }
      finally { pending.delete(completed); finish(); }
    },
    async lock(signal) {
      locked = true;
      await new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
        Promise.all([...pending]).then(resolve).finally(() => signal.removeEventListener('abort', aborted));
      });
    },
    unlock() { locked = false; },
  };
}

/** Match existing deployments as well as newly installed units. */
export async function managedServerRestart(profile, platform = process.platform, {
  read = readFile, home = homedir(), execute = exec, env = process.env, uid = () => process.getuid(),
} = {}) {
  if (platform !== 'linux' || !profile) return;
  const base = join(home, '.local/share/benchgo/server');
  let receiptPath;
  try {
    const [cgroup, raw] = await Promise.all([
      read('/proc/self/cgroup', 'utf8'),
      read(join(base, 'installation.json'), 'utf8'),
    ]);
    const installation = JSON.parse(raw);
    if (installation.schemaVersion !== 1 || resolve(profile) !== resolve(installation.profile)
      || typeof installation.dataDir !== 'string'
      || !cgroup.split('\n').some(line => /\/user@\d+\.service\/(?:[^/\n]+\/)*benchgo\.service$/.test(line))) return;
    receiptPath = join(installation.dataDir, 'update-restart.json');
  } catch { return; }
  const request = async () => {
    const runtime = env.XDG_RUNTIME_DIR || '/run/user/' + uid();
    await execute('systemctl', ['--user', '--no-block', 'restart', 'benchgo.service'], {
      timeout: 10_000,
      env: { ...env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS || 'unix:path=' + runtime + '/bus' },
    });
  };
  return { request, receiptPath };
}
