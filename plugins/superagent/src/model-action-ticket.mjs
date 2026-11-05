import { createHash, randomUUID } from 'node:crypto';
import { requestAssistantApproval } from './approval.mjs';
import { currentHumanInstruction } from './desktop-delegation-service.mjs';
import { recordDesktopTrigger } from './desktop-trigger.mjs';

const validName = value => typeof value === 'string' && /^assistant_(?:config|profile|generate_image|pet)$/.test(value);
const validId = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error(`Model action requires ${name}`);
  return value;
};
function snapshot(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Model action arguments must be JSON values');
  const copy = JSON.parse(serialized);
  const freeze = item => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return { value: freeze(copy), serialized };
}
const digest = value => createHash('sha256').update(value).digest('hex');
const asEvidence = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Model action verifier must return structured evidence');
  const { serialized } = snapshot(value);
  return JSON.parse(serialized);
};

/** Model-owned persistent actions use a real, fenced Router-action Ticket. */
export function createModelActionTicketExecutor({ ctx, database, readPolicy, perform, verify, leaseMs = 120000 } = {}) {
  if (!database?.reserveRouterAction || !database?.settleRouterAction || !database?.getRouterAction) throw new Error('Model action executor requires atomic Router-action APIs');
  if (!ctx?.agents || typeof readPolicy !== 'function' || typeof perform !== 'function' || typeof verify !== 'function') throw new Error('Model action executor requires host identity, policy and verifier callbacks');
  const pending = new Map();

  async function execute(input = {}) {
    const { name: toolName, args = {}, exec, ownerAgent, threadId = 'main', reason } = input;
    if (!validName(toolName)) throw new Error('Unsupported model persistent action');
    if (!ownerAgent || exec?.agent !== ownerAgent) throw new Error('Model action owner mismatch');
    const sessionId = validId(String(ownerAgent.id || ownerAgent.session?.id || ''), 'session identity');
    const callId = validId(exec.callId, 'callId');
    const instruction = currentHumanInstruction(ctx, ownerAgent);
    if (!instruction?.message?.id) throw new Error('Model action requires the active root user turn');
    const frozen = snapshot(args), argsHash = digest(frozen.serialized);
    const requestKey = JSON.stringify([sessionId, callId]);
    const binding = JSON.stringify([toolName, argsHash, threadId]);
    const existingPending = pending.get(requestKey);
    if (existingPending) {
      if (existingPending.binding !== binding) throw Object.assign(new Error('Model action identity conflict'), { code: 'IDEMPOTENCY_CONFLICT' });
      return existingPending.promise;
    }
    const promise = run({ toolName, args: frozen.value, serializedArgs: frozen.serialized, argsHash, exec, ownerAgent, threadId, sessionId, callId, reason, instruction });
    pending.set(requestKey, { binding, promise });
    try { return await promise; } finally { if (pending.get(requestKey)?.promise === promise) pending.delete(requestKey); }
  }

  async function run({ toolName, args, serializedArgs, argsHash, exec, ownerAgent, threadId, sessionId, callId, reason, instruction }) {
    const sourceMessage = instruction.message;
    const instructionHash = digest(JSON.stringify([instruction.turn, sourceMessage]));
    const prior = database.getRouterAction(sessionId, callId);
    if (prior) {
      if (prior.action?.toolName !== toolName || prior.action?.argsHash !== argsHash || prior.action?.threadId !== threadId
        || prior.ticket?.mandate?.source?.messageId !== sourceMessage.id) throw Object.assign(new Error('Model action identity conflict'), { code: 'IDEMPOTENCY_CONFLICT' });
      if (prior.state === 'completed' && prior.receipt && Object.hasOwn(prior.receipt, 'value')) return prior.receipt.value;
      throw Object.assign(new Error('Model action is already reserved; inspect its Ticket and reconcile before retrying'), { code: 'MODEL_ACTION_UNCERTAIN' });
    }

    exec.signal?.throwIfAborted();
    if (!await requestAssistantApproval(ctx, { ...exec, authorized: false }, toolName, reason || `Persistent action ${toolName}: ${serializedArgs}`)) throw Object.assign(new Error('Model action was not approved'), { code: 'MODEL_ACTION_DENIED' });
    exec.signal?.throwIfAborted();
    const currentInstruction = currentHumanInstruction(ctx, ownerAgent);
    if (!currentInstruction || digest(JSON.stringify([currentInstruction.turn, currentInstruction.message])) !== instructionHash) throw Object.assign(new Error('User instruction changed during model-action approval'), { code: 'MODEL_ACTION_INSTRUCTION_CHANGED' });

    const policy = await readPolicy();
    const policyReadInstruction = currentHumanInstruction(ctx, ownerAgent);
    if (!policyReadInstruction || digest(JSON.stringify([policyReadInstruction.turn, policyReadInstruction.message])) !== instructionHash) throw Object.assign(new Error('User instruction changed before model-action reservation'), { code: 'MODEL_ACTION_INSTRUCTION_CHANGED' });
    const desktopVersion = policy?.desktopVersion;
    if (typeof desktopVersion !== 'string' || !desktopVersion) throw new Error('Current desktop policy is unavailable');
    const source = { channel: 'desktop', sessionId, messageId: sourceMessage.id, threadId };
    const trigger = recordDesktopTrigger(database, { sessionId, threadId, message: sourceMessage });
    if (!trigger?.trigger?.id) throw new Error('Model action source Trigger is unavailable');
    const mandate = {
      actorId: 'desktop-owner', source, instruction: trigger.trigger.content,
      policyVersion: desktopVersion, admission: 'desktop-model-action',
      controlledActions: 'model-persistent-action',
      action: { toolName, callId, argsHash, threadId },
      approval: { kind: 'harness', callId, toolName },
    };
    const owner = `model-action:${randomUUID()}`;
    const validateMandate = value => value?.admission === 'desktop-model-action'
      && value?.controlledActions === 'model-persistent-action'
      && value?.policyVersion === desktopVersion
      && value?.actorId === 'desktop-owner'
      && value?.action?.toolName === toolName && value?.action?.callId === callId
      && value?.action?.argsHash === argsHash && value?.action?.threadId === threadId;
    const reservation = database.reserveRouterAction({
      sessionId, messageId: sourceMessage.id, callId, toolName, argsHash,
      triggerId: trigger.trigger.id, mandate, target: `Model action: ${toolName}`,
      acceptance: 'Execute once; persist canonical result and independently verify authoritative state.',
      owner, leaseMs, validateMandate,
    });
    if (reservation.duplicate) {
      if (reservation.action?.toolName !== toolName || reservation.action?.argsHash !== argsHash || reservation.action?.threadId !== threadId) throw Object.assign(new Error('Model action identity conflict'), { code: 'IDEMPOTENCY_CONFLICT' });
      if (reservation.state === 'completed' && reservation.receipt && Object.hasOwn(reservation.receipt, 'value')) return reservation.receipt.value;
      throw Object.assign(new Error('Model action was already reserved; external outcome must be reconciled'), { code: 'MODEL_ACTION_UNCERTAIN' });
    }
    let observedReceipt;
    try {
      exec.signal?.throwIfAborted();
      const afterReserve = await readPolicy();
      if (afterReserve?.desktopVersion !== desktopVersion || !validateMandate(mandate)) throw Object.assign(new Error('Model action policy changed before execution'), { code: 'MODEL_ACTION_POLICY_CHANGED' });
      const dispatchInstruction = currentHumanInstruction(ctx, ownerAgent);
      if (!dispatchInstruction || digest(JSON.stringify([dispatchInstruction.turn, dispatchInstruction.message])) !== instructionHash) throw Object.assign(new Error('User instruction changed before model-action dispatch'), { code: 'MODEL_ACTION_INSTRUCTION_CHANGED' });
      const actionResult = await perform({ name: toolName, args, exec, ticket: reservation.ticket, assignment: reservation.assignment, run: reservation.run, actionKey: reservation.actionKey });
      observedReceipt = asEvidence({ value: actionResult });
      const afterAction = await readPolicy();
      if (afterAction?.desktopVersion !== desktopVersion) throw Object.assign(new Error('Model action policy changed before verification'), { code: 'MODEL_ACTION_POLICY_CHANGED' });
      const proof = await verify({ name: toolName, args, result: actionResult, ticket: reservation.ticket, assignment: reservation.assignment, run: reservation.run });
      if (proof?.verified !== true) throw new Error('Model action readback did not verify the requested state');
      const evidence = asEvidence(proof.evidence);
      const finalPolicy = await readPolicy();
      if (finalPolicy?.desktopVersion !== desktopVersion) throw Object.assign(new Error('Model action policy changed before settlement'), { code: 'MODEL_ACTION_POLICY_CHANGED' });
      const settled = database.settleRouterAction({
        sessionId, callId, owner, fence: reservation.assignment.fence, argsHash,
        receipt: observedReceipt, readback: evidence, verified: true,
        summary: `Model action completed: ${toolName}`,
        validateMandate: value => validateMandate(value) && finalPolicy.desktopVersion === desktopVersion,
      });
      if (settled.state !== 'completed' || !settled.receipt || !Object.hasOwn(settled.receipt, 'value')) throw Object.assign(new Error('Model action settlement is uncertain; inspect its Ticket'), { code: 'MODEL_ACTION_UNCERTAIN' });
      return settled.receipt.value;
    } catch (error) {
      try {
        database.settleRouterAction({ sessionId, callId, owner, fence: reservation.assignment.fence, argsHash,
          receipt: observedReceipt || { error: { code: error.code || 'MODEL_ACTION_OUTCOME_UNKNOWN', message: String(error.message || error).slice(0, 1000) } },
          readback: { verified: false }, verified: false, uncertain: true,
          summary: `Model action requires reconciliation: ${toolName}`, validateMandate: () => false });
      } catch { /* Keep the original failure; the reservation remains non-replayable. */ }
      throw error;
    }
  }

  return { execute };
}
