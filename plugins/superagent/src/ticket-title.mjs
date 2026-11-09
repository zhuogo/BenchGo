export const TICKET_TITLE_MAX_CHARS = 10;

const genericDescriptions = new Set(['任务', '工单', '执行任务', '处理请求', '执行请求', '新建任务', '新任务', '任务处理', '完成任务', '未命名工单',
  '执行用户任务', '处理用户请求', '帮用户完成任务', 'task', 'ticket', 'execute task', 'process request', 'new task', 'untitled ticket']);

/** Reject exact placeholders at admission; never guess or rewrite business meaning. */
export function assertSpecificTicketDescription({ title, target }) {
  for (const [field, value] of Object.entries({ title, target })) {
    const text = typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').replace(/[。.!！]+$/gu, '').toLocaleLowerCase() : '';
    if (genericDescriptions.has(text)) throw Object.assign(new Error(`开单${field === 'title' ? '标题' : '活摘要'}过于空泛，请根据用户原话写清要做的事情与预期产出；不要增加范围或使用固定模板`), {
      code: 'TICKET_DESCRIPTION_GENERIC', field,
    });
  }
}

/** A display label only; task target and acceptance stay complete and independent. */
export function normalizeTicketTitle(value, fallback = '') {
  const clean = input => typeof input === 'string'
    ? input.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim()
    : '';
  return Array.from(clean(value) || clean(fallback) || '未命名工单').slice(0, TICKET_TITLE_MAX_CHARS).join('');
}
