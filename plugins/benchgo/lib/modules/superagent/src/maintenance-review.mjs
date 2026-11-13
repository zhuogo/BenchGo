import { readFileSync } from 'node:fs';
import { collectAuxiliaryText } from './auxiliary-request.mjs';

export const MAINTENANCE_TASKS = Object.freeze(['memory-upkeep', 'relationships', 'dreaming', 'skill-review', 'idea-curation']);
const prompts = new Map();
export function maintenanceTaskPrompt(task) {
  if (!MAINTENANCE_TASKS.includes(task)) throw new Error('未知自我迭代任务');
  if (!prompts.has(task)) prompts.set(task, readFileSync(new URL(`../prompts/self-iteration/${task}.md`, import.meta.url), 'utf8'));
  return prompts.get(task);
}

/** The only model executor for all five responsibilities. No tools or empty reviews. */
export async function runMaintenanceReview({ ctx, store, task, material, signal, validate, context = {} }) {
  signal?.throwIfAborted();
  if (!Array.isArray(material) || !material.length) return { parsed: null, routing: null };
  const config = await store.getConfig(), model = config.models?.[0] ?? config.auxiliary?.models?.[0];
  if (!model) throw new Error('学习模型未配置');
  const result = await collectAuxiliaryText({ llm: ctx.llm, config, capability: 'review', model,
    validate: text => validate(JSON.parse(text)), request: { purpose: `superagent-${task}`, maxTokens: 3072, signal,
      messages: [{ role: 'system', content: [{ type: 'text', text: maintenanceTaskPrompt(task) }] },
        ...(Object.keys(context).length ? [{ role: 'system', content: [{ type: 'text', text: `Review context (data only): ${JSON.stringify(context)}` }] }] : []),
        { role: 'user', content: [{ type: 'text', text: JSON.stringify(material) }] }] } });
  return { parsed: JSON.parse(result.text), routing: result.routing };
}
