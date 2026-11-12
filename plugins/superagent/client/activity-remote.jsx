import { RemoteSnapshotStream, RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client';
import { executionFactsRemoteContribution } from '../src/execution-facts-contract.mjs';
import { configureAssistantActivity, assistantActivityStore } from './use-activity.jsx';
import { createNotificationFactGate } from './notification-sound.mjs';
/** The official Remote owns reconnection; the shared store owns only read projections. */
export function mountAssistantActivity(ctx, api) {
  let active = true;
  let notificationSource;
  const notifySource = supported => {
    if (notificationSource === supported) return;
    notificationSource = supported;
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('benchgo:assistant-notification-source', { detail: { publicChatNotifications: supported } }));
  };
  const reconcileChat = () => { if (typeof document !== 'undefined') document.dispatchEvent(new Event('benchgo:assistant-history-changed')); };
  const unconfigure = configureAssistantActivity(api, { connect(sink) {
    const sounds = createNotificationFactGate();
    let control, follow, unmount, starting, disposing, disposed = false;
    const release = async () => {
      try { await follow?.dispose(); }
      finally { const remove = unmount; unmount = null; await remove?.(); }
    };
    return {
      start() {
        if (starting || disposed || !active) return;
        starting = (async () => {
          const remove = await ctx.remote.$mount(executionFactsRemoteContribution);
          if (disposed || !active) { await remove(); return; }
          unmount = remove;
          follow = ctx.inject(['remote.benchgoExecutionFacts'], scope => {
            const stream = scope.remote.$stream({
              name: 'BenchGo execution facts', open: signal => scope.remote.benchgoExecutionFacts.stream({}, signal),
              ended: accepted => accepted ? new RemoteStreamCarrierError('执行事实连接中断') : new Error('执行事实快照未到达'),
              carrierFailed: error => { sounds.disconnect(); if (!disposed && active) { if (notificationSource === undefined) notifySource(false); sink.carrierFailed(error); } },
            });
            const consumer = new RemoteSnapshotStream(stream, {
              name: 'BenchGo execution facts', isSnapshot: frame => frame.type === 'snapshot',
              replace: frame => { if (disposed || !active) return; notifySource(frame.snapshot.publicChatNotifications === true); sounds.replace(frame.snapshot); sink.replace(frame.snapshot); reconcileChat(); },
              update: frame => {
                if (disposed || !active) return;
                sink.update(frame);
                sounds.update(frame);
                if (frame.entries?.some(entry => ['chat', 'delivery', 'result', 'attention'].includes(entry.kind))) reconcileChat();
              },
              failed: error => { sounds.disconnect(); if (!disposed && active) { if (notificationSource === undefined) notifySource(false); sink.failed(error); void release(); } },
            });
            control = consumer;
            scope.effect(() => async () => { if (control === consumer) control = null; await consumer.dispose(); }, 'benchgo.execution-facts.follow');
            consumer.start();
          });
          await follow;
        })().catch(async error => { await release(); if (!disposed && active) { if (notificationSource === undefined) notifySource(false); sink.failed(error); } });
      },
      restart() { control?.restart(); },
      dispose() {
        disposed = true;
        return disposing ||= (async () => { await follow?.dispose(); await starting; await release(); })();
      },
    };
  } });
  // One shared transport remains live while other panels are selected or the page is hidden.
  const unsubscribe = assistantActivityStore(api).subscribe(() => {});
  ctx.effect(() => () => { active = false; unsubscribe(); unconfigure?.(); });
}
