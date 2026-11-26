import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { modelProtocol } from '../../base/src/provider-access.mjs';
import { notifySettings } from '../../base/shared/settings-adapter-utils.mjs';
import {
  audioTypes, checkStreamPrefix, discard, imageFormat, imageTypes, MAX_REFERENCE, mediaFailure,
  mediaJson, mediaProviderRejectedField, readImage, readMediaProviderError, rejectsSpeechVoice, submission, validateStreamType, videoDocument,
} from './generation-openai.mjs';

const kinds = ['image', 'video', 'audio'];
const byteLimits = { audio: 32 * 1024 * 1024, video: 256 * 1024 * 1024 };
const acceptedRejects = new Set([400, 401, 402, 403, 404, 405, 415, 422, 429, 501]);
const statusOptions = { mode: 0o600, dirMode: 0o700 };
const fileTypes = { ...imageTypes, ...audioTypes, mp4: 'video/mp4' };
const validIdentifier = value => typeof value === 'string' && value.trim() === value && value.length > 0
  && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const validRequestId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
const options = (signal, timeout) => AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
const transportCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID']);
function submissionFailure(error, { signal, upstreamSignal, started, requestId, modelId }) {
  const failures = [error, error?.cause, ...(Array.isArray(error?.cause?.errors) ? error.cause.errors : [])];
  const knownCodes = [...new Set(failures.map(failure => failure?.code).filter(code => transportCodes.has(code)))];
  const timeout = upstreamSignal.aborted && upstreamSignal.reason?.name === 'TimeoutError';
  const code = signal.aborted && !timeout ? 'ABORTED' : timeout ? 'TIMEOUT' : knownCodes.join('/') || 'FETCH_FAILED';
  const elapsedMs = Math.round(performance.now() - started);
  const detail = signal.aborted && !timeout ? '本地取消了响应等待' : timeout ? '等待供应商 HTTP 响应超时'
    : '未收到供应商 HTTP 响应，网络错误 ' + code;
  return { diagnostic: { stage: 'submission-response', code, elapsedMs },
    reason: `${detail}（${elapsedMs} ms，模型 ${modelId}，请求 ID ${requestId}）。供应商是否接单尚未确认，请勿自动重新生成。` };
}
const validVoice = value => validIdentifier(value) && value.length <= 100;
export const MAX_MEDIA_BATCH = 8;
const validPrompt = (prompt, kind) => typeof prompt === 'string' && prompt.trim()
  && prompt.length <= (kind === 'audio' ? 4096 : 16000);

function audioRouteSettings({ voice, voices, defaultVoice }) {
  const entries = voices ?? (voice === undefined || voice === '' ? [] : [{ name: voice }]);
  if (!Array.isArray(entries) || entries.length > 20) throw mediaFailure('每个模型最多可配置 20 个音色');
  const seen = new Set();
  const saved = entries.map(entry => {
    if (!validVoice(entry?.name)) throw mediaFailure('音色名称须为 1–100 个字符，首尾不能含空格');
    if (seen.has(entry.name)) throw mediaFailure('同一模型的音色名称不能重复');
    seen.add(entry.name);
    const description = entry.description ?? '';
    if (typeof description !== 'string' || description.length > 160 || /[\u0000-\u001f\u007f]/u.test(description)) {
      throw mediaFailure('音色说明须在 160 个字符以内');
    }
    return { name: entry.name, ...(description.trim() && { description: description.trim() }) };
  });
  if (defaultVoice && !seen.has(defaultVoice)) throw mediaFailure('默认音色须从当前模型的音色中选择');
  return saved.length ? { voices: saved, defaultVoice: defaultVoice || saved[0].name } : {};
}

function routeSettings(value, kind) {
  if (!validIdentifier(value?.providerId) || !validIdentifier(value.modelId)) throw mediaFailure('请填写有效的供应商和模型 ID');
  const route = { providerId: value.providerId, modelId: value.modelId };
  if (value.credentialRef) {
    if (typeof value.credentialRef !== 'string' || !/^[A-Za-z_][A-Za-z_0-9]*$/u.test(value.credentialRef)) throw mediaFailure('媒体凭据引用无效');
    route.credentialRef = value.credentialRef;
  }
  for (const key of ['size', 'quality']) if (value[key] !== undefined) {
    if (!validIdentifier(value[key]) || value[key].length > 100) throw mediaFailure('媒体模型默认参数无效');
    route[key] = value[key];
  }
  return kind === 'audio' ? { ...route, ...audioRouteSettings(value) } : route;
}

export function normalizeMediaCategorySettings(value, kind) {
  if (typeof value?.enabled !== 'boolean' || !Array.isArray(value?.routes) || value.routes.length > 3) {
    throw mediaFailure('各媒体类型最多配置三个顺位');
  }
  const routes = value.routes.map(route => routeSettings(route, kind));
  if (new Set(routes.map(route => JSON.stringify([route.providerId, route.modelId]))).size !== routes.length) throw mediaFailure('同一供应商的模型只能配置一次');
  if (value.enabled && !routes.length) throw mediaFailure('请先配置至少一个模型');
  return { enabled: value.enabled, routes };
}

function initialSettings() {
  return { revision: 0, ...Object.fromEntries(kinds.map(kind => [kind, { enabled: false, routes: [] }])) };
}

async function jsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function normalizeInput(args) {
  const { kind, requestId, prompt, model, providerId, size, quality, seconds, voice, configuredVoice } = args;
  if (!kinds.includes(kind) || !validRequestId(requestId)) throw mediaFailure('媒体类型或请求 ID 无效');
  if (!validPrompt(prompt, kind)) throw mediaFailure('请输入有效的媒体生成描述');
  if (model !== undefined && !validIdentifier(model) || providerId !== undefined && (!model || !validIdentifier(providerId))) {
    throw mediaFailure('请指定有效的模型 ID 或显示名');
  }
  for (const value of [size, quality, voice, configuredVoice]) if (value !== undefined && (!validIdentifier(value) || value.length > 100)) {
    throw mediaFailure('媒体生成参数无效');
  }
  if (configuredVoice !== undefined && (kind !== 'audio' || voice !== undefined)) throw mediaFailure('音色选择参数无效');
  const references = Array.isArray(args.reference) ? args.reference : args.reference === undefined ? [] : [args.reference];
  const operation = args.operation ?? (kind === 'image' && references.length ? 'edit' : 'generate');
  const editing = kind === 'image' && operation === 'edit';
  const referencesAllowed = editing || kind === 'video';
  if (editing && !references.length || !editing && operation !== 'generate' || !referencesAllowed && references.length) {
    throw mediaFailure('媒体操作与参考图不匹配');
  }
  if ((args.mask !== undefined && (kind !== 'image' || operation !== 'edit')) || references.length > (kind === 'video' ? 1 : 16)) {
    throw mediaFailure('遮罩或参考图数量不符合要求');
  }
  if (seconds !== undefined && (kind !== 'video' || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 600)) {
    throw mediaFailure('视频时长须为正整数秒');
  }
  const format = args.format ?? (kind === 'audio' ? 'mp3' : undefined);
  if (format !== undefined && !Object.hasOwn(kind === 'image' ? imageTypes : kind === 'audio' ? audioTypes : { mp4: true }, format)) {
    throw mediaFailure('所请求的媒体输出格式不受支持');
  }
  if (kind === 'audio' && (size !== undefined || quality !== undefined) || kind !== 'audio' && args.voice !== undefined || kind === 'video' && quality !== undefined) {
    throw mediaFailure('参数与媒体类型不匹配');
  }
  const assets = [...references, ...(args.mask === undefined ? [] : [args.mask])];
  if (assets.some(file => !(file instanceof Blob) || file.size === 0) || assets.reduce((total, file) => total + file.size, 0) > MAX_REFERENCE) {
    throw mediaFailure('参考图和遮罩必须为图片文件，总大小最多 16 MiB');
  }
  const images = await Promise.all(assets.map(async blob => {
    const bytes = Buffer.from(await blob.arrayBuffer());
    const format = imageFormat(bytes);
    if (!['png', 'jpeg', 'webp'].includes(format)) throw mediaFailure('参考图须为 PNG、JPEG 或 WebP');
    return { blob: new Blob([bytes], { type: imageTypes[format] }), format, hash: createHash('sha256').update(bytes).digest('hex') };
  }));
  const mask = args.mask === undefined ? undefined : images.pop();
  if (mask && mask.format !== 'png') throw mediaFailure('局部编辑的遮罩必须是 PNG');
  return { kind, requestId, operation, prompt, model, providerId, size, quality, seconds, format, voice, configuredVoice, reference: images, mask };
}

function requestFingerprint({ reference, mask, ...inputs }) {
  return createHash('sha256').update(JSON.stringify({ ...inputs, reference: reference.map(image => image.hash), mask: mask?.hash })).digest('hex');
}

function constraintReason(input, row, route) {
  const capability = input.kind === 'audio' ? 'tts' : input.kind === 'video' ? 'video' : input.operation === 'edit' ? 'image-edit' : 'image-generation';
  if (!row.capabilities?.includes(capability)) return '模型未标记为支持此操作';
  const constraints = row.mediaConstraints?.[capability];
  if (input.mask && (constraints?.mask === false || !(constraints?.mask === true || row.capabilities.includes('image-mask')))) {
    return '模型未确认支持遮罩编辑，请在模型选项确认局部修改能力';
  }
  if (!constraints) return;
  if (input.reference.length && constraints.reference === false) return '模型不支持参考图';
  for (const [parameter, choices, label] of [
    [input.size ?? route.size, constraints.sizes, '尺寸'],
    [input.seconds, constraints.seconds, '时长'],
    [input.format, constraints.output_formats ?? constraints.response_formats, '输出格式'],
  ]) {
    if (parameter !== undefined && Array.isArray(choices) && !choices.includes(parameter)) return '模型不支持所请求的' + label;
  }
}

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch {}
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw mediaFailure('供应商接口地址无效', 409, 'MEDIA_PROVIDER_UNAVAILABLE');
  }
  return url.href.replace(/\/+$/u, '');
}

function selectRoutes(input, routes, loadProvider) {
  const candidates = input.providerId ? routes.filter(route => route.providerId === input.providerId) : routes;
  if (!input.model) return candidates;
  return selectExplicitRoutes(input.model, candidates, loadProvider);
}

async function selectExplicitRoutes(model, routes, loadProvider) {
  const ids = routes.filter(route => route.modelId === model);
  if (ids.length > 1) throw mediaFailure('配置中有多个同名模型，请同时指定供应商', 409, 'MEDIA_MODEL_AMBIGUOUS');
  if (ids.length === 1) return ids;
  const names = await Promise.all(routes.map(async route => ({ route, catalog: await loadProvider(route.providerId) })));
  const matching = names.filter(({ route, catalog }) => catalog.rows?.some(row => row.id === route.modelId && row.name === model));
  if (matching.length > 1) throw mediaFailure('配置中有多个同名模型，请同时指定供应商', 409, 'MEDIA_MODEL_AMBIGUOUS');
  if (!matching.length) throw mediaFailure('指定的模型不在已配置的三个顺位内，请核对模型 ID', 409, 'MEDIA_MODEL_NOT_CONFIGURED');
  if (names.some(({ catalog }) => !catalog.rows)) throw mediaFailure('有供应商暂时无法核对显示名，请按原始模型 ID 指定', 409, 'MEDIA_MODEL_UNVERIFIED');
  return [matching[0].route];
}

async function saveStream(response, type, limit, path, signal) {
  let size = 0;
  let prefix = Buffer.alloc(0);
  const sample = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.byteLength;
      if (size > limit) return callback(mediaFailure('媒体产物超过文件大小限制', 502, 'MEDIA_OUTPUT_TOO_LARGE'));
      if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
      callback(null, chunk);
    },
  });
  try {
    if (Number(response.headers.get('content-length')) > limit) throw mediaFailure('媒体产物超过文件大小限制', 502, 'MEDIA_OUTPUT_TOO_LARGE');
    const body = validateStreamType(response, type);
    await pipeline(Readable.fromWeb(body), sample, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
    if (!size) throw mediaFailure('媒体供应商返回了空文件', 502, 'MEDIA_OUTPUT_EMPTY');
    checkStreamPrefix(prefix, type, size);
    return size;
  } catch (error) {
    await discard(response);
    throw error;
  }
}

export async function createMediaGeneration({ directory, providers, credentials, fetcher = fetch, shutdown = new AbortController().signal }) {
  const settingsPath = join(directory, 'generation.json');
  const taskDirectory = join(directory, 'generation-tasks');
  const artifactDirectory = join(directory, 'generation-artifacts');
  const taskPath = requestId => join(taskDirectory, requestId + '.json');
  const active = new Map();
  const settingsListeners = new Set();
  const disposeController = new AbortController();
  const useSignal = signal => AbortSignal.any([shutdown, disposeController.signal, ...(signal ? [signal] : [])]);
  const storeJson = (path, value) => writeFileAtomic(path, JSON.stringify(value), statusOptions);

  await Promise.all([mkdir(taskDirectory, { recursive: true, mode: 0o700 }), mkdir(artifactDirectory, { recursive: true, mode: 0o700 })]);

  function validateSettings(saved) {
    if (!saved) return initialSettings();
    if (!Number.isSafeInteger(saved.revision) || saved.revision < 0) throw mediaFailure('媒体设置修订号无效', 500, 'MEDIA_SETTINGS_INVALID');
    return { revision: saved.revision, ...Object.fromEntries(kinds.map(kind => [kind, normalizeMediaCategorySettings(saved[kind], kind)])) };
  }

  async function getSettings() {
    return validateSettings(await jsonFile(settingsPath));
  }

  function updateSettings(patch, revision, { signal } = {}) {
    return withFileLock(settingsPath, async () => {
      const saved = await jsonFile(settingsPath);
      const current = validateSettings(saved);
      if (revision !== current.revision) throw mediaFailure('媒体设置已变更，请刷新后重新保存', 409, 'MEDIA_SETTINGS_STALE');
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(kind => kind !== 'revision' && !kinds.includes(kind))) {
        throw mediaFailure('无效的媒体设置');
      }
      const next = { ...current, revision: revision + 1 };
      const touched = new Set(saved?.touched ?? []);
      for (const kind of kinds) if (Object.hasOwn(patch, kind)) {
        next[kind] = normalizeMediaCategorySettings(patch[kind], kind);
        touched.add(kind);
      }
      signal?.throwIfAborted();
      await storeJson(settingsPath, { ...next, touched: [...touched] });
      notifySettings(settingsListeners);
      return next;
    }, { signal });
  }

  function subscribeSettings(listener) {
    settingsListeners.add(listener);
    return () => settingsListeners.delete(listener);
  }

  function importLegacyMedia(values) {
    return withFileLock(settingsPath, async () => {
      const previous = await jsonFile(settingsPath);
      const current = validateSettings(previous);
      const touched = new Set(previous?.touched ?? []);
      const next = { ...current };
      for (const kind of ['image', 'video']) {
        if (touched.has(kind) || current[kind].routes.length || !values?.[kind]?.providerId || !values[kind].modelId) continue;
        next[kind] = { enabled: kind === 'image', routes: [routeSettings(values[kind], kind)] };
        touched.add(kind);
      }
      if (next.image !== current.image || next.video !== current.video) {
        next.revision++;
        await storeJson(settingsPath, { ...next, touched: [...touched] });
        notifySettings(settingsListeners);
      }
      return next;
    });
  }

  async function resolveRoute(route, signal) {
    signal.throwIfAborted();
    const resolved = await providers.describeRoute(route.providerId, { credentials: !route.credentialRef });
    const protocol = modelProtocol(resolved.protocol);
    if (!['openai', 'responses'].includes(protocol)) throw mediaFailure('供应商未配置 OpenAI 兼容协议', 409, 'MEDIA_PROVIDER_UNAVAILABLE');
    const apiKey = route.credentialRef ? (await credentials?.resolve(route.credentialRef))?.value : resolved.apiKey;
    if (!apiKey) throw mediaFailure('供应商凭据不可用', 409, 'MEDIA_PROVIDER_UNAVAILABLE');
    return { ...resolved, baseURL: endpoint(resolved.baseURL), apiKey };
  }

  async function request(route, path, signal, method = 'GET', data) {
    signal.throwIfAborted();
    return fetcher(route.baseURL + path, {
      method, redirect: 'error', signal, ...(data?.body === undefined ? {} : { body: data.body }),
      headers: { authorization: 'Bearer ' + route.apiKey, ...data?.headers },
    });
  }

  async function settleResult(path, recorded, delivery) {
    const result = { ...recorded.result, status: 'completed', ...delivery };
    await storeJson(path, { ...recorded, state: 'settled', result });
    return result;
  }

  async function finish(path, recorded, format, mimeType, content, signal) {
    const { requestId } = recorded.result;
    const nonce = createHash('sha256').update(recorded.fingerprint).digest('hex').slice(0, 24);
    const filename = requestId + '-' + nonce + '.' + format;
    const destination = join(artifactDirectory, filename);
    const temporary = destination + '.' + randomUUID() + '.tmp';
    try {
      let bytes;
      if (content instanceof Response) bytes = await saveStream(content, mimeType, byteLimits[recorded.kind], temporary, signal);
      else {
        await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
        bytes = content.byteLength;
      }
      await rename(temporary, destination);
      return await settleResult(path, recorded, { filename, mimeType, bytes });
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function readVideo(path, recorded, route, signal) {
    const { jobId } = recorded.result;
    const response = await request(route, '/videos/' + encodeURIComponent(jobId) + '/content', signal);
    if (!response.ok) { await discard(response); throw mediaFailure('视频已生成，下载失败，请查询原任务重试', 502, 'MEDIA_DOWNLOAD_FAILED'); }
    return finish(path, recorded, 'mp4', 'video/mp4', response, signal);
  }

  async function settleVideo(path, recorded, response, route, signal, download = false) {
    const job = videoDocument(await mediaJson(response, signal));
    if (recorded.result.jobId && job.jobId !== recorded.result.jobId) throw mediaFailure('视频查询返回了不同任务', 502, 'MEDIA_VIDEO_MISMATCH');
    const terminal = ['failed', 'cancelled'].includes(job.status);
    const upstreamComplete = job.status === 'completed';
    const result = { ...recorded.result, ...job, ...(upstreamComplete ? { status: 'in_progress', progress: 100 } : {}) };
    const next = { ...recorded, result, state: terminal ? 'settled' : upstreamComplete ? 'video-download' : 'video' };
    await storeJson(path, next);
    return upstreamComplete && download ? readVideo(path, next, route, signal) : result;
  }

  async function generateOnce(path, input, fingerprint, signal) {
    const previous = await jsonFile(path);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw mediaFailure('媒体请求 ID 已用于另一组参数', 409, 'MEDIA_REQUEST_CONFLICT');
      if (previous.result?.jobId || previous.state === 'settled') return previous.result;
      if (previous.state === 'rejected') throw mediaFailure(previous.reason, 409, previous.code ?? 'MEDIA_PROVIDER_REJECTED');
      throw mediaFailure(previous.reason ?? '媒体请求已提交，结果尚未确认，请勿自动重新生成', 409, 'MEDIA_SUBMISSION_UNCERTAIN');
    }
    const setting = (await getSettings())[input.kind];
    if (!setting.enabled) throw mediaFailure('请在媒体设置开启此生成能力', 409, 'MEDIA_DISABLED');
    const catalogs = new Map();
    const loadProvider = id => {
      if (!catalogs.has(id)) catalogs.set(id, providers.models(id, signal).then(rows => ({ rows }), () => ({})));
      return catalogs.get(id);
    };
    let routes = await selectRoutes(input, setting.routes, loadProvider);
    if (input.configuredVoice !== undefined) {
      routes = routes.filter(route => route.voices?.some(voice => voice.name === input.configuredVoice));
      if (!routes.length) throw mediaFailure('音色「' + input.configuredVoice + '」未配置给当前模型。请查看已配置的音色。', 400, 'MEDIA_VOICE_NOT_CONFIGURED');
    }
    const unavailable = [];
    let reserved = false;
    for (const configured of routes) {
      signal.throwIfAborted();
      const catalog = await loadProvider(configured.providerId);
      const model = catalog.rows?.find(row => row.id === configured.modelId);
      if (!model) {
        unavailable.push(catalog.rows ? '供应商账号未提供此模型' : '无法读取供应商模型列表');
        continue;
      }
      const reason = constraintReason(input, model, configured);
      if (reason) { unavailable.push(reason); continue; }
      let route;
      try { route = await resolveRoute(configured, signal); }
      catch (error) { signal.throwIfAborted(); unavailable.push(error.code === 'MEDIA_PROVIDER_UNAVAILABLE' ? error.message : '供应商路由或凭据不可用'); continue; }
      let requestInput = input;
      if (input.kind === 'audio') {
        const voices = model.mediaConstraints?.tts?.voices;
        const voice = input.voice ?? input.configuredVoice ?? configured.defaultVoice ?? (Array.isArray(voices) ? voices[0] : undefined);
        if (!voice) {
          unavailable.push('此模型未提供默认音色，请在设置 → 媒体 → 媒体生成 → 音频填写音色名称');
          continue;
        }
        if (Array.isArray(voices) && voices.length && !voices.includes(voice)) {
          const reason = '音色「' + voice + '」不在此模型的供应商音色列表中。请核对供应商音色名称后再生成。';
          const code = 'MEDIA_VOICE_INVALID';
          if (reserved) await storeJson(path, { kind: input.kind, state: 'rejected', fingerprint, reason, code });
          throw mediaFailure(reason, 400, code);
        }
        requestInput = { ...input, voice };
      }
      const data = submission(requestInput, configured);
      const result = {
        requestId: input.requestId, providerId: configured.providerId, modelId: configured.modelId,
        ...(input.kind === 'image' && model.name && { modelName: model.name }),
      };
      const recorded = { kind: input.kind, state: 'submitted', fingerprint, result, route: configured, baseURL: route.baseURL };
      if (!reserved) {
        await withFileLock(path, async () => {
          if (await jsonFile(path)) throw mediaFailure('相同媒体请求正在处理，请查询原任务', 409, 'MEDIA_REQUEST_ACTIVE');
          await storeJson(path, recorded);
        }, { signal });
        reserved = true;
      } else await storeJson(path, recorded);
      const upstreamSignal = options(signal, 120000);
      const started = performance.now();
      let response;
      try { response = await request(route, data.path, upstreamSignal, 'POST', data); }
      catch (error) {
        const failure = submissionFailure(error, { signal, upstreamSignal, started, requestId: result.requestId, modelId: result.modelId });
        await storeJson(path, { ...recorded, ...failure });
        throw mediaFailure(failure.reason, 502, 'MEDIA_SUBMISSION_UNCERTAIN');
      }
      if (!response.ok) {
        const refused = acceptedRejects.has(response.status);
        const parameterRejection = [400, 415, 422].includes(response.status);
        const providerError = input.kind === 'audio' || parameterRejection ? await readMediaProviderError(response, upstreamSignal) : null;
        if (input.kind !== 'audio' && !parameterRejection) await discard(response);
        const voiceRejected = input.kind === 'audio' && rejectsSpeechVoice(providerError);
        if (voiceRejected) {
          const reason = '供应商报告音色「' + requestInput.voice + '」无效或不受支持（HTTP ' + response.status + '）。请核对供应商音色名称。';
          if (!refused) {
            const unknown = reason + '原请求结果尚未确认，请勿自动重新生成。';
            await storeJson(path, { ...recorded, reason: unknown });
            throw mediaFailure(unknown, 502, 'MEDIA_SUBMISSION_UNCERTAIN');
          }
          const code = 'MEDIA_VOICE_INVALID';
          await storeJson(path, { kind: input.kind, state: 'rejected', fingerprint, reason, code });
          throw mediaFailure(reason, 400, code);
        }
        if (!refused) {
          const reason = `媒体供应商返回 HTTP ${response.status}（模型 ${result.modelId}，请求 ID ${result.requestId}）。供应商是否接单尚未确认，请勿自动重新生成。`;
          await storeJson(path, { ...recorded, reason, diagnostic: { stage: 'submission-response', status: response.status } });
          throw mediaFailure(reason, 502, 'MEDIA_SUBMISSION_UNCERTAIN');
        }
        const field = parameterRejection ? mediaProviderRejectedField(input.kind, providerError) : undefined;
        unavailable.push(field
          ? `供应商拒绝参数 ${field}（HTTP ${response.status}），请核对此模型支持的取值`
          : `供应商拒绝请求（HTTP ${response.status}）`);
        continue;
      }
      if (input.kind === 'video') return settleVideo(path, recorded, response, route, upstreamSignal);
      if (input.kind === 'audio') return finish(path, recorded, input.format, audioTypes[input.format], response, upstreamSignal);
      const image = await readImage(response, route, fetcher, upstreamSignal, input.format);
      if (image.externalUrl) return settleResult(path, recorded, image);
      return finish(path, recorded, image.format, image.mimeType, image.bytes, upstreamSignal);
    }
    const reason = '没有可用的媒体模型' + (unavailable.length ? '。' + [...new Set(unavailable)].join('；') : '，请检查媒体设置');
    if (reserved) await storeJson(path, { kind: input.kind, state: 'rejected', fingerprint, reason });
    throw mediaFailure(reason, 409, 'MEDIA_PROVIDER_REJECTED');
  }

  async function generate(args = {}) {
    const signal = useSignal(args.signal);
    const input = await normalizeInput(args);
    return generateInput(input, signal);
  }

  function generateInput(input, signal) {
    signal.throwIfAborted();
    const fingerprint = requestFingerprint(input);
    const path = taskPath(input.requestId);
    const existing = active.get(path);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw mediaFailure('媒体请求 ID 已用于另一组参数', 409, 'MEDIA_REQUEST_CONFLICT');
      return existing.pending;
    }
    const pending = generateOnce(path, input, fingerprint, signal).finally(() => active.delete(path));
    active.set(path, { fingerprint, pending });
    return pending;
  }

  async function generateBatch({ prompts, ...args }) {
    if (!Array.isArray(prompts) || prompts.length < 2 || prompts.length > MAX_MEDIA_BATCH) throw mediaFailure('每批须提供 2–8 条生成描述');
    const descriptions = Array.from(prompts);
    if (!descriptions.every(prompt => validPrompt(prompt, args.kind))) throw mediaFailure('请输入有效的媒体生成描述');
    const input = await normalizeInput({ ...args, prompt: descriptions[0] });
    const { requestId, kind } = input;
    if (requestId.length > 126) throw mediaFailure('批量媒体请求 ID 过长');
    const signal = useSignal(args.signal);
    const path = taskPath(requestId);
    const fingerprint = createHash('sha256').update(JSON.stringify([requestFingerprint(input), descriptions])).digest('hex');
    await withFileLock(path, async () => {
      const existing = await jsonFile(path);
      if (!existing) await storeJson(path, { kind, state: 'batch', fingerprint });
      else if (existing.state !== 'batch' || existing.fingerprint !== fingerprint)
        throw mediaFailure('媒体请求 ID 已用于另一组参数', 409, 'MEDIA_REQUEST_CONFLICT');
    }, { signal });
    const results = await Promise.all(descriptions.map(async (prompt, index) => {
      const itemId = requestId + '-' + (index + 1);
      try {
        return await generateInput({ ...input, requestId: itemId, prompt }, signal);
      } catch (error) {
        return { requestId: itemId, status: 'error', error: { code: error.code ?? 'MEDIA_GENERATION_FAILED', message: error.message } };
      }
    }));
    signal.throwIfAborted();
    return { requestId, results };
  }

  async function imageReceipt(requestId) {
    if (!validRequestId(requestId)) throw mediaFailure('图片请求 ID 无效');
    const recorded = await jsonFile(taskPath(requestId));
    return recorded?.kind === 'image' && recorded.state === 'settled' ? recorded.result : null;
  }

  async function videoReceipt(requestId) {
    if (!validRequestId(requestId)) throw mediaFailure('视频请求 ID 无效');
    const recorded = await jsonFile(taskPath(requestId));
    return recorded?.kind === 'video' && recorded.result?.jobId ? recorded.result : null;
  }

  async function videoStatus({ requestId, signal } = {}) {
    if (!validRequestId(requestId)) throw mediaFailure('视频请求 ID 无效');
    const requestSignal = useSignal(signal);
    const path = taskPath(requestId);
    return withFileLock(path, async () => {
      requestSignal.throwIfAborted();
      const recorded = await jsonFile(path);
      if (recorded?.kind !== 'video' || !recorded.result?.jobId) throw mediaFailure('找不到已确认提交的视频请求', 404, 'MEDIA_VIDEO_NOT_FOUND');
      if (recorded.state === 'settled') return recorded.result;
      const route = await resolveRoute(recorded.route, requestSignal);
      if (route.baseURL !== recorded.baseURL) throw mediaFailure('供应商地址已变，恢复原路由后可查询此任务', 409, 'MEDIA_ROUTE_CHANGED');
      const upstreamSignal = options(requestSignal, 120000);
      if (recorded.state === 'video-download') return readVideo(path, recorded, route, upstreamSignal);
      const response = await request(route, '/videos/' + encodeURIComponent(recorded.result.jobId), upstreamSignal);
      if (!response.ok) { await discard(response); throw mediaFailure('视频状态查询失败，请用原任务 ID 重试', 502, 'MEDIA_VIDEO_STATUS_FAILED'); }
      return settleVideo(path, recorded, response, route, upstreamSignal, true);
    }, { signal: requestSignal, waitMs: 120000 });
  }

  async function artifact(filename) {
    if (typeof filename !== 'string' || !/^[a-zA-Z0-9_-]{1,128}-[0-9a-f]{24}\.[a-z0-9]+$/u.test(filename)) return null;
    const mimeType = fileTypes[extname(filename).slice(1)];
    if (!mimeType) return null;
    const path = join(artifactDirectory, filename);
    try {
      const stat = await lstat(path);
      if (!stat.isFile()) return null;
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
      return { filename, mimeType, bytes: stat.size, path, stream: range => Readable.toWeb(createReadStream(path, { ...range, flags })) };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  return { getSettings, updateSettings, subscribeSettings, importLegacyMedia, generate, generateBatch, imageReceipt, videoReceipt, videoStatus, artifact, dispose: () => disposeController.abort() };
}
