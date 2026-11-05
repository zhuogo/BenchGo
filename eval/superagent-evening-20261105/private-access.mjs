import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';

export async function createPrivateDirectory(path) {
  await mkdir(path, { mode: 0o700 });
  if (process.platform === 'win32') {
    const user = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-5-21-(?:\d+-){3}\d+/)?.[0];
    assert.ok(user, 'Cannot determine current user SID');
    execFileSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `*${user}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { stdio: 'pipe' });
  }
  await assertPrivateAccess(path);
}

export async function assertPrivateAccess(path) {
  if (process.platform === 'win32') {
    const script = "$ErrorActionPreference = 'Stop'; $acl = [System.IO.Directory]::GetAccessControl($env:BENCHGO_ACL_CHECK_PATH); $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $bad = @($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -notin @($me, 'S-1-5-18') }); if ($bad.Count -gt 0) { exit 1 }";
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe', env: { ...process.env, BENCHGO_ACL_CHECK_PATH: path } }); }
    catch (error) { throw new Error(`Isolated state directory ACL is not restricted to the current user and SYSTEM: ${String(error.stderr || '').trim()}`); }
  } else {
    const info = await stat(path);
    assert.ok(info.uid === process.getuid() && (info.mode & 0o077) === 0, 'Isolated state directory must be private to the current user');
  }
}
