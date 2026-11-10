import { RemoteSnapshotStream, RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client';
import { executionFactsRemoteContribution } from '../src/execution-facts-contract.mjs';
import { configureAssistantActivity } from './use-activity.jsx';
/** The official Remote owns reconnection; the shared store owns only read projections. */
export function mountAssistantActivity(ctx, api) {
  configureAssistantActivity(api, { connect(sink) {
    let control, follow, unmount, starting, disposing, disposed = false;
    const release = async () => {
      try { await follow?.dispose(); }
      finally { const remove = unmount; unmount = null; await remove?.(); }
    };
    return {
      start() {
        if (starting || disposed) return;
        starting = (async () => {
          const remove = await ctx.remote.$mount(executionFactsRemoteContribution);
          if (disposed) { await remove(); return; }
          unmount = remove;
          follow = ctx.inject(['remote.benchgoExecutionFacts'], scope => {
            const stream = scope.remote.$stream({
              name: 'BenchGo execution facts', open: signal => scope.remote.benchgoExecutionFacts.stream({}, signal),
              ended: accepted => accepted ? new RemoteStreamCarrierError('执行事实连接中断') : new Error('执行事实快照未到达'),
              carrierFailed: sink.carrierFailed,
            });
            const consumer = new RemoteSnapshotStream(stream, {
              name: 'BenchGo execution facts', isSnapshot: frame => frame.type === 'snapshot',
              replace: frame => sink.replace(frame.snapshot), update: sink.update,
              failed: error => { if (!disposed) { sink.failed(error); void release(); } },
            });
            control = consumer;
            scope.effect(() => async () => { if (control === consumer) control = null; await consumer.dispose(); }, 'benchgo.execution-facts.follow');
            consumer.start();
          });
          await follow;
        })().catch(async error => { await release(); if (!disposed) sink.failed(error); });
      },
      restart() { control?.restart(); },
      dispose() {
        disposed = true;
        return disposing ||= (async () => { await follow?.dispose(); await starting; await release(); })();
      },
    };
  } });
}
