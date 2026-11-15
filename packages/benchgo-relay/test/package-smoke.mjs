/** Install the real tarball outside the repo, then exercise its actual TLS/HTTP2/WebSocket runtime. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

if (!process.argv[2]) throw new Error('Provide the packed benchgo-relay tgz');
const temporary = await mkdtemp(join(tmpdir(), 'benchgo-relay-package-'));
try {
  const npm = process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath) ? process.env.npm_execpath
    : join(dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
  const installed = spawnSync(process.execPath, [npm, 'install', '--prefix', temporary, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', resolve(process.argv[2])],
    { cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(installed.status, 0, installed.stderr || installed.error?.message);
  const packageRoot = join(temporary, 'node_modules/benchgo-relay');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '0.1.1'); assert.equal(manifest.dependencies.ws, '8.22.2');
  const cli = args => {
    const result = spawnSync(process.execPath, [join(packageRoot, 'bin/benchgo-relay.mjs'), ...args], { cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  assert.equal(cli(['--version']), manifest.version); assert.match(cli(['--help']), /benchgo-relay run/);
  assert.match(await readFile(join(packageRoot, 'LICENSE'), 'utf8'), /MIT License/);
  // Keep certificate tooling outside the installed Relay's resolution graph, too.
  const fixtureRoot = join(temporary, 'fixture-tools');
  const fixtureInstall = spawnSync(process.execPath, [npm, 'install', '--prefix', fixtureRoot, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', 'selfsigned@3.0.1'],
    { cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(fixtureInstall.status, 0, fixtureInstall.stderr || fixtureInstall.error?.message);
  const selfsigned = createRequire(join(fixtureRoot, 'package.json'))('selfsigned');
  const signed = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, days: 1, algorithm: 'sha256', extensions: [
    { name: 'basicConstraints', cA: true }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
    { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
  ] });
  const identity = join(temporary, 'identity.json');
  await writeFile(identity, JSON.stringify({ key: signed.private, cert: signed.cert }), { mode: 0o600 });
  const probe = join(temporary, 'probe.mjs');
  await writeFile(probe, `import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {connect as connectHttp2} from 'node:http2';
import {once} from 'node:events';
import {join,relative,isAbsolute} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.argv[2], identity=JSON.parse(await readFile(process.argv[3],'utf8'));
const require=createRequire(join(root,'package.json'));
const wsPath=require.resolve('ws/package.json');
const child=relative(join(root,'..'),wsPath); assert.ok(!isAbsolute(child)&&child.split(/[\\\\/]/)[0]!=='..');
const {WebSocket}=require('ws');
const {createRelayServer}=await import(pathToFileURL(join(root,'src/relay/relay-server.mjs')).href);
const reservation=createServer(); reservation.listen(0,'127.0.0.1'); await once(reservation,'listening');
const port=reservation.address().port; await new Promise(done=>reservation.close(done));
const origin='https://127.0.0.1:'+port, token='isolated-relay-package-smoke-secret';
const relay=await createRelayServer({host:'127.0.0.1',port,publicUrl:origin,identity,token});
let session,socket;
try {
  const probe=credential=>new Promise((done,fail)=>{const request=httpsRequest(origin+'/__link/relay/probe',{ca:identity.cert,servername:'localhost',headers:{authorization:'Bearer '+credential}},response=>{let body='';response.on('data',data=>body+=data);response.once('end',()=>done({status:response.statusCode,body}));});request.once('error',fail);request.setTimeout(8000,()=>request.destroy(new Error('HTTPS probe timeout')));request.end();});
  const valid=await probe(token); assert.equal(valid.status,200); assert.deepEqual(JSON.parse(valid.body),{protocol:'benchgo-link-relay',version:1,authenticated:true});
  assert.equal((await probe('wrong-package-smoke-secret')).status,401);
  session=connectHttp2(origin,{ca:identity.cert,servername:'localhost'}); await once(session,'connect'); assert.equal(session.alpnProtocol,'h2');
  const response=await new Promise((done,fail)=>{const request=session.request({':method':'GET',':authority':new URL(origin).host,':path':'/__link/relay/probe',authorization:'Bearer '+token});let body='',status;request.once('response',headers=>status=headers[':status']);request.on('data',chunk=>body+=chunk);request.once('end',()=>done({status,body}));request.once('error',fail);request.setTimeout(8000,()=>request.destroy(new Error('HTTP2 probe timeout')));request.end();});
  assert.equal(response.status,200,'authenticated HTTP2 probe'); assert.equal(JSON.parse(response.body).authenticated,true);
  socket=new WebSocket(origin.replace('https:','wss:')+'/__link/relay/control',{ca:identity.cert,servername:'localhost',headers:{authorization:'Bearer '+token},handshakeTimeout:8000}); await once(socket,'open');
  socket.close(); await once(socket,'close'); socket=undefined;
  console.log(JSON.stringify({package:'benchgo-relay',version:'0.1.1',ws:JSON.parse(await readFile(wsPath,'utf8')).version,https:200,badToken:401,http2:'h2',websocket:'upgraded',repoFallback:false,license:'MIT',success:true}));
} finally {socket?.terminate();session?.destroy();await relay.close();}
`);
  const result = spawnSync(process.execPath, [probe, packageRoot, identity], { cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message); process.stdout.write(result.stdout);
} finally { await rm(temporary, { recursive: true, force: true }); }
