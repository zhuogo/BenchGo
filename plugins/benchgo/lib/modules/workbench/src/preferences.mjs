import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applySettingsOps, assertSettingsExpected, notifySettings, settingsSnapshot } from '../../../../shared/settings-adapter-utils.mjs';

export const SIDEBAR_NS = 'benchgo-workbench';
const defaults = {
  autoOpenSubagent: false, autoOpenJobs: false, tasksViewMode: 'tree',
  tasksAutoFoldSettled: true, tasksAutoFoldBranches: true, tasksAutoFoldIdle: true,
  jobsAutoCollapse: true, mobileNoAutoOpen: true, mobileDefaultTree: true,
  agentOpenTools: false, editorExplorer: true, editorGitGutter: true,
  explorerExclude: ['.DS_Store', 'Thumbs.db'], customCss: '',
  htmlViewerNoSandbox: false, htmlViewerDefaultUnsafe: false,
  tabsEnabled: { sidechat: false, subagent: false }, viewersEnabled: {}, pluginSettings: {},
};
export const WORKBENCH_PREFERENCES_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    ...Object.fromEntries(['autoOpenSubagent', 'autoOpenJobs', 'tasksAutoFoldSettled', 'tasksAutoFoldBranches', 'tasksAutoFoldIdle', 'jobsAutoCollapse', 'mobileNoAutoOpen', 'mobileDefaultTree', 'agentOpenTools', 'editorExplorer', 'editorGitGutter', 'htmlViewerNoSandbox', 'htmlViewerDefaultUnsafe'].map(key => [key, { type: 'boolean', default: defaults[key] }])),
    tasksViewMode: { type: 'string', enum: ['tree', 'graph'], default: defaults.tasksViewMode },
    customCss: { type: 'string', maxLength: 32768, default: '' },
    explorerExclude: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 512 }, default: defaults.explorerExclude },
    tabsEnabled: { type: 'object', maxProperties: 128, additionalProperties: { type: 'boolean' }, default: defaults.tabsEnabled },
    viewersEnabled: { type: 'object', maxProperties: 128, additionalProperties: { type: 'boolean' }, default: {} },
    pluginSettings: { type: 'object', maxProperties: 128, additionalProperties: { type: 'object' }, default: {} },
  },
};
export const WORKBENCH_BLOCKED_PATHS = [['agentOpenTools'], ['htmlViewerNoSandbox'], ['htmlViewerDefaultUnsafe'], ['autoOpenSubagent'], ['autoOpenJobs'], ['tabsEnabled', 'sidechat'], ['tabsEnabled', 'subagent']];
export const WORKBENCH_SENSITIVE_PATHS = [['pluginSettings']];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function validatePreferences(patch) {
  if (!object(patch) || Buffer.byteLength(JSON.stringify(patch)) > 65536) throw new Error('工作台设置格式无效或过大');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(WORKBENCH_PREFERENCES_SCHEMA.properties, key)) throw new Error(`不支持的工作台设置：${key}`);
    if (typeof defaults[key] === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} 必须为布尔值`);
    if (key === 'tasksViewMode' && !['tree', 'graph'].includes(value)) throw new Error('任务视图无效');
    if (key === 'customCss' && (typeof value !== 'string' || value.length > 32768)) throw new Error('样式内容过大');
    if (key === 'explorerExclude' && (!Array.isArray(value) || value.length > 128 || value.some(v => typeof v !== 'string' || v.length > 512))) throw new Error('排除规则无效');
    if (['tabsEnabled', 'viewersEnabled', 'pluginSettings'].includes(key)) {
      if (!object(value) || Object.keys(value).length > 128) throw new Error('工作台选项无效');
      if (Object.keys(value).some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) throw new Error('工作台选项键无效');
      if (key !== 'pluginSettings' && Object.values(value).some(v => typeof v !== 'boolean')) throw new Error('启用选项必须为布尔值');
      if (key === 'pluginSettings' && Object.values(value).some(v => !object(v))) throw new Error('扩展选项必须为对象');
    }
  }
  if (patch.agentOpenTools === true || patch.htmlViewerNoSandbox === true || patch.htmlViewerDefaultUnsafe === true) throw new Error('此集成保持预览隔离，模型工具由 BenchGo 统一管理');
  if (patch.tabsEnabled?.sidechat === true || patch.tabsEnabled?.subagent === true || patch.autoOpenSubagent === true || patch.autoOpenJobs === true) throw new Error('对话和任务请使用 BenchGo 现有入口');
  return structuredClone(patch);
}

export async function openPreferences(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'workbench.json');
  let user = {}, revision = 0, pending = Promise.resolve();
  const listeners = new Set();
  try { const saved = JSON.parse(await readFile(path, 'utf8')); user = validatePreferences(saved.value); revision = Number.isSafeInteger(saved.revision) ? saved.revision : 0; }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`工作台设置无法读取：${error.message}`); }
  const snapshot = () => ({ value: { ...structuredClone(defaults), ...structuredClone(user), tabsEnabled: { ...defaults.tabsEnabled, ...user.tabsEnabled } }, revision });
  const configurationSnapshot = () => {
    const value = snapshot().value, override = structuredClone(user);
    const secrets = [{ path: ['pluginSettings'], set: Object.keys(value.pluginSettings || {}).length > 0 }];
    delete value.pluginSettings; delete override.pluginSettings;
    const base = structuredClone(defaults); delete base.pluginSettings;
    return settingsSnapshot(value, revision, { user: override, secrets, base });
  };
  return {
    snapshot,
    settingsSnapshot: configurationSnapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    describe: () => [{ ns: SIDEBAR_NS, ...snapshot(), user: structuredClone(user) }],
    configure: () => () => {},
    update(ns, input, expectedRevision, options = {}) {
      const task = pending.then(async () => {
        if (ns !== SIDEBAR_NS) throw new Error('未知工作台设置');
        if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('设置已被其他页面更新，请重新加载');
        if (options.expected || options.ops) assertSettingsExpected(configurationSnapshot(), options.expected, options.signal);
        const patch = validatePreferences(options.ops ? applySettingsOps(user, options.ops, { blockedPaths: WORKBENCH_BLOCKED_PATHS, sensitivePaths: WORKBENCH_SENSITIVE_PATHS }) : input);
        const next = options.ops ? patch : { ...user, ...patch };
        if (!options.ops) for (const field of ['tabsEnabled', 'viewersEnabled', 'pluginSettings']) if (patch[field]) next[field] = { ...user[field], ...patch[field] };
        const temp = `${path}.${randomUUID()}.tmp`;
        try { await writeFile(temp, JSON.stringify({ revision: revision + 1, value: next }), { mode: 0o600 }); await rename(temp, path); }
        finally { await rm(temp, { force: true }); }
        user = next; revision++; notifySettings(listeners, { namespace: SIDEBAR_NS }); return snapshot();
      });
      pending = task.catch(() => {}); return task;
    },
    flush: () => pending,
  };
}
