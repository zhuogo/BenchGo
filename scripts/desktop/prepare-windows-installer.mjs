import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { scrubWindowsSigningEnvironment } from '../../deepseek-harness/apps/desktop/scripts/windows-sign.mjs';

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) {
    throw new Error(`Official Windows update banner changed near ${anchor.split('\n')[0]}`);
  }
  return source.replace(anchor, () => replacement);
}

async function prepareRestartBanner(installer) {
  const banner = join(installer, 'restart-banner.h');
  let source = (await readFile(banner, 'utf8')).replaceAll('\r\n', '\n');
  source = replaceOnce(source, '#include "restart-text.h"',
    '#include "restart-text.h"\n#include "benchgo-restart-progress.h"');
  source = replaceOnce(source, '    HBITMAP bitmap;', `    HBITMAP bitmap;
    RECT progressTrack{};
    ULONGLONG progressStarted{};`);
  source = replaceOnce(source, '    if (message == WM_PAINT || message == WM_PRINTCLIENT) {', `    if (message == WM_TIMER && wp == benchgo_restart_progress::timer) {
        InvalidateRect(window, &state->progressTrack, FALSE);
        return TRUE;
    }
    if (message == WM_PAINT || message == WM_PRINTCLIENT) {`);
  source = replaceOnce(source, '        FillRect(dc, &bounds, state->brush);', `        FillRect(dc, &bounds, state->brush);
        benchgo_restart_progress::Paint(dc, state->progressTrack,
            state->background != RGB(255, 255, 255), state->progressStarted);`);
  source = replaceOnce(source, '    const int textHeight = titleHeight + titleGap + paragraph.bottom;', `    const int progressGap = px(10), progressHeight = px(4);
    const int textHeight = titleHeight + titleGap + paragraph.bottom + progressGap + progressHeight;`);
  source = replaceOnce(source, '    const int height = 2 * padding + std::max<int>(iconSize, textHeight);', `    const int height = 2 * padding + std::max<int>(iconSize, textHeight);
    const int bodyLeft = padding + iconSize + gap;
    const int trackBottom = (height + textHeight) / 2;
    state->progressTrack = RECT{bodyLeft, trackBottom - progressHeight, bodyLeft + bodyWidth, trackBottom};`);
  source = replaceOnce(source, '    RedrawWindow(window, nullptr, nullptr, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW);', `    BOOL animate = FALSE;
    if (SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &animate, 0) && animate &&
        SetTimer(window, benchgo_restart_progress::timer, 16, nullptr)) {
        state->progressStarted = GetTickCount64();
    }
    RedrawWindow(window, nullptr, nullptr, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW);`);
  await writeFile(banner, replaceOnce(source, 'SetWindowTextW(title, L"DeepSeek Harness")', 'SetWindowTextW(title, L"BenchGo")'));

  const status = join(installer, 'restart-status.h');
  source = await readFile(status, 'utf8');
  await writeFile(status, replaceOnce(source, 'SetWindowTextW(window, L"DeepSeek Harness")', 'SetWindowTextW(window, L"BenchGo")'));
}

/** Use the official x86 compiler and linker settings on a temporary packaging tree. */
export async function prepareWindowsInstaller(root, output) {
  const upstream = join(root, 'deepseek-harness/apps/desktop');
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), 'installer-native-'));
  try {
    const installer = join(staging, 'installer');
    const scripts = join(staging, 'scripts');
    const build = join(staging, 'build');
    await cp(join(upstream, 'installer'), installer, { recursive: true });
    await mkdir(scripts);
    const compiler = join(scripts, 'prepare-windows-installer.ps1');
    await copyFile(join(upstream, 'scripts/prepare-windows-installer.ps1'), compiler);
    await copyFile(new URL('./windows-installer/restart-progress.h', import.meta.url), join(installer, 'benchgo-restart-progress.h'));
    await prepareRestartBanner(installer);
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', compiler,
      '-OutputDirectory', build], { env: scrubWindowsSigningEnvironment(process.env), windowsHide: true });
    await mkdir(output, { recursive: true });
    await copyFile(join(build, 'window-frame.dll'), join(output, 'window-frame.dll'));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
