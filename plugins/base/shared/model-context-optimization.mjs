import { hasTextCapability, structuredCapabilities } from './model-capabilities.mjs';

const openAiPricing = 'https://openai.com/api/pricing/';
const longContextPricingModels = new Set([
  'gpt-5.4', 'gpt-5.4-2026-03-05', 'gpt-5.4-pro', 'gpt-5.4-pro-2026-03-05',
  'gpt-5.5', 'gpt-5.5-2026-04-23', 'gpt-5.5-pro', 'gpt-5.5-pro-2026-04-23',
]);
const longContextThreshold = 272_000;
// The default compaction policy reserves this in addition to maximum output.
const compactionHeadroom = 65_536;
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;

export function suggestContextWindows(models, profiles, { baseURL, defaultMaxTokens, discoveredModels } = {}) {
  const directOpenAi = /^https:\/\/api\.openai\.com\/v1\/?$/i.test(baseURL ?? '');
  const suggestions = [];
  for (const [index, model] of models.entries()) {
    const { id } = model;
    if (typeof id !== 'string' || !id) continue;
    const profile = profiles.get(id);
    const capabilities = profile ? structuredCapabilities(profile, profile.input_modalities ?? [], profile.output_modalities ?? []) : [];
    if (capabilities.length && !hasTextCapability(capabilities)) continue;

    const discovered = discoveredModels?.get(id);
    const publishedWindow = positive(profile?.context) ?? positive(discovered?.contextWindow);
    const before = positive(model.contextWindow) ?? publishedWindow;
    if (before === undefined) continue;
    const paidTier = directOpenAi && longContextPricingModels.has(id);
    if (!paidTier && (publishedWindow ?? 0) < 1_000_000) continue;
    const after = paidTier ? longContextThreshold : Math.floor(publishedWindow / 2);
    const maxTokens = positive(model.maxTokens) ?? positive(profile?.max_output)
      ?? positive(discovered?.maxTokens) ?? positive(defaultMaxTokens);
    if (after >= before || maxTokens === undefined || after <= maxTokens + compactionHeadroom) continue;

    suggestions.push({ index, id, name: model.name || profile?.model_name || id, before, after,
      reason: paidTier ? 'pricing' : 'half', ...(paidTier && { source: openAiPricing }) });
  }
  return suggestions;
}
