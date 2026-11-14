import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('builtin responsibilities require real memory writes and keep Dreams and maintenance within authority', async () => {
  const prompt = await readFile(new URL('../prompts/builtin-layer.md', import.meta.url), 'utf8');
  assert.match(prompt, /主动识别.*耐久事实.*调用现有记忆工具保存/s);
  assert.match(prompt, /保存成功后才说已记住/);
  assert.match(prompt, /纠正事实.*来源.*遗忘工具/s);
  assert.match(prompt, /下次相关场景主动使用/);
  assert.match(prompt, /Dreams.*如何与用户相处/s);
  assert.match(prompt, /不据此新增授权、任务或承诺/);
  assert.match(prompt, /不自动批准候选/);
  assert.match(prompt, /Watchdog 只监督/);
  assert.match(prompt, /不让 Router 轮询驱动整理/);
});

test('project inventory distinguishes Recent and covers outgoing devices without inventing missing coverage', async () => {
  const source = await readFile(new URL('../src/router-tools.mjs', import.meta.url), 'utf8');
  const description = source.match(/register\('assistant_projects', '([^']+)'/)?.[1] ?? '';
  assert.match(description, /isDefault=true identifies Recent \(ungrouped sessions\).*not part of the project count/);
  assert.match(description, /only by isDefault=true, never by a default-workspace name or path/);
  assert.match(description, /general project inventory, also read assistant_devices and query its saved outgoing device IDs/);
  assert.match(description, /explicit local questions need only the local catalog and an explicitly named device needs only that device/);
  assert.match(description, /Follow remaining pages; failures are unknown coverage, not empty catalogs/);
  assert.match(description, /name coverage gaps.*never present the local list.*as all projects/);
  const prompt = await readFile(new URL('../prompts/builtin-layer.md', import.meta.url), 'utf8');
  assert.doesNotMatch(prompt, /isDefault=true|default-workspace/);
});

test('builtin layer speaks as the long-term assistant with concrete conversational craft', async () => {
  const prompt = await readFile(new URL('../prompts/builtin-layer.md', import.meta.url), 'utf8');
  const body = prompt.slice(prompt.search(/^# 内置层$/m));
  assert.match(body, /^# 内置层\n\n你是用户的长期个人助手/);
  assert.match(body, /Router、Worker 和任务编号是内部说法，不用来称呼自己/);
  assert.match(body, /多数回复一两句话就够/);
  assert.match(body, /先给答案.*不复述问题/s);
  assert.match(body, /跟着用户的温度、正式程度和长度走/);
  assert.match(body, /不冒充人类/);
  assert.match(body, /先用一句普通文字以自己的口吻说你正在做什么.*不套固定句式.*不调用 assistant_reply/s);
  assert.match(body, /assistant_react.*不能拿表情代替回答/s);
  assert.match(body, /要问就问一个自然的问题/);
  assert.match(body, /不凑一句“暂无变化”/);
  assert.doesNotMatch(body, /你是 BenchGo 的 Router/);
});
