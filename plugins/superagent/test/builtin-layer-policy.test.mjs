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
