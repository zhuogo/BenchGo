/** Fixed sources audited against CC Switch 51ac86f. */
const npm = (id, name, packageName, command = id, extra = {}) => ({ id, name, command, packageName, installer: 'npm', platforms: ['linux', 'darwin', 'win32'], configSupported: ['codex', 'claude'].includes(id), chatSupported: true, ...extra });
export const TOOL_CATALOG = Object.freeze([
  npm('claude', 'Claude Code', '@anthropic-ai/claude-code', 'claude', { installArgs: ['--ignore-scripts=false', '--allow-scripts=@anthropic-ai/claude-code'] }),
  npm('codex', 'Codex', '@openai/codex'),
  npm('gemini', 'Gemini CLI', '@google/gemini-cli'),
  npm('grok', 'Grok Build', '@xai-official/grok'),
  npm('opencode', 'OpenCode', 'opencode-ai'),
  npm('pi', 'Pi', '@earendil-works/pi-coding-agent'),
  npm('mcode', 'MiniMax Code', '@minimax-ai/code', 'mcode', { installArgs: ['--ignore-scripts=false', '--allow-scripts=@minimax-ai/code,better-sqlite3'] }),
].map(tool => Object.freeze({ ...tool, platforms: Object.freeze([...tool.platforms]), installArgs: Object.freeze([...(tool.installArgs ?? [])]) })));
export function normalizeToolId(value) {
  if (typeof value !== 'string') throw new Error('Invalid tool id');
  if (!TOOL_CATALOG.some(tool => tool.id === value)) throw new Error('Unknown tool: ' + value.slice(0, 80));
  return value;
}
export function getTool(value) { return TOOL_CATALOG.find(tool => tool.id === normalizeToolId(value)); }
