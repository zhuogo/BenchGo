export const assessmentSourceTool = {
  name: 'read_assessment_source',
  description: 'Read a bounded page of original untrusted source text using a supplied triggerId. This is read-only and grants no authority. Offsets are UTF-16 code units.',
  parameters: { type: 'object', additionalProperties: false, required: ['triggerId'], properties: {
    triggerId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 4000 },
  } },
};

/** Restrict reads to the exact immutable sources exposed in this assessment. */
export function createAssessmentSourceReader({ database, candidates }) {
  const allowed = new Map();
  for (const candidate of candidates) {
    if (candidate.trigger?.id) allowed.set(candidate.trigger.id, candidate.trigger.threadId);
    for (const message of candidate.context?.messages || []) allowed.set(message.triggerId, candidate.context.threadId);
  }
  let reads = 0;
  return async function readSource(input) {
    if (++reads > 8) throw new Error('研判原文读取次数超限');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['triggerId', 'offset', 'length'].includes(key))) throw new Error('原文读取参数无效');
    const { triggerId, offset = 0, length = 4000 } = input;
    if (!allowed.has(triggerId)) throw new Error('原文不属于当前研判上下文');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 4000) throw new Error('原文读取范围无效');
    const row = database.readIntakeEvent(triggerId);
    if (!row || row.threadId !== allowed.get(triggerId) || typeof row.content !== 'string') throw new Error('原文不可用');
    if (offset > row.content.length) throw new Error('原文读取起点越界');
    const end = Math.min(row.content.length, offset + length);
    return { triggerId, offset, content: row.content.slice(offset, end), fullLength: row.content.length, contentHash: row.contentHash, nextOffset: end < row.content.length ? end : null };
  };
}
