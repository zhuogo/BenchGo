import { currentHumanInstruction } from './desktop-delegation-service.mjs';

const scopes = new WeakSet();
export const isDesktopTaskManagementScope = scope => !!scope && scopes.has(scope);

/** A host capability, never a model argument or a transferable conversation identity. */
export async function desktopTaskManagementScope({ ctx, store, agent, threadId = 'main' }) {
  if (!agent) return null;
  const instruction = currentHumanInstruction(ctx, agent);
  if (!instruction?.message?.id || !(instruction.message.content || []).some(block => block.type === 'text' && block.text?.trim())) return null;
  const stamp = JSON.stringify(instruction);
  const state = await store.getState();
  const thread = threadId === 'main' ? { sessionId: state.mainSessionId } : state.threads?.find(row => row.id === threadId);
  if (!thread || thread.archived || thread.sourceKey || thread.source && thread.source.channel !== 'desktop' || thread.sessionId !== agent.id) return null;
  const current = currentHumanInstruction(ctx, agent);
  if (JSON.stringify(current) !== stamp) return null;
  const scope = Object.freeze({ owner: 'desktop-owner', mode: 'global' });
  scopes.add(scope);
  return scope;
}
