import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createModuleSource } from '../client/modules.mjs';
import * as helpers from '../client/sidebar-state.mjs';

const require = createRequire(import.meta.url);
const { transformSync } = require('esbuild');
const source = readFileSync(new URL('../client/index.jsx', import.meta.url), 'utf8');
const code = transformSync(source + '\nexport { Projects, mountSidebarProjects }; export function setSidebarSnapshot(snapshot, defaultId) { data = snapshot; defaultWorkspaceId = defaultId; }', { loader: 'jsx', format: 'cjs' }).code;

function render(activeSessionId, options = {}) {
  const state = [], effects = [], events = new Map(); let cursor = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(child => child !== false && child != null) }),
    useState: initial => { const index = cursor++; if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial; return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }]; },
    useRef: initial => ({ current: initial }), useEffect: effect => effects.push(effect),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  const module = { exports: {} }, moduleSource = createModuleSource();
  moduleSource.update({base: true, harness: true, superagent: true, link: true, ...options.modules});
  runInNewContext(code, { module, exports: module.exports, localStorage: { getItem: () => null }, document: { addEventListener: (name, handler) => events.set(name, handler), removeEventListener() {} }, window: { matchMedia: () => ({ matches: true }) }, require: id => id.endsWith('modules.mjs') ? { moduleSource } : id === 'react' ? react : id.endsWith('sidebar-state.mjs') ? helpers : id.includes('superagent/client') ? { AssistantSidebarEntry: 'AssistantSidebarEntry' } : id.includes('device-launcher') ? { DeviceLauncher: 'DeviceLauncher' } : id.includes('device-switch') ? { DeviceSwitch: 'DeviceSwitch' } : {} });
  const sessions = ['first', 'second', 'third'];
  module.exports.setSidebarSnapshot(options.commander ?? { loaded: true, projects: [{ id: 'recent', isDefault: true, sessionIds: sessions }], sessions: [] }, options.defaultId);
  const snapshot = options.sessionSnapshot ?? { ids: sessions, byId: Object.fromEntries(sessions.map(id => [id, { id, title: id, retainedBy: id === activeSessionId ? { mainView: 1 } : {}, blank: false, running: false }])) };
  const host = {
    layout: { panelInfo: { subscribe: () => () => {}, getSnapshot: () => ({ activePanelId: options.activePanelId ?? null }) } },
    sessions: { list: { getSnapshot: () => snapshot } },
    workspaces: { list: { getSnapshot: () => options.workspaces ?? ({ archivedSessionIds: [] }) } },
    remoteAccess: { source: () => ({ subscribe: () => () => {}, getSnapshot: () => true }) },
    uiSession: { sessionStatus: { getSnapshot: () => options.statuses ?? new Map() } },
    uiWorkspace: { openSession: id => options.onOpenSession?.(id) },
  };
  const renderSlot = (name, owner) => {
    assert.equal(name, 'benchgo.sidebar.session.row.trailing');
    options.onRenderSlot?.(name, owner);
    return options.ticketSessionIds?.includes(owner.sessionId) ? react.createElement('span', { 'aria-label': '工单：真实任务' }, '工单') : null;
  };
  const props = { host, open() {}, newSession: options.newSession ?? (() => {}), wide: options.wide ?? true, expandSidebar() {}, renderSlot, panelNavigation: options.panelNavigation };
  let tree = module.exports.Projects(props);
  if (options.showArchived) {
    effects.forEach(effect => effect());
    events.get('commander:toggle-archive')();
    cursor = 0; tree = module.exports.Projects(props);
  }
  const walk = node => {
    if (!node || typeof node !== 'object') return [];
    let resolved = node;
    while (options.resolveIcons && ['SessionIcon', 'Activity', 'Icon'].includes(resolved?.type?.name)) resolved = resolved.type(resolved.props);
    return resolved ? [resolved, ...resolved.children.flatMap(walk)] : [];
  };
  return walk(tree);
}

test('collapsed sidebar removes the project and conversation content region', () => {
  const nodes = render(undefined, { wide: false });
  assert.equal(nodes.filter(node => node.props.className?.split(' ').includes('cmd-session')).length, 0);
  assert.equal(nodes.filter(node => node.props.className?.split(' ').includes('cmd-sidebar-content')).length, 0);
  assert(nodes.some(node => node.props['aria-label'] === '快捷工具栏'));
});

test('official panel navigation follows quick actions in expanded and collapsed DOM order', () => {
  const panelNavigation = { type: 'nav', props: { 'aria-label': '工具与自动化' }, children: [] };
  for (const wide of [true, false]) {
    const nodes = render(undefined, { wide, panelNavigation });
    const quick = nodes.findIndex(node => node.props['aria-label'] === '搜索对话');
    const panels = nodes.indexOf(panelNavigation);
    assert(quick >= 0 && panels > quick);
    const conversations = nodes.findIndex(node => node.props.className === 'cmd-sidebar-content');
    assert(conversations < 0 || conversations > panels);
  }
});

test('SuperAgent panel hides retained native session selection without deleting it', () => {
  const selected = nodes => nodes.filter(node => node.props.className?.split(' ').includes('is-selected'));
  assert(selected(render('first')).length > 0);
  assert.equal(selected(render('first', { activePanelId: 'benchgo-assistant' })).length, 0);
});

test('optional sidebar entries follow module availability while official chats remain usable', () => {
  const enabled = render('first');
  for (const type of ['AssistantSidebarEntry', 'DeviceLauncher', 'DeviceSwitch']) assert(enabled.some(node => node.type === type));
  const disabled = render('first', { modules: { superagent: false, link: false, harness: false } });
  for (const type of ['AssistantSidebarEntry', 'DeviceLauncher', 'DeviceSwitch']) assert(!disabled.some(node => node.type === type));
  assert(disabled.some(node => node.props.className?.split(' ').includes('cmd-session')));
  assert(disabled.some(node => node.props['aria-label'] === '创建新聊天'));
});

test('loaded sidebar has no selected row while no conversation is open', () => {
  const nodes = render(undefined);
  assert.equal(nodes.filter(node => node.props.className?.split(' ').includes('cmd-session')).length, 3);
  assert.equal(nodes.filter(node => node.props.className?.split(' ').includes('cmd-selected')).length, 0);
  assert.equal(nodes.filter(node => node.props['aria-current'] === 'page').length, 0);
  assert.equal(nodes.filter(node => node.props.className?.split(' ').includes('is-selected')).length, 0);
});

test('restoring and switching current conversation selects exactly one matching row', () => {
  for (const active of ['first', 'second', 'third']) {
    const nodes = render(active), selected = nodes.filter(node => node.props['aria-current'] === 'page');
    assert.equal(selected.length, 1);
    assert(selected[0].children.some(child => child.type === 'span' && child.children.includes(active)));
    assert.equal(nodes.filter(node => node.props.className?.split(' ').includes('cmd-selected')).length, 1);
    assert.equal(nodes.filter(node => node.props.className?.split(' ').includes('is-selected')).length, 1);
  }
});

test('official conversation rows navigate to their own Harness session after selection', () => {
  const opened = [];
  const nodes = render('first', { onOpenSession: id => opened.push(id) });
  const rows = nodes.filter(node => node.props.className?.split(' ').includes('cmd-session'));
  rows[1].props.onClick();
  rows[2].props.onClick();
  assert.deepEqual(opened, ['second', 'third']);
  const selected = render(opened.at(-1)).filter(node => node.props['aria-current'] === 'page');
  assert.equal(selected.length, 1);
  assert(selected[0].children.some(node => node.type === 'span' && node.children.includes('third')));
});

test('official workspaces render projects and conversations before Commander state returns', () => {
  const calls=[],nodes=render('first',{
    commander:{loaded:false,projects:[],sessions:[]},defaultId:'recent',
    workspaces:{phase:'ready',archivedSessionIds:[],items:[{workspaceId:'recent',title:'default',sessionIds:['first','second']},{workspaceId:'fresh',title:'Fresh project',sessionIds:['third']}]},
    newSession:id=>calls.push(id),
  });
  assert(nodes.some(node=>node.type==='span'&&node.children.includes('Fresh project')));
  assert.equal(nodes.filter(node=>node.props.className?.split(' ').includes('cmd-session')).length,2);
  assert.equal(nodes.filter(node=>node.props['aria-current']==='page').length,1);
  assert.equal(nodes.some(node=>node.children.includes('正在读取项目…')),false);
  nodes.find(node=>node.props['aria-label']==='在 Fresh project 新聊天').props.onClick();
  assert.deepEqual(calls,['fresh']);
});

test('Recent, global and project new-chat buttons create independent conversations without touching voice history', async () => {
  const requests=[],opened=[],old={id:'voice-old',blank:true,title:'语音历史',events:[{type:'plugin:benchgo-plugin/voice-conversation',data:{kind:'call-start',callId:'old-call'}}]},projects=[{id:'recent',isDefault:true},{id:'fresh',title:'Fresh project'}];
  const host={workspaces:{},sessions:{create:async request=>{requests.push(request);return 'new-'+requests.length;}},uiWorkspace:{startSession:()=>assert.fail('must not reuse blank session'),openSession:id=>opened.push(id)}};
  const actions=[];
  const nodes=render('voice-old',{
    commander:{loaded:true,projects,sessions:[]},defaultId:'recent',
    workspaces:{phase:'ready',archivedSessionIds:[],items:[{workspaceId:'recent',sessionIds:[old.id]},{workspaceId:'fresh',title:'Fresh project',sessionIds:[]}]},
    sessionSnapshot:{ids:[old.id],byId:{[old.id]:old}},
    newSession:projectId=>actions.push(helpers.startSidebarSession(host,projects,projectId,'recent',async()=>({workspaceId:'recent'}))),
  });
  for(const label of ['最近新聊天','创建新聊天','在 Fresh project 新聊天']){
    nodes.find(node=>node.props['aria-label']===label).props.onClick({stopPropagation(){}});
    await actions.at(-1);
  }
  assert.deepEqual(requests,[{workspaceId:'recent'},{workspaceId:'recent'},{workspaceId:'fresh'}]);
  assert.deepEqual(opened,['new-1','new-2','new-3']);
  assert.equal(old.events[0].data.callId,'old-call');
});

test('ready empty official workspaces clear stale projects and rows', () => {
  const nodes=render(undefined,{workspaces:{phase:'ready',items:[],archivedSessionIds:[]},sessionSnapshot:{ids:[],byId:{}}});
  assert.equal(nodes.filter(node=>node.props.className?.split(' ').includes('cmd-session')).length,0);
  assert.equal(nodes.some(node=>node.children.includes('暂无项目')),true);
});

const sessionRows = nodes => nodes.filter(node => node.props.className?.split(' ').includes('cmd-session'));
const rowTitles = nodes => sessionRows(nodes).map(row => row.children.find(child => child.type === 'span')?.children[0]);

test('private main, side and historical Routers stay out of ordinary lists while Worker and IM stay visible', () => {
  const ids = ['main', 'side', 'old-side', 'worker', 'im'];
  const options = {
    commander: { loaded: true, sessions: [], privateSessionIds: ['main', 'side', 'old-side', 'im'] },
    workspaces: { phase: 'ready', items: [], archivedSessionIds: [] },
    sessionSnapshot: { ids, byId: Object.fromEntries(ids.map(id => [id, { id, title: id, blank: false,
      projectionValues: id === 'im' ? { benchgoChannelSource: { channel: 'feishu' } } : {} }])) },
  };
  assert.deepEqual(rowTitles(render(undefined, options)), ['worker', 'im']);
  options.workspaces.archivedSessionIds = ids;
  assert.deepEqual(rowTitles(render(undefined, { ...options, showArchived: true })), ['worker', 'im']);
  options.workspaces.items = [{ workspaceId: 'project', title: 'Project', sessionIds: ids }];
  assert.deepEqual(rowTitles(render(undefined, { ...options, showArchived: true })), ['worker', 'im']);
});

test('official ungrouped sessions join Recent without attaching a Workspace or duplicating its members', () => {
  const opened = [], nodes = render('second', {
    defaultId: 'recent', onOpenSession: id => opened.push(id),
    workspaces: { phase: 'ready', items: [{ workspaceId: 'recent', sessionIds: ['first'] }, { workspaceId: 'project', title: 'Project', sessionIds: ['third'] }], archivedSessionIds: [] },
  });
  assert.deepEqual(rowTitles(nodes), ['first', 'second']);
  const second = sessionRows(nodes).find(row => row.children.some(child => child.children?.includes('second')));
  assert.equal(second.props['aria-current'], 'page'); second.props.onClick();
  assert.deepEqual(opened, ['second']);
});

test('Recent keeps ungrouped sessions when the ready official Workspace catalog is empty', () => {
  const nodes = render(undefined, { workspaces: { phase: 'ready', items: [], archivedSessionIds: [] } });
  assert.deepEqual(rowTitles(nodes), ['first', 'second', 'third']);
});

test('ungrouped discovery follows list.ids and excludes missing, blank and dismissed catalog rows', () => {
  const records = ['worker', 'blank', 'dismissed', 'not-listed'].map(id => [id, { id, title: id, blank: id === 'blank', retainedBy: {} }]);
  const nodes = render(undefined, {
    commander: { loaded: true, sessions: [], projects: [], deletedHarnessIds: ['dismissed'] },
    workspaces: { phase: 'ready', items: [], archivedSessionIds: [] },
    sessionSnapshot: { ids: ['worker', 'missing', 'blank', 'dismissed'], byId: Object.fromEntries(records) },
  });
  assert.deepEqual(rowTitles(nodes), ['worker']);
});

test('durable voice activity keeps blank official sessions visible, selectable and archivable without showing unused blanks', () => {
  const records=[['call-start',30],['legacy-voice',20],['ungrouped-voice',10]].map(([id,updatedAt])=>[id,{id,blank:true,displayTitle:'default-workspace',updatedAt,retainedBy:id==='legacy-voice'?{mainView:1}:{},projectionValues:{benchgoVoice:{used:true,startedAt:updatedAt,lastActivityAt:updatedAt}}}]);
  const options={defaultId:'recent',commander:{loaded:true,projects:[],sessions:[]},workspaces:{phase:'ready',items:[{workspaceId:'recent',sessionIds:['call-start','legacy-voice','unused']}],archivedSessionIds:[]},sessionSnapshot:{ids:[...records.map(([id])=>id),'unused'],byId:{...Object.fromEntries(records),unused:{id:'unused',blank:true,projectionValues:{benchgoVoice:null}}}}};
  const nodes=render('legacy-voice',options),rows=sessionRows(nodes);
  assert.equal(rows.length,3);assert.deepEqual(rowTitles(nodes),['语音对话','语音对话','语音对话']);
  assert.equal(rows.filter(node=>node.props['aria-current']==='page').length,1);
  assert.equal(nodes.filter(node=>node.props['aria-label']==='归档对话').length,3);
  assert.equal(sessionRows(render(undefined,{...options,showArchived:true,workspaces:{...options.workspaces,archivedSessionIds:['legacy-voice']}})).length,1);
  assert.equal(sessionRows(render(undefined,{...options,commander:{...options.commander,deletedHarnessIds:['call-start']}})).length,2);
});

test('ungrouped and default Workspace rows share official pin and recent activity ordering', () => {
  const nodes = render(undefined, {
    defaultId: 'recent', workspaces: { phase: 'ready', items: [{ workspaceId: 'recent', sessionIds: ['default'] }, { workspaceId: 'project', sessionIds: ['project'] }], archivedSessionIds: [], pinnedSessionIds: ['pinned'] },
    sessionSnapshot: { ids: ['old', 'default', 'pinned', 'new', 'project'], byId: Object.fromEntries([
      ['old', 10], ['default', 30], ['pinned', 1], ['new', '2026-11-08T00:00:00Z'], ['project', 100],
    ].map(([id, updatedAt]) => [id, { id, title: id, updatedAt, blank: false, retainedBy: {} }])) },
  });
  assert.deepEqual(rowTitles(nodes), ['pinned', 'new', 'default', 'old']);
});

test('recent voice activity sorts beside text prompts and preserves pin priority', () => {
  const records=[{id:'voice',title:'Voice',blank:true,updatedAt:1,projectionValues:{benchgoVoice:{used:true,lastActivityAt:50}}},{id:'text',title:'Text',blank:false,updatedAt:30},{id:'pinned',title:'Pinned',blank:false,updatedAt:2}];
  const nodes=render(undefined,{defaultId:'recent',workspaces:{phase:'ready',items:[{workspaceId:'recent',sessionIds:records.map(row=>row.id)}],archivedSessionIds:[],pinnedSessionIds:['pinned']},sessionSnapshot:{ids:records.map(row=>row.id),byId:Object.fromEntries(records.map(row=>[row.id,row]))}});
  assert.deepEqual(rowTitles(nodes),['Pinned','Voice','Text']);
});

test('ungrouped rows follow the official archive set and retain their own navigation identity after restore', () => {
  const base = { defaultId: 'recent', workspaces: { phase: 'ready', items: [{ workspaceId: 'recent', sessionIds: ['first'] }], archivedSessionIds: ['second'] } };
  assert.deepEqual(rowTitles(render(undefined, base)), ['first', 'third']);
  const archived = render(undefined, { ...base, showArchived: true });
  assert.deepEqual(rowTitles(archived), ['second']);
  assert(archived.some(node => node.props['aria-label'] === '取消归档对话'));
  assert.deepEqual(rowTitles(render('second', { ...base, workspaces: { ...base.workspaces, archivedSessionIds: [] } })), ['first', 'second', 'third']);
});

test('an archived project never captures ungrouped rows through two absent cwd fields', () => {
  const nodes = render(undefined, { showArchived: true, defaultId: 'recent',
    workspaces: { phase: 'ready', items: [{ workspaceId: 'recent', sessionIds: ['first'] }, { workspaceId: 'project', title: 'Project', sessionIds: ['third'] }], archivedSessionIds: ['second', 'third'] },
  });
  assert.deepEqual(rowTitles(nodes), ['third', 'second']);
});

test('custom sidebar renders its own trailing slot for default and ungrouped sessions', () => {
  const calls = [], nodes = render(undefined, { ticketSessionIds: ['second'], onRenderSlot: (name, owner) => calls.push([name, owner.sessionId]),
    defaultId: 'recent', workspaces: { phase: 'ready', items: [{ workspaceId: 'recent', sessionIds: ['first'] }], archivedSessionIds: [] },
  });
  assert.deepEqual(calls, ['first', 'second', 'third'].map(id => ['benchgo.sidebar.session.row.trailing', id]));
  assert.equal(nodes.filter(node => node.props['aria-label'] === '工单：真实任务').length, 1);
});

test('custom sidebar registers its own extension ownership without reading or replacing official components', () => {
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, require: id => id === 'react' ? { createElement: (type, props) => ({ type, props }) } : {} });
  const open = () => {}, newSession = () => {};
  let registration, component, removed = false;
  const host = { slots: {
    entries: () => assert.fail('must not inspect or mutate official components'),
    inject: (name, setup) => { assert.equal(name, 'sidebar.workspaces'); return setup(); },
    register: (options, view) => { registration = options; component = view; return () => { removed = true; }; },
  } };
  const dispose = module.exports.mountSidebarProjects(host, open, newSession);
  assert.equal(component, module.exports.Projects); assert.equal(registration.priority, -10);
  assert.deepEqual(Object.keys(registration.children), ['benchgo.sidebar.session.row.trailing']);
  assert.deepEqual({ ...registration.children['benchgo.sidebar.session.row.trailing'] }, { kind: 'list', scope: 'root', inline: true });
  const injected = registration.inject();
  assert.equal(injected.host, host); assert.equal(injected.open, open); assert.equal(injected.newSession, newSession);
  dispose(); assert.equal(removed, true);
});

test('live official sessions light their workspace without adding a global toolbar indicator', () => {
  for (const [status, expected] of [[{}, undefined], [{ running: true }, 'running'], [{ running: true, pendingInteraction: true }, 'waiting']]) {
    const nodes = render(undefined, {
      defaultId: 'recent', statuses: new Map([['third', status]]),
      workspaces: { phase: 'ready', items: [{ workspaceId: 'recent', sessionIds: ['first', 'second'] }, { workspaceId: 'project', title: 'Project', sessionIds: ['third'] }] },
    });
    const activity = nodes.filter(node => node.props.className === 'cmd-project-activity');
    assert.equal(activity.length, expected ? 1 : 0);
    assert.equal(activity[0]?.props.status, expected);
    const toolbar = nodes.find(node => node.props['aria-label'] === '快捷工具栏');
    const labels = toolbar.children.map(node => node.props?.['aria-label'] ?? node.props?.label);
    assert.ok(labels.includes('新聊天') && labels.includes('搜索对话'), 'new chat and search remain');
    assert.equal(toolbar.children.some(node => node.props?.status !== undefined), false, 'workspace activity never reaches the toolbar');
  }
});

test('Recent shows activity for its default workspace', () => {
  const nodes = render(undefined, { statuses: new Map([['first', { pendingInteraction: true }]]) });
  const label = nodes.find(node => node.props.className === 'cmd-section-label');
  assert.equal(label.children.find(node => typeof node === 'object')?.props.status, 'waiting');
});

test('session list exposes unread completed, running and waiting icons without keeping workspace activity lit after completion', () => {
  const nodes=render(undefined,{statuses:new Map([['first',{running:false,completionUnread:true}],['second',{running:true}],['third',{running:true,pendingInteraction:{kind:'question'}}]])});
  const rows=nodes.filter(node=>node.props.className?.split(' ').includes('cmd-session'));
  assert.deepEqual(rows.map(row=>row.children.find(child=>typeof child==='object')?.props.status),['completed','running','waiting']);
  const completed=render(undefined);
  assert.equal(completed.some(node=>node.props.className==='cmd-project-activity'),false);
  assert.equal(completed.find(node=>node.props.className==='cmd-section-label').children.filter(child=>typeof child==='object').length,0);
});

test('reading a completed session restores its original tool icon', () => {
  const unread = render(undefined, { resolveIcons: true, statuses: new Map([['first', { running: false, completionUnread: true }]]) });
  assert.equal(unread.filter(node => node.props.className?.includes('cmd-status-completed')).length, 1);
  assert.equal(unread.filter(node => node.props.className === 'cmd-icon cmd-deepseek').length, 2);
  // The official main view acknowledges completionUnread when the user opens the session.
  const read = render('first', { resolveIcons: true, statuses: new Map([['first', { running: false, completionUnread: false }]]) });
  assert.equal(read.filter(node => node.props.className?.includes('cmd-status-completed')).length, 0);
  assert.equal(read.filter(node => node.props.className === 'cmd-icon cmd-deepseek').length, 3);
  const restored = render(undefined, { resolveIcons: true });
  assert.equal(restored.filter(node => node.props.className?.includes('cmd-status-completed')).length, 0, 'historical stopped sessions are not automatically unread');
  assert.equal(restored.filter(node => node.props.className === 'cmd-icon cmd-deepseek').length, 3);
});

test('read coding agent sessions restore their provider icon too', () => {
  const commander = { loaded: true, projects: [{ id: 'recent', isDefault: true, sessionIds: ['first'] }], sessions: [{ id: 'native-first', ownerSessionId: 'first', projectId: 'recent', provider: 'codex', status: 'idle', turnId: 'finished' }] };
  const unread = render(undefined, { commander, resolveIcons: true, statuses: new Map([['first', { completionUnread: true }]]) });
  assert.equal(unread.filter(node => node.props.className?.includes('cmd-status-completed')).length, 1);
  const read = render('first', { commander, resolveIcons: true, statuses: new Map([['first', { completionUnread: false }]]) });
  assert.equal(read.filter(node => node.props.className?.includes('cmd-status-completed')).length, 0);
  assert.equal(read.filter(node => node.props.className === 'cmd-icon cmd-codex').length, 1);
});

test('archived and dismissed official sessions do not keep workspace activity visible', () => {
  for (const archived of [true, false]) {
    const nodes = render(undefined, {
      defaultId: 'recent', statuses: new Map([['third', { running: true }]]),
      commander: { loaded: true, sessions: [], projects: [], deletedHarnessIds: archived ? [] : ['third'] },
      workspaces: { phase: 'ready', archivedSessionIds: archived ? ['third'] : [], items: [{ workspaceId: 'project', sessionIds: ['third'] }] },
    });
    assert.equal(nodes.some(node => node.props.className === 'cmd-project-activity'), false);
  }
});

test('archived project and recent sessions expose only unarchive and delete buttons', () => {
  const nodes = render(undefined, { showArchived: true,
    commander: { loaded: true, projects: [], sessions: [{ id: 'native', title: 'Native', provider: 'codex', archived: true, status: 'disconnected', projectId: 'project' }] },
    workspaces: { phase: 'ready', archivedSessionIds: ['first', 'second'], pinnedSessionIds: ['first'], items: [{ workspaceId: 'project', path: '/project', title: 'Project', sessionIds: ['first'] }, { workspaceId: 'recent', path: '/recent', title: 'Recent', isDefault: true, sessionIds: ['second'] }] },
  });
  const rows = nodes.filter(node => node.props.className?.split(' ').includes('cmd-session-row'));
  assert.equal(rows.length, 3);
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
  for (const row of rows) {
    assert(row.props.className.includes('is-archived'));
    const children = walk(row), actions = children.filter(node => node.type === 'button' && node.props.className?.includes('cmd-session-quick'));
    assert.deepEqual(actions.map(node => node.props['aria-label']), ['取消归档对话', '删除对话']);
    assert(children.some(node => node.props.name === 'unarchive'));
    assert(!children.some(node => node.props.className === 'cmd-session-more'));
  }
});
