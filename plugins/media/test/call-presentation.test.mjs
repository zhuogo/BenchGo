import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallPresentation } from '../client/call-presentation.mjs';

function fixture(start) {
  const state = { mode: 'idle', sessionId: null }, actions = [], listeners = new Set();
  const publish = patch => { Object.assign(state, patch); for (const listener of listeners) listener(); };
  const controller = {
    state: { getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } },
    async startCall(args) { actions.push(['start', args.sessionId]); if (start) await start(args); publish({ mode: 'call', sessionId: args.sessionId }); },
    async hangup() { actions.push(['hangup']); publish({ mode: 'idle' }); },
  };
  const view = createCallPresentation(controller, { title: id => '标题 ' + id, openSession: async id => actions.push(['open', id]) });
  return { state, actions, view, publish };
}

test('leaving a view minimizes presentation while preserving the original call and controls', async () => {
  const { view, state, actions } = fixture();
  await view.start({ sessionId: 'A' });
  view.leave('B'); assert.equal(view.getSnapshot().expanded, true);
  view.leave('A'); assert.equal(view.getSnapshot().expanded, false);
  assert.equal(state.mode, 'call'); assert.equal(state.sessionId, 'A');
  await view.start({ sessionId: 'B' });
  assert.equal(view.getSnapshot().sessionId, 'A'); assert.equal(view.getSnapshot().expanded, true);
  assert.deepEqual(actions, [['start', 'A']]);
  view.history('B'); assert.equal(view.getSnapshot().sessionId, 'A');
  await view.returnToSession();
  assert.deepEqual(actions.at(-1), ['open', 'A']);
  await view.hangup(); assert.equal(view.getSnapshot().sessionId, null); assert.equal(state.mode, 'idle');
});

test('starting call retains its presentation when its view leaves or another session requests a call', async () => {
  let ready;
  const { view, actions } = fixture(() => new Promise(resolve => { ready = resolve; }));
  const opening = view.start({ sessionId: 'A' });
  assert.equal(view.getSnapshot().pending, true);
  view.leave('A'); assert.equal(view.getSnapshot().expanded, false);
  await view.start({ sessionId: 'B' });
  assert.equal(view.getSnapshot().sessionId, 'A');
  assert.deepEqual(actions, [['start', 'A']]);
  ready(); await opening; assert.equal(view.getSnapshot().pending, false);
});

test('failed starts remain recoverable and a late failure cannot resurrect a hung-up call', async () => {
  const failed = fixture(async () => { throw Error('麦克风权限被拒绝'); });
  await failed.view.start({ sessionId: 'A' });
  assert.equal(failed.view.getSnapshot().error, '麦克风权限被拒绝');
  assert.equal(failed.view.getSnapshot().pending, false);
  failed.view.minimize(); assert.equal(failed.view.getSnapshot().sessionId, 'A');
  await failed.view.retry(); assert.equal(failed.actions.filter(row => row[0] === 'start').length, 2);
  let reject;
  const late = fixture(() => new Promise((_, fail) => { reject = fail; }));
  const opening = late.view.start({ sessionId: 'A' }); await late.view.hangup(); reject(Error('迟到错误')); await opening;
  assert.equal(late.view.getSnapshot().sessionId, null); assert.equal(late.view.getSnapshot().error, '');
});

test('history close does not end media and disposal stops all pending presentation notifications', async () => {
  let reject;
  const { view, actions } = fixture(() => new Promise((_, fail) => { reject = fail; }));
  view.history('A'); assert.equal(view.getSnapshot().historyOnly, true);
  view.minimize(); assert.equal(view.getSnapshot().sessionId, null); assert.deepEqual(actions, []);
  let changes = 0; view.subscribe(() => changes++);
  const opening = view.start({ sessionId: 'A' }); const initial = changes;
  view.dispose(); reject(Error('模块已卸载')); await opening;
  assert.equal(changes, initial);
});

test('retry ignores stale controller errors until the new call is ready', async () => {
  let h;
  h = fixture(async () => {
    h.publish({ mode: 'idle', sessionId: 'A', error: '旧连接已中断' });
    h.publish({ error: '' });
  });
  await h.view.start({ sessionId: 'A' });
  h.publish({ mode: 'idle', error: '旧连接已中断' });
  assert.equal(h.view.getSnapshot().error, '旧连接已中断');
  await h.view.retry();
  assert.equal(h.view.getSnapshot().error, '');
  assert.equal(h.state.mode, 'call');
});

test('a minimized call follows its official session title without reopening or switching to another session', async () => {
  const titles=new Map(),subscribers=new Set();let changes=0;
  const controller={state:{subscribe:()=>()=>{},getSnapshot:()=>({mode:'call',sessionId:'A'})},startCall:async()=>{}};
  const view=createCallPresentation(controller,{title:id=>titles.get(id),subscribeTitle:listener=>{subscribers.add(listener);return()=>subscribers.delete(listener);}});
  view.expand();view.minimize();view.move({x:10,y:20});view.subscribe(()=>changes++);
  assert.equal(view.getSnapshot().title,'语音对话');
  titles.set('A','本周旅行计划');for(const listener of subscribers)listener();
  assert.equal(view.getSnapshot().title,'本周旅行计划');assert.equal(view.getSnapshot().expanded,false);
  assert.deepEqual(view.getSnapshot().position,{x:10,y:20});
  titles.set('B','其他对话');for(const listener of subscribers)listener();assert.equal(changes,1);
  titles.set('A','用户手动命名');for(const listener of subscribers)listener();assert.equal(view.getSnapshot().title,'用户手动命名');
  view.dispose();assert.equal(subscribers.size,0);
});
