const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const parse = text => { try { const value = JSON.parse(text); return record(value) ? value : null; } catch { return null; } };

/** Public question fields only; the original call owns the question identity. */
export function questionBatch(argumentsText) {
  const value = typeof argumentsText === 'string' ? parse(argumentsText) : argumentsText, ids = new Set();
  if (!Array.isArray(value?.questions) || !value.questions.length) return null;
  const questions = [];
  for (const row of value.questions) {
    if (!record(row) || typeof row.id !== 'string' || !row.id || typeof row.question !== 'string' || ids.has(row.id)) return null;
    ids.add(row.id);
    questions.push({ id: row.id, question: row.question, ...(typeof row.header === 'string' && row.header.trim() ? { header: row.header } : {}) });
  }
  return questions;
}

export function questionAnswers(questions, message) {
  const content = message?.content || [];
  if (message?.isError === true || content.length !== 1 || content[0]?.type !== 'text') return null;
  const value = parse(content[0].text);
  if (!value || value.pending === true || !Array.isArray(value.answers) || value.answers.length !== questions.length) return null;
  const ids = new Set(questions.map(row => row.id)), answers = [];
  for (const row of value.answers) {
    if (!record(row) || typeof row.id !== 'string' || !ids.delete(row.id) || !Array.isArray(row.selected)
      || !row.selected.every(item => typeof item === 'string') || (row.custom !== undefined && typeof row.custom !== 'string')) return null;
    answers.push({ id: row.id, selected: [...row.selected], ...(row.custom?.trim() ? { custom: row.custom } : {}) });
  }
  return answers;
}

export const questionReplyText = (questions, answers) => questions.map(row => {
  const answer = answers.find(item => item.id === row.id), values = [...(answer?.selected || []), ...(answer?.custom ? [answer.custom] : [])];
  return `${row.header || row.question}：${values.length ? values.join('、') : '已跳过'}`;
}).join('\n');

/** This predicate applies only to Host-admitted messages, never model JSON. */
export const isChatUserMessage = message => message?.source?.kind === 'user' ||
  (message?.source?.kind === 'user-question-reply' && message.source.outcome === 'answered'
    && typeof message.source.callId === 'string' && !!message.source.callId);

/** Keep original calls available across timed-out results and later turns. */
export function questionCalls(events) {
  const calls = new Map();
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.name === 'ask_user_question' && !event.data.parentCallId) {
      const questions = questionBatch(event.data.arguments);
      if (questions) calls.set(String(event.data.callId), questions);
    } else if (event.type === 'tool/ptc-dispatch' && event.data?.name === 'ask_user_question' && !event.data.isError) {
      const questions = questionBatch(event.data.arguments);
      if (questions) calls.set(String(event.data.subCallId), questions);
    }
  }
  return calls;
}

/** Decode only an already Host-admitted official node; never call on model output. */
export function readAdmittedQuestionReply(message) {
  if (!isChatUserMessage(message) || message.source.kind !== 'user-question-reply') return null;
  const callId = message.source.callId;
  const value = parse(message.content?.length === 1 && message.content[0]?.type === 'text' ? message.content[0].text : '');
  const questions = questionBatch(value);
  if (value?.kind !== 'answer_to_pending_question' || value.tool !== 'ask_user_question' || value.callId !== callId || !questions) return null;
  const answers = questionAnswers(questions, message);
  return answers ? { callId, questions, answers, text: questionReplyText(questions, answers) } : null;
}

/** Original official call and admitted reply must agree; the payload cannot invent a call. */
export function readQuestionReply(message, events) {
  return readBoundQuestionReply(message, questionCalls(events).get(message?.source?.callId));
}

/** Questions supplied by the trusted Host binding store, never by model content. */
export function readBoundQuestionReply(message, questions) {
  const reply = readAdmittedQuestionReply(message);
  if (!reply) return null;
  if (!questions || questions.length !== reply.questions.length
    || !questions.every(question => reply.questions.some(row => row.id === question.id && row.question === question.question))) return null;
  return { ...reply, questions, text: questionReplyText(questions, reply.answers) };
}
