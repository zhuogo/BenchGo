import { assertSameOrigin, HttpError, readJson } from '../shared/http.mjs';

/** Read the official winning catalog; never scan or mutate provider files. */
export function createSkillsCatalog({ getSkills, getWorkspaces, getPresets = () => undefined }) {
  const summary = skill => Object.fromEntries(['name', 'description', 'whenToUse', 'source', 'provider', 'path', 'invocation', 'resourceBase'].filter(key => skill[key] !== undefined).map(key => [key, skill[key]]));
  return async (input, signal) => {
    signal?.throwIfAborted();
    if (!['list', 'get'].includes(input.action)) throw new HttpError('未知技能操作');
    const registry = getWorkspaces();
    const projects = (registry?.list() ?? []).map(project => ({ id: String(project.id), title: project.title, path: project.path }));
    let scope = { title: '全局技能' };
    if (input.projectId !== undefined) {
      if (typeof input.projectId !== 'string' || !input.projectId) throw new HttpError('项目标识无效');
      const project = projects.find(row => row.id === input.projectId);
      if (!project) throw new HttpError('项目不存在或已移除', 404);
      scope = { projectId: project.id, title: project.title, cwd: project.path };
    }
    const skills = getSkills(), available = typeof skills?.list === 'function' && typeof skills?.get === 'function';
    const options = { ...(scope.cwd ? { cwd: scope.cwd } : {}), signal };
    if (!available) {
      if (input.action === 'list') return { available, skills: [], projects, scope };
      throw new HttpError('官方技能服务尚未启用', 503);
    }
    // Filesystem providers live in the default preset, not the host-global layer.
    // A standing lease reads that composition without creating a session/Agent.
    const lease = await getPresets()?.acquireScope();
    try {
      signal?.throwIfAborted();
      if (lease) options.scope = lease.key;
      if (input.action === 'list') return { available, skills: (await skills.list(options)).map(summary), projects, scope };
      if (typeof input.name !== 'string' || !input.name || input.name.length > 256 || typeof input.provider !== 'string' || !input.provider || input.provider.length > 256) throw new HttpError('技能名称与来源无效');
      const skill = await skills.get(input.name, options);
      if (!skill) throw new HttpError('技能已移除，请刷新目录', 404);
      if (skill.provider !== input.provider) throw new HttpError('同名技能来源已变化，请刷新目录', 409);
      return { skill: { ...summary(skill), content: skill.content } };
    } finally { await lease?.[Symbol.asyncDispose](); }
  };
}

export function mountSkills(ctx) {
  const catalog = createSkillsCatalog({ getSkills: () => ctx.get('skills'), getWorkspaces: () => ctx.get('workspaceRegistry'), getPresets: () => ctx.get('agentPresets') });
  const fetch = async request => {
    try {
      assertSameOrigin(request, { allowDesktopOrigin: true });
      const input = await readJson(request);
      return Response.json(await catalog(input, request.signal), { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      return Response.json({ error: error instanceof HttpError ? error.message : '读取技能失败，请重试' }, { status: error instanceof HttpError ? error.status : 503, headers: { 'cache-control': 'no-store' } });
    }
  };
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/benchgo/skills', methods: ['POST'], requestBody: 'buffered', fetch }));
  return { fetch };
}
