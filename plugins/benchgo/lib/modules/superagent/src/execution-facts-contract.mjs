import { z } from 'zod';

/** Shared endpoint identity; this module contains no Host service or transport. */
export const executionFactsRemoteNamespace = 'benchgoExecutionFacts';
const namespace = executionFactsRemoteNamespace;
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.string().min(1).max(1024);
const jsonObject = z.record(z.string(), z.json());
const snapshotRequest = z.strictObject({ ticketId: identity.optional() });
const pageRequest = z.strictObject({
  after: cursor.optional(), through: cursor.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
const evidenceRequest = z.strictObject({
  ticketId: identity, runId: identity.optional(),
  instructionRevision: z.number().int().positive().optional(),
  after: cursor.optional(), limit: z.number().int().min(1).max(1000).optional(),
});
const entry = z.object({
  seq: cursor, ticketId: identity.nullable(), kind: identity, record: z.json().optional(),
}).catchall(z.json());
const snapshot = z.object({ cursor, tickets: z.array(jsonObject) }).catchall(z.json());
const page = z.object({ cursor, entries: z.array(entry), hasMore: z.boolean() }).catchall(z.json());
const frame = z.union([
  z.strictObject({ type: z.literal('snapshot'), snapshot }),
  page.extend({ type: z.literal('changes') }),
]);

/** Wire validation shared by the Host adapter and optional Client validation. */
export const executionFactsSchemas = Object.freeze({ cursor, jsonObject, snapshot, page, frame });

function codec(typeSymbol, schema) {
  return { mode: 'strict', typeSymbol: `benchgo-plugin#ExecutionFacts.${typeSymbol}`, create: () => schema };
}

const descriptors = Object.freeze([
  ['snapshot', snapshotRequest, snapshot],
  ['page', pageRequest, page],
  ['evidence', evidenceRequest, jsonObject],
  ['stream', z.strictObject({}), frame],
].map(([method, request, result]) => Object.freeze({
  id: `benchgo-plugin#${namespace}/${method}`, service: namespace, namespace, method,
  invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec(`${method}.request`, request) }],
  cancellation: { parameter: 'signal' },
  result: codec(`${method}.result`, result),
  ...(method === 'stream' ? { mode: 'stream' } : {}),
})));

/** Mount with ctx.remote.$mount(); the Host registers these exact descriptors. */
export const executionFactsRemoteContribution = Object.freeze({ package: 'benchgo-plugin', descriptors });
