import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export function testCommand(candidates) {
  return candidates.find(command => spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).status === 0);
}

export const bash = testCommand(['bash', ...(process.platform === 'win32' ? [
  join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe'),
  join(process.env.LOCALAPPDATA || 'C:/Users/Default/AppData/Local', 'Programs/Git/bin/bash.exe'),
] : [])]);
export const requiresBash = { skip: !bash && 'Requires Bash; install Git Bash on Windows to run shell checks' };
