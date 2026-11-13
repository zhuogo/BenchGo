// Descriptions mirror the existing validators. Runtime validators remain authoritative.
const identifier = { type: 'string', minLength: 1, maxLength: 512, pattern: '^[^\\u0000-\\u001f\\u007f]*\\S[^\\u0000-\\u001f\\u007f]*$' };
const options = { type: 'object', additionalProperties: false, properties: { reasoningEffort: { type: 'string', minLength: 1, maxLength: 100 }, maxTokens: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } };
const model = { type: 'object', required: ['providerId', 'modelId'], properties: { providerId: identifier, modelId: identifier, options }, additionalProperties: true };
const modelQueue = { type: 'array', maxItems: 32, items: model };
const media = { anyOf: [{ type: 'null' }, { ...model, properties: { ...model.properties, ...Object.fromEntries(['protocol', 'voice', 'language', 'size', 'quality', 'credentialRef'].map(key => [key, { type: 'string', maxLength: 512, pattern: '^[^\\u0000-\\u001f\\u007f]*$' }])), speed: { type: 'number', minimum: 0.25, maximum: 4 } } }] };
export const ASSISTANT_CONFIG_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  name: { type: 'string', maxLength: 100 }, cardHtml: { type: ['string', 'null'], maxLength: 16000 }, cardMotion: { type: 'boolean' },
  models: modelQueue, workerModels: modelQueue, workerConcurrency: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  auxiliary: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['models', 'capabilities'], properties: { models: { ...modelQueue, minItems: 1 }, capabilities: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['vision', 'compression', 'summary', 'review'] } } } }] },
  image: media, video: media, tts: media, asr: media,
  capabilities: { type: 'object', additionalProperties: true },
  maintenance: { type: 'object', additionalProperties: false, properties: {
    quietSeconds: { type: 'integer', minimum: 10, maximum: 86400, default: 120 },
    intervalHours: { type: 'integer', minimum: 1, maximum: 168, default: 6 },
  } },
  pet: { type: ['object', 'null'] }, petPrevious: { type: ['object', 'null'] }, petHasPrevious: { type: 'boolean' },
} };
export const ASSISTANT_BLOCKED_PATHS = [['pet'], ['petPrevious'], ['petHasPrevious']];
export const LEARNING_CONFIG_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  enabled: { type: 'boolean', default: true },
  ...Object.fromEntries(['excludedScopes', 'excludedTerms'].map(key => [key, { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 256 }, default: [] }])),
} };
