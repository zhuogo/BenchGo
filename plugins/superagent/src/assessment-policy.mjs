import { roleModels } from './routing.mjs';
import { readAdmissionRules } from './admission-rules.mjs';
import { createHash } from 'node:crypto';
import { isScheduledTrigger } from './schedule-bridge.mjs';
import { assessChannelAdmission, validateChannelMandate } from './channel-policy.mjs';

export async function readAssessmentPolicy(store, workspaceRegistry, threadId) {
  const connection = store.connections.read();
  const [config, document] = await Promise.all([store.getConfig(), store.documents.read('AGENTS.md')]);
  // Channel revisions belong to their adapter; unrelated channels never revoke work.
  const projects = (workspaceRegistry?.list() || []).map(({ id, path, title }) => ({ id, path, title }));
  const bindings = projects.map(({ id, path }) => [id, path]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const connections = store.connections.list();
  const version = createHash('sha256').update(JSON.stringify([document.hash, bindings])).digest('hex');
  const desktopVersion = createHash('sha256').update(JSON.stringify(['desktop', document.hash, bindings])).digest('hex');
  const channel = threadId ? store.orchestration.getThread(threadId)?.source?.type : 'feishu';
  const selected = connections.find(row => row.channel === channel) || connection;
  const enabled = new Set(selected.config.enabledRuleIds || []);
  const writtenRules = readAdmissionRules(document.content).filter(rule => enabled.has(rule.id));
  return { version, desktopVersion, connections: Object.fromEntries(connections.map(row => [row.channel, { ...row, enabledRuleIds: readAdmissionRules(document.content).filter(rule => (row.config.enabledRuleIds || []).includes(rule.id)).map(rule => rule.id) }])), projects, model: roleModels(undefined, config, 'router')[0], models: roleModels(undefined, config, 'router'), workerHarness: config.workerHarness, workerModels: config.workerModels, routingConfig: { revision: config.revision, auxiliary: config.auxiliary, models: config.models, workerHarness: config.workerHarness, workerModels: config.workerModels }, rules: document.content + '\nEnabled admission rules (exact IDs):\n' + JSON.stringify(writtenRules), connection: connection.config, mode: selected.config.admissionMode || 'manual', enabledRuleIds: writtenRules.map(rule => rule.id) };
}

/** Admission records a trusted instruction; it does not preapprove controlled actions. */
export function authorizeAssessment({ policy, candidate, trigger, decision, task }) {
  const channel = trigger.source?.channel || 'feishu';
  const config = channel === 'feishu' ? policy.connection : policy.connections?.[channel]?.config;
  if (!config && !isScheduledTrigger(trigger)) return { allowed: false, reason: 'unknown-channel' };
  if (decision.outcome === 'ignore') return { allowed: true, reason: 'read-only-ignore' };
  if (isScheduledTrigger(trigger)) {
    if (candidate.gate.strength !== 'explicit' || candidate.gate.evidence?.desktopPolicyVersion !== policy.desktopVersion) return { allowed: false, reason: 'schedule-policy-changed' };
    const project = decision.projectId === undefined ? undefined : policy.projects?.find(item => item.id === decision.projectId);
    if (decision.projectId !== undefined && !project) return { allowed: false, reason: 'unknown-project' };
    if (decision.outcome === 'answer') return { allowed: true, reason: 'scheduled-notification' };
    if (decision.outcome !== 'accept') return { allowed: false, reason: 'schedule-requires-new-task' };
    return { allowed: true, reason: 'owned-harness-schedule', mandate: {
      admission: 'desktop-schedule', actorId: 'harness-schedule', actorKind: 'machine', source: trigger.source,
      instruction: trigger.content, desktopPolicyVersion: policy.desktopVersion,
      controlledActions: 'require-current-policy-and-harness-approval',
      ...(project ? { project: { id: project.id, path: project.path } } : {}),
    } };
  }
  const admission = assessChannelAdmission({ policy, candidate, trigger, decision });
  if (!admission.allowed) return admission;
  if (['answer', 'ask'].includes(decision.outcome)) return admission;
  const project = decision.projectId === undefined ? undefined : policy.projects?.find(item => item.id === decision.projectId);
  if (decision.projectId !== undefined && !project) return { allowed: false, reason: 'unknown-project' };
  if (['attach', 'stop', 'revise', 'adjustment'].includes(decision.outcome) && !decision.taskId) return { allowed: false, reason: 'missing-task' };
  if (admission.routerAttention) return admission;
  if (['attach', 'stop', 'revise', 'adjustment'].includes(decision.outcome)
    && (!task || task.mandate?.actorId !== trigger.actor.id || !['channel', 'connectionId', 'conversationId'].every(key => typeof trigger.source[key] === 'string' && !!trigger.source[key] && task.mandate.source?.[key] === trigger.source[key]))) return { allowed: false, reason: 'task-source-ownership-mismatch' };
  return { allowed: true, reason: admission.reason, mandate: {
    ...admission.mandate,
    actorId: trigger.actor.id, source: trigger.source, instruction: trigger.content,
    controlledActions: 'require-current-policy-and-harness-approval',
    ...(project ? { project: { id: project.id, path: project.path } } : {}),
  } };
}

/** Current disk rules may revoke an immutable admission; they never broaden it. */
export function validateTaskMandate(mandate, { policy }) {
  if (!mandate || !policy) return false;
  const desktop = mandate.source?.channel === 'desktop';
  // A peer never grants business authority or creates a second Task.
  if (mandate.source?.channel === 'link') return false;
  if (mandate.admission === 'desktop-schedule') return isScheduledTrigger({ actor: { id: mandate.actorId, kind: mandate.actorKind }, source: mandate.source })
    && mandate.policyVersion === policy.version && mandate.desktopPolicyVersion === policy.desktopVersion
    && mandate.controlledActions === 'require-current-policy-and-harness-approval'
    && (!mandate.project || policy.projects?.some(project => project.id === mandate.project.id && project.path === mandate.project.path));
  // Desktop mandates pin the desktop policy version; channel mandates are revalidated
  // against their own adapter's current policy.
  if (desktop && mandate.policyVersion !== policy.desktopVersion) return false;
  if (mandate.execution) {
    const { deviceId, hostId, authorizationId, config, protocolVersion } = mandate.execution;
    if (!desktop || [deviceId, hostId, authorizationId].some(value => typeof value !== 'string' || !value)
      || deviceId === 'local' || protocolVersion !== 2 || !['official', 'codex', 'claude'].includes(config?.harness)
      || !Array.isArray(config.models) || config.models.length !== 1
      || config.models.some(model => typeof model?.providerId !== 'string' || !model.providerId || typeof model?.modelId !== 'string' || !model.modelId)
      || mandate.project && (mandate.project.deviceId !== deviceId || mandate.project.hostId !== hostId
        || typeof mandate.project.id !== 'string' || !mandate.project.id || typeof mandate.project.path !== 'string' || !mandate.project.path)) return false;
  } else if (mandate.project && (!policy.projects?.some(project => project.id === mandate.project.id && project.path === mandate.project.path)
    || mandate.project.deviceId && mandate.project.deviceId !== 'local')) return false;
  const source = mandate.source;
  if (desktop) return typeof mandate.actorId === 'string' && !!mandate.actorId && mandate.admission === 'desktop-approved-delegation'
    && typeof source.sessionId === 'string' && !!source.sessionId && typeof source.messageId === 'string' && !!source.messageId
    && mandate.controlledActions === 'require-current-policy-and-harness-approval';
  return validateChannelMandate(mandate, policy);
}
