export const EFFICIENCY_CONFIG_SCHEMA = { type: 'object', additionalProperties: false, properties: { features: { type: 'object', additionalProperties: false, properties: {
  ops: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean', default: true }, shell: { type: 'boolean', default: false } } },
  compaction: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean', default: true } } },
} } } };
