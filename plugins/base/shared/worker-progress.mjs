import { redactExecutionText } from './execution-text.mjs';

/** A public status sentence from the executor, not another model request. */
export const workerProgressInstruction = 'Keep the task timeline understandable. Before a meaningful group of actions, and when an important finding or blocker changes your next action, write one brief public status line in your assistant message using exactly "进展：<具体动作及对象，或已确认的发现>". Use the user\'s language, normally 15–50 Chinese characters and at most 120 characters. Examples: "进展：检查注册邮箱是否收到验证邮件"; "进展：验证码仍受限，记录限制后等待重试". Describe actual work, distinguish plans from confirmed results, and avoid generic "processing" or "running commands", worker identities, secrets, raw commands, long output and internal reasoning. Do not repeat unchanged status or add a status for every tool call. Continue executing after the status line; it is not the final result.';

export function installWorkerProgressPrompt(scope) {
  scope.systemPrompt.section({ name: 'benchgo-worker-progress', order: -108, interpolate: false, text: workerProgressInstruction });
}

export function scanWorkerProgressLine(value, state) {
  const marker = /^\s*(`{3,}|~{3,})/.exec(value)?.[1];
  if (marker) {
    if (!state.fence) state.fence = marker;
    else if (marker[0] === state.fence[0] && marker.length >= state.fence.length) state.fence = undefined;
    return '';
  }
  if (state.fence) return '';
  const match = /^进展[：:][ \t]*(\S.*)$/u.exec(value.trim());
  return match && [...match[1]].length <= 120 ? redactExecutionText(match[1], 120) : '';
}

/** Only explicitly published, complete short lines are status reports. */
export function publicExecutionActivity(event) {
  const data = event.data, message = data?.message;
  if (event.type !== 'assistant/message' || data?.parentCallId || data?.interrupted
    || message?.role !== 'assistant' || message.source?.kind !== 'model') return '';
  let report = '';
  for (const block of message.content || []) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    const state = {};
    for (const line of block.text.split(/\r?\n/)) report = scanWorkerProgressLine(line, state) || report;
  }
  return report;
}
