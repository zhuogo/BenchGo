export async function requestAssistantApproval(ctx, exec, toolName, reason) {
  if (exec.authorized === true) return true;
  const approval = ctx.get?.('approval');
  if (!approval?.request || !exec.agent) throw new Error('需要人工审批服务');
  const result = await approval.request({ agent: exec.agent, toolName, callId: exec.callId, signal: exec.signal, reason });
  return result === true || result === 'allowed-once' || result === 'allowed-always' || result?.allow === true;
}
