const levels = { min: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

/** Supplier IDs are opaque; duplicate directory IDs are ambiguous. */
export function matchModelProfile(id, catalog) {
  if (typeof id !== 'string' || !id || !Array.isArray(catalog)) return undefined;
  const rows = catalog.filter(row => row?.model_id === id);
  return rows.length === 1 ? rows[0] : undefined;
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Only capabilities the model editors can persist; absent facts stay untouched. */
export function modelProfilePatch(row, { reasoning = false } = {}) {
  if (!row || typeof row !== 'object') return {};
  const patch = {};
  const contextWindow = positive(row.context), maxTokens = positive(row.max_output);
  if (contextWindow) patch.contextWindow = contextWindow;
  if (maxTokens) patch.maxTokens = maxTokens;
  const input = [...new Set((Array.isArray(row.input_modalities) ? row.input_modalities : []).filter(item => item === 'text' || item === 'image'))];
  if (input.length) patch.input = input;
  if (reasoning && Array.isArray(row.thinking_levels) && row.thinking_levels.length) {
    const efforts = {};
    for (const level of row.thinking_levels) if (levels[level]) efforts[levels[level]] = level;
    if (Object.keys(efforts).length > 0) patch.reasoningEfforts = efforts;
  }
  return patch;
}

export function applyModelProfile(model, row, options) {
  const patch = modelProfilePatch(row, options);
  const next = { ...model };
  let matched = false;
  for (const [key, value] of Object.entries(patch)) if (next[key] === undefined) { next[key] = value; matched = true; }
  return { model: next, matched };
}
