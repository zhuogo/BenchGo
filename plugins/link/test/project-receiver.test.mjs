import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createProjectReceiver, projectInput, projectPickerActions } from '../client/project-receiver.mjs';

const source = 'function installResourceReceiver' + readFileSync(new URL('../client/resource-navigation.jsx', import.meta.url), 'utf8').split('export function installResourceReceiver')[1];
const origin = 'https://owner.example';
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(projectApi, { host = {}, getDefaultProjectId } = {}) {
  const listeners = new Set(), messages = [], attributes = new Set();
  const parent = { postMessage: (value, target) => messages.push({ value: JSON.parse(JSON.stringify(value)), target }) };
  const window = { parent, addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener) };
  const install = runInNewContext('(' + source + ')', { window, location: { hash: '#' + new URLSearchParams({ resourceParentOrigin: origin }) }, document: { documentElement: { setAttribute: name => attributes.add(name) } }, URL, URLSearchParams, setTimeout, clearTimeout, createProjectReceiver, projectInput, projectPickerActions });
  const dispose = install(host, { projectApi, getDefaultProjectId });
  const send = (data, source = parent, from = origin) => { for (const listener of listeners) listener({ data, source, origin: from }); };
  return { send, dispose, messages, listeners, parent, window, attributes };
}

test('project receiver allowlists operations and fields, authenticates the parent and deduplicates concurrent writes', async () => {
  const calls = []; let complete;
  const view = fixture(async (action, args) => { calls.push({ action, args: JSON.parse(JSON.stringify(args)) }); if (action === 'clone') return new Promise(resolve => { complete = resolve; }); return { path: args.path }; });
  try {
    assert.deepEqual(view.messages[0].value.projectActions, ['browse', 'project', 'clone']);
    const browse = { type: 'benchgo:project:call', action: 'browse', args: { path: '/srv/exact', url: 'ignored', action: 'delete' }, requestId: 'browse' };
    view.send(browse, view.window); view.send(browse, view.parent, 'https://forged.example'); await flush();
    assert.equal(calls.length, 0);
    view.send(browse); await flush();
    assert.deepEqual(calls, [{ action: 'browse', args: { path: '/srv/exact' } }]);
    assert.equal(view.messages.at(-1).target, origin);
    assert.equal(view.messages.at(-1).value.value.path, '/srv/exact');
    view.send({ ...browse, action: 'management', requestId: 'unsupported' }); await flush();
    assert.match(view.messages.at(-1).value.error, /不支持/); assert.equal(calls.length, 1);
    const clone = { type: 'benchgo:project:call', action: 'clone', args: { url: 'https://github.com/owner/exact.git', path: 'ignored' }, requestId: 'clone' };
    view.send(clone); view.send(clone); await flush();
    assert.equal(calls.length, 2); assert.deepEqual(calls[1].args, { url: 'https://github.com/owner/exact.git' });
    complete({ project: { id: 'opaque:project/id' } }); await flush();
    assert.equal(view.messages.filter(message => message.value.requestId === 'clone').length, 2);
    assert(view.messages.filter(message => message.value.requestId === 'clone').every(message => message.value.value.project.id === 'opaque:project/id'));
  } finally { view.dispose(); }
  assert.equal(view.listeners.size, 0);
});

test('remote delete removes only the verified non-default workspace and deduplicates one confirmed request',async()=>{
 const deleted=[],items=[{workspaceId:'default',path:'/srv/default'},{workspaceId:'opaque/project',path:'/srv/exact'}];let release;
 const host={workspaces:{list:{getSnapshot:()=>({phase:'ready',items})},delete:async id=>{deleted.push(id);await new Promise(resolve=>release=resolve);}}};
 const view=fixture(async()=>{throw Error('delete must use workspaces');},{host,getDefaultProjectId:()=> 'default'});
 try{
  assert.deepEqual(view.messages[0].value.projectActions,['browse','project','clone','deleteProject']);
  for(const [requestId,args,reason] of [['default',{id:'default',path:'/srv/default'},/默认/],['changed',{id:'opaque/project',path:'/srv/changed'},/身份/],['missing',{id:'missing',path:'/srv/exact'},/身份/],['invalid',{id:'opaque/project'},/引用/]]){
   view.send({type:'benchgo:project:call',action:'deleteProject',requestId,args});await flush();assert.match(view.messages.at(-1).value.error,reason);assert.deepEqual(deleted,[]);
  }
  const call={type:'benchgo:project:call',action:'deleteProject',requestId:'confirmed',args:{id:'opaque/project',path:'/srv/exact',deleteFiles:true}};
  view.send(call,view.window);await flush();assert.deepEqual(deleted,[]);
  view.send(call);view.send(call);await flush();assert.deepEqual(deleted,['opaque/project']);
  release();await flush();const replies=view.messages.filter(message=>message.value.requestId==='confirmed');assert.equal(replies.length,2);assert.deepEqual(replies[0].value.value,{deleted:true,id:'opaque/project'});
 }finally{view.dispose();}
 const unknown=fixture(async()=>{}, {host,getDefaultProjectId:()=>undefined});
 try{unknown.send({type:'benchgo:project:call',action:'deleteProject',requestId:'unknown-default',args:{id:'opaque/project',path:'/srv/exact'}});await flush();assert.match(unknown.messages.at(-1).value.error,/默认项目身份尚未就绪/);assert.doesNotMatch(unknown.messages.at(-1).value.error,/默认项目不可删除/);assert.equal(deleted.length,1);}finally{unknown.dispose();}
});

test('cold-start deletion waits for default identity and rechecks the live project before writing', async () => {
  for (const scenario of ['ready', 'default', 'changed', 'disposed', 'failed']) {
    let release, reject, reads = 0;
    const deleted = [], project = { workspaceId: 'opaque/project', path: '/srv/exact' };
    const initialized = new Promise((resolve, fail) => { release = resolve; reject = fail; });
    const host = { workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [project] }) }, delete: async id => { deleted.push(id); } } };
    const view = fixture(undefined, { host, getDefaultProjectId: () => { reads++; return initialized; } });
    try {
      assert(view.messages[0].value.projectActions.includes('deleteProject'));
      const call = { type: 'benchgo:project:call', action: 'deleteProject', requestId: scenario, args: { id: 'opaque/project', path: '/srv/exact' } };
      view.send(call); view.send(call); await flush();
      assert.equal(reads, 1, 'one confirmation shares its pending initialization');
      assert.deepEqual(deleted, []);
      assert.equal(view.messages.length, 1, 'the first confirmation waits rather than failing before initialization');
      if (scenario === 'changed') project.path = '/srv/changed';
      if (scenario === 'disposed') view.dispose();
      if (scenario === 'failed') reject(Error('默认项目初始化失败'));
      else release(scenario === 'default' ? 'opaque/project' : 'default');
      await flush();
      if (scenario === 'ready') {
        assert.deepEqual(deleted, ['opaque/project']);
        assert.deepEqual(view.messages.at(-1).value.value, { deleted: true, id: 'opaque/project' });
      } else {
        assert.deepEqual(deleted, []);
        if (scenario === 'disposed') assert.equal(view.messages.length, 1);
        else assert.match(view.messages.at(-1).value.error, { default: /默认项目不可删除/, changed: /身份已变化/, failed: /默认项目初始化失败/ }[scenario]);
      }
    } finally { view.dispose(); }
  }
});

test('project receiver reports unavailable capabilities and suppresses replies after disposal', async () => {
  const unsupported = fixture();
  unsupported.send({ type: 'benchgo:project:call', action: 'browse', requestId: 'missing' }); await flush();
  assert.deepEqual(unsupported.messages[0].value.projectActions, []);
  assert.match(unsupported.messages.at(-1).value.error, /更新 BenchGo/); unsupported.dispose();
  let finish;
  const view = fixture(() => new Promise(resolve => { finish = resolve; }));
  view.send({ type: 'benchgo:project:call', action: 'project', args: { path: '/srv/exact' }, requestId: 'pending' }); await flush();
  const count = view.messages.length; view.dispose(); finish({ project: { id: 'exact' } }); await flush();
  assert.equal(view.messages.length, count);
});
