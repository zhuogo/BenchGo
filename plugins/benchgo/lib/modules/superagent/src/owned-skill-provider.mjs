// Official Harness SkillProvider contract (pinned engine 5719020). Bodies stay
// in the assistant store; no duplicate filesystem installation is created.
import { createHash } from 'node:crypto';

export const OWNED_SKILL_PROVIDER = 'benchgo-superagent';
const visible = row => row && ['active', 'stale'].includes(row.state);
const nameOf = row => row.source?.skillName || `benchgo-${row.id}`;
const summary = row => ({
  name: nameOf(row), description: row.source?.description || `BenchGo reusable procedure: ${row.id}`,
  source: 'benchgo-owned', provider: OWNED_SKILL_PROVIDER,
  invocation: { modelInvocable: true, userInvocable: true },
  resourceBase: { kind: 'opaque', description: 'BenchGo managed skill; no filesystem resources.' },
});

export function registerOwnedSkillProvider({ skills, database, ctx }) {
  if (typeof skills?.registerProvider !== 'function') throw new Error('Harness skills provider service unavailable');
  let control, disposed = false;
  const loaded = new WeakMap();
  const release = skills.registerProvider(lifecycle => {
    control = lifecycle;
    const check = options => { lifecycle.signal.throwIfAborted(); options?.signal?.throwIfAborted(); };
    return {
      name: OWNED_SKILL_PROVIDER,
      async list(options) {
        check(options);
        return database.listOwnedSkills().filter(row => visible(row) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(nameOf(row)))
          .map(row => ({ ...summary(row), rank: 700, locator: { id: row.id, hash: row.hash } }));
      },
      async get(candidate, options) {
        check(options);
        if (candidate.provider !== OWNED_SKILL_PROVIDER || typeof candidate.locator?.id !== 'string') return undefined;
        const row = database.getOwnedSkill(candidate.locator.id);
        if (!visible(row) || nameOf(row) !== candidate.name || row.hash !== candidate.locator.hash) {
          lifecycle.invalidate(); return undefined;
        }
        // Discovery and UI preview are reads, not evidence of actual use.
        const session = options?.scope?.session;
        if (session && loaded.has(session)) loaded.get(session).set(candidate.name, { id: row.id, hash: row.hash });
        return { ...summary(row), content: row.body };
      },
    };
  });
  const adapter = {
    invalidate() { if (!disposed) control.invalidate(); },
    // Call only after a successful official skill tool result or confirmed
    // user-invocation injection, with its durable event identity.
    recordUse({ name, provider, eventId, now } = {}) {
      if (disposed || provider !== OWNED_SKILL_PROVIDER || typeof name !== 'string') return false;
      const row = database.listOwnedSkills().find(row => nameOf(row) === name);
      if (!visible(row) || nameOf(row) !== name) return false;
      database.recordOwnedSkillUse(row.id, { eventId, ...(now === undefined ? {} : { now }) });
      control.invalidate(); return true;
    },
    dispose() { if (disposed) return; disposed = true; stopUsage?.(); stopStep?.(); stopInjection?.(); release(); },
  };
  // Only a provider load in the current official step can authenticate an
  // invocation injection. A catalog preview or same-name foreign skill cannot.
  const stopStep = ctx?.on('agent/pre-step', ({ agent }, next) => {
    loaded.set(agent.session, new Map());
    return next();
  });
  const stopInjection = ctx?.on('session/event', (session, event) => {
    const message = event.type === 'user/message' && event.data;
    if (disposed || message?.source?.kind !== 'skill-invocation' || typeof message.id !== 'string') return;
    const proof = loaded.get(session)?.get(message.source.name);
    const row = proof && database.getOwnedSkill(proof.id);
    if (!visible(row) || row.hash !== proof.hash || nameOf(row) !== message.source.name) return;
    const text = message.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (!text?.includes(`<skill_instructions>\n${row.body}\n</skill_instructions>`)) return;
    const eventId = 'skill-invocation:' + createHash('sha256').update(JSON.stringify([session.id, message.id])).digest('hex');
    try { adapter.recordUse({ name: message.source.name, provider: OWNED_SKILL_PROVIDER, eventId }); }
    catch (error) { ctx.logger?.warn?.(`技能使用记录失败：${error.message}`); }
  });
  // The official final-result observer runs after denial, output validation,
  // post-execution policy and cancellation. Catalog/get reads never count.
  // Session + call identity also works for native and PTC nested dispatches.
  const stopUsage = ctx?.on('tools/result', (exec, result) => {
    if (disposed || exec.name !== 'skill' || result.isError !== false) return;
    const value = result.value, sessionId = exec.agent?.session?.id;
    if (typeof sessionId !== 'string' || !sessionId || typeof exec.callId !== 'string' || !exec.callId
      || !value || value.provider !== OWNED_SKILL_PROVIDER || value.name !== exec.arguments?.name
      || typeof value.content !== 'string') return;
    const row = database.listOwnedSkills().find(row => nameOf(row) === value.name);
    if (!row || row.body !== value.content) return;
    const eventId = 'skill-tool:' + createHash('sha256').update(JSON.stringify([sessionId, exec.callId])).digest('hex');
    try { adapter.recordUse({ name: value.name, provider: value.provider, eventId }); }
    catch (error) { ctx.logger?.warn?.(`技能使用记录失败：${error.message}`); }
  });
  return adapter;
}
