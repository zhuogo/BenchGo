import { createHash } from 'node:crypto';
import { createMemoryUpkeepProcessor, prepareDailyDream } from './maintenance-memory-upkeep.mjs';
import { validateOwnedSkill } from './owned-skills.mjs';
import { MAINTENANCE_TASKS, runMaintenanceReview } from './maintenance-review.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error(`${label}无效`);
  return value.trim();
};
const array = (value, max, label) => { if (!Array.isArray(value) || value.length > max) throw new Error(`${label}无效`); return value; };
const ref = source => { const { excerpt, excerptTruncated, ...value } = source || {}; return value; };
const realSource = source => object(source) && !!(source.messageId || source.eventId || source.taskId || source.callId);
const markdown = value => value.replace(/[\r\n]+/gu, ' ').replace(/[<>\[\]]/gu, '');
const sections = [['whenToUse', 'When to Use'], ['procedure', 'Procedure'], ['pitfalls', 'Pitfalls'], ['verification', 'Verification']];
const sourceIds = (value, sources) => {
  array(value, 8, '来源引用');
  if (!value.length || new Set(value).size !== value.length) throw new Error('来源引用为空或重复');
  return value.map(id => { const found = sources.find(source => source.id === id); if (!found) throw new Error('来源引用不存在'); return found; });
};
const citation = sources => [...new Set(sources.map(row => row.memoryIds?.length ? row.memoryIds.map(id => `[[memory:${id}]]`).join(' ')
  : `[source:${row.source?.messageId || row.source?.eventId || row.source?.taskId || row.source?.callId || row.id}]`))].join(' ');
const sourceBinding = (sources, task, reviewId) => ({ role: 'assistant', type: 'maintenance', task, reviewId,
  references: [...new Map(sources.filter(row => realSource(row.source)).map(row => [JSON.stringify(ref(row.source)), ref(row.source)])).values()] });
const memoryIds = sources => [...new Set(sources.flatMap(row => row.memoryIds || []))];
const receipt = value => value && ({ ...(value.id ? { id: value.id } : {}), ...(value.document ? { document: value.document } : {}),
  ...(value.status ? { status: value.status } : {}), ...(value.revision ? { revision: value.revision } : {}) });
const readOptionalDocument = async (store, name) => {
  try { return await (store.memory.readDocument ? store.memory.readDocument(name) : store.documents?.read?.(name)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
async function existingRelationshipEntries(store) {
  const result = [];
  for (const row of await store.documents?.list?.({ recursive: true }) || []) {
    const match = /^memory\/(people|groups)\/(entity-[a-f0-9]{24})\.md$/u.exec(row.name);
    if (!match) continue;
    const visible = await readOptionalDocument(store, row.name);
    if (!visible?.content?.trim()) continue;
    const marker = /<!-- benchgo-derived (\{[^\n]*\}) -->/u.exec(visible.content), name = /^# (.+)$/mu.exec(visible.content)?.[1];
    if (!marker || !name) continue;
    let provenance;
    try { provenance = JSON.parse(marker[1]); } catch { throw new Error('既有关系对象来源损坏'); }
    if (!Array.isArray(provenance.memoryIds) || !Array.isArray(provenance.source?.references || [])) throw new Error('既有关系对象来源损坏');
    const ids = provenance.memoryIds.map(value => value?.id), refs = provenance.source?.references || [];
    if (ids.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('既有关系对象来源损坏');
    if (!ids.length && !refs.some(realSource)) continue;
    const evidence = refs.filter(realSource).map((source, index) => ({ id: `existing:${match[2]}:${index}`, memoryIds: ids, source }));
    if (!evidence.length) evidence.push({ id: `existing:${match[2]}`, memoryIds: ids, source: {} });
    const summary = visible.content.replace(marker[0], '').replace(/^\s*# [^\n]+\n/u, '').replace(/\n\n来源：[\s\S]*$/u, '').trim().slice(0, 600);
    result.push({ type: match[1], id: match[2], key: provenance.source?.entityKey || name, name, summary, evidence });
  }
  return result;
}

/** Lightweight task dispatch, sharing one bounded review executor and the existing review worker. */
export function createMaintenanceProcessor({ ctx, store, readSources, now = () => new Date() }) {
  const learning = createMemoryUpkeepProcessor({ ctx, store, readSources, now });
  return async function process(item, { signal } = {}) {
    const task = item?.payload?.task || (MAINTENANCE_TASKS.includes(item?.kind) ? item.kind : 'memory-upkeep');
    if (!MAINTENANCE_TASKS.includes(task)) throw new Error('未知自我迭代任务');
    if (task === 'memory-upkeep') return learning(item, { signal });
    signal?.throwIfAborted();
    const settings = await store.memory.learning();
    if (!settings.enabled) return { status: 'rejected', reason: '学习已停用', modelUsed: false };
    let revision = await store.memory.contextRevision?.();
    const excluded = value => (settings.excludedTerms || []).some(term => value.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
    const rows = [], context = {};
    let existingRelationships = [];
    const add = row => {
      if (rows.length >= 40 || !realSource(row.source) && !row.memoryIds?.length || !row.text?.trim()
        || row.kind !== 'memory' && (settings.excludedScopes || []).includes('personal')
        || excluded(row.text) || (settings.excludedScopes || []).includes(row.scope || 'personal') || rows.some(value => value.id === row.id)) return;
      rows.push({ ...row, text: row.text.slice(0, 2000) });
    };
    const batch = await store.learning?.takeSources?.({ task, limit: 20, maxChars: 24000, signal, readSources, batchKey: item?.id });
    for (const row of batch?.items || []) {
      const user = row.source?.role === 'user', feedback = task === 'dreaming' && row.kind === 'feedback' && row.source?.role === 'assistant';
      if ((!user && !feedback) || !(row.source.messageId || row.source.eventId)) continue;
      const content = row.text ?? row.content;
      if (typeof content !== 'string') continue;
      add({ id: row.id || row.source.messageId || row.source.eventId, kind: feedback ? 'feedback' : 'user', text: content, source: row.source, scope: row.scope, memoryIds: [] });
    }
    if (task === 'skill-review') {
      rows.length = 0; // Skill feedback is its sole evidence; arbitrary conversation is not a use event.
      for (const skill of await store.ownedSkills?.reviewInputs?.({ limit: 8 }) || []) {
        if (skill.pinned || skill.fixed || skill.status === 'archived') continue;
        const feedback = (skill.feedback || []).filter(row => row.outcome === 'success' || row.outcome === 'failure' || row.outcome === 'unknown');
        for (const entry of feedback) add({ id: `skill:${skill.id}:${skill.revision}:${entry.eventId || entry.id}`, kind: 'skill-feedback',
          text: entry.text, source: entry.source, memoryIds: [], outcome: entry.outcome, skillId: skill.id, skillRevision: skill.revision });
        if (feedback.length) (context.skills ||= []).push({ id: skill.id, name: skill.name, revision: skill.revision, description: skill.description, content: skill.content?.slice(0, 10000) });
      }
    } else {
      const allMemories = await store.memory.list?.() || [], recent = allMemories.slice(-30);
      if (task === 'relationships') {
        existingRelationships = await existingRelationshipEntries(store);
        const visibleText = [...rows.map(row => row.text), ...recent.map(row => row.content)].join('\n');
        const relevant = existingRelationships.filter(row => visibleText.includes(row.name)).slice(0, 8);
        // Old navigation is context only; its original still-current memories are evidence.
        for (const entity of relevant) for (const id of memoryIds(entity.evidence)) {
          const entry = allMemories.find(row => row.id === id);
          if (entry && entry.category !== 'reflections') add({ id: `memory:${entry.id}`, kind: 'memory', text: entry.content, source: entry.source,
            scope: entry.scope, memoryIds: [entry.id], category: entry.category || 'world' });
        }
        context.existingEntities = relevant.map(row => ({ type: row.type, key: row.key, name: row.name, summary: row.summary, navigationOnly: true,
          sourceIds: memoryIds(row.evidence).map(id => `memory:${id}`).filter(id => rows.some(row => row.id === id)) }));
      }
      for (const entry of recent) {
        if (entry.category === 'reflections') continue;
        add({ id: `memory:${entry.id}`, kind: 'memory', text: entry.content, source: entry.source,
          scope: entry.scope, memoryIds: [entry.id], category: entry.category || 'world' });
      }
    }
    if (task === 'idea-curation') {
      context.existingIdeas = (await store.ideas?.list?.({ limit: 30 }) || []).map(row => ({ id: row.id, title: row.title, content: row.content }));
      const preferences = await readOptionalDocument(store, 'PROACTIVE_PREFERENCES.md');
      context.proactivePreferences = typeof preferences === 'string' ? preferences.slice(0, 5000) : preferences?.content?.slice(0, 5000) || '';
    }
    if (task === 'dreaming') {
      const alignment = await readOptionalDocument(store, 'dreams/alignment/ALIGNMENT_SYNTHESIS.md');
      if (alignment) context.existingAlignment = (typeof alignment === 'string' ? alignment : alignment.content || '').slice(0, 3000);
    }
    let remaining = 28000;
    const sources = rows.filter(row => { if (remaining <= 0) return false; row.text = row.text.slice(0, remaining); remaining -= row.text.length; return true; });
    for (const entity of context.existingEntities || []) entity.sourceIds = entity.sourceIds.filter(id => sources.some(row => row.id === id));
    const complete = () => { signal?.throwIfAborted(); return { ...(batch?.batchId ? { watermark: store.learning.completeSources(batch.batchId) } : {}), hasMore: batch?.hasMore === true }; };
    if (!sources.length) return { status: 'completed', reason: '没有可整理的新材料', modelUsed: false, ...complete() };
    const stateFingerprint = hash(JSON.stringify({ task, policy: settings.hash, sources: task === 'skill-review' ? sources : sources.filter(row => row.kind === 'memory'),
      ...(task === 'idea-curation' ? { preferences: context.proactivePreferences } : {}), ...(task === 'skill-review' ? { skills: context.skills } : {}) }));
    if ((task === 'skill-review' || !sources.some(row => row.kind === 'user' || row.kind === 'feedback'))
      && await store.learning?.getTaskFingerprint?.(task) === stateFingerprint) return { status: 'completed', task, reason: '事实材料未变化', modelUsed: false, ...complete() };
    const checkPolicy = async () => {
      signal?.throwIfAborted();
      const latest = await store.memory.learning();
      await store.memory.list?.();
      if (!latest.enabled || latest.hash !== settings.hash || JSON.stringify(await store.memory.contextRevision?.()) !== JSON.stringify(revision)) throw new Error('学习规则或来源已变更，请重新整理');
    };
    const material = sources.map(({ source, ...row }) => ({ ...row, source: ref(source) }));
    revision = await store.memory.contextRevision?.();
    const validate = value => {
      if (!object(value)) throw new Error('自我迭代输出无效');
      if (task === 'relationships') array(value.entities, 8, '关系视图');
      else if (task === 'dreaming') { array(value.reflections, 5, '反思'); array(value.alignment, 5, '对齐建议'); }
      else if (task === 'skill-review') array(value.skills, 2, '技能候选');
      else array(value.ideas, 5, '想法候选');
    };
    const { parsed, routing } = await runMaintenanceReview({ ctx, store, task, material, signal, context, validate });
    const reviewId = batch?.batchId || item?.id || hash(JSON.stringify(material));
    const writes = [];
    // Validate every output and evidence before the first mutation.
    if (task === 'relationships') {
      const entities = parsed.entities.map(value => {
        if (!['people', 'groups'].includes(value?.type)) throw new Error('关系视图类型无效');
        const key = text(value.key, 100, '关系对象标识'), name = text(value.name, 100, '关系对象名称'), summary = text(value.summary, 600, '关系摘要');
        const supplied = sourceIds(value.sourceIds, sources), id = `entity-${hash(`${value.type}:${key.normalize('NFKC').toLocaleLowerCase()}`).slice(0, 24)}`;
        const previous = existingRelationships.find(row => row.type === value.type && row.id === id);
        const evidence = [...new Map([...supplied, ...(previous?.evidence || [])].map(row => [JSON.stringify([row.source, row.memoryIds]), row])).values()];
        return { type: value.type, id, key, name, summary, evidence };
      });
      if (new Set(entities.map(row => `${row.type}/${row.id}`)).size !== entities.length) throw new Error('关系对象重复');
      for (const entity of entities) writes.push({ document: `memory/${entity.type}/${entity.id}.md`,
        content: `# ${markdown(entity.name)}\n\n${entity.summary}\n\n来源：${citation(entity.evidence)}\n`, memoryIds: memoryIds(entity.evidence),
        source: { ...sourceBinding(entity.evidence, task, reviewId), entityKey: entity.key } });
      for (const type of ['people', 'groups']) {
        const group = entities.filter(row => row.type === type);
        if (!group.length) continue;
        const merged = [...new Map([...existingRelationships.filter(row => row.type === type), ...group].map(row => [row.id, row])).values()];
        const evidence = merged.flatMap(row => row.evidence);
        writes.push({ document: `memory/${type}/INDEX.md`, content: `# ${type === 'people' ? '人物' : '群体'}索引\n\n${merged.map(row => `- [${markdown(row.name)}](${row.id}.md) — ${markdown(row.summary || '').slice(0, 100)} — ${citation(row.evidence)}`).join('\n')}\n`,
          memoryIds: memoryIds(evidence), source: sourceBinding(evidence, task, reviewId) });
      }
    } else if (task === 'dreaming') {
      const reflections = parsed.reflections.map(value => ({ content: text(value?.content, 600, '反思内容'), evidence: sourceIds(value.sourceIds, sources) }));
      const alignment = parsed.alignment.map(value => ({ content: text(value?.content, 300, '对齐内容'), evidence: sourceIds(value.sourceIds, sources) }));
      for (const [entries, document, heading] of [[reflections, `dreams/${new Date(now()).toISOString().slice(0, 10)}.md`, '助手反思'],
        [alignment, 'dreams/alignment/ALIGNMENT_SYNTHESIS.md', '协作对齐']]) {
        if (!entries.length) continue;
        const evidence = entries.flatMap(row => row.evidence);
        const input = { document, content: `# ${heading}\n\n${entries.map(row => `- ${row.content}\n  来源：${citation(row.evidence)}`).join('\n\n')}\n`,
          memoryIds: memoryIds(evidence), source: sourceBinding(evidence, task, reviewId) };
        writes.push(heading === '助手反思' ? await prepareDailyDream({ store, input }) : input);
      }
    } else if (task === 'skill-review') {
      for (const value of parsed.skills) {
        const evidence = sourceIds(value?.sourceIds, sources), skill = context.skills?.find(row => row.id === value.skillId && row.revision === value.skillRevision);
        if (!skill || value.name !== skill.name || evidence.some(row => row.skillId !== skill.id || row.skillRevision !== skill.revision)
          || !evidence.some(row => row.outcome === 'success')) throw new Error('技能候选缺少同版本成功反馈');
        const name = text(value.name, 100, '技能名称'), description = text(value.description, 500, '技能说明');
        const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${sections.map(([key, heading]) => `## ${heading}\n\n${text(value[key], 3000, '学习技能字段')}`).join('\n\n')}\n`;
        if (excluded(content)) throw new Error('技能候选包含排除内容');
        const input = { name, description, content, idempotencyKey: `skill-review:${hash(`${reviewId}:${skill.id}:${skill.revision}`)}`,
          source: { ...sourceBinding(evidence, task, reviewId), skillId: skill.id, skillRevision: skill.revision } };
        validateOwnedSkill(input); writes.push(input);
      }
    } else {
      for (const [index, value] of parsed.ideas.entries()) {
        const evidence = sourceIds(value?.sourceIds, sources), title = text(value.title, 120, '想法标题'), content = text(value.content, 1200, '想法说明');
        if (!Number.isSafeInteger(value.expiresInDays) || value.expiresInDays < 1 || value.expiresInDays > 30 || excluded(`${title}\n${content}`)) throw new Error('想法期限或内容无效');
        writes.push({ title, content, memoryIds: memoryIds(evidence), source: sourceBinding(evidence, task, reviewId),
          expiresAt: new Date(new Date(now()).getTime() + value.expiresInDays * 86400000).toISOString(), idempotencyKey: `idea-review:${reviewId}:${index}` });
      }
    }
    if (writes.some(row => excluded(row.content))) throw new Error('自我迭代输出包含排除内容');
    if (writes.some(row => row.content.length > 16000 || row.memoryIds?.length > 100 || row.memoryIds?.some(id => typeof id !== 'string' || !id || id.length > 200)
      || JSON.stringify(row.source).length > 16000)) throw new Error('自我迭代派生内容超过预算');
    await checkPolicy();
    const results = [];
    for (const input of writes) {
      await checkPolicy();
      if (task === 'skill-review') results.push(receipt(await store.ownedSkills.propose(input)));
      else if (task === 'idea-curation') results.push(receipt(await store.ideas.propose(input)));
      else results.push(receipt(await store.memory.writeDerived(input)));
      revision = await store.memory.contextRevision?.();
    }
    await checkPolicy();
    await store.learning?.setTaskFingerprint?.(task, stateFingerprint);
    return { status: 'completed', task, results, routing, modelUsed: true, sourceIds: sources.map(row => row.id), ...complete() };
  };
}
