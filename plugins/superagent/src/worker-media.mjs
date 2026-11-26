import { mediaToolDefinitions } from '../../media/src/generation-tools.mjs';
import { MEDIA_PRESENTATION, mediaResultFile, mediaResultItems } from '../../media/shared/generation-result.mjs';

const generation = new Set(['generate_image', 'generate_video', 'generate_audio']);
const reports = new Set([...generation, 'media_video_status']);

export function installWorkerMedia(scope, ctx, agent, source, instruction) {
  if (!scope.tools?.register) return;
  const definitions = mediaToolDefinitions({ generation: () => ctx.get?.('mediaGeneration'), attachments: () => ctx.get?.('attachments') });
  for (const { when, execute, ...definition } of definitions) scope.tools.register({
    ...definition,
    async execute(args, exec) {
      if (exec.agent !== agent) throw new Error('媒体工具仅供此工单的 Worker 使用');
      if (!generation.has(definition.name)) return execute(args, exec);
      let sourceEvents = [], userMessage;
      if (source?.channel === 'desktop' && source.sessionId && source.messageId) {
        const parent = ctx.sessions?.get?.(source.sessionId);
        const events = parent?.snapshotEvents() ?? (await ctx.sessionQuery.readSession(source.sessionId)).events ?? [];
        const index = events.findIndex(event => event.type === 'user/message' && event.data?.id === source.messageId && event.data.source?.kind === 'user');
        if (index >= 0) {
          userMessage = events[index].data;
          sourceEvents = events.slice(0, index);
        }
      }
      exec.signal?.throwIfAborted();
      return execute(args, exec, { worker: true, userMessage, userText: instruction, sourceEvents });
    },
  }, { when: context => context.agent === agent && when(context) });
  scope.systemPrompt?.section?.({ name: 'benchgo-worker-media', order: -98, interpolate: false, text: 'For requested media, use the enabled media tools here. Use one batch per media kind for multiple items. The host includes delivered files from the tool receipts in the original conversation. Report real errors and pending items individually, preserving request IDs and diagnostic codes when present. A file list in the working directory cannot establish media generation status. Never resubmit an unconfirmed media request. For video with a known request ID, use media_video_status to check the original request.' });
}

export function workerMediaReport(events = []) {
  const calls = new Map(), files = new Map(), errors = new Set(), videos = new Map();
  for (const event of events) {
    if (event.type === 'assistant/message') for (const block of event.data?.message?.content ?? []) {
      if (block.type === 'tool-call' && reports.has(block.name)) calls.set(block.id, block.name);
    }
    if (event.type !== 'tool/result') continue;
    const { message, meta, error } = event.data;
    if (!calls.has(message?.toolCallId ?? message?.source?.callId)) continue;
    const text = (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (message.isError || error) {
      const detail = error?.message || text;
      const code = error?.code ?? error?.info?.code;
      if (detail.trim()) errors.add(code ? `${code} — ${detail}` : detail);
      continue;
    }
    let receipt = meta?.[MEDIA_PRESENTATION];
    if (!receipt) {
      try { receipt = JSON.parse(text); } catch { continue; }
    }
    for (const item of mediaResultItems(receipt)) {
      const file = mediaResultFile(item);
      if (file) files.set(file.url, item);
      if (typeof item?.error?.message === 'string') {
        errors.add([item.requestId, item.error.code, item.error.message].filter(Boolean).join(' · '));
      }
      if (item?.jobId && item.requestId) videos.set(item.requestId, item.status);
    }
  }
  const pending = [], failedVideos = [];
  for (const [id, status] of videos) {
    if (['queued', 'in_progress'].includes(status)) pending.push({ requestId: id, status });
    if (['failed', 'cancelled'].includes(status)) failedVideos.push(`视频 ${id}：${status === 'failed' ? '供应商报告失败' : '供应商报告取消'}`);
  }
  const failures = [...errors, ...failedVideos].map(detail => detail.slice(0, 1200));
  if (files.size || failures.length || pending.length) return { files: [...files.values()], failures, pending };
}
