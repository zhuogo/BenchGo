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

/** Read-only compatibility face for the built-in workbench runtime. */
export async function openPreferences() {
  const snapshot = () => ({ value: structuredClone(defaults), revision: 0 });
  return {
    snapshot,
    describe: () => [{ ns: SIDEBAR_NS, ...snapshot(), user: {} }],
    configure: () => () => {},
    async update() { throw new Error('工作台已内置，使用固定配置，无需设置'); },
  };
}
