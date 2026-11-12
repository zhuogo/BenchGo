/** Business high-risk cards cannot inherit internal authorization or accept an always grant. */
export async function requestExternalActionApproval(ctx, { exec, action, reason }) {
  const approval = ctx.get?.('approval');
  if (!approval?.request || !exec.agent) throw new Error('外部动作需要可用的人工审批服务');
  return approval.request({ agent: exec.agent, toolName: 'assistant_external_action', callId: exec.callId,
    signal: exec.signal, reason: reason || JSON.stringify({ category: action.category, origin: action.origin, target: action.target, content: action.content }) });
}
