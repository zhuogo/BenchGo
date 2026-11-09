import { Service } from '@deepseek-ai/cordis';
import { bindTypertRemote, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import {
  executionFactsRemoteNamespace as namespace,
  executionFactsRemoteContribution,
  executionFactsSchemas,
} from './execution-facts-contract.mjs';

const pageLimit = 100;
const { cursor: cursorSchema, jsonObject, snapshot: snapshotSchema, page: pageSchema } = executionFactsSchemas;

const hostContribution = {
  package: 'benchgo-plugin', face: 'host', schemas: [],
  model: { services: [], events: [], objects: [] }, invocations: executionFactsRemoteContribution.descriptors,
};

function owner(ctx, method) {
  if (ctx.invocation?.peer?.principal?.kind !== 'owner') {
    throw new RemoteError('remote-access/denied', 'Execution facts require the Host owner', {
      action: `${namespace}/${method}`, reason: 'owner-required',
    });
  }
}

function invalid(message) {
  return new RemoteError('gateway/internal', message, {});
}

function readResult(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid('Execution facts returned an invalid JSON result');
  return result.data;
}

/** Enforce the dense task-journal cursor, independently of Session-local seqs. */
function checkedPage(value, after, through) {
  const page = readResult(pageSchema, value);
  let next = after;
  for (const entry of page.entries) {
    if (entry.seq !== next + 1 || (through !== undefined && entry.seq > through)) {
      throw invalid('Execution facts page has a sequence gap or exceeds its read cut');
    }
    next = entry.seq;
  }
  if (page.cursor !== next || (page.hasMore && page.entries.length === 0)) {
    throw invalid('Execution facts page has an invalid continuation cursor');
  }
  return page;
}

/**
 * Register owner-only reads and a coalesced durable fact stream on the official mux.
 * facts owns persistence, projections and the dense journal; this adapter owns no history.
 * @returns an awaited disposer that aborts streams and withdraws the Remote contribution.
 */
export async function installExecutionFactsRemote({ ctx, facts }) {
  // A missing required registry must fail installation instead of leaving a pending plugin.
  if (!ctx.get('typert')) throw new Error('Execution facts Remote requires the typert service');
  const stopped = new AbortController();
  class ExecutionFactsRemote extends Service {
    constructor(serviceCtx) {
      super(serviceCtx, namespace);
      this.typertRemote = bindTypertRemote(this, namespace);
    }

    async snapshot(request, signal) {
      owner(this.ctx, 'snapshot');
      signal.throwIfAborted();
      const result = await facts.snapshot(request);
      signal.throwIfAborted();
      return readResult(snapshotSchema, result);
    }

    async page(request, signal) {
      owner(this.ctx, 'page');
      signal.throwIfAborted();
      const after = request.after ?? 0;
      if (request.through !== undefined && request.through < after) {
        throw new RemoteError('gateway/bad-request', 'through must not precede after', {});
      }
      const result = await facts.page({ ...request, after, limit: request.limit ?? pageLimit });
      signal.throwIfAborted();
      return checkedPage(result, after, request.through);
    }

    async evidence(request, signal) {
      owner(this.ctx, 'evidence');
      signal.throwIfAborted();
      const result = await facts.evidence(request);
      signal.throwIfAborted();
      return readResult(jsonObject, result);
    }

    async *stream(_request, callerSignal) {
      owner(this.ctx, 'stream');
      const signal = AbortSignal.any([callerSignal, stopped.signal]);
      signal.throwIfAborted();
      let dirty = true, wake, released = false;
      const touch = () => {
        dirty = true;
        const pending = wake;
        wake = undefined;
        pending?.();
      };
      // Subscription precedes the asynchronous baseline; notifications occupy one bit.
      const unsubscribe = facts.subscribe(touch);
      const release = () => {
        if (released) return;
        released = true;
        unsubscribe();
      };
      const aborted = () => { release(); touch(); };
      signal.addEventListener('abort', aborted, { once: true });
      try {
        const snapshot = readResult(snapshotSchema, await facts.snapshot({}));
        signal.throwIfAborted();
        let cursor = snapshot.cursor;
        yield { type: 'snapshot', snapshot };
        while (!signal.aborted) {
          dirty = false;
          const through = facts.currentCursor();
          if (!cursorSchema.safeParse(through).success || through < cursor) {
            throw invalid('Execution facts cursor regressed; reopen the snapshot');
          }
          while (cursor < through && !signal.aborted) {
            const page = checkedPage(await facts.page({ after: cursor, through, limit: pageLimit }), cursor, through);
            signal.throwIfAborted();
            if (page.cursor === cursor || page.hasMore !== (page.cursor < through)) {
              throw invalid('Execution facts page did not cover its read cut');
            }
            cursor = page.cursor;
            yield { type: 'changes', ...page };
          }
          if (!dirty && !signal.aborted) await new Promise(resolve => { wake = resolve; });
        }
      } finally {
        signal.removeEventListener('abort', aborted);
        release();
      }
    }
  }
  const fiber = ctx.plugin({
    name: 'benchgo-execution-facts-remote', inject: ['typert'],
    apply(serviceCtx) {
      serviceCtx.effect(() => () => stopped.abort(), 'execution-facts-remote.stop');
      new ExecutionFactsRemote(serviceCtx);
      serviceCtx.typert.register(hostContribution);
    },
  });
  try { await fiber; }
  catch (error) { await fiber.dispose(); throw error; }
  return () => fiber.dispose();
}
