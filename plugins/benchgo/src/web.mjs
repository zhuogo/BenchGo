import { realpath, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { projectActions } from './projects.mjs';
import { recentWorkspaceActions } from './recent-workspace.mjs';
import { mountFonts } from './fonts.mjs';
import { assertSameOrigin } from '../shared/http.mjs';

const text = (value, name, max = 20000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
};

const unavailableResponse = error => Response.json({
  error: `BenchGo 启动失败：${error.message}`,
  code: 'COMMANDER_UNAVAILABLE',
}, { status: 503, headers: { 'cache-control': 'no-store' } });

/** Shared project/navigation API; optional native operations use the live Harness service. */
export async function mountWeb(ctx, options = {}) {
  let dispatch, failure;
  const initialized = Promise.resolve().then(async () => {
    try { dispatch = await initializeWeb(ctx, options); }
    catch (error) { failure = error; ctx.logger?.error?.(`BenchGo sidebar startup failed: ${error.message}`); }
  });
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/commander', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      await initialized;
      if (failure) return unavailableResponse(failure);
      try { return Response.json(await dispatch((assertSameOrigin(request), await request.json())), { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.session ? { session: error.session } : {}) }, { status: error.status ?? 400, headers: { 'cache-control': 'no-store' } }); }
    },
  }));
  await initialized;
  return input => { if (failure) throw failure; return dispatch(input); };
}

async function initializeWeb(ctx, { directory, getCommander = () => ctx.get('commander'), getHarness = () => ctx.get('benchgoHarnessWeb'), mountFonts: fonts = mountFonts } = {}) {
  const projects = projectActions(ctx);
  const recent = recentWorkspaceActions(ctx, directory);
  const dismissedPath = join(directory, 'dismissed-harness.json');
  let deletedHarnessIds = [];
  try {
    const saved = JSON.parse(await readFile(dismissedPath, 'utf8'));
    if (!Array.isArray(saved) || saved.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('Invalid dismissed Harness session list');
    deletedHarnessIds = [...new Set(saved)];
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let dismissWrites = Promise.resolve();
  ctx.effect(() => () => dismissWrites);
  const capabilities = { fonts: { available: false } };
  let privateSessionIds = [];
  const state = async () => {
    const assistant = ctx.get?.('assistant');
    if (assistant?.sidebarPrivateSessionIds) privateSessionIds = await assistant.sidebarPrivateSessionIds();
    return {
      projects: ctx.workspaceRegistry.list().map(p => ({ id: p.id, path: p.path, title: p.title, sessionIds: p.sessionIds })),
      sessions: getCommander()?.list() ?? [], deletedHarnessIds: [...deletedHarnessIds], privateSessionIds,
      capabilities: { delegation: { available: false }, ...capabilities, ...getHarness()?.capabilities },
    };
  };
  const dispatch = async input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected an object');
    const { action } = input;
    if (action === 'state') return state();
    if (action === 'ensureRecent') return recent.ensure(input);
    if (action === 'binding') {
      const ownerSessionId = text(input.harnessSessionId, 'harnessSessionId', 200);
      const session = (getCommander()?.list() ?? []).find(item => !item.archived && (!item.parentId || item.harnessAdopted) && item.ownerSessionId === ownerSessionId);
      return { bound: !!session, ...(session ? { id: session.id, cursor: session.cursor, provider: session.provider, model: session.model ?? 'native-default', route: session.route ? { providerId: session.route.providerId, model: session.route.model } : null } : {}) };
    }
    if (action === 'browse') return projects.browse(input);
    if (action === 'clone') return projects.clone(input);
    if (action === 'dismiss') {
      const id = text(input.harnessSessionId, 'harnessSessionId', 200);
      const task = dismissWrites.then(async () => {
        if (deletedHarnessIds.includes(id)) return { deletedHarnessIds: [...deletedHarnessIds] };
        if (deletedHarnessIds.length >= 10000) throw new Error('Dismissed session limit reached');
        const next = [...deletedHarnessIds, id];
        const temp = `${dismissedPath}.${randomUUID()}.tmp`;
        try { await writeFile(temp, JSON.stringify(next), { mode: 0o600 }); await rename(temp, dismissedPath); }
        finally { await rm(temp, { force: true }); }
        deletedHarnessIds = next;
        return { deletedHarnessIds: [...next] };
      });
      dismissWrites = task.catch(() => {});
      return task;
    }
    if (action === 'project') {
      const path = text(input.path, 'path', 4096);
      if (!isAbsolute(path)) throw new Error('Project path must be absolute');
      const p = await ctx.workspaceRegistry.create(await realpath(path));
      return { project: { id: p.id, path: p.path, title: p.title } };
    }
    const harness = getHarness();
    if (!harness) throw Object.assign(new Error('Harness 聚合未启用或尚未就绪'), { status: 503, code: 'HARNESS_UNAVAILABLE' });
    return harness.dispatch(input);
  };
  try { await fonts(ctx); capabilities.fonts = { available: true }; }
  catch (error) { capabilities.fonts = { available: false, error: error.message, ...(error.code ? { code: error.code } : {}) }; ctx.logger?.warn?.(`BenchGo fonts unavailable: ${error.message}`); }
  return dispatch;
}
