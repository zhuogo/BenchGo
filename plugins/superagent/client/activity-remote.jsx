import { RemoteSnapshotStream, RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client';
import { executionFactsRemoteContribution } from '../src/execution-facts-contract.mjs';
import { configureAssistantActivity } from './use-activity.jsx';
/** The official Remote owns reconnection; the shared store owns only read projections. */
export function mountAssistantActivity(ctx, api) {
  configureAssistantActivity(api, { connect(sink) {
    let control, disposed = false;
    return {
      start() {
        void ctx.remote.$mount(executionFactsRemoteContribution).then(unmount => {
          if (disposed) { unmount(); return; }
          const stream = ctx.remote.$stream({
            name: 'BenchGo execution facts', open: signal => ctx.remote.benchgoExecutionFacts.stream({}, signal),
            ended: accepted => accepted ? new RemoteStreamCarrierError('执行事实连接中断') : new Error('执行事实快照未到达'),
            carrierFailed: sink.carrierFailed,
          });
          const consumer = new RemoteSnapshotStream(stream, {
            name: 'BenchGo execution facts', isSnapshot: frame => frame.type === 'snapshot',
            replace: frame => sink.replace(frame.snapshot), update: sink.update, failed: sink.failed,
          });
          control = { restart: () => consumer.restart(), dispose: async () => { await consumer.dispose(); unmount(); } };
          consumer.start();
        }).catch(error => { if (!disposed) sink.failed(error); });
      },
      restart() { control?.restart(); },
      async dispose() { disposed = true; await control?.dispose(); },
    };
  } });
}
