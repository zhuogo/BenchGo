import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { resolve4, resolve6 } from 'node:dns/promises';
import { join } from 'node:path';
import { validateConfig as validateCertificateConfig } from '../../scripts/ip-certificate.mjs';

const ROOT = '/opt/benchgo-relay';
const MARKER = '# Managed by BenchGo relay deployment v1';
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const WEBROOT_DETECTOR = String.raw`import glob, os, re, sys
domain=sys.argv[1]
files=[]
for pattern in ['/www/server/panel/vhost/nginx/*.conf','/etc/nginx/sites-enabled/*','/etc/nginx/conf.d/*.conf','/etc/apache2/sites-enabled/*','/etc/httpd/conf.d/*.conf']:
 files.extend(glob.glob(pattern))
text='\n'.join(open(path,errors='ignore').read() for path in files if os.path.isfile(path))
for match in re.finditer(r'\bserver\s*\{',text):
 start=match.end(); depth=1; i=start
 while i<len(text) and depth:
  if text[i]=='{': depth+=1
  elif text[i]=='}': depth-=1
  i+=1
 block=text[start:i-1]
 names=re.search(r'(?m)^\s*server_name\s+([^;]+);',block)
 if names and domain in names.group(1).split():
  for root in re.findall(r'(?m)^\s*root\s+([^;]+);',block):
   root=root.strip("\"'")
   if root.startswith('/') and os.path.isdir(root): print(root); sys.exit(0)
for match in re.finditer(r'(?is)<VirtualHost\b[^>]*>(.*?)</VirtualHost>',text):
 block=match.group(1)
 names=re.findall(r'(?im)^\s*Server(?:Name|Alias)\s+([^\s#]+)',block)
 if domain in names:
  for root in re.findall(r'(?im)^\s*DocumentRoot\s+([^\s#]+)',block):
   if root.startswith('/') and os.path.isdir(root): print(root); sys.exit(0)`;
export function validateRelayDeployment(input) {
  const publicIp = String(input.publicIp ?? '').trim();
  const domain = String(input.domain ?? '').trim().toLowerCase();
  if (domain && (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))) throw new Error('请输入有效域名');
  if (!isIP(publicIp) || /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(publicIp) || publicIp === '::1' || /^(?:f[cd]|fe80:)/i.test(publicIp)) throw new Error('请输入服务器实际公网 IP');
  const relayPort = Number(input.relayPort ?? 48730);
  if (!Number.isInteger(relayPort) || relayPort < 20000 || relayPort > 49151) throw new Error('中继端口须为 20000–49151');
  const email = String(input.email ?? '').trim();
  if (email && !/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/.test(email)) throw new Error('请输入有效联系邮箱');
  // Domain certificates normally run behind an existing web server (BaoTa/Nginx/Apache).
  // Defaulting them to standalone makes the deployment incorrectly require exclusive port 80.
  const challengeMode = input.challengeMode ?? (domain ? 'webroot' : 'standalone');
  if (!['standalone', 'webroot'].includes(challengeMode)) throw new Error('不支持的证书验证方式');
  const webrootAuto = challengeMode === 'webroot' && !String(input.webroot ?? '').trim();
  const webroot = challengeMode === 'standalone'
    ? ROOT + '/challenge'
    : (String(input.webroot ?? '').trim() || (domain ? '/www/wwwroot/' + domain : ''));
  if (typeof webroot !== 'string' || !webroot.startsWith('/') || /[\x00-\x1f]/.test(webroot) || webroot.split('/').includes('..')) throw new Error('请填写现有反向代理的绝对 webroot 路径');
  if (!domain) validateCertificateConfig({ ip: publicIp, email, webroot, stateDir: ROOT + '/state', challengePort: 80, relayPort, confirmPublicIp: true });
  return { publicIp, domain, relayPort, email, challengeMode, webroot, webrootAuto, url: 'https://' + (domain || (isIP(publicIp) === 6 ? '[' + publicIp + ']' : publicIp)) + ':' + relayPort };
}
export function verifyRelayTls(url) {
  return new Promise((resolve, reject) => {
    const req = request(new URL('/', url), { timeout: 15000 }, res => { let body = ''; res.on('data', value => { body += value; if (body.length > 4096) req.destroy(new Error('中继健康响应异常')); }); res.on('end', () => res.statusCode === 404 && body === 'Link 路径未授权' ? resolve() : reject(new Error('公网 TLS 可连接，但服务身份响应不符'))); res.on('error', reject); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('公网 TLS 检查超时，请检查中继端口和安全组'))); req.end();
  });
}
export function relayDeploymentScript(config, stage) {
  const payload = Buffer.from(JSON.stringify(config)).toString('base64');
  return `set -eu
[ "$(id -u)" = 0 ] || { echo '需要 root 或免密 sudo'; exit 1; }
command -v systemctl >/dev/null
systemctl show-environment >/dev/null
command -v python3 >/dev/null
NODE=$(command -v node)
case "$NODE" in /root/*|/home/*) echo "请先将 Node 22+ 安装到系统路径，再部署独立中继服务"; exit 1;; esac
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
ROOT=${quote(ROOT)}
MARKER=${quote(MARKER)}
if [ -e "$ROOT" ]; then [ ! -L "$ROOT" ] && [ "$(cat "$ROOT/.managed" 2>/dev/null)" = "$MARKER" ] || { echo '目标目录非本工具所有，拒绝接管'; exit 1; }; fi
for unit in benchgo-relay.service benchgo-relay-challenge.service benchgo-relay-cert-renew.service benchgo-relay-cert-renew.timer; do
 if [ -e "/etc/systemd/system/$unit" ] || [ -L "/etc/systemd/system/$unit" ]; then [ ! -L "/etc/systemd/system/$unit" ] && [ "$(head -n 1 "/etc/systemd/system/$unit")" = "$MARKER" ] || { echo '已有同名单元，拒绝覆盖'; exit 1; }; fi
done
mkdir -p "$ROOT"
printf '%s\\n' "$MARKER" > "$ROOT/.managed"
chmod 711 "$ROOT"
id benchgo-relay >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin benchgo-relay
cp ${quote(stage + '/run-relay-server.cjs')} "$ROOT/run-relay-server.cjs"
cp ${quote(stage + '/ip-certificate.mjs')} "$ROOT/ip-certificate.mjs"
chmod 644 "$ROOT/run-relay-server.cjs" "$ROOT/ip-certificate.mjs"
node --input-type=module - "$ROOT" ${quote(payload)} <<'JS'
import {writeFileSync} from 'node:fs';
const [root,data]=process.argv.slice(2);const c=JSON.parse(Buffer.from(data,'base64'));
writeFileSync(root+'/deploy.json',JSON.stringify(c),{mode:0o600});
JS
cd "$ROOT"
echo 'BENCHGO_STAGE:安装证书工具'
if ! python3 -m venv "$ROOT/certbot" 2>"$ROOT/venv-error.log"; then
 PYTHON_VERSION=$(python3 -c 'import sys; print(str(sys.version_info[0])+"."+str(sys.version_info[1]))')
 VENV_PACKAGE="python${'${'}PYTHON_VERSION}-venv"
 command -v apt-get >/dev/null || { echo "当前系统缺少 Python venv（ensurepip），且没有 apt-get，无法自动安装 $VENV_PACKAGE；请手动安装后重试" >&2; exit 1; }
 echo "BENCHGO_STAGE:安装 $VENV_PACKAGE"
 DEBIAN_FRONTEND=noninteractive apt-get update -qq
 DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$VENV_PACKAGE" || DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-venv
 python3 -m venv "$ROOT/certbot"
fi
rm -f "$ROOT/venv-error.log"
if ! env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy "$ROOT/certbot/bin/pip" install --disable-pip-version-check 'certbot>=5.4,<6' 2>"$ROOT/pip-error.log"; then
 if grep -qi 'SOCKS support' "$ROOT/pip-error.log"; then
  echo '检测到远端 SOCKS 代理缺少 Python 支持，改用直连安装证书工具'
  env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy "$ROOT/certbot/bin/pip" install --disable-pip-version-check 'certbot>=5.4,<6'
 else
  cat "$ROOT/pip-error.log" >&2
  exit 1
 fi
fi
rm -f "$ROOT/pip-error.log"
echo 'BENCHGO_STAGE:检查公网端口'
node --input-type=module - "$ROOT" "$NODE" <<'JS'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createServer} from 'node:net';
import {spawnSync} from 'node:child_process';
const [root,node]=process.argv.slice(2),c=JSON.parse(readFileSync(root+'/deploy.json'));
const marker=${JSON.stringify(MARKER)};
const unit=(name,value)=>writeFileSync('/etc/systemd/system/'+name,marker+'\\n'+value,{mode:0o644});
const test=port=>new Promise((ok,bad)=>{const s=createServer();s.once('error',()=>bad(new Error('端口 '+port+' 已占用；不会停止现有服务')));s.listen(port,'::',()=>s.close(ok));});
const prior=spawnSync('systemctl',['is-active','--quiet','benchgo-relay.service']).status===0;
if(!prior)await test(c.relayPort);
if(c.challengeMode==='standalone'){
 const challengeActive=spawnSync('systemctl',['is-active','--quiet','benchgo-relay-challenge.service']).status===0;
 if(!challengeActive)await test(80);mkdirSync(c.webroot,{recursive:true});
 const script="import http.server,os,socket;os.chdir("+JSON.stringify(c.webroot)+");S=type('S',(http.server.ThreadingHTTPServer,),{'address_family':socket.AF_INET6});S.address_family=socket.AF_INET6;S(('::',80),http.server.SimpleHTTPRequestHandler).serve_forever()";
 writeFileSync(root+'/challenge.py',script,{mode:0o600});
 unit('benchgo-relay-challenge.service','[Service]\\nExecStart=/usr/bin/python3 '+root+'/challenge.py\\nProtectSystem=strict\\nProtectHome=true\\nNoNewPrivileges=true\\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\\n[Install]\\nWantedBy=multi-user.target\\n');
}
JS
systemctl daemon-reload
${config.challengeMode === 'standalone' ? `CHALLENGE_STARTED=0
if ! systemctl is-active --quiet benchgo-relay-challenge.service; then
 systemctl enable --now benchgo-relay-challenge.service
 CHALLENGE_STARTED=1
fi
cleanup_challenge() {
 code=$?
 if [ "$code" -ne 0 ] && [ "$CHALLENGE_STARTED" = 1 ]; then
  systemctl disable --now benchgo-relay-challenge.service 2>/dev/null || true
  rm -f /etc/systemd/system/benchgo-relay-challenge.service
  systemctl daemon-reload 2>/dev/null || true
 fi
 exit "$code"
}
trap cleanup_challenge EXIT` : `WEBROOT=${quote(config.webroot)}
if [ "${config.webrootAuto ? '1' : '0'}" = 1 ]; then
 DETECTED_WEBROOT=$(python3 - ${quote(config.domain)} <<'PYWEBROOT'
${WEBROOT_DETECTOR}
PYWEBROOT
)
 if [ -n "$DETECTED_WEBROOT" ]; then WEBROOT=$DETECTED_WEBROOT; fi
 if [ ! -d "$WEBROOT" ]; then
  for candidate in "/var/www/${config.domain}" "/var/www/html" "/srv/www/${config.domain}" "/www/server/nginx/html/${config.domain}"; do
   if [ -d "$candidate" ]; then WEBROOT="$candidate"; break; fi
  done
 fi
fi
if [ ! -d "$WEBROOT" ] && command -v nginx >/dev/null; then
 WEBROOT="$ROOT/acme-webroot"
 mkdir -p "$WEBROOT/.well-known/acme-challenge"
 NGINX_RELAY_CONF=/www/server/panel/vhost/nginx/benchgo-relay-${config.domain}.conf
 if [ -e "$NGINX_RELAY_CONF" ] && ! grep -q '^# Managed by BenchGo relay deployment v1$' "$NGINX_RELAY_CONF"; then
  echo '目标域名已有未归属的 Nginx 配置，拒绝覆盖'; exit 1
 fi
 cat > "$NGINX_RELAY_CONF" <<NGINX
# Managed by BenchGo relay deployment v1
server {
    listen 80;
    listen [::]:80;
    server_name ${config.domain};
    root $WEBROOT;
    location ^~ /.well-known/acme-challenge/ { try_files \\\$uri =404; }
    location / { return 404; }
}
NGINX
 nginx -t >/dev/null && (systemctl reload nginx 2>/dev/null || service nginx reload 2>/dev/null)
fi
if ! command -v nginx >/dev/null && ! command -v apache2 >/dev/null && ! command -v httpd >/dev/null && ! command -v caddy >/dev/null; then
 WEBROOT="$ROOT/challenge"
 mkdir -p "$WEBROOT"
 cat > /etc/systemd/system/benchgo-relay-challenge.service <<CHALLENGE
# Managed by BenchGo relay deployment v1
[Service]
ExecStart=/usr/bin/python3 -m http.server 80 --bind :: --directory $WEBROOT
Restart=on-failure
CHALLENGE
 systemctl daemon-reload
 systemctl enable --now benchgo-relay-challenge.service || { echo '80 端口不可用，无法自动完成域名证书验证'; exit 1; }
fi
test -d "$WEBROOT" || { echo '未找到域名站点 webroot，请填写宝塔/Nginx/Apache/Caddy 的站点根目录'; exit 1; }
test -w "$WEBROOT" || { echo '域名站点 webroot 不可写，请检查 SSH 用户权限'; exit 1; }
mkdir -p "$WEBROOT/.well-known/acme-challenge"
test -w "$WEBROOT/.well-known/acme-challenge" || { echo '域名站点 challenge 目录不可写'; exit 1; }
if [ "$WEBROOT" != ${quote(config.webroot)} ]; then
 node --input-type=module - "$ROOT" "$WEBROOT" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const [root,webroot]=process.argv.slice(2), config=JSON.parse(readFileSync(root+'/deploy.json'));
config.webroot=webroot; writeFileSync(root+'/deploy.json',JSON.stringify(config),{mode:0o600});
JS
fi
CHALLENGE_FILE="$WEBROOT/.well-known/acme-challenge/.benchgo-${randomBytes(8).toString('hex')}"
printf '%s' 'benchgo-http01-check' > "$CHALLENGE_FILE"
cleanup_webroot() { rm -f "$CHALLENGE_FILE"; }
trap cleanup_webroot EXIT
if ! command -v curl >/dev/null; then echo '域名模式需要 curl 检查现有网站的 challenge 路径'; exit 1; fi
if ! env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy curl --fail --silent --show-error --location --insecure --max-time 10 -H ${quote('Host: ' + config.domain)} http://127.0.0.1/.well-known/acme-challenge/$(basename "$CHALLENGE_FILE") | grep -Fx 'benchgo-http01-check' >/dev/null; then
 echo '域名的 webroot 未被现有网站映射，无法通过 HTTP-01 验证；请检查宝塔站点根目录和 80 端口'; exit 1
fi`}
echo 'BENCHGO_STAGE:申请公网证书'
 env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy node "$ROOT/ip-certificate.mjs" issue --state-dir "$ROOT/state" ${config.domain ? '--domain ' + quote(config.domain) : '--ip ' + quote(config.publicIp)} ${config.email ? '--email ' + quote(config.email) : ''} --webroot "$WEBROOT" --challenge-port 80 --relay-port ${config.relayPort} --confirm-public-ip true --certbot "$ROOT/certbot/bin/certbot"
echo 'BENCHGO_STAGE:配置并启动中继'
node --input-type=module - "$ROOT" "$NODE" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const [root,node]=process.argv.slice(2),c=JSON.parse(readFileSync(root+'/deploy.json'));
const marker=${JSON.stringify(MARKER)};
const unit=(name,value)=>writeFileSync('/etc/systemd/system/'+name,marker+'\\n'+value,{mode:0o644});
const certDir=root+'/service-certs';
writeFileSync(root+'/relay.json',JSON.stringify({host:c.publicIp.includes(':')?'::':'0.0.0.0',port:c.relayPort,publicUrl:c.url,token:c.token,keyFile:certDir+'/privkey.pem',certFile:certDir+'/fullchain.pem'}),{mode:0o600});
const publish="import {copyFileSync,chmodSync,chownSync,renameSync} from 'node:fs';import {spawnSync} from 'node:child_process';const [root]=process.argv.slice(2),src=root+'/state/dsh-link-ip-certificate/active/',dst=root+'/service-certs/';for(const n of ['fullchain.pem','privkey.pem']){const t=dst+'.'+n+'.tmp';copyFileSync(src+n,t);chmodSync(t,n==='privkey.pem'?0o600:0o644);const r=spawnSync('chown',['benchgo-relay:benchgo-relay',t]);if(r.status!==0)throw new Error('证书权限设置失败');renameSync(t,dst+n)}";
import {mkdirSync} from 'node:fs';mkdirSync(certDir,{recursive:true,mode:0o755});writeFileSync(root+'/publish-cert.mjs',publish,{mode:0o600});
unit('benchgo-relay.service','[Unit]\\nAfter=network-online.target\\n[Service]\\nUser=benchgo-relay\\nExecStart='+node+' '+root+'/run-relay-server.cjs --config '+root+'/relay.json\\nRestart=on-failure\\nRestartSec=5\\nUMask=0077\\nNoNewPrivileges=true\\nCapabilityBoundingSet=\\nProtectSystem=strict\\nProtectHome=true\\nPrivateTmp=true\\n[Install]\\nWantedBy=multi-user.target\\n');
const args=['renew','--state-dir',root+'/state',...(c.domain?['--domain',c.domain]:['--ip',c.publicIp]),...(c.email?['--email',c.email]:[]),'--webroot',c.webroot,'--challenge-port','80','--relay-port',String(c.relayPort),'--confirm-public-ip','true','--certbot',root+'/certbot/bin/certbot'];
// Shell quoting then systemd escaping is unnecessary: persist a fixed script with JSON argv.
writeFileSync(root+'/renew.mjs',"import {spawnSync} from 'node:child_process';import {existsSync,writeFileSync,unlinkSync} from 'node:fs';const pending="+JSON.stringify(root+'/renew-pending')+";const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(?:HTTP|HTTPS|ALL)_PROXY$|^(?:http|https|all)_proxy$/.test(k)));const r=spawnSync(process.execPath,"+JSON.stringify([root+'/ip-certificate.mjs',...args])+",{encoding:'utf8',env});if(r.status!==0){process.stderr.write(r.stderr||'证书续期失败');process.exit(1)};process.stdout.write(r.stdout);const changed=JSON.parse(r.stdout.trim()).changed;if(changed||existsSync(pending)){writeFileSync(pending,'1',{mode:0o600});const p=spawnSync(process.execPath,["+JSON.stringify(root+'/publish-cert.mjs')+","+JSON.stringify(root)+"],{stdio:'inherit'});if(p.status!==0)process.exit(1);const s=spawnSync('systemctl',['try-restart','benchgo-relay.service'],{stdio:'inherit'});if(s.status!==0)process.exit(s.status??1);unlinkSync(pending)}",{mode:0o600});
unit('benchgo-relay-cert-renew.service','[Service]\\nType=oneshot\\nUMask=0077\\nExecStart='+node+' '+root+'/renew.mjs\\n');
unit('benchgo-relay-cert-renew.timer','[Timer]\\nOnCalendar=daily\\nRandomizedDelaySec=1h\\nPersistent=true\\n[Install]\\nWantedBy=timers.target\\n');
JS
mkdir -p "$ROOT/service-certs"
node "$ROOT/publish-cert.mjs" "$ROOT"
chown benchgo-relay:benchgo-relay "$ROOT/relay.json"
systemctl daemon-reload
systemctl enable --now benchgo-relay-cert-renew.timer
systemctl enable benchgo-relay.service
systemctl restart benchgo-relay.service
systemctl is-active --quiet benchgo-relay.service
`;
}
export async function deployRelay({ client, input, execute, upload, assets, step, onRelay, verify = verifyRelayTls }) {
  const config = validateRelayDeployment(input); let token = randomBytes(32).toString('base64url');
  if (config.domain) {
    const [a, aaaa] = await Promise.all([
      resolve4(config.domain).catch(() => []),
      resolve6(config.domain).catch(() => []),
    ]);
    const records = [...a, ...aaaa];
    // Do not issue a certificate when another address could send ACME traffic elsewhere.
    if (!records.length || records.some(record => record !== config.publicIp)) {
      throw new Error('域名 DNS 未解析到服务器公网 IP，或存在指向其他服务器的记录，请先完成解析后重试');
    }
  }
  // Preserve an existing registered relay identity on retry; read only our marked directory.
  const saved = await execute(client, 'if [ "$(id -u)" = 0 ]; then bash -s; else sudo -n bash -s; fi', { stdin: 'if [ ! -L ' + quote(ROOT) + ' ] && [ "$(cat ' + quote(ROOT + '/.managed') + ' 2>/dev/null)" = ' + quote(MARKER) + ' ] && [ -f ' + quote(ROOT + '/relay.json') + ' ]; then cat ' + quote(ROOT + '/relay.json') + '; fi' });
  if (saved.code !== 0) throw new Error('需要 root 或免密 sudo 才能部署中继');
  if (saved.stdout.trim()) { let previous; try { previous = JSON.parse(saved.stdout); } catch { throw new Error('现有中继配置损坏，请先检查服务器'); } if (previous.publicUrl !== config.url) throw new Error('现有中继地址不同，请先卸载原中继'); if (!/^[A-Za-z0-9_-]{6,256}$/.test(previous.token ?? '')) throw new Error('现有中继身份无效'); token = previous.token; }
  const nonce = randomBytes(16).toString('hex');
  const result = await execute(client, 'umask 077; mktemp -d /tmp/benchgo-relay-' + nonce + '-XXXXXX');
  const stage = result.stdout.trim();
  if (result.code !== 0 || !new RegExp('^/tmp/benchgo-relay-' + nonce + '-[A-Za-z0-9]+$').test(stage)) throw new Error('无法建立中继临时目录');
  try {
    step('上传中继与证书工具');
    for (const name of ['run-relay-server.cjs','ip-certificate.mjs']) await upload(client, join(assets, name), stage + '/' + name);
    step('检查端口、申请公网证书并安装服务');
    let stageOutput = '';
    const deployed = await execute(client, 'if [ "$(id -u)" = 0 ]; then bash -s; else sudo -n bash -s; fi', { stdin: relayDeploymentScript({...config,token}, stage), timeout: 25 * 60 * 1000, onData: data => {
      stageOutput += data;
      const lines = stageOutput.split(/\r?\n/); stageOutput = lines.pop() ?? '';
      for (const line of lines) if (line.startsWith('BENCHGO_STAGE:')) step(line.slice('BENCHGO_STAGE:'.length));
    } });
    if (deployed.code !== 0) throw new Error((deployed.stderr || deployed.stdout || '中继部署失败').split(token).join('[redacted]').slice(-3000));
    step('验证公网可信 TLS'); await verify(config.url);
    step('接入本机 Link'); try { await onRelay({ ...config, token }); } catch { throw new Error('中继服务及可信 TLS 已部署，但本机接入失败；请修正本机配置后重试部署'); }
    return { relay: { url: config.url, publicIp: config.publicIp, port: config.relayPort, tls: 'verified', host: 'pending' } };
  } finally { await execute(client, 'rm -rf -- ' + quote(stage), { timeout: 10000 }).catch(() => {}); }
}
export function relayManagementCommand(operation) {
  const prefix = 'set -eu; ROOT=' + quote(ROOT) + '; [ ! -L "$ROOT" ] && [ "$(cat "$ROOT/.managed")" = ' + quote(MARKER) + ' ]; ';
  const commands = {
    status: 'systemctl is-active benchgo-relay.service',
    logs: 'journalctl -u benchgo-relay.service -n 80 --no-pager -o cat',
    start: 'systemctl start benchgo-relay.service',
    stop: 'systemctl stop benchgo-relay.service',
    restart: 'systemctl restart benchgo-relay.service',
    renew: 'systemctl start benchgo-relay-cert-renew.service',
    'renew-status': 'systemctl is-active benchgo-relay-cert-renew.timer',
    diagnose: 'printf "service=%s\\n" "$(systemctl is-active benchgo-relay.service || true)"; printf "renew_timer=%s\\n" "$(systemctl is-active benchgo-relay-cert-renew.timer || true)"; printf "port=%s\\n" "$(node -e "const c=require(\"fs\").readFileSync(\"/opt/benchgo-relay/relay.json\",\"utf8\"); process.stdout.write(JSON.parse(c).port+\"\\n\")" 2>/dev/null || true)"; systemctl --no-pager --failed --type=service || true'
  };
  if (Object.hasOwn(commands, operation)) return prefix + commands[operation];
  if (operation !== 'uninstall') throw new Error('不支持的中继操作');
  return prefix + `for unit in benchgo-relay.service benchgo-relay-challenge.service benchgo-relay-cert-renew.service benchgo-relay-cert-renew.timer; do if [ -e "/etc/systemd/system/$unit" ] || [ -L "/etc/systemd/system/$unit" ]; then [ ! -L "/etc/systemd/system/$unit" ] && [ "$(head -n 1 "/etc/systemd/system/$unit")" = ${quote(MARKER)} ]; fi; done; for unit in benchgo-relay.service benchgo-relay-challenge.service benchgo-relay-cert-renew.timer; do systemctl disable --now "$unit" 2>/dev/null || true; done; rm -f /etc/systemd/system/benchgo-relay.service /etc/systemd/system/benchgo-relay-challenge.service /etc/systemd/system/benchgo-relay-cert-renew.service /etc/systemd/system/benchgo-relay-cert-renew.timer; systemctl daemon-reload; rm -rf -- "$ROOT"`;
}
