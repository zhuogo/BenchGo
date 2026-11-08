/** Private durable question identities; no writes to the official Session log. */
export function installRouterQuestionStore({ db, tx }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_router_question_bindings(
    session_id TEXT NOT NULL, call_id TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(session_id,call_id));`);
  return {
    saveRouterQuestionBinding(binding) {
      if (!binding || typeof binding.sessionId !== 'string' || !binding.sessionId || typeof binding.callId !== 'string' || !binding.callId
        || typeof binding.threadId !== 'string' || !binding.threadId || !Array.isArray(binding.questions) || !binding.questions.length
        || !Array.isArray(binding.entries)) throw new Error('无效问题绑定');
      const text = JSON.stringify(binding);
      return tx(() => {
        const previous = db.prepare('SELECT payload FROM sa_router_question_bindings WHERE session_id=? AND call_id=?').get(binding.sessionId, binding.callId);
        if (previous) {
          if (previous.payload !== text) throw new Error('问题调用已绑定其他内容');
          return JSON.parse(previous.payload);
        }
        db.prepare('INSERT INTO sa_router_question_bindings VALUES (?,?,?)').run(binding.sessionId, binding.callId, text);
        return JSON.parse(text);
      });
    },
    routerQuestionBinding(sessionId, callId) {
      const row = db.prepare('SELECT payload FROM sa_router_question_bindings WHERE session_id=? AND call_id=?').get(sessionId, callId);
      return row ? JSON.parse(row.payload) : null;
    },
  };
}
