import React from 'react';
import { FileSaveButton } from '../../shared/client/file-save-button.jsx';
import { ImageGallery } from '../../shared/client/image-gallery.jsx';
import { ConversationMediaFile } from '../../shared/client/conversation-media.jsx';
import { MEDIA_PRESENTATION, mediaResultFile, NATIVE_MEDIA_RESULT } from '../shared/generation-result.mjs';

const NODE_KIND = 'benchgo-media-result';
const names = new Set(['generate_image', 'generate_video', 'generate_audio', 'media_video_status']);

function mediaFile({ message, meta }) {
  if (message?.isError) return null;
  if (meta?.[MEDIA_PRESENTATION]) return mediaResultFile(meta[MEDIA_PRESENTATION]);
  if (message?.content?.length !== 1) return null;
  const [block] = message.content;
  if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 16384) return null;
  let result;
  try { result = JSON.parse(block.text); } catch { return null; }
  return mediaResultFile(result);
}

const callIdOf = message => message?.source?.callId ?? message?.toolCallId;

function groupId(event, callId) {
  const turn = event.data?.turn;
  return Number.isSafeInteger(turn) && turn >= 0 ? `turn:${turn}` : `call:${callId}`;
}

function collect(state, event) {
  if (event.type === 'tool/call') {
    const calls = new Set(state.calls);
    calls.add(String(event.data.callId));
    return { ...state, calls };
  }
  const message = event.data.message;
  const file = event.type === NATIVE_MEDIA_RESULT ? mediaResultFile(event.data)
    : event.data.meta?.[MEDIA_PRESENTATION] || state.calls.has(String(callIdOf(message))) ? mediaFile(event.data) : null;
  if (!file || state.files.some(existing => existing.url === file.url)) return state;
  return { ...state, files: [...state.files, file], seq: state.seq ?? event.seq };
}

const definition = {
  kind: NODE_KIND, target: 'chat',
  match: {
    [NATIVE_MEDIA_RESULT]: event => event.ignorable === true && mediaResultFile(event.data)
      ? { id: `native:${event.data.groupId || event.seq}`, role: 'start' } : null,
    'tool/call': event => names.has(event.data?.name) && event.data.callId != null
      ? { id: groupId(event, event.data.callId), role: 'start' } : null,
    'tool/result': event => {
      const callId = callIdOf(event.data?.message);
      if (event.surfaceOp !== 'append' || event.data?.error || callId == null || !mediaFile(event.data)) return null;
      return { id: groupId(event, callId), role: event.data.meta?.[MEDIA_PRESENTATION] ? 'start' : 'update' };
    },
  },
  start(_context, match) {
    return collect({ calls: new Set(), files: [], seq: undefined }, match.event);
  },
  update(context, match) {
    return collect(context.state, match.event);
  },
  buildViewNode({ key, id, start, state, current }) {
    if (!start || !state?.files.length) return null;
    const previous = current.get('chat');
    const location = start.location.kind === 'step' ? { kind: 'turn', turn: start.location.turn } : start.location;
    if (previous?.data === state.files && previous.location.kind === location.kind && previous.location.turn === location.turn
      && previous.anchorSeq === state.seq) return previous;
    return { key, kind: NODE_KIND, id, target: 'chat', anchorSeq: state.seq, location,
      visibility: 'visible', groupTree: 'turn', data: state.files };
  },
};

export function registerMediaGenerationResults(ctx) {
  ctx.effect(() => ctx.uiConversation.events.register(definition));
  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: NODE_KIND }, MediaGenerationResult)));
}

function MediaGenerationResult({ node }) {
  const renderImage = file => file.mimeType.startsWith('image/') && (file.external || file.mimeType !== 'image/svg+xml');
  const images = node.data.filter(renderImage);
  return <section data-media-result aria-label="交付文件">
    {images.length > 0 && <ImageGallery images={images} />}
    {node.data.filter(file => !renderImage(file)).map(file => file.mimeType === 'image/svg+xml'
      ? <div key={file.url}>{file.name}<FileSaveButton file={file} label={`下载 ${file.name}`} /></div>
      : <ConversationMediaFile key={file.url} file={file} />)}
  </section>;
}
