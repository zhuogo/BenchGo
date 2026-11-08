import { roleModels } from './routing.mjs';
import { readAdmissionRules } from './admission-rules.mjs';
import { createHash } from 'node:crypto';
import { isScheduledTrigger } from './schedule-bridge.mjs';
import { channelSourceAllowed, connectionPolicy } from './channel-policy.mjs';

export async function readAssessmentPolicy(store, workspaceRegistry, threadId) {
  const connection = store.connections.read();
  const [config, document] = await Promise.all([store.getConfig(), store.documents.read('AGENTS.md')]);
  // Display/model/concurrency edits are not permission revisions. Only trusted
  // channel authority and current disk rules invalidate an existing Mandate.
  const projects = (workspaceRegistry?.list() || []).map(({ id, path, title }) => ({ id, path, title }));
  const bindings = projects.map(({ id, path }) => [id, path]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const connections = store.connections.list?.() || [{ channel: 'feishu', ...connection }];
  const version = createHash('sha256').update(JSON.stringify([connections.map(row => [row.channel, row.revision]), document.hash, bindings])).digest('hex');
  const desktopVersion = createHash('sha256').update(JSON.stringify(['desktop', document.hash, bindings])).digest('hex');
  const channel = threadId ? store.orchestration?.getThread(threadId)?.source?.type : 'feishu';
  const selected = connections.find(row => row.channel === channel) || connection;
  const enabled = new Set(selected.config.enabledRuleIds || []);
  const writtenRules = readAdmissionRules(document.content).filter(rule => enabled.has(rule.id));
  return { version, desktopVersion, connections: Object.fromEntries(connections.map(row => [row.channel, { ...row, enabledRuleIds: readAdmissionRules(document.content).filter(rule => (row.config.enabledRuleIds || []).includes(rule.id)).map(rule => rule.id) }])), projects, model: roleModels(undefined, config, 'router')[0], models: roleModels(undefined, config, 'router'), workerModels: roleModels(undefined, config, 'worker'), routingConfig: { revision: config.revision, auxiliary: config.auxiliary, models: config.models, workerModels: config.workerModels }, rules: document.content + '\nEnabled admission rules (exact IDs):\n' + JSON.stringify(writtenRules), connection: connection.config, mode: selected.config.admissionMode || 'manual', enabledRuleIds: writtenRules.map(rule => rule.id) };
}

/** Admission records an owner's instruction; it does not preapprove controlled actions. */
export function authorizeAssessment({ policy, candidate, trigger, decision, ticket }) {
  const channel = trigger.source?.channel || 'feishu';
  const config = channel === 'feishu' ? policy.connection : policy.connections?.[channel]?.config;
  if (!config && !isScheduledTrigger(trigger)) return { allowed: false, reason: 'unknown-channel' };
  if (decision.outcome === 'ignore') return { allowed: true, reason: 'read-only-ignore' };
  if (isScheduledTrigger(trigger)) {
    if (candidate.gate.strength !== 'explicit' || candidate.gate.evidence?.desktopPolicyVersion !== policy.desktopVersion) return { allowed: false, reason: 'schedule-policy-changed' };
    const project = decision.projectId === undefined ? undefined : policy.projects?.find(item => item.id === decision.projectId);
    if (decision.projectId !== undefined && !project) return { allowed: false, reason: 'unknown-project' };
    if (decision.outcome === 'answer') return { allowed: true, reason: 'scheduled-notification' };
    if (decision.outcome !== 'accept') return { allowed: false, reason: 'schedule-requires-new-ticket' };
    return { allowed: true, reason: 'owned-harness-schedule', mandate: {
      admission: 'desktop-schedule', actorId: 'harness-schedule', actorKind: 'machine', source: trigger.source,
      instruction: trigger.content, desktopPolicyVersion: policy.desktopVersion,
      controlledActions: 'require-current-policy-and-harness-approval',
      ...(project ? { project: { id: project.id, path: project.path } } : {}),
    } };
  }
  if (!['direct', 'group', 'topic', 'system'].includes(trigger.source?.sourceType)) return { allowed: false, reason: 'source-evidence-expired-recollect-required' };
  if (decision.outcome === 'accept' && trigger.source.sourceType === 'group' && trigger.source.mentioned !== true) return { allowed: false, reason: 'group-new-task-requires-mention' };
  const channelAllowed = channelScope(config, trigger.source, policy.connections?.[channel]);
  const platformHuman = connectionPolicy({ config }).allowHumanRequests && trigger.actor.kind === 'human';
  const explicit = trigger.actor.kind === 'human' && (platformHuman || (config.ownerOpenIds || config.ownerIds || []).includes(trigger.actor.id)) && candidate.gate.strength === 'explicit';
  const inferred = trigger.actor.kind === 'machine' && (config.machineOpenIds || config.machineIds || []).includes(trigger.actor.id)
    && candidate.gate.strength === 'inferred' && decision.outcome === 'accept' && (channel === 'feishu' ? policy.mode : config.admissionMode) === 'auto'
    && validRuleReferences(decision.ruleIds, channel === 'feishu' ? policy.enabledRuleIds : policy.connections?.[channel]?.enabledRuleIds);
  const machineAttention = decision.outcome === 'stop' && trigger.source.sourceType !== 'direct'
    && trigger.actor.kind === 'machine' && (config.machineOpenIds || config.machineIds || []).includes(trigger.actor.id)
    && candidate.gate.allowed === true && candidate.gate.strength === 'inferred' && candidate.gate.evidence?.sourceVerified === true;
  if (!channelAllowed || candidate.gate.allowed === false || (!explicit && !inferred && !machineAttention)) return { allowed: false, reason: 'current-channel-actor-or-rule-denied' };
  if (['answer', 'ask'].includes(decision.outcome)) {
    if (!explicit || decision.ticketId !== undefined) return { allowed: false, reason: 'direct-reply-requires-explicit-human-source' };
    return { allowed: true, reason: 'authenticated-direct-reply' };
  }
  const project = decision.projectId === undefined ? undefined : policy.projects?.find(item => item.id === decision.projectId);
  if (decision.projectId !== undefined && !project) return { allowed: false, reason: 'unknown-project' };
  if (['attach', 'stop', 'revise', 'adjustment'].includes(decision.outcome) && !decision.ticketId) return { allowed: false, reason: 'missing-ticket' };
  const evidence = candidate.gate.evidence;
  const owner = evidence?.sourceVerified === true && evidence.ownerVerified === true && ['sourceType', 'connectionId', 'conversationId'].every(key => evidence[key] === trigger.source[key]) && trigger.actor.kind === 'human' && (config.ownerOpenIds || config.ownerIds || []).includes(trigger.actor.id);
  if (decision.outcome === 'stop' && trigger.source.sourceType !== 'direct') return { allowed: true, outcome: 'attach', routerAttention: true, reason: 'non-direct-stop-router-attention' };
  if (decision.outcome === 'stop' && !owner) return { allowed: false, reason: 'stop-requires-verified-direct-owner' };
  if (['attach', 'stop', 'revise', 'adjustment'].includes(decision.outcome)
    && (!ticket || ticket.mandate?.actorId !== trigger.actor.id || !['channel', 'connectionId', 'conversationId'].every(key => typeof trigger.source[key] === 'string' && !!trigger.source[key] && ticket.mandate.source?.[key] === trigger.source[key]))) return { allowed: false, reason: 'ticket-source-ownership-mismatch' };
  return { allowed: true, reason: inferred ? 'enabled-written-rules' : platformHuman ? 'authenticated-platform-request' : 'authenticated-owner-instruction', mandate: {
    ...(inferred ? { admission: 'enabled-rules', strength: 'inferred', actorKind: 'machine', ruleIds: [...decision.ruleIds] } : {}),
    ...(platformHuman ? { admission: 'platform-request', actorKind: 'human' } : {}),
    actorId: trigger.actor.id, source: trigger.source, instruction: trigger.content,
    controlledActions: 'require-current-policy-and-harness-approval',
    ...(project ? { project: { id: project.id, path: project.path } } : {}),
  } };
}

/** Current disk rules may revoke an immutable admission; they never broaden it. */
export function validateTicketMandate(mandate, { policy }) {
  if (!mandate || !policy) return false;
  const desktop = mandate.source?.channel === 'desktop';
  if (mandate.admission === 'desktop-schedule') return isScheduledTrigger({ actor: { id: mandate.actorId, kind: mandate.actorKind }, source: mandate.source })
    && mandate.policyVersion === policy.version && mandate.desktopPolicyVersion === policy.desktopVersion
    && mandate.controlledActions === 'require-current-policy-and-harness-approval'
    && (!mandate.project || policy.projects?.some(project => project.id === mandate.project.id && project.path === mandate.project.path));
  if (mandate.policyVersion !== (desktop ? policy.desktopVersion : policy.version)) return false;
  if (mandate.project && !policy.projects?.some(project => project.id === mandate.project.id && project.path === mandate.project.path)) return false;
  const source = mandate.source, channel = source?.channel || 'feishu';
  const config = channel === 'feishu' ? policy.connection : policy.connections?.[channel]?.config;
  if (desktop) return mandate.actorId === 'desktop-owner' && mandate.admission === 'desktop-approved-delegation'
    && typeof source.sessionId === 'string' && !!source.sessionId && typeof source.messageId === 'string' && !!source.messageId
    && mandate.controlledActions === 'require-current-policy-and-harness-approval';
  return channelScope(config, source, policy.connections?.[channel])
    && (mandate.admission === 'enabled-rules'
      ? mandate.actorKind === 'machine' && mandate.strength === 'inferred' && (channel === 'feishu' ? policy.mode : config.admissionMode) === 'auto'
        && (config.machineOpenIds || config.machineIds || []).includes(mandate.actorId) && validRuleReferences(mandate.ruleIds, channel === 'feishu' ? policy.enabledRuleIds : policy.connections?.[channel]?.enabledRuleIds)
      : mandate.admission === 'platform-request'
        ? connectionPolicy({ config }).allowHumanRequests && mandate.actorKind === 'human'
        : (config.ownerOpenIds || config.ownerIds || []).includes(mandate.actorId))
    && mandate.controlledActions === 'require-current-policy-and-harness-approval';
}

function validRuleReferences(ruleIds, enabledRuleIds) {
  return Array.isArray(ruleIds) && ruleIds.length > 0 && new Set(ruleIds).size === ruleIds.length
    && Array.isArray(enabledRuleIds) && ruleIds.every(id => typeof id === 'string' && enabledRuleIds.includes(id));
}

function channelScope(config, source, row) {
  return !!config?.enabled && channelSourceAllowed(config, source, row);
}
