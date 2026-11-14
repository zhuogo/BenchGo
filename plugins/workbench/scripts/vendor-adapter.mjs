import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../benchgo/package.json', import.meta.url));
const vendors = { '@linxin666/dsh-ssh': '0.4.15', 'dsh-better-sidebar': '0.30.1', '@huanlin/dsh-plugin-better-sidebar-plugin-audio': '0.1.0', 'dsh-video-preview': '0.1.4' };
const clients = { ssh: '@linxin666/dsh-ssh', sidebar: 'dsh-better-sidebar', audio: '@huanlin/dsh-plugin-better-sidebar-plugin-audio', video: 'dsh-video-preview' };

function replaceReviewed(source, needle, replacement) {
  if (source.split(needle).length !== 2) throw new Error('Workbench dependency changed; review the built-in adapter');
  return source.replace(needle, replacement);
}

function omitRegion(source, suffix) {
  const lines = source.split('\n');
  const starts = lines.flatMap((line, index) => line.includes('//#region ') && line.trimEnd().endsWith(suffix) ? [index] : []);
  if (starts.length !== 1) throw new Error(`Workbench dependency region changed: ${suffix}`);
  const start = starts[0], end = lines.findIndex((line, index) => index > start && line.trim() === '//#endregion');
  if (end < 0) throw new Error('Workbench dependency region is incomplete');
  lines.splice(start, end - start + 1);
  return lines.join('\n');
}

function omitTabSettings(source) {
  const start = source.indexOf('//#region src/client/builtins/tabs.tsx'), end = source.indexOf('//#endregion', start);
  if (start < 0 || end < 0) throw new Error('Workbench tab descriptors changed');
  let region = source.slice(start, end);
  const matches = [...region.matchAll(/^\t+settings: \{/gm)].reverse();
  for (const match of matches) {
    let index = match.index + match[0].length, depth = 1, quote = '';
    while (index < region.length && depth) {
      const char = region[index++];
      if (quote) { if (char === '\\') index++; else if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    if (depth || region[index] !== ',') throw new Error('Workbench settings descriptor seam changed');
    region = region.slice(0, match.index) + region.slice(index + 1).replace(/^\r?\n/, '');
  }
  if (matches.length !== 3) throw new Error('Workbench settings descriptor count changed');
  return source.slice(0, start) + region + source.slice(end);
}

/** Adapt the pinned published artifact, leaving installed vendor sources untouched. */
function builtinSidebar(source) {
  const settings = /\t*ctx\.slots\.inject\("settings\.section\.icon",[\s\S]*?\}, SideCardSection\)\);/g;
  if ([...source.matchAll(settings)].length !== 1) throw new Error('Workbench settings seam changed; review integration');
  let result = omitTabSettings(source.replace(settings, '/* BenchGo workbench is built in; no plugin settings or installer. */'));
  for (const region of ['SideCardSection.module.css.mjs', 'src/client/open-with-settings.tsx', 'src/client/plugins-shared.ts', 'src/client/plugins-tabs.ts', 'src/client/plugins-viewers.ts', 'src/client/add-plugin-modal.tsx', 'src/client/SideCardSection.tsx']) result = omitRegion(result, region);
  // The retired catalog's copy is no longer shipped in either locale.
  result = result.replace(/^\s*(?:plugin[A-Z]\w*|addPlugins\w*): "(?:\\.|[^"\\])*",?\r?\n/gm, '');
  return result.replaceAll('[dsh-better-sidebar]', '[BenchGo 工作台]').replaceAll('dsh-better-sidebar: ', 'BenchGo workbench: ');
}

function builtinAudioPerformance(source) {
  let result = replaceReviewed(source, 'function defaultDecodeContext() {', `const BENCHGO_ANALYSIS_RATE = 16000, BENCHGO_ANALYSIS_SAMPLES = 12000000;
    function benchgoAnalysisAllowed(duration) { return Number.isFinite(duration) && duration > 0 && duration * BENCHGO_ANALYSIS_RATE * 9 <= BENCHGO_ANALYSIS_SAMPLES; }
    function defaultDecodeContext() {`);
  result = replaceReviewed(result, 'new scope.OfflineAudioContext(1, 1, 44100)', 'new scope.OfflineAudioContext(1, 1, BENCHGO_ANALYSIS_RATE)');
  const decodeStart = result.indexOf('function defaultDecodeContext() {'), decodeEnd = result.indexOf('//#endregion', decodeStart);
  if (decodeStart < 0 || decodeEnd < 0) throw new Error('Audio decoder lifecycle changed');
  let decode = result.slice(decodeStart, decodeEnd);
  decode = replaceReviewed(decode, 'return Ctor === void 0 ? null : new Ctor();', 'return Ctor === void 0 ? null : new Ctor({ sampleRate: BENCHGO_ANALYSIS_RATE });');
  decode = replaceReviewed(decode, 'const buffer = await context.decodeAudioData(data);', `const buffer = await context.decodeAudioData(data);
        if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
        const samples = buffer.length * (buffer.numberOfChannels + (options.keepMono === false ? 0 : 1));
        if (buffer.numberOfChannels > 8 || buffer.sampleRate > BENCHGO_ANALYSIS_RATE || !Number.isSafeInteger(samples) || samples > BENCHGO_ANALYSIS_SAMPLES) throw new Error("音频超出波形内存预算，可继续流式播放");`);
  result = result.slice(0, decodeStart) + decode + result.slice(decodeEnd);
  result = replaceReviewed(result, '" · " + (decoded.sampleRate / 1e3).toFixed(1) + " kHz · "', '" · " + (lang === "zh" ? "分析 " : "Analysis ") + (decoded.sampleRate / 1e3).toFixed(1) + " kHz · "');
  result = replaceReviewed(result, 'const [ready, setReady] = (0, react.useState)(false);', `const [benchgoVisible, setBenchgoVisible] = react.useState(() => !document.hidden);
    react.useEffect(() => {
      let intersects = true;
      const update = () => setBenchgoVisible(!document.hidden && intersects);
      const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => { intersects = entries[0]?.isIntersecting !== false; update(); });
      if (containerRef.current) observer?.observe(containerRef.current);
      document.addEventListener("visibilitychange", update); update();
      return () => { observer?.disconnect(); document.removeEventListener("visibilitychange", update); };
    }, []);
    const [ready, setReady] = (0, react.useState)(false);`);
  result = replaceReviewed(result, 'if (duration <= 0 || decodeStartedRef.current) return;', `if (!benchgoVisible) { decodeAbortRef.current?.abort(); if (decoded === null) decodeStartedRef.current = false; setDecodeState(previous => previous.status === "running" ? { status: "idle", loaded: 0, total: 0 } : previous); return; }
        if (duration <= 0 || decodeStartedRef.current) return;`);
  result = replaceReviewed(result, '\t\t\t\t\t}));\n\t\t\t\t\tif (controller.signal.aborted) return;', '\t\t\t\t\t}), { signal: controller.signal });\n\t\t\t\t\tif (controller.signal.aborted) return;');
  result = replaceReviewed(result, 'const onPause = () => setPlaying(false);', 'const onPause = () => { player.pause(); setPlaying(false); };');
  result = replaceReviewed(result, 'const onEnded = () => setPlaying(false);', 'const onEnded = () => { player.pause(); setPlaying(false); };');
  const playerStart = result.indexOf('function createPlayer(url, options = {}) {'), playerEnd = result.indexOf('//#endregion', playerStart);
  if (playerStart < 0 || playerEnd < 0) throw new Error('Audio player lifecycle changed');
  let player = result.slice(playerStart, playerEnd);
  player = replaceReviewed(player, 'let disposed = false;', 'let disposed = false, suspending;');
  player = replaceReviewed(player, 'async play() {', 'async play() {\nawait suspending;');
  player = replaceReviewed(player, 'element.pause();\n\t\t\t\t\t} catch {}\n\t\t\t\t},\n\t\t\t\tdispose()', 'element.pause();\n\t\t\t\t\t} catch {}\nif (context?.state === "running") { const current = context; suspending = current.suspend().then(() => { if (context === current) state = "suspended"; }).catch(() => {}); }\n\t\t\t\t},\n\t\t\t\tdispose()');
  result = result.slice(0, playerStart) + player + result.slice(playerEnd);
  const overlayStart = result.indexOf('\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tif (typeof requestAnimationFrame !== "function") return;'), overlayEnd = result.indexOf('\n\t\t\tconst paintSpectrum', overlayStart);
  if (overlayStart < 0 || overlayEnd < 0) throw new Error('Audio overlay animation changed');
  let overlay = result.slice(overlayStart, overlayEnd);
  overlay = overlay.replace('if (typeof requestAnimationFrame !== "function") return;', 'if (!benchgoVisible || typeof requestAnimationFrame !== "function") return;');
  overlay = overlay.replace('frame = requestAnimationFrame(draw);', 'if (playing) frame = requestAnimationFrame(draw);');
  overlay = replaceReviewed(overlay, '\t\t\t\tpalette\n\t\t\t]);', '\t\t\t\tpalette, benchgoVisible, playing, cursor, playing ? null : time\n\t\t\t]);');
  result = result.slice(0, overlayStart) + overlay + result.slice(overlayEnd);
  const spectrumStart = result.indexOf('\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tif (sourceUrl === null) return;\n\t\t\t\tif (spectrumStyle === "off") return;'), spectrumEnd = result.indexOf('\n\t\t\tconst seekTo', spectrumStart);
  if (spectrumStart < 0 || spectrumEnd < 0) throw new Error('Audio spectrum animation changed');
  let spectrum = result.slice(spectrumStart, spectrumEnd);
  spectrum = replaceReviewed(spectrum, 'if (spectrumStyle === "off") return;', 'if (spectrumStyle === "off" || !playing || !benchgoVisible) return;');
  spectrum = replaceReviewed(spectrum, '\t\t\t\tspectrumStyle\n\t\t\t]);', '\t\t\t\tspectrumStyle, playing, benchgoVisible\n\t\t\t]);');
  return result.slice(0, spectrumStart) + spectrum + result.slice(spectrumEnd);
}

function builtinAudio(source) {
  let result = replaceReviewed(source, 'function apply(ctx) {', 'let benchgoHostRouteUrl;\nfunction apply(ctx) {\nbenchgoHostRouteUrl = path => ctx.betterSidebar.hostRouteUrl(path);');
  result = replaceReviewed(result, 'return `${ROUTE_PREFIX}/${kind}?${audioQuery(params)}`;', 'return benchgoHostRouteUrl(`api/benchgo/workbench/media${kind === "meta" ? "/meta" : ""}?${audioQuery(params)}`);');
  result = replaceReviewed(result, 'component: (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AudioViewer, { data: props.customData })', `component: function BenchGoAudioViewer(props) {
    const [data, setData] = react.useState(props.customData), [retrying, setRetrying] = react.useState(false), request = react.useRef(null);
    react.useEffect(() => { setData(props.customData); setRetrying(false); return () => request.current?.abort(); }, [props.customData]);
    const retry = async () => {
      if (request.current && !request.current.signal.aborted) return;
      const controller = new AbortController(); request.current = controller; setRetrying(true);
      try { const value = await loadAudioSource(props.path, props.scope, controller.signal); if (!controller.signal.aborted) setData(value); }
      finally { if (!controller.signal.aborted) { request.current = null; setRetrying(false); } }
    };
    if (isSourceError(data)) return react.createElement("div", { className: "dsh-audio", "data-dsh-audio-preview": "error" },
      react.createElement("div", { className: "dsh-audio__error", role: "alert", "aria-busy": retrying },
        react.createElement("p", null, "音频读取失败，请重试。"),
        react.createElement("button", { type: "button", disabled: retrying, onClick: retry, style: { minHeight: 36, padding: "6px 12px", borderRadius: 8 } }, retrying ? "正在重试…" : "重试")));
    return react.createElement(AudioViewer, { data });
  }`);
  // Keep edge labels inside the canvas without bunching several ticks at the
  // same clamped x position when the pane becomes narrow.
  result = replaceReviewed(result, 'const withMillis = tickStep(view.end - view.start, width) < 1;', 'const withMillis = tickStep(view.end - view.start, width) < 1;\nlet benchgoLabelEnd = -Infinity;');
  result = replaceReviewed(result, 'g.fillText(formatTime(time, withMillis), Math.min(x + 4, Math.max(0, width - 52)), height / 2 + 1);', `const label = formatTime(time, withMillis), labelWidth = g.measureText(label).width;
        const labelX = Math.min(x + 4, Math.max(0, width - labelWidth - 2));
        if (labelX >= benchgoLabelEnd + 8 && labelX + labelWidth <= width) { g.fillText(label, labelX, height / 2 + 1); benchgoLabelEnd = labelX + labelWidth; }`);
  // Streaming playback stays unlimited; only in-memory analysis is bounded.
  result = replaceReviewed(result, 'if (sourceUrl === null) return;\n\t\t\t\tdecodeAbortRef.current?.abort();', 'if (sourceUrl === null) return;\nif (!benchgoVisible || !benchgoAnalysisAllowed(duration) || sourceSize > 16777216) { setNotice("当前音频超出波形分析预算，可继续流式播放。"); return; }\n\t\t\t\tdecodeAbortRef.current?.abort();');
  result = replaceReviewed(result, '}, [sourceSize, sourceUrl]);', '}, [duration, sourceSize, sourceUrl, benchgoVisible]);');
  result = replaceReviewed(result, 'if (duration > 1800) {', 'if (duration > 30 || sourceSize > 8388608 || !benchgoAnalysisAllowed(duration)) {');
  result = replaceReviewed(result, 'tooLong: "文件过长（超过 30 分钟），只做流式播放、不生成波形与频谱图",', 'tooLong: "已使用流式播放；波形可按需生成，受内存预算限制。",');
  result = replaceReviewed(result, 'tooLong: "Very long file (over 30 minutes): streaming playback only, no waveform or spectrogram",', 'tooLong: "Streaming playback; optional waveform analysis is limited by its memory budget.",');
  const start = result.indexOf('\t\tasync function fetchBytes(url, options = {}) {');
  const end = result.indexOf('\n\t\t/** A decoding context', start);
  if (start < 0 || end < 0) throw new Error('Audio analysis seam changed; review integration');
  result = result.slice(0, start) + `async function fetchBytes(url, options = {}) {
    const response = await fetch(url, { signal: options.signal, headers: { accept: "audio/*" } });
    if (!response.ok) throw new Error("读取音频失败 (" + response.status + ")");
    const limit = 16777216, total = Number(response.headers.get("content-length") || 0);
    if (total > limit) { await response.body?.cancel(); throw new Error("音频超过波形分析大小限制，可继续流式播放"); }
    const reader = response.body?.getReader();
    if (!reader) { const bytes = await response.arrayBuffer(); if (bytes.byteLength > limit) throw new Error("音频超过波形分析大小限制"); return bytes; }
    const chunks = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) throw new Error("音频超过波形分析大小限制，可继续流式播放"); chunks.push(value); options.onProgress?.(size, total); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
  }\n` + result.slice(end);
  return builtinAudioPerformance(result).replaceAll('[dsh-audio-preview]', '[BenchGo 音频]').replaceAll('dsh-audio-preview: file viewer', 'BenchGo audio viewer');
}

export function unwrapClient(source, name) {
  const start = /^(\s*(?:\/\*![\s\S]*?\*\/\s*)?)window\.__ModuleLoader__\.load\(\{\s*id:\s*(["'])([^"']+)\2,\s*factory:\s*\(require\)\s*=>\s*\{/;
  const match = source.match(start);
  if (!match || match[3] !== name || !/\n\s*}\s*\n\}\);\s*(?:\/\/# sourceMappingURL=[^\n]*\s*)?$/.test(source)) throw new Error(`Unsupported ${name} client wrapper`);
  let result = source.replace(start, '$1module.exports = ((require) => {').replace(/\n\s*}\s*\n\}\);\s*(?:\/\/# sourceMappingURL=[^\n]*\s*)?$/, '\n})(require);\n');
  // Respect the upstream opt-out by excluding its optional reporting call from
  // this product's build, without mutating global storage or vendor sources.
  if (name === '@linxin666/dsh-ssh') {
    const call = 'reportDailyHeartbeat([{ name: "@linxin666/dsh-ssh" }]);';
    if (result.split(call).length !== 2) throw new Error('SSH telemetry call changed; review integration');
    result = result.replace(call, '/* BenchGo does not send third-party installation telemetry. */');
  }
  if (name === 'dsh-better-sidebar') result = builtinSidebar(result);
  if (name === '@huanlin/dsh-plugin-better-sidebar-plugin-audio') result = builtinAudio(result);
  if (name === 'dsh-video-preview') result = replaceReviewed(result, 'component: VideoView', 'component: () => null /* BenchGo supplies the shared media player. */');
  return result;
}
export function workbenchClientAdapters() {
  return { name: 'benchgo-workbench-vendors', setup(build) {
    build.onResolve({ filter: /^benchgo-workbench-vendor:(ssh|sidebar|audio|video)$/ }, args => ({ path: args.path, namespace: 'benchgo-workbench-vendor' }));
    build.onLoad({ filter: /.*/, namespace: 'benchgo-workbench-vendor' }, async args => {
      const name = clients[args.path.split(':').at(-1)];
      const path = require.resolve(`${name}/client`), root = dirname(require.resolve(`${name}/package.json`));
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      if (manifest.version !== vendors[name]) throw new Error(`Review ${name} ${manifest.version} before updating the workbench adapter`);
      return { contents: unwrapClient(await readFile(path, 'utf8'), name), loader: 'js', resolveDir: dirname(path) };
    });
  } };
}

export async function prepareWorkbenchVendors() {
  const root = dirname(require.resolve('@linxin666/dsh-ssh/package.json'));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.version !== vendors[pkg.name]) throw new Error('SSH package version requires integration review');
  const original = await readFile(join(root, 'lib/index.js'), 'utf8');
  const needle = 'import { Client } from "ssh2";';
  if (original.split(needle).length !== 2) throw new Error('SSH transport import changed; host key verification cannot be installed');
  const output = fileURLToPath(new URL('../lib/', import.meta.url));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'ssh-host.mjs'), original.replace(needle, 'import { Client } from "../src/ssh-trust.mjs";').replace(/\/\/# sourceMappingURL=[^\n]*/g, ''));
  await copyFile(join(root, 'LICENSE'), join(output, 'DSH-SSH-LICENSE'));
  const sidebarRoot = dirname(require.resolve('dsh-better-sidebar/package.json'));
  await copyFile(join(sidebarRoot, 'LICENSE'), join(output, 'BETTER-SIDEBAR-LICENSE'));
  for (const [name, file] of [['@huanlin/dsh-plugin-better-sidebar-plugin-audio', 'AUDIO-LICENSE'], ['dsh-video-preview', 'VIDEO-LICENSE']]) await copyFile(join(dirname(require.resolve(`${name}/package.json`)), 'LICENSE'), join(output, file));
  await writeFile(join(output, 'NOTICE'), 'BenchGo composes @linxin666/dsh-ssh 0.4.15 (Apache-2.0), https://github.com/zhu1090093659/dsh-web, dsh-better-sidebar 0.30.1 (MIT), https://github.com/omdsh-dev/DSH-better-sidebar, @huanlin/dsh-plugin-better-sidebar-plugin-audio 0.1.0 (MIT), https://github.com/huanlinoto/dsh-plugin-better-sidebar-plugin-audio, and dsh-video-preview 0.1.4 (MIT), https://github.com/zemul/dsh-video-preview.\nBuild-time adaptations remove the sidebar settings and installation catalog, use built-in defaults, bound audio analysis, and route media through the authenticated BenchGo workspace service. The video descriptor uses the shared BenchGo player for loading, error and retry states. SSH requires an explicitly confirmed host key; optional installation telemetry is omitted. Original installed packages and upstream Harness sources are not modified.\n');
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareWorkbenchVendors();
