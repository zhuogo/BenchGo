/** Official subagents use parent navigation. Voice activity can make a blank session visible. */
export function isSidebarSessionVisible(session) {
  return Boolean(session && session.origin !== 'subagent' && (!session.blank || session.projectionValues?.benchgoVoice?.used === true));
}

export function sidebarSessionTitle(session) {
  return session?.title || (session?.projectionValues?.benchgoVoice?.used === true ? '语音对话' : session?.displayTitle) || '新对话';
}

export function sidebarSessionUpdatedAt(session) {
  const voice = session?.projectionValues?.benchgoVoice;
  if (voice?.used !== true) return session?.updatedAt;
  return Math.max(Number(session.updatedAt) || Date.parse(session.updatedAt) || 0, Number(voice.lastActivityAt) || 0);
}

export function latestSidebarNativeSessions(sessions) {
  const owners = new Map();
  for (const session of sessions) {
    const owner = session.ownerSessionId;
    if (!owner || (session.parentId && !session.harnessAdopted)) continue;
    const previous = owners.get(owner);
    if (!previous || Number(session.updatedAt) > Number(previous.updatedAt)) owners.set(owner, session);
  }
  return owners;
}
