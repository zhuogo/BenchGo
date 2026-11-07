import { readFile, writeFile } from 'node:fs/promises';

const base = new URL('./', import.meta.url);
const read = path => readFile(new URL(path, base), 'utf8');
const controlled = JSON.parse(await read('superagent-20261103/conversation/controlled-results.json'));
const real = JSON.parse(await read('superagent-20261103/conversation/real-results.json'));
const context = JSON.parse(await read('superagent-20261103/conversation-context/real-results.json'));
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const rate = report => `${report.scenarios.filter(row => row.status === 'pass').length}/${report.scenarios.length}`;
const rows = [...controlled.scenarios, ...real.scenarios, ...context.scenarios.map(row => ({ ...row, id: `${row.id}-复测` }))];
const tests = await read('conversation-final-tests.tap');
const testCount = tests.match(/tests (\d+)/)?.[1] || '?';
const testPass = tests.match(/pass (\d+)/)?.[1] || '?';
const style = (await read('index.html')).match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
const fixes = [
  ['CHAT-01', '原始执行流进入聊天', '正式回复支持 assistant_reply 或官方 completed 终答；官方日志白名单投影，不追加一次模型调用。', 'plugins/superagent/src/chat-publication.mjs'],
  ['CHAT-02', 'Worker 摘要绕过交付面', '同一次验收生成 deliver/ask/silent；出站以合法 publication 为唯一正文，旧待发记录不重放原文。', 'plugins/superagent/src/result-delivery.mjs'],
  ['CHAT-03', '跨会话通知与旧队列泄露', '原来源隔离；桌面和设备队列统一投影，非法历史通知持久结算，不堵塞队列。', 'plugins/superagent/src/runtime-store.mjs'],
  ['CHAT-04', '旁聊保留独立模型覆盖', '删除 threadConfig 和 thread 配置工具分支；迁移移除历史 models，统一主辅路由；旧持久动作拒绝误写全局。', 'plugins/superagent/src/engine.mjs'],
  ['CHAT-05', '陈旧选项重复执行', '读取持久选项，校验线程、工单版本和状态；稳定请求键保证首次选择，选择只表达意愿。', 'plugins/superagent/src/notification-option.mjs'],
  ['CHAT-06', '其他线程占满当前通知分页', '先按来源筛选再分页，空页推进游标；对应回归通过。', 'plugins/superagent/src/runtime-store.mjs'],
];
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BenchGo · 统一对话交付验收</title><style>${style}</style></head><body><main>
<p><a href="index.html">返回完整评估报告</a></p><h1>SuperAgent 统一对话与交付</h1><p class="intro">2026-11-03 · 工作区集成验收。主旁聊同一模型设置、正式发布边界、来源隔离、工单结果验收与选项回复已接通。官方引擎与参考仓库未修改。</p><p><a href="chat-terminal-fix.md">后续修复 CHAT-07：普通问答终答被过滤；真实用户问法回归与目标能力核对</a>。前述通过率不代表此前已覆盖该问题，详细修复证据单列。</p>
<div class="stats"><div class="stat"><strong>${rate(controlled)}</strong><small>可控模型 / 真实 Harness HTTP</small></div><div class="stat"><strong>${rate(real)} + ${rate(context)}</strong><small>真实供应商首轮 + 上下文复测</small></div><div class="stat"><strong>${testPass}/${testCount}</strong><small>本轮最终定向回归</small></div><div class="stat"><strong>通过</strong><small>reload:plus / 根入口检查</small></div></div>
<section class="panel"><h2>已修复问题与实现出处</h2><table><thead><tr><th>编号</th><th>问题与处理</th><th>源码</th></tr></thead><tbody>${fixes.map(([id, title, resolution, path]) => `<tr><td>${id}</td><td><strong>${title}</strong><p>${resolution}</p></td><td><a href="../${path}">${path.split('/').at(-1)}</a></td></tr>`).join('')}</tbody></table></section>
<section class="panel"><h2>与 DSH 实验经验的关系</h2><p>保留 Router/Worker 权限分工、订阅直通、按线程批处理和代码准入复核；没有放宽执行权限，没有增加 Worker 并发限流。验收与交付正文在同一次模型请求生成，发布后不再请求空回复。</p><p>参考原型版本 6337fc823ce20251c8de8085948165c81aaa701e。DSH Eval 是准入研判，不能等同于 BenchGo 的执行后证据验收。本报告不将合成实验数字当作本地性能收益，也不宣称产品完整度优于原型。</p></section>
<section class="panel"><h2>场景结果</h2><table><thead><tr><th>ID</th><th>场景 / 失败诊断</th><th>结果</th><th>耗时</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escape(row.id)}</td><td>${escape(row.title)}${row.error ? `<p>${escape(row.error)}</p>` : ''}</td><td class="${row.status === 'pass' ? 'pass' : 'fail'}">${escape(row.status || '运行中')}</td><td>${escape(row.durationMs)} ms</td></tr>`).join('')}</tbody></table></section>
<section class="panel"><h2>验证边界与尚未开放能力</h2><ul><li>已委派任务、定时任务按原来源交付。自由主动候选、新机会推送、安静时段与类别偏好尚未开放，未留下无入口框架。</li><li>未进行视觉校验（按用户要求）；聊天附件当前显示附件说明，完整预览不在本轮交付内。</li><li>真实外部渠道收发、操作系统强杀恢复未在本轮重测；渠道格式与错误路径由注入适配器测试覆盖，不能替代真实账号验收。</li><li>历史原始会话日志保留为审计证据，不自动转换成正式聊天回复；用户已有工作区修改保留。</li><li>可控场景首轮 S14 失败来自 mock 将前一轮发布工具回执当作当前回答，已修复 fixture 并完整重跑。不是产品归档故障。</li><li>真实 R02 首轮“请记住口令”120 秒未结束；长期记忆工具本身需要审批，本次未捕获审批状态，不能断言超时原因。限定“仅本轮上下文、不保存长期记忆”后两轮回复通过（${context.scenarios[0]?.durationMs} ms）。首轮失败保留，不用复测覆盖证据。</li></ul></section>
<section class="panel"><h2>证据与复现</h2><p><a href="conversation-final-tests.tap">最终定向测试</a> · <a href="conversation-build.log">构建</a> · <a href="conversation-check.log">入口一致性</a> · <a href="superagent-20261103/conversation/controlled-results.json">30 场景 JSON</a> · <a href="superagent-20261103/conversation/real-results.json">真实模型 JSON</a> · <a href="../docs/06-superagent/设计.md">设计与实施边界</a></p><pre>npm run reload:plus
node eval/run-superagent.mjs --output-dir eval/superagent-20261103/conversation
node eval/run-superagent.mjs --real --output-dir eval/superagent-20261103/conversation
node eval/build-conversation-report.mjs</pre><p>不同测试组存在重叠，不累计成虚高的用例总数。真实模型命令使用已有供应商并产生实际请求；隔离临时运行目录由 finally 清理。</p></section><footer class="footer">生成于 ${new Date().toISOString()}</footer></main></body></html>`;
await writeFile(new URL('conversation.html', base), html);
