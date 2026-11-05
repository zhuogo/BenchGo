# P0 隔离真实运行

复用官方 CLI/Web loader 和 BenchGo 唯一插件，读取现有 SuperAgent 首选供应商与精确模型 ID。凭据只在内存和子进程环境中使用，不写入记录。不启动图形应用，不改现有运行实例或用户数据。

准备检查不发模型请求：

```powershell
node eval/superagent-p0-20261105/run-live.mjs
```

集成准备好后执行：

```powershell
node eval/superagent-p0-20261105/run-live.mjs --run
```

可用 `--case no-files|fourteen|router-block|worker-block` 单独重跑；用 `--output-dir` 保留不同运行记录。新闻日期固定为 2026-11-04。每场景默认最多 12 分钟，失败就停止余下场景，防止隔离控制条件串场。

额外的 `--case router-stream` 观察官方 `agent/assistant-stream` 实时事件，检查至少两次增长的普通文字增量且首段早于持久化终结。不用终答轮询冒充流式，不记录 reasoning 内容或工具参数。此检查证明真实供应商与官方事件源；前端最终视觉由用户验收。

`fourteen` 及两种阻塞属于明确标注的受控场景，模型、网络工具、验收和持久运行时均为真实调用。`worker-controls.mjs` 只在隔离 Worker 的首轮输入追加独立来源的控制条件；不修改 Mandate、验收、结果、日志或 review，也不伪造通过。

重点检验 Router review 的 Attention；额外记录原生 Worker 问答链。回答由隔离测试用户给出“AI 科技优先”的真实选择，通过正式 `ticketAnswer` 入口提交。没有生成真实 Attention 就判失败。

输出的 `results.json`、各场景 `*-evidence.json` 与 `*-progress.json` 保留任务、验收、续做身份、交付回执和原聊天通知；`worker-controls.jsonl` 保留控制条件；`loader.log` 脱敏。不会把定向测试或受控条件称作自然发生。运行结束停止本脚本启动的子进程并移除独立临时用户目录。

若真实运行明确进入 `EXECUTION_BUDGET_EXHAUSTED` 且该系统状态已回原聊天，脚本按本次获准的隔离测试用户动作明确记录一次“增加10分钟并继续”，调用正式 `ticketResume`；不自动增加 Goal 配额，不处理未知外效、撤权等其他门禁。记录额度前后原 Run/session、已有工具统计及官方会话前缀哈希的一致性。`observe-session.mjs` 只读隔离目录的官方日志统计，不输出正文、reasoning、工具参数或网页内容。
