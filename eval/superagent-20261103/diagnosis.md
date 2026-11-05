# SuperAgent 本地评估诊断

## D04 · P1 · 执行成功，但工具证据未传给验收器

现象：R06 的 result.txt 实际存在，磁盘内容精确为 VERIFIED_391；Worker 文字称已 write/read，checkpoint 为 2 文件、43 字节。但验收返回 wait，理由为没有可核验的 write/read 记录。待确认通知已送达，任务未达到通过验收的完成条件。 针对性复现再次出现 wait；对相同执行结果重审后 resultVersion 从 1 增至 2，仍为 wait，未重新执行任务。

原因：assignment-executor 读取完整会话后只取 executionEvidence 的 summary 和 transcript。executionEvidence 仅汇总 assistant/message 文本与整段日志哈希；工具调用及返回值未进入 result。ticket-review 把该 result 序列化给纯文本审查模型，模型既拿不到日志内容，也没有工具去解引用 sessionId。文件清单同样只有摘要哈希、总数和字节数，不能证明指定文件内容。

影响：形成真实产物已完成但被卡在待确认的假阴性，阻断文件任务自动闭环。重审流程仍传 saved result，若不补证据，同样存在反复等待风险。 本次诊断已执行同版本重审，详细结果见诊断原始记录。

建议：最小修复应在公共证据提取处生成有界 tool/call 与 tool/result 证明：工具名、callId、成功/失败、路径、读回内容或摘要、产物路径和校验值；由服务核验后传入首次验收及重审，不能仅在提示词里要求“相信Worker”。保留当前磁盘/日志身份校验，外部内容仍按不可信数据处理。新增“真实write/read可通过、仅口头声称不可通过、失败工具不得被摘要伪装成功”三组对照回归。

证据：real-artifact-diagnostic.json

源码：plugins/superagent/src/assignment-executor.mjs:204；plugins/superagent/src/execution-evidence.mjs:16；plugins/superagent/src/ticket-review.mjs:14；plugins/superagent/src/review-continuation.mjs:22

可信度：高：实际磁盘结果、审查明确理由和源码传参链一致；未修改产品源码。

## D01 · P2 · 活动面板测试引用已失效

现象：全量测试 activity-panel.test.mjs 失败：把 activity-panel.jsx 源码拼接 export { task }，但该模块已无 task；活动数据映射已迁移到 activity-data.mjs 的 activityTask。

原因：测试依赖旧内部变量和源码转译，而非当前公共函数，属于测试与重构不同步。

影响：npm run test:superagent 不能全绿；此失败本身不证明活动面板运行故障。

建议：改为直接 import { activityTask as task } from ../client/activity-data.mjs，移除只为旧转换使用的 fs/vm/esbuild 导入，再运行这两项断言。

证据：baseline.tap

源码：plugins/superagent/test/activity-panel.test.mjs:9；plugins/superagent/client/activity-data.mjs:4

可信度：高：基线失败和当前源码一致；子代理内存替换后原两项断言通过，未落产品修复。

## D02 · P2 · Host Schedule 测试受并发负载影响

现象：全量并发时 schedule-host 测试超过 20 秒上限，被取消；独立重跑成功，测试体耗时 1.907 秒。

原因：官方引擎重型测试与其他测试竞争资源；单次独立通过支持负载敏感判断，但尚不能排除偶发问题。

影响：CI 存在不稳定风险，不应把这次超时直接定性为产品定时任务故障。

建议：保留事实记录；按用户决策，本次不增加并发限流或开展上游负载治理。

证据：schedule-host-rerun.tap

源码：plugins/superagent/test/schedule-host.test.mjs:20

可信度：中：一次全量超时与一次独立通过；未做压力统计。

## D03 · P2 · 辅助能力说明与可达入口不一致

现象：README 声称“视觉及独立摘要尚未接入”，但 service 已有 summarize/analyzeImage，且摘要在本次真实 HTTP 调用成功。SuperAgent client 与 Link src 检索不到上述 action 调用。

原因：后端实现、产品说明和专用 UI 操作入口未同步。聊天工具有 assistant_summarize/assistant_analyze_image，不等于已有专用按钮路径。

影响：能力边界容易被误解；专用客户端入口覆盖尚未证明。

建议：先更新已实现能力说明，明确聊天工具入口与专用 UI 的差别；若产品承诺按钮操作，补上完整路径并验证。

证据：controlled-results.json

源码：plugins/superagent/README.md:37；plugins/superagent/src/service.mjs:590；plugins/superagent/src/auxiliary-operations.mjs:14

可信度：高（文档矛盾）；中（专用 UI 缺口为静态检索结论，未点击验证）。

## 未覆盖边界

- 30 个主场景使用可控供应商，通过真实网络、官方引擎和数据库执行；它们验证服务契约和状态，不测模型智能。另列真实模型场景，不混算质量分。
- 真实模型保留本机明确选择的 deepseek-v4.1-flash；隔离 profile 的 providerId 为 assistant-smoke，baseURL/API协议/模型ID沿用现有配置。没有改写供应商模型别名。
- 每个真实场景仅单次样本；没有置信区间、成本估计、重复稳定性结论或广泛模型排行榜。耗时是整个场景墙钟时间，不是首Token或单次模型推理延迟。
- R07 中 Worker 实际拒绝诱导虚假声明，验收也拒绝缺失产物；这证明该次整体路径拒绝了无产物任务，不能单独证明 Reviewer 能识别所有恶意伪造摘要。诊断重跑单列证据，不加入成功率分母。
- 未操作桌面和移动端 UI；按用户要求没有视觉校验。未连接真实飞书/邮件/QQ等外部渠道，也未向他人发送消息。桌面交付指隔离实例的本地通知队列 sent。
- 主会话 reset 已覆盖，操作系统进程崩溃后的全链路恢复未做本次专门注入；相关恢复单测通过不能代替真实重启验收。
- 实际文件写入只发生在本次临时 Git 工作树；本次没有修改产品源代码、官方子模块或用户业务配置。测试进程和临时目录由 finally 清理。