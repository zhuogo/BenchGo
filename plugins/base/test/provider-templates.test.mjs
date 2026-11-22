import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTemplateBaseURL, providerTemplate, providerTemplateForRoute, providerTemplates, templateProviderId } from '../shared/provider-templates.mjs';

test('curated provider templates have unique kinds and exact endpoint defaults', () => {
  assert.equal(providerTemplates.length, 21);
  assert.equal(new Set(providerTemplates.map(template => template.kind)).size, providerTemplates.length);

  for (const [kind, baseURL] of [
    ['kimi', 'https://api.moonshot.cn/v1'],
    ['openai', 'https://api.openai.com/v1'],
    ['anthropic', 'https://api.anthropic.com'],
    ['opencode', 'https://opencode.ai/inference/openai/v1'],
    ['google', 'https://generativelanguage.googleapis.com/v1beta'],
    ['meta', 'https://api.meta.ai/v1'],
    ['nvidia', 'https://integrate.api.nvidia.com/v1'],
    ['huggingface', 'https://router.huggingface.co/v1'],
    ['mistral', 'https://api.mistral.ai/v1'],
    ['zai', 'https://api.z.ai/api/paas/v4'],
  ]) assert.equal(providerTemplate(kind)?.baseURL, baseURL, kind);

  assert.equal(providerTemplate('spark')?.brand, 'spark');
  assert.equal(providerTemplate('qianfan')?.brand, 'qianfan');
});

test('curated templates retain explicit native protocols and default to Chat Completions', () => {
  assert.deepEqual(
    Object.fromEntries(providerTemplates
      .filter(template => template.protocol !== 'openai-completions')
      .map(({ kind, protocol }) => [kind, protocol])),
    {
      openai: 'openai-responses',
      anthropic: 'anthropic-messages',
      google: 'google-generative-ai',
    },
  );
  assert.match(providerTemplate('opencode')?.hint ?? '', /手动填写原始模型 ID/);
});

test('template routes are distinct and recognize only exact known identities', () => {
  for (const template of providerTemplates) {
    const { kind } = template;
    const first = templateProviderId(kind);
    const second = templateProviderId(kind);
    assert.match(first, new RegExp(`^benchgo-${kind}-[a-f0-9]{32}$`));
    assert.notEqual(first, second);
    assert.equal(providerTemplateForRoute(first), template);
    assert.equal(providerTemplateForRoute(second), template);
  }

  const suffix = 'a'.repeat(32);
  for (const id of [
    'dashscope', `benchgo-dashscope-${suffix.slice(1)}`, `benchgo-dashscope-${suffix}a`,
    `benchgo-dashscope-${suffix.toUpperCase()}`, `benchgo-DashScope-${suffix}`,
    `benchgo-dashscope-${suffix}\n`, ` benchgo-dashscope-${suffix}`, `benchgo-custom-${suffix}`,
  ]) assert.equal(providerTemplateForRoute(id), undefined, id);

  assert.throws(() => templateProviderId('custom'), /Unknown provider template/);
});

test('DashScope official roots receive the compatible path', () => {
  const template = providerTemplate('dashscope');
  for (const origin of [
    'https://llm-example.cn-beijing.maas.aliyuncs.com',
    'https://llm-example.us-east-1.maas.aliyuncs.com',
    'https://llm-example.ap-southeast-1.maas.aliyuncs.com',
    'https://llm-example.ap-northeast-1.maas.aliyuncs.com',
    'https://dashscope.aliyuncs.com',
    'https://dashscope-intl.aliyuncs.com',
    'https://cn-hongkong.dashscope.aliyuncs.com',
    'https://dashscope-us.aliyuncs.com',
  ]) {
    assert.equal(normalizeTemplateBaseURL(template, origin), `${origin}/compatible-mode/v1`);
    assert.equal(normalizeTemplateBaseURL(template, `${origin}/`), `${origin}/compatible-mode/v1`);
  }
});

test('normalization preserves explicit paths, foreign hosts and invalid addresses', () => {
  const template = providerTemplate('dashscope');
  const origin = 'https://llm-example.cn-beijing.maas.aliyuncs.com';
  for (const address of [
    `${origin}/compatible-mode/v1`, `${origin}/other/v1/`, `${origin}/.`, `${origin}/?`, `${origin}/#`,
    `${origin}.example.com`, `${origin}:8443`, 'https://dashscope.aliyuncs.com.example.com',
    'https://example.com', 'https://user@dashscope.aliyuncs.com', 'dashscope.aliyuncs.com',
    'http:dashscope.aliyuncs.com', 'https://invalid-.cn-beijing.maas.aliyuncs.com', 'invalid',
  ]) assert.equal(normalizeTemplateBaseURL(template, address), address);
  assert.equal(normalizeTemplateBaseURL(providerTemplate('grok'), origin), origin);
  assert.equal(normalizeTemplateBaseURL(undefined, origin), origin);
});
