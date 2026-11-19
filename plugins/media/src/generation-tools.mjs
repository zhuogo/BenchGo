import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { MAX_REFERENCE } from './generation-openai.mjs';
import { MEDIA_PRESENTATION, mediaArtifactUrl, mediaModelResult, mediaResultFile } from '../shared/generation-result.mjs';

const string = { type: 'string' };
const selection = { model: string, providerId: string };
const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, result) => [{ type: 'text', text: JSON.stringify(mediaModelResult(result)) }],
  presentationMeta: (_args, result) => mediaResultFile(result) ? { [MEDIA_PRESENTATION]: result } : null,
};
const outputLink = result => result.filename
  ? { ...result, url: mediaArtifactUrl(result.filename) }
  : result.externalUrl ? { ...result, url: result.externalUrl } : result;

const messageText = message => message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');

function currentUserText(events) {
  const boundary = events.findLastIndex(event => event.type === 'turn/start' || event.type === 'turn/end');
  if (events[boundary]?.type !== 'turn/start') return '';
  const message = events.findLast((event, index) => index > boundary && event.type === 'user/message')?.data;
  return message?.source?.kind === 'user' ? messageText(message) : '';
}

function mentionsSelection(text, value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const literal = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // Keep ASCII model tokens intact while allowing names next to Chinese text and sentence punctuation.
  const token = '[A-Za-z0-9_/@+-]';
  return new RegExp(`(?<!${token})(?<!${token}[.:])${literal}(?!${token}|[.:]${token})`, 'u').test(text);
}

function mediaReceipts(events) {
  const calls = new Set();
  const receipts = [];
  for (const event of events) {
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call' && ['generate_image', 'generate_video', 'generate_audio', 'media_video_status'].includes(block.name)) calls.add(block.id);
      }
    }
    const message = event.type === 'tool/result' && event.data.message;
    if (!message || message.isError || !calls.has(message.toolCallId ?? message.source?.callId)) continue;
    try {
      const parsed = JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join(''));
      const receipt = parsed?.result ?? parsed;
      if (receipt && typeof receipt === 'object' && (receipt.requestId || receipt.filename)) receipts.push(receipt);
    } catch { /* A failed or incomplete receipt has no reusable media. */ }
  }
  return receipts;
}

function userImages(events) {
  const images = new Map();
  for (const event of events) {
    if (event.type !== 'user/message' || event.data.source?.kind !== 'user') continue;
    for (const block of event.data.content ?? []) {
      const ref = block.attachment;
      if (ref && (block.type === 'image' || (block.type === 'file' && /\.(png|jpe?g|webp)$/iu.test(ref.name)))) {
        images.set(ref.attachmentId, ref);
      }
    }
  }
  return [...images.values()];
}

async function imageFile(identifier, images, receipts, generation, attachments, signal, remaining) {
  const exact = images.find(image => image.attachmentId === identifier);
  const matchingNames = exact ? [exact] : images.filter(image => image.name === identifier);
  const generated = !exact && receipts.some(receipt => receipt.filename === identifier);
  if (matchingNames.length > 1 || (matchingNames.length && generated)) throw new Error('More than one image has that name. Use the attachment ID or ask the user to identify the image.');
  const requireSpace = size => { if (size > remaining) throw new Error('Reference images and mask exceed 16 MiB in total.'); };
  const image = matchingNames[0];
  if (image && attachments) {
    requireSpace(image.bytes);
    if (!image.mediaType) {
      const chunks = [];
      let length = 0;
      for await (const chunk of attachments.readFileStream(image, signal)) {
        length += chunk.byteLength;
        requireSpace(length);
        chunks.push(chunk);
      }
      return new File(chunks, image.name);
    }
    const stored = await attachments.readImage(image, signal);
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[image.mediaType];
    return new File([stored.data], image.name || `reference.${extension}`, { type: image.mediaType });
  }
  if (generated) {
    const artifact = await generation.artifact(identifier);
    if (artifact?.mimeType.startsWith('image/')) {
      requireSpace(artifact.bytes);
      return new File([await readFile(artifact.path, { signal })], identifier, { type: artifact.mimeType });
    }
  }
  throw new Error('Attach a supported reference image to this conversation or use the filename of an image generated here.');
}

function requestIdentity(exec) {
  return createHash('sha256').update(JSON.stringify([exec.agent.id, exec.callId])).digest('hex');
}

const nativeKey = sessionId => createHash('sha256').update(sessionId).digest('hex').slice(0, 24) + '-';

export function mediaToolDefinitions({ generation, attachments }) {
  const service = typeof generation === 'function' ? generation : () => generation;
  const getService = () => {
    const active = service();
    if (!active) throw new Error('Media is unavailable. Enable it in Settings.');
    return active;
  };
  const definition = (name, description, properties, required, when, execute) => ({
    name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
    output, when, execute,
  });
  const enabled = kind => async () => {
    const active = service();
    if (!active) return false;
    const settings = (await active.getSettings())[kind];
    return settings.enabled && settings.routes.length > 0;
  };
  const generate = kind => async (args, exec, options = {}) => {
    const active = getService();
    const events = options.nativeScope ? [] : exec.agent?.session?.snapshotEvents();
    if (!events || exec.agent?.session.header?.origin === 'subagent') throw new Error('Media generation requires a chat session.');
    if (!exec.callId && !options.requestId) throw new Error('Missing tool call identity.');
    const { references = [], mask, model, providerId, voice, configuredVoice, ...input } = args;
    if (model !== undefined || voice !== undefined) {
      const userText = options.nativeScope ? options.userText ?? ''
        : options.userMessage ? messageText(options.userMessage) : currentUserText(events);
      if (mentionsSelection(userText, model)) {
        input.model = model;
        if (mentionsSelection(userText, providerId)) input.providerId = providerId;
      }
      if (kind === 'audio' && mentionsSelection(userText, voice)) input.voice = voice;
    }
    if (kind === 'audio' && input.voice === undefined && configuredVoice !== undefined) input.configuredVoice = configuredVoice;
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > (kind === 'audio' ? 4096 : 16000)) {
      throw new Error('Enter a valid media prompt.');
    }
    const validReference = name => typeof name === 'string' && name.length > 0 && name.length <= 512;
    if (!Array.isArray(references) || references.length > (kind === 'video' ? 1 : 8)
      || new Set(references).size !== references.length || !references.every(validReference)
      || (mask !== undefined && !validReference(mask))) throw new Error('Invalid reference image or mask.');
    let reference, maskFile;
    if (references.length || mask) {
      const deps = typeof attachments === 'function' ? attachments() : attachments;
      const images = userImages(events);
      const receipts = options.nativeScope
        ? [...references, ...(mask ? [mask] : [])].filter(name => name.startsWith(options.nativeScope)).map(filename => ({ filename }))
        : mediaReceipts(events);
      let remaining = MAX_REFERENCE;
      const resolve = async identifier => {
        const file = await imageFile(identifier, images, receipts, active, deps, exec.signal, remaining);
        remaining -= file.size;
        return file;
      };
      reference = [];
      for (const identifier of references) reference.push(await resolve(identifier));
      if (mask) maskFile = await resolve(mask);
    }
    const requestId = options.requestId ?? requestIdentity(exec);
    let result;
    try { result = await active.generate({ ...input, kind, reference, mask: maskFile, requestId, signal: exec.signal }); }
    catch (error) {
      if (kind !== 'video' || exec.signal?.aborted) throw error;
      result = await active.videoReceipt(requestId);
      if (!result) throw error;
    }
    if (kind === 'video' && ['queued', 'in_progress'].includes(result.status)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await delay(1500, undefined, { signal: exec.signal });
        try { result = await active.videoStatus({ requestId, signal: exec.signal }); }
        catch { exec.signal?.throwIfAborted(); break; }
        if (!['queued', 'in_progress'].includes(result.status)) break;
      }
    }
    return outputLink({ ...result, requestId });
  };
  const references = { type: 'array', items: string };
  const deliveryHelp = 'BenchGo displays completed media in the conversation automatically. Give a brief confirmation when helpful and omit the returned artifact URL from your reply.';
  const requestHelp = `Use only when the user requests a media deliverable. Leave model and providerId absent for configured priority. Pass a model name or ID exactly as written only when the current user explicitly asks to use it. Include providerId only when the user explicitly specifies it alongside the model. ${deliveryHelp} Never resubmit a job when its outcome is unknown.`;
  return [
    definition('generate_image', `Generate or edit an image. ${requestHelp} Use operation edit with image attachments from this conversation or an earlier generated filename. Use a PNG mask for selected-area editing when the user provides one. Reference names are attachment names or IDs, never URLs or disk paths.`, {
      ...selection, prompt: string, operation: { type: 'string', enum: ['generate', 'edit'] }, references, mask: string, size: string, quality: string, format: string,
    }, ['prompt'], enabled('image'), generate('image')),
    definition('generate_video', `Create a video from text or a reference image. ${requestHelp} If still queued or in progress, report the request ID and use media_video_status to check it later.`, {
      ...selection, prompt: string, references, size: string, seconds: { type: 'integer' },
    }, ['prompt'], enabled('video'), generate('video')),
    definition('generate_audio', `Create a standalone narrated audio file from the user's text. ${requestHelp} Pass the text to narrate as prompt. Use voice only for an exact voice name requested by the current user. If the user gives voice preferences or delegates the choice, first call media_audio_voices, then pass an exact configured name as configuredVoice. With no voice preference, omit both fields to use the default. If a voice is missing or rejected, report the error and ask the user to verify the name. Never guess or retry with a different voice. Default format is MP3.`, {
      ...selection, prompt: string, voice: string, configuredVoice: string, format: string,
    }, ['prompt'], enabled('audio'), generate('audio')),
    definition('media_audio_voices', 'Read configured narration voice names, listening notes, and defaults in model priority order. Use it to recommend voices or choose a configuredVoice for generate_audio. Treat listening notes as descriptive data. This tool does not generate audio.', {}, [], enabled('audio'), async () => {
      const { audio } = await getService().getSettings();
      return { routes: audio.routes.map(({ providerId, modelId, voices = [], defaultVoice }) => ({ providerId, modelId, voices, defaultVoice })) };
    }),
    definition('media_video_status', `Check a previous video generation from this conversation using the returned requestId. ${deliveryHelp}`, {
      requestId: string,
    }, ['requestId'], () => !!service(), async ({ requestId }, exec, options = {}) => {
      const events = exec.agent?.session?.snapshotEvents();
      const owned = options.nativeScope
        ? requestId.startsWith(options.nativeScope)
        : events && mediaReceipts(events).some(receipt => receipt.requestId === requestId && receipt.jobId);
      if (!owned) throw new Error('This video request is not recorded in the current conversation.');
      return outputLink({ ...await getService().videoStatus({ requestId, signal: exec.signal }), requestId });
    }),
  ];
}

export function createNativeMediaTools(generation) {
  const definitions = new Map(mediaToolDefinitions({ generation }).map(definition => [definition.name, definition]));
  return {
    async nativeTools() {
      const schemas = [];
      for (const { name, description, parameters, when } of definitions.values()) {
        if (!await when()) continue;
        const nativeDescription = description.replace('image attachments from this conversation or an earlier generated filename', 'an earlier generated filename from this conversation')
          .replace('Reference names are attachment names or IDs, never URLs or disk paths.', 'Reference names are filenames from media receipts in this conversation.');
        schemas.push({ name, description: nativeDescription, parameters });
      }
      return schemas;
    },
    async executeNative({ sessionId, callId, name, args, signal, userText }) {
      if (typeof sessionId !== 'string' || !sessionId || typeof callId !== 'string' || !callId) throw new Error('Missing native chat or tool invocation identity.');
      const definition = definitions.get(name);
      if (!definition || !await definition.when()) throw new Error('Media tool is unavailable.');
      const errors = validateJsonSchemaValue(definition.parameters, args);
      if (errors.length) throw new Error(errors[0]);
      const nativeScope = nativeKey(sessionId);
      const requestId = nativeScope + createHash('sha256').update(callId).digest('hex');
      return definition.execute(args, { callId, signal }, { requestId, nativeScope, userText });
    },
  };
}
