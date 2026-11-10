// Navigation intent only; the original official pending request remains authoritative.
let target = null;
const listeners = new Set();
export const approvalReminderNavigation = {
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  getSnapshot() { return target; },
  open(row) {
    target = { threadId: row.approval.ownerThreadId, requestId: row.requestId, eventKey: row.approval.eventKey };
    for (const listener of listeners) listener();
  },
  clear(expected) { if (target === expected) { target = null; for (const listener of listeners) listener(); } },
};
