// Translate native question contracts through Harness's human input seam.
// No model-generated answers or permission decisions enter this conversion.
export async function askNativeQuestion(provider, request, ask) {
  const details = request.details;
  if (provider === 'pi') {
    const confirm = details.method === 'confirm';
    const result = await ask({ questions: [{
      id: 'value', question: details.title ?? 'Pi question',
      ...(details.message ? { detail: details.message } : {}),
      ...(confirm ? { options: ['Yes', 'No'].map(label => ({ label })) } : details.options ? { options: details.options.map(label => ({ label })) } : {}),
    }] });
    const answer = result.answers.find(a => a.id === 'value');
    if (confirm) return { allow: false, confirmed: answer?.selected?.length === 1 && answer.selected[0] === 'Yes' && !answer.custom };
    const value = answer?.custom ?? answer?.selected?.[0];
    return { allow: false, ...(value === undefined ? {} : { value }) };
  }
  if (Array.isArray(details.acpOptions)) {
    const result = await ask({ questions: [{ id: '0', ...details.questions[0] }] });
    const answer = result.answers.find(item => item.id === '0');
    const selected = answer?.selected?.length === 1 && !answer.custom && details.acpOptions.find(option => option.label === answer.selected[0]);
    return { allow: false, ...(selected ? { selectedOptionId: selected.optionId } : {}) };
  }
  const native = details.questions;
  if (!Array.isArray(native) || !native.length) throw new Error('Native question list is empty or unsupported');
  const questions = native.map((q, index) => ({
    id: provider === 'codex' ? q.id : String(index),
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    ...(q.options?.length ? { options: q.options.map(option => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })) } : {}),
    multiSelect: q.multiSelect === true || q.multiple === true,
  }));
  const result = await ask({ questions });
  const answers = questions.map(q => {
    const response = result.answers.find(a => a.id === q.id);
    if (!response) throw new Error('Human did not answer every native question');
    return [...response.selected, ...(response.custom !== undefined ? [response.custom] : [])];
  });
  if (provider === 'codex') return { allow: false, answers: Object.fromEntries(questions.map((q, index) => [q.id, { answers: answers[index] }])) };
  if (provider === 'opencode') return { allow: false, answers };
  if (provider === 'claude') return { allow: true, answers: Object.fromEntries(native.map((q, index) => [q.question, answers[index].join(', ')])) };
  throw new Error(`Unsupported native question provider: ${provider}`);
}
