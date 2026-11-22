/** Business high-risk cards cannot inherit internal authorization or accept an always grant. */
export async function requestExternalActionApproval(ctx, { exec, action, reason }) {
  const approval = ctx.get?.('approval');
  if (!approval?.request || !exec.agent) throw new Error('外部动作需要可用的人工审批服务');
  return requestBusinessApproval(approval, { agent: exec.agent, toolName: 'assistant_external_action', callId: exec.callId,
    signal: exec.signal, reason: reason || JSON.stringify({ category: action.category, origin: action.origin, target: action.target, content: action.content }) });
}

/** Keep the official audit path and distinguish policy rejection from a human decision. */
export async function requestBusinessApproval(approval, request) {
  const policy = approval.overrideOf?.(request.agent.session) ?? approval.config?.policy ?? 'ask';
  const outcome = await approval.request(request);
  if (policy === 'never' && outcome === 'rejected') throw Object.assign(
    new Error('当前会话审批策略为 never，宿主已拒绝本次审批且不会显示审批卡；本次操作未提交，请用户接管。'),
    { code: 'APPROVAL_POLICY_NEVER' });
  return outcome;
}

const settingsApprovals = new WeakSet();

export async function requestSettingsApproval(approval, request) {
  const { session } = request.agent;
  const policy = approval.overrideOf?.(session) ?? approval.config?.policy;
  if (settingsApprovals.has(session)) throw Object.assign(new Error('请先处理当前设置审批'), { code: 'MANAGEMENT_APPROVAL_PENDING' });
  if (policy !== 'never') return requestBusinessApproval(approval, request);
  settingsApprovals.add(session);
  try {
    let pending;
    // The official request checks policy synchronously before dispatching the card.
    session.append('approval/policy', { policy: 'ask' });
    try { pending = approval.request(request); }
    finally {
      try { session.append('approval/policy', { policy }); }
      catch (error) { pending?.catch(() => {}); throw error; }
    }
    return await pending;
  } finally {
    settingsApprovals.delete(session);
  }
}
