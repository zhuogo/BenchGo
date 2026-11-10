import { currentHumanInstruction } from './desktop-delegation-service.mjs';

const scopes = new WeakSet();
export const isDesktopTicketManagementScope = scope => !!scope && scopes.has(scope);

/** A host capability, never a model argument or a transferable conversation identity. */
export async function desktopTicketManagementScope({ ctx, store, agent, threadId = 'main' }) {
  if (!agent) return null;
  const instruction = currentHumanInstruction(ctx, agent);
  if (!instruction?.message?.id || !(instruction.message.content || []).some(block => block.type === 'text' && block.text?.trim())) return null;
  const stamp = JSON.stringify(instruction);
  const state = await store.getState();
  const thread = threadId === 'main' ? { sessionId: state.mainSessionId } : state.threads?.find(row => row.id === threadId);
  if (!thread || thread.archived || thread.sourceKey || thread.source && thread.source.channel !== 'desktop' || thread.sessionId !== agent.id) return null;
  const current = currentHumanInstruction(ctx, agent);
  const latest = agent.session.snapshotEvents().slice(instruction.turn + 1).findLast(event => event.type === 'user/message')?.data;
  if (JSON.stringify(current) !== stamp || JSON.stringify(latest) !== JSON.stringify(instruction.message)) return null;
  const scope = Object.freeze({ owner: 'desktop-owner', mode: 'global' });
  scopes.add(scope);
  return scope;
}
