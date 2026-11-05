import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadBaselineInstructions } from '@deepseek-ai/dsh-agent-instructions';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const PROJECT_RULE_CANDIDATES = Object.freeze(['.hermes.md', 'AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules']);
const missing = error => ['ENOENT', 'ENOTDIR', 'NOT_FOUND', 'FS_NOT_FOUND'].includes(error?.code);
const contains = (parent, child) => { const path = relative(parent, child); return !isAbsolute(path) && path !== '..' && !path.startsWith(`..\\`) && !path.startsWith('../'); };

async function info(fs, path, signal) {
  try { const target = await fs.resolve(path, { signal }), value = await fs.stat(target, signal); return value && { ...value, target }; }
  catch (error) { signal?.throwIfAborted(); if (missing(error)) return undefined; throw error; }
}

/** Select one source for the applicable directory chain, then let the official
 * loader retain global instructions, same-name merging, bounds and rendering. */
export async function loadProjectRules({ fs, cwd, projectRoot, signal, maxBytes = 32000, dshHome, agentsHome }) {
  cwd = resolve(cwd);
  let root = projectRoot && resolve(projectRoot);
  if (!root) {
    let directory = cwd;
    for (;;) {
      if (await info(fs, join(directory, '.git'), signal)) { root = directory; break; }
      const parent = dirname(directory);
      if (parent === directory) { root = cwd; break; }
      directory = parent;
    }
  }
  if (!contains(root, cwd)) throw new Error('项目规则目录超出项目根目录');
  const directories = [];
  for (let directory = cwd;; directory = dirname(directory)) {
    directories.unshift(directory);
    if (directory === root) break;
  }
  let selected;
  for (const candidate of PROJECT_RULE_CANDIDATES) {
    for (const directory of directories) {
      if ((await info(fs, join(directory, candidate), signal))?.type === 'file') { selected = candidate; break; }
    }
    if (selected) break;
  }
  const selectedKeys = new Set();
  if (selected) for (const directory of directories) {
    const source = await info(fs, join(directory, selected), signal);
    if (source?.size > 1024 * 1024) throw new Error(`项目规则 ${join(directory, selected)} 超出 1 MiB 读取上限`);
    if (source?.type === 'file') selectedKeys.add(source.target.targetKey);
  }
  let readFailure;
  const checkedFs = { resolve: (...args) => fs.resolve(...args), stat: (...args) => fs.stat(...args),
    streamText: async (target, readSignal) => (async function* () {
      try {
        let bytes = 0;
        for await (const chunk of await fs.streamText(target, readSignal)) {
          bytes += Buffer.byteLength(chunk, 'utf8');
          if (selectedKeys.has(target.targetKey) && bytes > 1024 * 1024) throw new Error('项目规则超出 1 MiB 读取上限');
          yield chunk;
        }
      } catch (error) { if (selectedKeys.has(target.targetKey)) readFailure = error; throw error; }
    })(),
  };
  const loaded = await loadBaselineInstructions({ cwd, projectRoot: root, signal, maxBytes, dshHome, agentsHome,
    maxSourceBytes: 1024 * 1024, instructionFileCandidates: selected ? [selected] : [], localInstructionFileCandidates: [] }, checkedFs);
  if (readFailure) throw new Error(`首选项目规则读取失败，未回退到其他文件：${readFailure.message}`, { cause: readFailure });
  // An unreadable/oversize first match must never silently select a lower one.
  return { root, cwd, selected: selected ?? null, text: loaded?.text || '', omitted: loaded?.omitted || [], truncated: loaded?.truncated || [] };
}

/** Scope-local request projection: upstream transcripts stay byte-for-byte intact.
 * The official all-candidate projection is replaced only for this Agent's model
 * requests, while its user-global rules are retained by loadBaselineInstructions. */
export function installProjectRules(scope, agent) {
  if (!scope.systemPrompt?.context) return;
  let text = '', target;
  scope.systemPrompt.context({ name: 'benchgo-project-rules', order: 110, interpolate: false, text: () => text });
  scope.on('tools/result', (execution, result) => {
    if (result.isError || !['read', 'write', 'edit'].includes(execution.name)) return;
    const path = execution.arguments?.file_path;
    if (typeof path === 'string' && path) target = path;
  });
  scope.on('agent/pre-step', async ({ signal }, next) => {
    const fs = scope.get?.('fs'), workingDirectory = scope.get?.('workingDirectory');
    if (!fs || !workingDirectory) { text = 'Project rule selection is unavailable: the host filesystem or working-directory service is missing.'; return next(); }
    const cwd = await workingDirectory.ensure(agent, signal);
    let rules = await loadProjectRules({ fs, cwd, signal });
    if (target) {
      const directory = dirname(resolve(cwd, target));
      if (contains(rules.root, directory)) rules = await loadProjectRules({ fs, cwd: directory, projectRoot: rules.root, signal });
    }
    text = `BenchGo project rule source: ${rules.selected ?? '(none)'}. Applicable directory: ${rules.cwd}. `
      + 'Only the selected filename is the project rule source for this directory; same-name ancestor rules merge from broad to specific. SOUL and the assistant document chain remain independent. User-global rules below remain applicable.\n'
      + rules.text;
    const decision = await next();
    // Use the official durable surface replacement seam, not llm/stream:
    // Harness model requests are frozen and reconstructed from this surface.
    const visible = new Set(agent.session.surface.nodes);
    for (const event of agent.session.snapshotEvents()) {
      if (!visible.has(event.seq) || event.type !== 'user/message') continue;
      const notice = 'Workspace rule projection replaced by the current BenchGo first-match project-rule context.';
      let replacement;
      if (event.data.source?.kind === 'agent-instructions') replacement = { source: { kind: 'benchgo-project-rule-shadow', originalMessageId: event.data.id }, content: [{ type: 'text', text: notice }] };
      if (event.data.source?.kind === 'runtime-context') {
        const previous = event.data.source.sections?.find(section => section.name === 'benchgo-project-rules' && section.text !== notice && section.text !== text);
        if (previous) replacement = { source: { ...event.data.source, sections: event.data.source.sections.map(section => section === previous ? { ...section, text: notice } : section) },
          content: event.data.content.map(block => block.type === 'text' ? { ...block, text: block.text.replace(previous.text, () => notice) } : block) };
      }
      if (!replacement) continue;
      agent.session.append('user/message', createUserMessage(replacement),
      { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] });
    }
    return decision.kind === 'reject' ? decision : { ...decision, messages: decision.messages.filter(message => message.source?.kind !== 'agent-instructions') };
  }, { prepend: true });
}
