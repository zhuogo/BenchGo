import { MEDIA_PRESENTATION, mediaArtifactUrl, mediaResultFile, NATIVE_MEDIA_RESULT } from '../../media/shared/generation-result.mjs';

const mediaTools = new Set(['assistant_generate_image', 'generate_image', 'generate_video', 'generate_audio', 'media_video_status']);

function historyFile(name, value) {
  const file = mediaResultFile(value);
  if (file) return file;
  // Earlier image receipts only carried a name. Recover their original route.
  if ((name === 'assistant_generate_image' || name === 'generate_image')
    && /^[a-zA-Z0-9_-]+\.(png|jpe?g|webp|gif|svg)$/u.test(value?.filename)) {
    const url = name === 'generate_image' ? mediaArtifactUrl(value.filename)
      : `api/commander/assistant/artifact?file=${encodeURIComponent(value.filename)}`;
    return { name: value.filename, url };
  }
  return null;
}

function addFile(index, file, event, id, group) {
  if (!file) return;
  const { groupId, turn } = group;
  const identity = JSON.stringify([groupId, file.url]);
  if (index.fileKeys.has(identity)) return;
  index.fileKeys.add(identity);
  const value = { ...file, id, groupId, seq: event.seq, ...(Number.isSafeInteger(turn) && { turn }) };
  if (/^(audio|video)\//u.test(file.mimeType ?? '')) index.media.push({ seq: event.seq, file: value });
  else index.images.push({ seq: event.seq, image: value });
}

// Session events are append-only. Keep small pagination metadata beside the
// engine's existing bounded transcript cache instead of rescanning tool traces.
export function updateHistoryIndex(events, index = { watermark: 0, mediaCalls: new Map(), fileKeys: new Set(), images: [], media: [] }) {
  for (let i = index.watermark; i < events.length; i++) {
    const event = events[i];
    if (event.type === 'request/header') index.header = event.data.header.config;
    else if (event.type === 'turn/start') index.mediaGroup = { groupId: `turn:${event.seq}`, turn: event.data?.turn };
    else if (event.type === 'turn/end') { index.lastEnd = event.data.reason; index.mediaGroup = null; }
    else if (event.type === 'assistant/message') {
      // Capture the call's turn, not the result's arrival time. Results can land
      // after a boundary; old/incomplete transcripts fall back to one message.
      const group = index.mediaGroup ?? { groupId: `message:${event.data.message.id ?? event.seq}` };
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call' && mediaTools.has(block.name)) {
          index.mediaCalls.set(block.id, { ...group, name: block.name });
        }
      }
    } else if (event.type === 'tool/result') {
      const message = event.data.message;
      const callId = message?.toolCallId ?? message?.source?.callId;
      const group = message && !message.isError && index.mediaCalls.get(callId);
      if (!group) continue;
      index.mediaCalls.delete(callId);
      try {
        const value = event.data.meta?.[MEDIA_PRESENTATION]
          ?? JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join(''));
        addFile(index, historyFile(group.name, value), event, message.id, group);
      } catch { /* Invalid or incomplete tool results have no file. */ }
    } else if (event.type === NATIVE_MEDIA_RESULT && event.ignorable === true) {
      addFile(index, mediaResultFile(event.data), event, `native:${event.seq}`,
        index.mediaGroup ?? { groupId: event.data?.groupId ?? `event:${event.seq}` });
    }
  }
  index.watermark = events.length;
  return index;
}

// First file result at or after the cursor; result rows follow event seq.
function lowerBound(rows, cursor) {
  if (cursor === undefined) return rows.length;
  let low = 0, high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].seq < cursor) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function historyPage(messages, index, { before, limit }) {
  // Question answers can replace an earlier row with a newer seq. Preserve the
  // projection's display order instead of assuming all visible rows are sorted.
  const eligible = before === undefined ? messages : messages.filter(row => row.seq < before);
  const start = Math.max(0, eligible.length - limit), page = eligible.slice(start);
  const images = index.images.slice(page.length ? lowerBound(index.images, page[0].seq) : 0,
    lowerBound(index.images, before)).map(row => row.image);
  const media = index.media.slice(page.length ? lowerBound(index.media, page[0].seq) : 0,
    lowerBound(index.media, before)).map(row => row.file);
  return { messages: page, images, ...(media.length && { media }), hasMore: start > 0, nextBefore: start > 0 ? page[0].seq : null };
}
