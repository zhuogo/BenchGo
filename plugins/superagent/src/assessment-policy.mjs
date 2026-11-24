import { roleModels } from './routing.mjs';
import { readAdmissionRules } from './admission-rules.mjs';
import { createHash } from 'node:crypto';
import { isScheduledTrigger } from './schedule-bridge.mjs';
import { assessChannelAdmission, validateChannelMandate } from './channel-policy.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const desktopHistory = new WeakMap();
const desktopOwnerDelegationVersion = digest(['desktop-owner-delegation', 1]);

export const desktopDelegationVersion = policy => policy.desktopDelegationVersion ?? policy.desktopVersion;

async function desktopDocumentHashes(documents, document, rules) {
  if (!documents.versions) return [document.hash];
  const cached = desktopHistory.get(documents);
  if (cached?.hash === document.hash && cached.revision === document.revision) return cached.hashes;
  const hashes = [document.hash];
  for (const prior of await documents.versions('AGENTS.md')) {
    if (prior.status !== 'committed' || prior.revision >= document.revision) continue;
    try { if (JSON.stringify(readAdmissionRules(prior.content)) !== rules) break; }
    catch { break; }
    hashes.push(prior.hash);
  }
  desktopHistory.set(documents, { hash: document.hash, revision: document.revision, hashes });
  return hashes;
}

export function desktopPolicyMatches(policy, version) {
  return typeof version === 'string' && !!version
    && (policy.desktopVersion === version || policy.legacyDesktopVersions?.includes(version) === true);
}

export async function readAssessmentPolicy(store, workspaceRegistry, threadId) {
  const connection = store.connections.read();
  const [config, document] = await Promise.all([store.getConfig(), store.documents.read('AGENTS.md')]);
  // Channel revisions belong to their adapter; unrelated channels never revoke work.
  const projects = (workspaceRegistry?.list() || []).map(({ id, path, title }) => ({ id, path, title }));
  const bindings = projects.map(({ id, path }) => [id, path]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const connections = store.connections.list();
  let admissionRules = [], ruleDocumentValid = true;
  try { admissionRules = readAdmissionRules(document.content); }
  catch (error) {
    if (error.code !== 'DUPLICATE_ADMISSION_RULE') throw error;
    ruleDocumentValid = false;
  }
  const rules = JSON.stringify(admissionRules);
  const version = digest([document.hash, bindings]);
  const desktopVersion = digest(['desktop-admission-rules', rules]);
  const legacyDesktopVersions = ruleDocumentValid
    ? (await desktopDocumentHashes(store.documents, document, rules)).map(hash => digest(['desktop', hash, bindings])) : [];
  const channel = threadId ? store.orchestration.getThread(threadId)?.source?.type : 'feishu';
  const selected = connections.find(row => row.channel === channel) || connection;
  const enabled = new Set(selected.config.enabledRuleIds || []);
  const writtenRules = admissionRules.filter(rule => enabled.has(rule.id));
  return { version, desktopVersion, legacyDesktopVersions, desktopDelegationVersion: desktopOwnerDelegationVersion, ruleDocumentValid,
    ruleVersions: Object.fromEntries(admissionRules.map(rule => [rule.id, digest(rule.instruction)])),
    connections: Object.fromEntries(connections.map(row => [row.channel, { ...row, enabledRuleIds: admissionRules.filter(rule => (row.config.enabledRuleIds || []).includes(rule.id)).map(rule => rule.id) }])), projects, model: roleModels(undefined, config, 'router')[0], models: roleModels(undefined, config, 'router'), workerHarness: config.workerHarness, workerModels: config.workerModels, routingConfig: { revision: config.revision, auxiliary: config.auxiliary, models: config.models, workerHarness: config.workerHarness, workerModels: config.workerModels }, rules: document.content + '\nEnabled admission rules (exact IDs):\n' + JSON.stringify(writtenRules), connection: connection.config, mode: selected.config.admissionMode || 'manual', enabledRuleIds: writtenRules.map(rule => rule.id) };
}

/** Admission records a trusted instruction; it does not preapprove controlled actions. */
export function authorizeAssessment({ policy, candidate, trigger, decision, task }) {
  const channel = trigger.source?.channel || 'feishu';
  const config = channel === 'feishu' ? policy.connection : policy.connections?.[channel]?.config;
  if (!config && !isScheduledTrigger(trigger)) return { allowed: false, reason: 'unknown-channel' };
  if (decision.outcome === 'ignore') return { allowed: true, reason: 'read-only-ignore' };
  // Resolve remote projects in the target's catalog after source admission.
  const remote = decision.outcome === 'accept' && typeof decision.deviceId === 'string' && !!decision.deviceId && decision.deviceId !== 'local';
  if (isScheduledTrigger(trigger)) {
    if (policy.ruleDocumentValid === false || candidate.gate.strength !== 'explicit' || !desktopPolicyMatches(policy, candidate.gate.evidence?.desktopPolicyVersion)) return { allowed: false, reason: 'schedule-policy-changed' };
    const project = remote || decision.projectId === undefined ? undefined : policy.projects?.find(item => item.id === decision.projectId);
    if (!remote && decision.projectId !== undefined && !project) return { allowed: false, reason: 'unknown-project' };
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
  if (['attach', 'stop', 'revise', 'adjustment'].includes(decision.outcome) && !decision.taskId) return { allowed: false, reason: 'missing-task' };
  if (admission.routerAttention) return admission;
  if (['attach', 'stop', 'revise', 'adjustment'].includes(decision.outcome)
    && (!task || task.mandate?.actorId !== trigger.actor.id || !['channel', 'connectionId', 'conversationId'].every(key => typeof trigger.source[key] === 'string' && !!trigger.source[key] && task.mandate.source?.[key] === trigger.source[key]))) return { allowed: false, reason: 'task-source-ownership-mismatch' };
  const previous = ['revise', 'adjustment'].includes(decision.outcome) && task?.mandate?.execution ? task.mandate : null;
  if (previous && decision.projectId !== undefined && decision.projectId !== previous.project?.id)
    return { allowed: false, reason: 'execution-project-immutable' };
  const project = remote || previous || decision.projectId === undefined ? undefined : policy.projects?.find(item => item.id === decision.projectId);
  if (!remote && !previous && decision.projectId !== undefined && !project) return { allowed: false, reason: 'unknown-project' };
  return { allowed: true, reason: admission.reason, mandate: {
    ...admission.mandate,
    ...(admission.mandate.ruleIds && policy.ruleVersions ? { ruleVersions: admission.mandate.ruleIds.map(id => policy.ruleVersions[id]) } : {}),
    actorId: trigger.actor.id, source: trigger.source, instruction: trigger.content,
    controlledActions: 'require-current-policy-and-harness-approval',
    ...(project ? { project: { id: project.id, path: project.path } } : {}),
    ...(previous ? { execution: previous.execution, ...(previous.project ? { project: previous.project } : {}),
      ...(previous.scope ? { scope: previous.scope } : {}) } : {}),
  } };
}

/** Current disk rules may revoke an immutable admission; they never broaden it. */
export function validateTaskMandate(mandate, { policy }) {
  if (!mandate || !policy) return false;
  const desktop = mandate.source?.channel === 'desktop';
  // A peer never grants business authority or creates a second Task.
  if (mandate.source?.channel === 'link') return false;
  // Desktop mandates pin the desktop policy version; channel mandates are revalidated
  // against their own adapter's current policy.
  const scheduled = mandate.admission === 'desktop-schedule';
  if (desktop && !scheduled && !(typeof mandate.policyVersion === 'string' && !!mandate.policyVersion
    && (mandate.policyVersion === desktopDelegationVersion(policy) || desktopPolicyMatches(policy, mandate.policyVersion)))) return false;
  // Remote execution is not tied to the desktop conversation: any source admitted below may use a paired device.
  if (mandate.execution) {
    const { deviceId, hostId, authorizationId, config, protocolVersion } = mandate.execution;
    if ([deviceId, hostId, authorizationId].some(value => typeof value !== 'string' || !value)
      || deviceId === 'local' || protocolVersion !== 2 || !['official', 'codex', 'claude'].includes(config?.harness)
      || !Array.isArray(config.models) || config.models.length !== 1
      || config.models.some(model => typeof model?.providerId !== 'string' || !model.providerId || typeof model?.modelId !== 'string' || !model.modelId)
      || mandate.project && (mandate.project.deviceId !== deviceId || mandate.project.hostId !== hostId
        || typeof mandate.project.id !== 'string' || !mandate.project.id || typeof mandate.project.path !== 'string' || !mandate.project.path)) return false;
  } else if (mandate.project && (!policy.projects?.some(project => project.id === mandate.project.id && project.path === mandate.project.path)
    || mandate.project.deviceId && mandate.project.deviceId !== 'local')) return false;
  const source = mandate.source;
  if (scheduled) return isScheduledTrigger({ actor: { id: mandate.actorId, kind: mandate.actorKind }, source })
    && policy.ruleDocumentValid !== false && typeof mandate.policyVersion === 'string' && !!mandate.policyVersion
    && desktopPolicyMatches(policy, mandate.desktopPolicyVersion)
    && (policy.desktopDelegationVersion || mandate.policyVersion === policy.version)
    && mandate.controlledActions === 'require-current-policy-and-harness-approval';
  if (desktop) return typeof mandate.actorId === 'string' && !!mandate.actorId && mandate.admission === 'desktop-approved-delegation'
    && typeof source.sessionId === 'string' && !!source.sessionId && typeof source.messageId === 'string' && !!source.messageId
    && mandate.controlledActions === 'require-current-policy-and-harness-approval';
  if (mandate.admission === 'enabled-rules' && mandate.ruleVersions !== undefined
    && (!Array.isArray(mandate.ruleIds) || !Array.isArray(mandate.ruleVersions) || mandate.ruleIds.length !== mandate.ruleVersions.length
      || !mandate.ruleIds.every((id, i) => Object.hasOwn(policy.ruleVersions || {}, id) && policy.ruleVersions[id] === mandate.ruleVersions[i]))) return false;
  return validateChannelMandate(mandate, policy);
}
