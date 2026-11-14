import { redactExecutionText } from './execution-summary-input.mjs';

/** A public status sentence from the executor, not another model request. */
export function installWorkerProgressPrompt(scope) {
  scope.systemPrompt.section({ name: 'benchgo-worker-progress', order: -108, interpolate: false,
    text: 'Keep the task timeline understandable. Before a meaningful group of actions, and when an important finding or blocker changes your next action, write one brief public status line in your assistant message using exactly "进展：<具体动作及对象，或已确认的发现>". Use the user\'s language, normally 15–50 Chinese characters and at most 120 characters. Examples: "进展：检查注册邮箱是否收到验证邮件"; "进展：验证码仍受限，记录限制后等待重试". Describe actual work, distinguish plans from confirmed results, and avoid generic "processing" or "running commands", worker identities, secrets, raw commands, long output and internal reasoning. Do not repeat unchanged status or add a status for every tool call. Continue executing after the status line; it is not the final result.' });
}

/** Only explicitly published, complete short lines are status reports. */
export function publicExecutionActivity(event) {
  const data = event.data, message = data?.message;
  if (event.type !== 'assistant/message' || data?.parentCallId || data?.interrupted
    || message?.role !== 'assistant' || message.source?.kind !== 'model') return '';
  const reports = [];
  for (const block of message.content || []) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    let fence;
    for (const line of block.text.split(/\r?\n/)) {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        continue;
      }
      if (fence) continue;
      const match = /^进展[：:][ \t]*(\S.*)$/u.exec(line.trim());
      if (!match || [...match[1]].length > 120) continue;
      const text = redactExecutionText(match[1], 120);
      if (text) reports.push(text);
    }
  }
  return reports.at(-1) || '';
}
