import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as helpers from '../client/sidebar-state.mjs';

const { transformSync } = createRequire(new URL('../package.json', import.meta.url))('esbuild');
const source = transformSync(readFileSync(new URL('../client/index.jsx', import.meta.url), 'utf8') + '\nexport {Projects};export function setFixture(value){defaultWorkspaceId="recent";update(value);}', { loader: 'jsx', format: 'cjs' }).code;

test('real sidebar indexes native ownership once instead of scanning history per official row', t => {
  let reads = 0;
  const ids = Array.from({ length: 500 }, (_, index) => `official-${index}`);
  const native = ids.map((ownerSessionId, index) => ({ id: `native-${index}`, get ownerSessionId() { reads++; return ownerSessionId; }, status: 'idle', updatedAt: index, provider: 'codex' }));
  const sessions = { ids, byId: Object.fromEntries(ids.map((id, index) => [id, { id, title: id, updatedAt: index, blank: false }])) };
  const workspace = { phase: 'ready', items: [{ workspaceId: 'recent', sessionIds: ids }], archivedSessionIds: [] };
  const store = value => ({ getSnapshot: () => value, subscribe: () => () => {} });
  const modules = { harness: true, superagent: false, link: false };
  const react = { createElement: (type, props, ...children) => ({ type, props, children }), useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect() {}, useMemo: calculate => calculate(), useRef: current => ({ current }), useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, localStorage: { getItem: () => null }, require: name => name === 'react' ? react : name.endsWith('sidebar-state.mjs') ? helpers : name.endsWith('modules.mjs') ? { moduleSource: store(modules) } : {} });
  const host = { layout: { panelInfo: store({ activePanelId: null }) }, sessions: { list: store(sessions) }, workspaces: { list: store(workspace) }, uiSession: { sessionStatus: store(new Map()) } };
  module.exports.setFixture({ sessions: native, projects: [], loaded: true });
  const start = performance.now();
  module.exports.Projects({ host, open() {}, newSession() {}, renderSlot: () => null, wide: false });
  t.diagnostic(`500 official + 500 native rows: ${reads} ownership reads, ${(performance.now() - start).toFixed(2)}ms data preparation`);
  assert(reads <= native.length * 3, `ownership access must remain linear, observed ${reads}`);
});
