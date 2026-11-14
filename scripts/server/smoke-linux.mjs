/** Exercise the shipped installer with a fresh Unix user and a real systemd user manager. */
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { createReadStream, openSync, closeSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tar = createRequire(join(root, 'plugins/benchgo/package.json'))('tar');
export const installVerification = 'server-install-and-start';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function digest(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }

/** Only allowlisted categories reach logs; installer responses, bearer tokens and journald never do. */
export function safeSmokeDiagnostic(output) {
  const found = new Set(String(output).match(/\b(?:ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ECONNREFUSED|EACCES|ENOENT|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|E404|E403|E401)\b/g) ?? []);
  return [...found].join(', ');
}

export function validateSmokeConnection(value, version) {
  if (!value || value.version !== version || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535
    || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !/^[A-Za-z0-9+/]{43}=$/.test(value.pin)
    || typeof value.deviceId !== 'string' || !value.deviceId || typeof value.persistent !== 'boolean') throw new Error('Invalid private installer connection response');
  return value;
}

export function parseSmokePrivateJson(bytes) {
  try { return JSON.parse(bytes); } catch { throw new Error('Private installer metadata is invalid JSON'); }
}

async function run(label, command, args, { cwd, stdoutFile, timeout = 120_000 } = {}) {
  let fd;
  if (stdoutFile) fd = openSync(stdoutFile, 'wx', 0o600);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ['ignore', fd ?? 'pipe', 'pipe'] });
      let stdout = '', stderr = '', expired = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, timeout);
      child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-256 * 1024); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-256 * 1024); });
      child.once('error', () => { clearTimeout(timer); reject(new Error(`${label}: process could not start`)); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0 && !expired) return resolve(stdout);
        const diagnosis = safeSmokeDiagnostic(stderr);
        reject(new Error(`${label}: ${expired ? 'timeout' : `exit ${code ?? signal}`}${diagnosis ? ` (${diagnosis})` : ''}`));
      });
    });
  } finally { if (fd !== undefined) closeSync(fd); }
}

async function linkState({ port, token }, cert) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/link/api/rpc', method: 'POST', ca: cert,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, timeout: 10_000 }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; if (data.length > 1024 * 1024) response.destroy(); });
      response.once('error', () => reject(new Error('Link state response failed')));
      response.on('end', () => { try { resolve({ status: response.statusCode, value: JSON.parse(data) }); } catch { reject(new Error('Link state response is not JSON')); } });
    });
    req.once('error', error => reject(new Error(`Link state request failed${safeSmokeDiagnostic(error.code) ? ` (${safeSmokeDiagnostic(error.code)})` : ''}`)));
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.end(JSON.stringify({ action: 'state' }));
  });
}

async function assertAuthenticatedState(connection, cert) {
  const denied = await linkState({ port: connection.port }, cert);
  if (denied.status !== 401) throw new Error('Unauthenticated Link state was not rejected');
  const state = await linkState(connection, cert);
  if (state.status !== 200 || !Array.isArray(state.value.sessions) || !Array.isArray(state.value.projects) || !Array.isArray(state.value.models)) throw new Error('Authenticated Link state is unavailable');
}

/** Receipt checks happen before creating a privileged test account. */
export async function verifySmokeInput(directory, sourceSha) {
  const receipt = JSON.parse(await readFile(join(directory, 'build-source.json'), 'utf8'));
  if (receipt.schemaVersion !== 1 || receipt.sourceSha !== sourceSha || receipt.platform !== 'linux' || receipt.arch !== 'x64' || receipt.kind !== 'server'
    || !/^\d+\.\d+\.\d+$/.test(receipt.version) || !/^\d+\.\d+\.\d+$/.test(receipt.pluginVersion)) throw new Error('Linux smoke receipt source or identity mismatch');
  const archive = `benchgo-${receipt.version}-linux-server.tar.gz`;
  const names = [archive, `${archive}.sha256`];
  if (!Array.isArray(receipt.verified) || !Array.isArray(receipt.files) || receipt.files.length !== 2
    || JSON.stringify(receipt.files.map(file => file.name).sort()) !== JSON.stringify(names.sort())
    || JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify([...names, 'build-source.json'].sort())) throw new Error('Linux smoke input inventory mismatch');
  for (const file of receipt.files) if (!Number.isSafeInteger(file.size) || file.size < 1 || !/^[a-f0-9]{64}$/.test(file.sha256)
    || (await stat(join(directory, file.name))).size !== file.size || await digest(join(directory, file.name)) !== file.sha256) throw new Error('Linux smoke input checksum mismatch');
  const checksum = await readFile(join(directory, `${archive}.sha256`), 'utf8');
  if (checksum !== `${receipt.files.find(file => file.name === archive).sha256}  ${archive}\n`) throw new Error('Linux smoke checksum file mismatch');
  return { receipt, archive };
}

async function writeReceipt(directory, receipt) {
  const pending = join(directory, 'build-source.pending.json');
  await writeFile(pending, JSON.stringify(receipt, null, 2) + '\n');
  await rename(pending, join(directory, 'build-source.json'));
}

export async function smokeLinuxServer({ directory = join(root, 'artifacts/linux-server') } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() === 0) throw new Error('Run the Linux server smoke as a non-root Linux x64 CI user with passwordless sudo');
  directory = resolve(directory);
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  for (const expected of [process.env.SOURCE_SHA, process.env.GITHUB_SHA].filter(Boolean)) if (expected !== sourceSha) throw new Error('Linux smoke checkout differs from workflow source');
  const { receipt, archive } = await verifySmokeInput(directory, sourceSha);
  // A failed rerun must not retain an earlier success marker.
  receipt.verified = receipt.verified.filter(value => value !== installVerification);
  delete receipt.installSmoke;
  await writeReceipt(directory, receipt);
  const upstream = JSON.parse(await readFile(join(root, 'upstream.json')));
  const temporary = await mkdtemp(join(tmpdir(), 'benchgo-server-smoke-'));
  const username = `bgsmoke${process.pid}${randomBytes(3).toString('hex')}`;
  const home = join(temporary, 'home');
  const bundle = join(temporary, 'bundle');
  let created = false, uid, failure;
  const sudo = (label, args, options) => run(label, 'sudo', ['--non-interactive', ...args], options);
  const asUser = (label, args, options) => sudo(label, ['--set-home', '--user', username, 'env', `HOME=${home}`, `XDG_RUNTIME_DIR=/run/user/${uid}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, `PATH=${process.env.PATH}`, ...args], options);
  const userJson = async (path, fields) => parseSmokePrivateJson(await asUser('Read private installation metadata', [process.execPath, '--input-type=module', '-e',
    'import{readFile}from"node:fs/promises";const value=JSON.parse(await readFile(process.argv[1],"utf8"));const fields=JSON.parse(process.argv[2]);process.stdout.write(JSON.stringify(Object.fromEntries(fields.map(key=>[key,value[key]]))));', path, JSON.stringify(fields)]));
  try {
    await chmod(temporary, 0o755); await mkdir(bundle);
    await tar.x({ file: join(directory, archive), cwd: bundle, strict: true, preservePaths: false });
    const packageRoot = join(bundle, archive.slice(0, -7));
    await run('Verify extracted distribution inventory', 'sha256sum', ['--check', '--status', 'SHA256SUMS.txt'], { cwd: packageRoot });
    await sudo('Create isolated smoke user', ['useradd', '--create-home', '--home-dir', home, '--shell', '/bin/bash', username]); created = true;
    uid = (await run('Resolve isolated smoke UID', 'id', ['--user', username])).trim();
    if (!/^\d+$/.test(uid) || Number(uid) < 1000) throw new Error('Unexpected smoke user UID');
    await sudo('Enable isolated user manager', ['loginctl', 'enable-linger', username]);
    await sudo('Start isolated user manager', ['systemctl', 'start', `user@${uid}.service`]);
    await asUser('Verify real user systemd', ['systemctl', '--user', 'show-environment']);
    const responseFile = join(temporary, 'connection.json');
    await asUser('Install shipped Linux server', ['bash', 'install.sh', 'github', 'connect'], { cwd: packageRoot, stdoutFile: responseFile, timeout: 600_000 });
    if ((await stat(responseFile)).mode & 0o077) throw new Error('Private connection response permissions are too broad');
    const connection = validateSmokeConnection(parseSmokePrivateJson(await readFile(responseFile, 'utf8')), receipt.pluginVersion);
    if ((await asUser('Verify installed service is active', ['systemctl', '--user', 'is-active', 'benchgo.service'])).trim() !== 'active') throw new Error('Installed systemd service is inactive');
    const base = join(home, '.local/share/benchgo/server');
    const installation = await userJson(join(base, 'installation.json'), ['schemaVersion', 'harnessVersion', 'pluginVersion', 'runtime', 'dataDir', 'port', 'webPort']);
    if (installation.schemaVersion !== 1 || installation.harnessVersion !== upstream.version || installation.pluginVersion !== receipt.pluginVersion
      || installation.runtime !== join(base, 'runtimes', upstream.version) || installation.dataDir !== join(base, 'data') || installation.port !== connection.port
      || !Number.isSafeInteger(installation.webPort) || installation.webPort < 1 || installation.webPort > 65535) throw new Error('Installed runtime or service identity mismatch');
    const runtime = await userJson(join(installation.runtime, 'node_modules/@deepseek-ai/dsh/package.json'), ['name', 'version']);
    if (runtime.name !== '@deepseek-ai/dsh' || runtime.version !== upstream.version) throw new Error('Fresh installation did not resolve the pinned npm runtime');
    const { cert } = await userJson(join(installation.dataDir, 'link/tls.json'), ['cert']);
    if (createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64') !== connection.pin) throw new Error('Installed Link TLS identity mismatch');
    await assertAuthenticatedState(connection, cert);
    await asUser('Restart installed systemd service', ['systemctl', '--user', 'restart', 'benchgo.service']);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await assertAuthenticatedState(connection, cert); ready = true; break; } catch { await pause(500); }
    }
    if (!ready) throw new Error('Authenticated Link state did not recover after a real systemd restart');
    await asUser('Verify restarted service is active', ['systemctl', '--user', 'is-active', '--quiet', 'benchgo.service']);
  } catch (error) {
    failure = error;
    if (created && uid) {
      const properties = await asUser('Read safe systemd failure properties', ['systemctl', '--user', 'show', 'benchgo.service', '--property=ActiveState,SubState,ExecMainCode,ExecMainStatus']).catch(() => '');
      const safe = properties.split('\n').filter(line => /^(?:ActiveState|SubState)=[a-z-]+$|^ExecMain(?:Code|Status)=\d+$/.test(line)).join(' ');
      if (safe) console.error(`Linux smoke service diagnostic: ${safe}`);
    }
  } finally {
    if (created) {
      // Every privileged cleanup target is the unique account created by this invocation.
      if (uid) {
        await asUser('Stop smoke service', ['systemctl', '--user', 'stop', 'benchgo.service']).catch(() => {});
        await asUser('Disable smoke service', ['systemctl', '--user', 'disable', 'benchgo.service']).catch(() => {});
      }
      await sudo('Disable smoke user linger', ['loginctl', 'disable-linger', username]).catch(error => { failure ??= error; });
      await sudo('Terminate smoke user session', ['loginctl', 'terminate-user', username]).catch(() => {});
      if (uid) await sudo('Stop smoke user manager', ['systemctl', 'stop', `user@${uid}.service`]).catch(() => {});
      await sudo('Remove isolated smoke user and home', ['userdel', '--remove', username]).catch(error => { failure ??= error; });
    }
    await rm(temporary, { recursive: true, force: true }).catch(() => { failure ??= new Error('Smoke temporary directory cleanup failed'); });
  }
  if (failure) throw failure;
  receipt.verified.push(installVerification);
  receipt.installSmoke = { kind: 'fresh-user-systemd', registry: 'https://registry.npmjs.org', engine: upstream.version,
    checks: ['shipped-installer', 'fresh-npm-runtime', 'systemd-active', 'link-tls-pin', 'unauthenticated-rejected', 'authenticated-state', 'systemd-restart', 'isolated-user-cleanup'] };
  await writeReceipt(directory, receipt);
  return { verified: installVerification, sourceSha, platform: 'linux', arch: 'x64', version: receipt.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { directory: { type: 'string' } } });
  smokeLinuxServer({ directory: values.directory }).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
