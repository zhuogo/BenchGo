import { readFile } from 'node:fs/promises';

/** Shared authority for the main conversation and every channel reply. */
export async function readBuiltinLayer(source = new URL('../prompts/builtin-layer.md', import.meta.url)) {
  let document;
  try { document = await readFile(source, 'utf8'); }
  catch (cause) { throw Object.assign(new Error('BenchGo 内置层提示词无法读取，请检查插件文件后重启服务', { cause }), { code: 'BUILTIN_LAYER_UNAVAILABLE' }); }
  const heading = /^# 内置层\s*$/mu.exec(document);
  const body = heading ? document.slice(heading.index).trim() : '';
  if (!body || !body.slice('# 内置层'.length).trim()) throw Object.assign(new Error('BenchGo 内置层提示词正文缺失，请修复插件文件后重启服务'), { code: 'BUILTIN_LAYER_INVALID' });
  return body;
}
