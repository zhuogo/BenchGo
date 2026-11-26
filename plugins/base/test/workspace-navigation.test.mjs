import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ClientWorkspaceModel } from '../../../deepseek-harness/packages/api/workspace-controller/lib/types/client/model.js';
import { LayoutController } from '../../../deepseek-harness/packages/client/ui-layout/lib/types/client/service.js';
import { UiWorkspaceService } from '../../../deepseek-harness/packages/client/ui-workspace/lib/types/client/navigation.js';
import { preservePanelOnSessionArchive } from '../client/workspace-navigation.mjs';

const requireWorkspace = createRequire(new URL('../../../deepseek-harness/packages/client/ui-workspace/package.json', import.meta.url));
const { Context } = await import(pathToFileURL(requireWorkspace.resolve('@deepseek-ai/cordis')).href);
const { createSnapshotStore } = await import(pathToFileURL(requireWorkspace.resolve('@deepseek-ai/dsh-client-store')).href);

function fixture(t) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const panels = createSnapshotStore({ activePanelId: null });
  const layout = new LayoutController({
    selectPanel: activePanelId => panels.set({ activePanelId }),
  }, () => true, panels);
  ctx.provide('layout', layout);
  ctx.provide('uiSession', { sessionStatus: createSnapshotStore(new Map()) });
  const list = createSnapshotStore({ phase: 'pending', byId: {} });
  const sessions = {
    list,
    subagentAddress: () => undefined,
    retain(sessionId) {
      list.update(state => { state.byId[sessionId].retainedBy.mainView = 1; });
      return {
        sessionId,
        release() { list.update(state => { delete state.byId[sessionId].retainedBy.mainView; }); },
      };
    },
  };
  for (const id of ['worker', 'other']) {
    list.update(state => { state.byId[id] = { id, retainedBy: {} }; });
  }
  const workspaces = { list: new ClientWorkspaceModel() };
  const workspace = new UiWorkspaceService(ctx, {}, workspaces, sessions, {}, () => {}, createSnapshotStore(0));
  const stop = preservePanelOnSessionArchive({ layout, sessions, workspaces });
  t.after(stop);
  const archive = async (...ids) => { workspaces.list.replaceArchived(ids); await Promise.resolve(); };
  return { layout, workspace, list, archive, stop, panel: () => layout.panelInfo.getSnapshot().activePanelId };
}

test('a workspace archive clears the hidden Worker selection and preserves the current panel', async t => {
  const { layout, workspace, list, archive, panel } = fixture(t);
  workspace.openSession('worker');
  layout.selectPanel('benchgo-assistant');
  await archive('unrelated');
  assert.equal(list.getSnapshot().byId.worker.retainedBy.mainView, 1);
  await archive('unrelated', 'worker');
  assert.equal(list.getSnapshot().byId.worker.retainedBy.mainView, undefined);
  assert.equal(panel(), 'benchgo-assistant');

  workspace.openSession('other');
  assert.equal(panel(), null);
});

test('archiving the visible native conversation and navigating after disposal both use the official fallback', async t => {
  const { layout, workspace, list, archive, stop, panel } = fixture(t);
  workspace.openSession('worker');
  await archive('worker');
  assert.equal(list.getSnapshot().byId.worker.retainedBy.mainView, undefined);
  assert.equal(panel(), null);

  workspace.openSession('other');
  layout.selectPanel('schedules');
  stop();
  await archive('worker', 'other');
  assert.equal(panel(), null);
});
