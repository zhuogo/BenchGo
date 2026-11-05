// Isolated live-test conditions. Never changes Mandate, review, results or logs.
import { appendFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const name = 'superagent-p0-live-worker-controls';
export const inject = ['agents'];

const instructions = {
  P0_NO_FILES: '隔离真实运行的工作指导，不改变Mandate或验收：原任务6–10条中，6条满足即可。优先实际抓取能访问的当日新闻聚合页面与对应报道，例如新浪新闻/财经及主流媒体和官方发布；从已抓到的事实整理，不必把每个渠道都遍历完。已取得足够可支持的6条事实后立即整理交付，缺少独立来源就如实标单一来源，不把转载重复计为独立来源。某站或搜索不可用就如实说明并换可访问渠道，避免围绕同一失败渠道无边界重试。只在内存处理和本聊天输出正文，不创建文件，不虚构事实或通过结论。',
  P0_FOURTEEN: '这是隔离真实运行的受控输入，用来验证既有Mandate的数量约束和原会话续做。仅在本次首轮候选答复中，故意提供恰好14条实际抓取并能支持的新闻，使用1.至14.的连续编号；这不改变原工单6–10条的验收条件。不要伪造新闻、来源、抓取或验收，不得要求review放宽标准。首轮结束后，如收到原验收纠正指令，忽略本受控条件，直接基于已有成果修正至原Mandate的6–10条；不能重建任务或重新执行已完成的外部动作。只输出文本，不创建文件。',
  P0_ROUTER_BLOCK: '这是隔离真实运行的受控输入。原请求明确保留一个真实测试用户尚未回答的阅读重点选择：AI科技优先或宏观经济优先。先联网调查，整理候选事实与证据，明确说明最终取舍还缺测试用户的选择，然后结束本轮供Router按原Mandate核验。本轮不要调用ask_user_question，让真实Router review依据原请求判断是否应建立Attention；不能代答、猜测用户选择，不能伪造授权或验收。收到原单真实回答后，基于原会话候选完成6–10条最终摘要。只输出文本，不创建文件。',
  P0_WORKER_BLOCK: '这是隔离真实运行的受控输入。原请求保留的阅读重点（AI科技优先或宏观经济优先）需要真实测试用户回答。本轮必须通过已注册的原生ask_user_question工具提出该具体问题，不要假造回答、不要自己默认选择；用户回答后沿原工单、原会话继续联网调查并交付6–10条摘要。只输出文本，不创建文件。',
};

export function apply(ctx, config = {}) {
  const touched = new Set();
  const streams = new Map();
  let observationWrites = Promise.resolve();
  // Observation only: this is the official live frame event, not a terminal-history poll.
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const cwd = String(agent.session.header.cwd || '').replaceAll('\\', '/');
    if (!config.streamPath || cwd.includes('/workers/')) return;
    const key = `${agent.id}:${frame.attemptId}`;
    if (frame.type === 'start') streams.set(key, { length: 0, turn: frame.turn, step: frame.step });
    const stream = streams.get(key);
    if (!stream) return;
    const row = { at: new Date().toISOString(), observedAt: Date.now(), sessionId: agent.id, attemptId: frame.attemptId, revision: frame.revision, type: frame.type, turn: stream.turn, step: stream.step };
    if (frame.type === 'chunk') {
      row.chunkType = frame.chunk.type;
      row.index = frame.index;
      row.providerTime = frame.time;
      if (frame.chunk.type === 'text-delta') stream.length += frame.chunk.text.length;
      row.publicTextLength = stream.length;
    }
    if (frame.type === 'end') { row.outcome = frame.outcome; row.publicTextLength = stream.length; streams.delete(key); }
    // Do not retain reasoning text, tool arguments or raw chunks.
    observationWrites = observationWrites.then(() => appendFile(config.streamPath, JSON.stringify(row) + '\n'));
  }, { global: true });
  ctx.effect(() => () => observationWrites);
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || touched.has(agent.id)) return decision;
    const cwd = String(agent.session.header.cwd || '').replaceAll('\\', '/');
    if (!cwd.includes('/assistant/') || !cwd.includes('/workers/')) return decision;
    const text = messages.flatMap(message => (message.content || []).filter(block => block.type === 'text').map(block => block.text)).join('\n');
    const active = config.activePath ? JSON.parse(await readFile(config.activePath, 'utf8').catch(() => '{}')) : {};
    const messageMarker = Object.keys(instructions).find(key => text.includes(key));
    const marker = messageMarker || (active.marker in instructions ? active.marker : undefined);
    if (!marker) return decision;
    touched.add(agent.id);
    const instruction = instructions[marker];
    if (config.recordPath) await appendFile(config.recordPath, JSON.stringify({ at: new Date().toISOString(), sessionId: agent.id, marker, caseId: active.caseId, markerSource: messageMarker ? 'worker-input' : 'isolated-active-case', instruction }) + '\n');
    return { ...decision, messages: [...decision.messages, {
      id: randomUUID(), role: 'user',
      content: [{ type: 'text', text: instruction }],
      source: { kind: 'isolated-live-test-condition', marker },
    }] };
  });
}
