import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { routerAdmissionLanguagePolicy } from '../src/router-language-policy.mjs';

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
  assert.match(description, /By default aggregate the local catalog and ALL saved outgoing devices, independent of sidebar scope/);
  assert.match(description, /scope=local explicitly reads only local projects/);
  assert.match(description, /local folder or remembered server note cannot establish or disprove a remote device or project/);
  assert.match(description, /Follow remaining pages; failures are unknown coverage, not empty catalogs/);
  assert.match(description, /name coverage gaps.*never present the local list.*as all projects/);
  const prompt = await readFile(new URL('../prompts/builtin-layer.md', import.meta.url), 'utf8');
  assert.doesNotMatch(prompt, /isDefault=true|default-workspace/);
});

test('builtin layer speaks as the long-term assistant with concrete conversational craft', async () => {
  const prompt = await readFile(new URL('../prompts/builtin-layer.md', import.meta.url), 'utf8');
  const body = prompt.slice(prompt.search(/^# 内置层$/m));
  assert.match(body, /^# 内置层\r?\n\r?\n你是用户的长期个人助手/);
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

test('delegation instructions preserve the target device from the first investigation', async () => {
  const prompt = await readFile(new URL('../prompts/builtin-layer.md', import.meta.url), 'utf8');
  assert.match(prompt, /统一使用 assistant_delegate，通过 deviceId 选择本机或远端执行位置/);
  assert.match(prompt, /业务工单始终保存在受理任务的本机/);
  assert.match(prompt, /远端不可用时如实说明，不回退本机执行/);
  assert.match(prompt, /只说项目名.*本机与全部出站设备.*唯一匹配直接沿所属设备/s);
  assert.match(prompt, /发个 hi.*默认在该项目的对话中发送 hi/s);
  assert.match(prompt, /确认配对已包含.*不再次要求逐项授权/s);
  assert.match(prompt, /本机入站设备名单不能说明某个出站服务器是否授权/);
  assert.doesNotMatch(prompt, /从第一次探查起通过 assistant_delegate/);
  const source = await readFile(new URL('../src/router-tools.mjs', import.meta.url), 'utf8');
  const local = source.match(/register\('assistant_delegate', routerAdmissionLanguagePolicy \+ '([^']+)'/)?.[1] ?? '';
  assert.match(local, /business Task on THIS host/);
  assert.match(local, /assistant_devices\(deviceId\) returns workerPreference.config, omit executionConfig/);
  assert.match(local, /all Task IDs, queries, controls, revisions and results remain on this host/);
  assert.doesNotMatch(source, /register\('assistant_remote_task'/);
});

test('assignment text is executable while explicit verbatim and cross-device work survive dispatch', async () => {
  const prompt = await readFile(new URL('../prompts/builtin-layer.md', import.meta.url), 'utf8');
  assert.match(prompt, /宿主保留用户原始消息及来源。Router 将当前委派整理成 Worker 可直接执行的任务。用户明确要求逐字传递的内容，以及必须精确使用的文本、命令和标识，按原样保留。/);
  assert.match(prompt, /通过 `deviceId` 和 `projectId` 完成绑定.*跨设备访问、传输或比较本身是任务要求/);
  assert.match(routerAdmissionLanguagePolicy, /pass verbatim.*text, commands and identifiers/);
  assert.match(routerAdmissionLanguagePolicy, /deviceId and projectId.*cross-device access, transfer or comparison.*authorized scope/);
});
