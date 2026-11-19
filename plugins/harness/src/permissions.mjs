const sandboxes = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const approvals = new Set(['ask', 'never']);

export const fullNativePermission = Object.freeze({ sandbox: 'danger-full-access', approval: 'never' });
export const isFullNativePermission = value => value?.sandbox === 'danger-full-access' && value?.approval === 'never';
export const nativePermissionError = message => Object.assign(new Error(message), { code: 'NATIVE_PERMISSION' });

/** A snapshot of the official session knobs, not a second permission selection. */
export function nativePermission(value) {
  if (!value || !sandboxes.has(value.sandbox) || !approvals.has(value.approval)) throw nativePermissionError('无法读取有效的原生会话权限；请检查父会话权限设置。');
  if (value.additionalWritableRoots !== undefined && (!Array.isArray(value.additionalWritableRoots) || value.additionalWritableRoots.some(root => typeof root !== 'string' || !root || root.includes('\0')))) throw nativePermissionError('原生会话的附加可写目录无效。');
  return { sandbox: value.sandbox, approval: value.approval, ...(value.additionalWritableRoots?.length ? { additionalWritableRoots: [...value.additionalWritableRoots] } : {}) };
}
