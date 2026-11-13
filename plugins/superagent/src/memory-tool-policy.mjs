/** Defense in depth for inherited/retained tool handles as well as registration filtering. */
export function isLongTermMemoryWrite(name, args = {}) {
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return ['assistant_memory', 'assistant_profile', 'assistant_review', 'assistant_learn'].includes(name); } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ['assistant_memory', 'assistant_profile', 'assistant_review', 'assistant_learn'].includes(name);
  if (name === 'assistant_memory') return !!args.remove || Object.hasOwn(args, 'content');
  if (name === 'assistant_profile') return ['update', 'restore'].includes(args.op);
  if (name === 'assistant_review') return ['enqueue', 'skill-feedback', 'dismiss-idea'].includes(args.op);
  return name === 'assistant_learn';
}

export function assertRouterMemoryTool({ name, args, agent, ownerAgent }) {
  if (isLongTermMemoryWrite(name, args) && (!agent || !ownerAgent || agent !== ownerAgent)) {
    throw Object.assign(new Error('Worker 与子 Worker 不能直写长期记忆；任务经验由闭单后台整理'), { code: 'WORKER_MEMORY_WRITE_DENIED' });
  }
}
