// Session events are append-only. Keep small pagination metadata beside the
// engine's existing bounded transcript cache instead of rescanning tool traces.
export function updateHistoryIndex(events, index = { watermark: 0, imageCalls: new Set(), images: [] }) {
  for (let i = index.watermark; i < events.length; i++) {
    const event = events[i];
    if (event.type === 'request/header') index.header = event.data.header.config;
    else if (event.type === 'turn/end') index.lastEnd = event.data.reason;
    else if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call' && block.name === 'assistant_generate_image') index.imageCalls.add(block.id);
      }
    } else if (event.type === 'tool/result') {
      const message = event.data.message;
      if (!message || message.isError || !index.imageCalls.has(message.toolCallId)) continue;
      try {
        const value = JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join(''));
        if (!/^[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/.test(value.filename)) continue;
        index.images.push({ seq: event.seq, image: { id: message.id, name: value.filename,
          url: `api/commander/assistant/artifact?file=${encodeURIComponent(value.filename)}` } });
      } catch { /* Invalid or incomplete tool results are not image attachments. */ }
    }
  }
  index.watermark = events.length;
  return index;
}

// First image result at or after the cursor; result rows follow event seq.
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
  return { messages: page, images, hasMore: start > 0, nextBefore: start > 0 ? page[0].seq : null };
}
