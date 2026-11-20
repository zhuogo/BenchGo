import { hasTextCapability, structuredCapabilities } from './model-capabilities.mjs';

const levels = { min: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

export function normalizeInputModalities(input) {
  return Array.isArray(input) ? [...new Set(input.filter(value => typeof value === 'string').map(value => value.trim().toLowerCase())
    .filter(value => ['text', 'image', 'audio', 'video', 'pdf'].includes(value)))] : [];
}

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
export function modelProfilePatch(row, { reasoning = false, inputField = 'input' } = {}) {
  if (!row || typeof row !== 'object') return {};
  const patch = {};
  const contextWindow = positive(row.context), maxTokens = positive(row.max_output);
  if (contextWindow) patch.contextWindow = contextWindow;
  if (maxTokens) patch.maxTokens = maxTokens;
  const declared = normalizeInputModalities(row.input_modalities);
  const outputs = Array.isArray(row.output_modalities) ? row.output_modalities : [];
  const capabilities = structuredCapabilities(row, declared, outputs);
  if ((!capabilities.length && !Array.isArray(row.capabilities)) || hasTextCapability(capabilities)) {
    if (declared.includes('image')) patch[inputField] = ['text', 'image'];
    else if (declared.includes('text')) patch[inputField] = ['text'];
  }
  if (reasoning && Array.isArray(row.thinking_levels) && row.thinking_levels.length) {
    const efforts = {};
    for (const level of row.thinking_levels) if (Object.hasOwn(levels, level)) efforts[levels[level]] = level;
    if (Object.keys(efforts).length > 0) {
      if (row.thinking_levels.includes('off')) efforts.off = null;
      patch.reasoningEfforts = efforts;
    }
  }
  return patch;
}

export function applyModelProfile(model, row, options, defaults) {
  const patch = modelProfilePatch(row, options);
  const next = { ...model };
  let matched = false;
  for (const [key, value] of Object.entries(patch)) {
    if (model[key] !== undefined && (!defaults || JSON.stringify(model[key]) !== JSON.stringify(defaults[key]))) continue;
    next[key] = value;
    matched = true;
  }
  return { model: next, matched };
}
