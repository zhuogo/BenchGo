import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A live Windows PID can belong to a later process after a crashed owner. */
export async function ownerProcessExited(pid, lockModifiedAt, { platform = process.platform, kill = process.kill, execute = run } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647) throw new TypeError('Invalid owner PID');
  try { kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  if (platform !== 'win32' || !Number.isFinite(lockModifiedAt)) return false;
  try {
    const command = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execute(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop';(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o',[Globalization.CultureInfo]::InvariantCulture)`],
    { windowsHide: true, timeout: 2000, maxBuffer: 4096, encoding: 'utf8' });
    const value = stdout.trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value)) return false;
    const startedAt = Date.parse(value);
    // A full second avoids reclaiming on filesystem/timestamp rounding alone.
    return Number.isFinite(startedAt) && startedAt > lockModifiedAt + 1000;
  } catch { return false; } // Access errors and timeouts do not prove an exit.
}
