import { createHash } from 'node:crypto';
import { validateOwnedSkill } from './owned-skills.mjs';
import { runMaintenanceReview } from './maintenance-review.mjs';

const skillSections = [['whenToUse', 'When to Use'], ['procedure', 'Procedure'], ['pitfalls', 'Pitfalls'], ['verification', 'Verification']];
const slot = (batchId, kind, index) => `closed-learning:${batchId}:${kind}:${index}`;
const clipped = (value, length) => typeof value === 'string' ? value.slice(0, length) : '';
const receipt = ({ id, status, memoryId, revision }) => ({ ...(id ? { id } : {}), status,
  ...(memoryId ? { memoryId } : {}), ...(revision ? { revision } : {}) });
const categories = new Set(['world', 'experience', 'opinions', 'reflections']);
const failed = result => result?.success === false || ['failed', 'failure', 'error', 'waiting', 'cancelled'].includes(result?.outcome)
  || /未(?:能|完成|成功|通过)|失败|凭据失效|not (?:accomplished|completed|successful)|failed|failure|error\b/iu.test(result?.summary || '');
const succeeded = result => !failed(result) && (result?.success === true || /已完成|已通过|成功|completed|succeeded|passed/iu.test(result?.summary || ''));
const reference = ({ excerpt, excerptTruncated, ...source }) => source;

/** Keep a small sourced daily log; alignment remains a replaceable synthesis. */
export async function prepareDailyDream({ store, input }) {
  if (/<!--\s*benchgo-(?:dream-batch|derived)/u.test(input.content)) throw new Error('反思正文包含保留标识');
  let previous;
  try { previous = await (store.memory.readDocument ? store.memory.readDocument(input.document) : store.documents?.read?.(input.document)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const body = content => content.replace(/^# 助手反思\s*/u, '').trim();
  const blocks = [];
  const marker = /<!-- benchgo-derived (\{[^\n]*\}) -->/u.exec(previous?.content || '');
  if (marker) {
    let provenance;
    try { provenance = JSON.parse(marker[1]); } catch { throw new Error('既有反思来源损坏'); }
    const ids = (provenance.memoryIds || []).map(row => row.id), refs = provenance.source?.references || [];
    if (!Array.isArray(provenance.memoryIds) || !Array.isArray(refs) || ids.some(id => typeof id !== 'string')) throw new Error('既有反思来源损坏');
    const content = body(previous.content.replace(marker[0], '').trim());
    const records = [...content.matchAll(/<!-- benchgo-dream-batch (\{[^\n]*\}) -->\n([\s\S]*?)(?=\n<!-- benchgo-dream-batch |$)/gu)];
    if (!records.length && content) blocks.push({ content, memoryIds: ids, references: refs });
    for (const row of records) {
      let metadata;
      try { metadata = JSON.parse(row[1]); } catch { throw new Error('既有反思批次损坏'); }
      if (!Array.isArray(metadata.memoryIds) || !Array.isArray(metadata.references)
        || metadata.memoryIds.some(id => !ids.includes(id))
        || metadata.references.some(source => !refs.some(ref => JSON.stringify(ref) === JSON.stringify(source)))) throw new Error('既有反思批次来源损坏');
      blocks.push({ content: row[2].trim(), memoryIds: metadata.memoryIds, references: metadata.references });
    }
  }
  const current = { content: body(input.content), memoryIds: input.memoryIds || [], references: input.source.references || [] };
  const key = block => createHash('sha256').update(JSON.stringify(block)).digest('hex');
  const latest = [...blocks.filter(block => key(block) !== key(current)), current].slice(-6);
  let result;
  while (latest.length) {
    const memoryIds = [...new Set(latest.flatMap(block => block.memoryIds))];
    const references = [...new Map(latest.flatMap(block => block.references).map(source => [JSON.stringify(source), source])).values()];
    const source = { ...input.source, references };
    const content = `# 助手反思\n\n${latest.map(block => `<!-- benchgo-dream-batch ${JSON.stringify({ memoryIds: block.memoryIds, references: block.references }).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e')} -->\n${block.content}`).join('\n\n')}\n`;
    if (content.length <= 12000 && JSON.stringify(source).length <= 16000 && memoryIds.length <= 100) { result = { ...input, content, memoryIds, source }; break; }
    latest.shift();
  }
  if (!result) throw new Error('单次反思内容或来源超过预算');
  return result;
}

/** Background-only extraction. Router events are scheduling metadata, never material. */
export function createMemoryUpkeepProcessor({ ctx, store, readSources, now = () => new Date() }) {
  return async (item, { signal } = {}) => {
    const settings = await store.memory.learning();
    if (!settings.enabled) return { status: 'rejected', reason: '学习已停用', modelUsed: false };
    const database = store.orchestration;
    const batch = database?.learningSources?.({ limit: 5 }) ?? { batchId: null, items: [], hasMore: false };
    const observed = await store.learning?.takeSources?.({ task: 'memory-upkeep', limit: 20, maxChars: 24000, signal, readSources, batchKey: item?.id });
    const sources = [], digest = [];
    const excluded = text => (settings.excludedTerms || []).some(term => text.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
    const reviewId = observed?.batchId ? `${batch.batchId || 'conversation'}:${observed.batchId}` : batch.batchId;
    const complete = () => {
      signal?.throwIfAborted();
      return { watermark: database?.completeLearningSources?.(batch.batchId),
        ...(observed?.batchId ? { conversationWatermark: store.learning.completeSources(observed.batchId) } : {}),
        hasMore: !!(batch.hasMore || observed?.hasMore) };
    };
    for (const ticket of batch.items) {
      if (ticket.status !== 'completed' || !ticket.closedAt) throw new Error('学习材料不是明确已关工单');
      if ((settings.excludedScopes || []).includes('personal') || excluded(JSON.stringify(ticket))) continue;
      const originals = (ticket.instructions || []).filter(row => row.source?.role === 'user' && typeof row.text === 'string' && row.text.trim());
      const instructions = originals.length <= 3 ? originals : [originals[0], ...originals.slice(-2)];
      if (!instructions.length) continue;
      const result = ticket.result || {};
      const rows = instructions.map(row => ({ messageId: `${ticket.ticketId}:${row.id}`, text: row.text.slice(0, 6000),
        truncated: row.text.length > 6000, source: row.source, ticketId: ticket.ticketId, resultVersion: ticket.resultVersion,
        closedAt: ticket.closedAt, failed: failed(result), successful: succeeded(result) }));
      sources.push(...rows);
      digest.push({ ticketId: ticket.ticketId, resultVersion: ticket.resultVersion, status: ticket.status, closedAt: ticket.closedAt,
        instructions: rows.map(({ messageId, text, truncated }) => ({ messageId, text: text.slice(0, 2000), truncated: truncated || text.length > 2000 })),
        result: { summary: clipped(result.summary, 2000) } });
    }
    for (const row of observed?.items || []) {
      const text = row.text ?? row.content, source = row.source;
      if (source?.role !== 'user' || !(source.messageId || source.eventId) || typeof text !== 'string' || !text.trim()
        || (settings.excludedScopes || []).includes('personal') || (settings.excludedScopes || []).includes(row.scope || 'personal') || excluded(text)) continue;
      const messageId = row.id || row.messageId || source.messageId || source.eventId;
      if (typeof messageId !== 'string' || messageId.length > 500 || sources.some(entry => entry.messageId === messageId)) continue;
      const entry = { messageId, text: text.slice(0, 6000), truncated: text.length > 6000 || row.truncated === true,
        source, successful: false, failed: false };
      sources.push(entry);
      digest.push({ messageId, text: entry.text.slice(0, 2000), truncated: entry.truncated || text.length > 2000, source: reference(source) });
    }
    const storedMemories = (await store.memory.list?.() || []).filter(row => row.category !== 'reflections'
      && !(settings.excludedScopes || []).includes(row.scope || 'personal') && !excluded(row.content || '')).slice(0, 20);
    let revision = await store.memory.contextRevision?.();
    const fingerprint = entries => createHash('sha256').update(JSON.stringify({ policy: settings.hash,
      memories: entries.map(row => ({ id: row.id, revision: row.revision, content: row.content, category: row.category })) })).digest('hex');
    if (!sources.length && await store.learning?.getTaskFingerprint?.('memory-upkeep') === fingerprint(storedMemories)) return {
      status: 'completed', reason: '事实材料未变化', modelUsed: false, ...complete() };
    digest.push(...storedMemories.map(row => ({ kind: 'memory', memoryId: row.id, content: clipped(row.content, 1500), category: row.category || 'world' })));
    if (!sources.length && !storedMemories.length) return { status: 'completed', reason: '没有新的可学习闭单材料，等待后续调度', modelUsed: false,
      ...complete() };
    const { parsed, routing } = await runMaintenanceReview({ ctx, store, task: 'memory-upkeep', material: digest, signal,
      validate: result => { if (!Array.isArray(result?.memories) || (result.skills !== undefined && !Array.isArray(result.skills))) throw new Error('Invalid learning response'); } });
    if (!Array.isArray(parsed.memories) || parsed.memories.length > 5) throw new Error('学习记忆数量无效');
    const evidence = source => ({ ...source.source, role: 'user', ticketId: source.ticketId, resultVersion: source.resultVersion,
      closedAt: source.closedAt, reviewId, excerpt: source.text, excerptTruncated: source.truncated });
    const memories = parsed.memories.map((memory, index) => {
      const source = memory && sources.find(row => row.messageId === memory.sourceMessageId);
      if (!source || typeof memory.content !== 'string' || !memory.content.trim() || memory.content.length > 4000) throw new Error('学习结果缺少原文证据');
      const category = memory.category || 'world';
      if (!categories.has(category) || category === 'experience' && source.failed) throw new Error('学习分类或结果证据无效');
      const content = memory.content;
      if (category === 'reflections' && content.length > 600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|<!--\s*\/?benchgo-memory/u.test(content)
        || JSON.stringify(evidence(source)).length > 16000) throw new Error('学习内容或来源超出有效范围');
      if (excluded(content)) throw new Error('学习结果包含排除内容');
      return { content, category, source: evidence(source), key: slot(reviewId, 'memory', index) };
    });
    const proposedSkills = parsed.skills ?? [];
    const curateIds = parsed.curateIds ?? [];
    if (!Array.isArray(curateIds) || curateIds.length > 20 || new Set(curateIds).size !== curateIds.length
      || curateIds.some(id => !storedMemories.some(row => row.id === id))) throw new Error('记忆整理引用无效');
    if (!Array.isArray(proposedSkills) || proposedSkills.length > 2) throw new Error('学习技能数量无效');
    const skillInputs = proposedSkills.map((skill, index) => {
      const source = skill && sources.find(row => row.messageId === skill.sourceMessageId);
      if (!source) throw new Error('学习技能缺少原文证据');
      if (!source.successful) throw new Error('学习技能缺少明确成功结果证据');
      for (const [field, max] of [['name', 100], ['description', 500], ...skillSections.map(([field]) => [field, 3000])]) {
        if (typeof skill[field] !== 'string' || !skill[field].trim() || skill[field].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(skill[field])) throw new Error('学习技能字段无效');
      }
      const body = `---\nname: ${JSON.stringify(skill.name.trim())}\ndescription: ${JSON.stringify(skill.description.trim())}\n---\n\n${skillSections.map(([field, heading]) => `## ${heading}\n\n${skill[field].trim()}`).join('\n\n')}\n`;
      if (excluded(body)) throw new Error('学习技能包含排除内容');
      const { excerpt, excerptTruncated, ...sourceReference } = evidence(source);
      const input = { idempotencyKey: `learned-${createHash('sha256').update(slot(reviewId, 'skill', index)).digest('hex')}`,
        name: skill.name.trim(), description: skill.description.trim(), content: body, source: sourceReference };
      try { validateOwnedSkill(input); } catch (error) { throw new Error(`学习技能字段无效：${error.message}`); }
      return input;
    });
    const reflections = memories.filter(row => row.category === 'reflections');
    const reflectionWrite = reflections.length ? await prepareDailyDream({ store, input: { document: `dreams/${new Date(now()).toISOString().slice(0, 10)}.md`,
      content: `# 助手反思\n\n${reflections.map(row => `- ${row.content}\n  来源：${row.source.messageId || row.source.eventId}`).join('\n\n')}\n`, memoryIds: [],
      source: { role: 'assistant', type: 'maintenance', task: 'memory-upkeep', reviewId, references: reflections.map(row => reference(row.source)) } } }) : null;
    if (reflectionWrite && (reflectionWrite.content.length > 16000 || JSON.stringify(reflectionWrite.source).length > 16000)) throw new Error('反思内容或来源超过预算');
    const checkPolicy = async () => {
      signal?.throwIfAborted();
      const latest = await store.memory.learning();
      await store.memory.list?.(); // Observe authoritative Markdown edits before comparing its revision.
      if (!latest.enabled || latest.hash !== settings.hash) throw new Error('学习规则已变更，请重新整理');
      if (JSON.stringify(await store.memory.contextRevision?.()) !== JSON.stringify(revision)) throw new Error('学习来源已变更，请重新整理');
    };
    await checkPolicy();
    const candidates = [], skills = [];
    for (const memory of memories.filter(row => row.category !== 'reflections')) {
      await checkPolicy();
      candidates.push(receipt(await store.memory.propose({ content: memory.content, category: memory.category, document: 'MEMORY.md', scope: 'personal', source: memory.source },
        { verifiedSource: memory.source, idempotencyKey: memory.key })));
      revision = await store.memory.contextRevision?.();
    }
    if (reflectionWrite) {
      await checkPolicy();
      await store.memory.writeDerived(reflectionWrite);
      revision = await store.memory.contextRevision?.();
    }
    for (const input of skillInputs) { await checkPolicy(); skills.push(receipt(await store.ownedSkills.propose(input))); }
    let overview;
    if (curateIds.length) {
      await checkPolicy();
      const result = await store.memory.curate({ ids: curateIds, source: { role: 'assistant', type: 'maintenance', task: 'memory-upkeep', reviewId } });
      revision = await store.memory.contextRevision?.();
      overview = { document: 'MEMORY.md', ...(result?.hash ? { hash: result.hash } : {}) };
    }
    await checkPolicy();
    if (store.learning?.setTaskFingerprint) {
      const current = (await store.memory.list?.() || []).filter(row => row.category !== 'reflections'
        && !(settings.excludedScopes || []).includes(row.scope || 'personal') && !excluded(row.content || '')).slice(0, 20);
      await checkPolicy();
      await store.learning.setTaskFingerprint('memory-upkeep', fingerprint(current));
    }
    return { candidates, skills, ...(overview ? { overview } : {}), routing, modelUsed: true, ticketIds: digest.map(row => row.ticketId).filter(Boolean),
      sourceMessageIds: sources.map(row => row.messageId), ...complete() };
  };
}
