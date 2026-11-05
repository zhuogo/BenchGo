# DeepSeek SuperAgent 原型与 BenchGo 对照

审查日期：2026-11-03。范围：只读代码与测试审查；没有运行参考仓库，没有修改产品实现。

## 参考版本与定位

- 本地目录：`reference/dsh-superagent-prototype/`
- origin：<https://github.com/deepseek-ai/dsh-superagent-prototype.git>
- commit：`6337fc823ce20251c8de8085948165c81aaa701e`，2026-10-31。
- README 明确：DeepSeek 团队发布的研究原型，**不是正式 DeepSeek 产品，也不承诺生产就绪**；公开实现不等于内部版本，也不等于研究文章中的全部设计。
- 原型主要面向单个 GitHub 仓库，通过 GitHub/飞书接收触发；BenchGo 是多项目、桌面优先的个人助手。机制可以借鉴，产品流程不能整体照搬。

## 结论

最值得立即借鉴的是**可读取的真实执行证据与按需展开方式**。这直接对应本次 R06：文件存在且内容正确，但我们的验收器只看到文字总结和哈希，无法核验工具结果。

原型没有与 BenchGo 同样的独立执行后验收器。因此不能宣称“官方已经实现了我们的验收方案”，也不能通过取消现有验收门槛来消除失败。

## 已实现机制与我们的差异

| 项目 | 参考原型实际实现 | BenchGo 现状 | 借鉴判断 |
| --- | --- | --- | --- |
| 原始执行证据 | `src/app/context.ts:29` 的 `transcriptEntry` 保留 user/message、assistant/message、tool/result，只过滤 reasoning 等非必要内容 | `execution-evidence.mjs:16` 只提取助手文字和日志 hash；Worker result 中主要是 summary、transcript、session/run 引用、checkpoint | **最高优先级**：补工具证据投影；保留现有身份和产物校验 |
| 按需读证据 | `src/app/resources.ts:114` 通过官方 sessionController.inspect 读会话；`:272` 读单条消息；`:283` 返回短预览、长度和 read 引用 | 已有工单列表分页及 ownerSessionId 隔离；`desktop-ticket-access.mjs:9` 返回数据库中的结果，但不等于给验收器读取实际工具日志 | 复用现有服务和授权边界，避免新增独立证据数据库或插件 |
| 上下文体积控制 | `src/app/tools/tool.ts:23`：文本默认 4000 字符、最多 8000；列表默认 20、最多 50；使用 offset/next_offset | 验收通过 `ticket-review.mjs:14` 一次性序列化 result；`auxiliary-request.mjs:18` 明确 `tools: []` | **不能只加 read 引用**：当前验收器没有工具，第一阶段应由宿主直接提供有界核心证据 |
| 用户跟进优先 | `src/executor/dsh.ts:171` 的 WorkerSlots 为用户消息保留额外一个唤醒槽，启动前同步预留，避免抢占竞争 | `assignment-worker.mjs:77` 按 configured − active.size 领取任务；尚未看到相同的人类唤醒专用槽 | 值得补满负载用户跟进测试；确认需求后再决定优先队列或有限额外容量，不直接突破预算 |
| 后台工作的生命周期 | `docs/003-execution.md` 与 executor 实现区分回合结束、后台 job/subagent 仍运行、人工交接、Assignment 终止 | `assignment-executor.mjs:187` 等待 whenIdle 后取日志；该段未显式展示相同后台工作聚合规则 | **待专项验证**，不是已确认 Bug；不能把 agent idle 直接等同于所有后台工作结束 |
| 副作用与并发陈旧结果 | `src/app/effects.ts:38` 使用 seq/generation，副作用事务内持久化、提交后执行 | 已有 SQLite 工单、fence/lease、原子 commitResult 与 outbox | 已有同类基础能力；借鉴竞态测试，不引入第二套 Effects 框架 |

## 如何用于修复 BUG-01

以下是**待实施的 BenchGo 适配方案**，不是原型现成功能。

### 第一阶段：最小修复

1. 复用 `ctx.sessionQuery.readSession(sessionId)`。`assignment-executor.mjs:204` 已经拿到了真实日志，无需从磁盘手工解压会话，也不必新建存储系统。
2. 在现有公共证据模块中，保留与真实工具调用对应的 `tool/result`：原始工具名、关联标识、事件序号、返回内容、失败状态，以及可获得的产物路径/校验信息。工具和协议值保持原样，不猜别名、不把任意文本解析成“成功”。过滤 reasoning；敏感值使用现有隐私处理能力。
3. 将任务相关的有界证据交给当前纯文本验收器。明确记录截断、证据是否完整；证据不完整时保留 wait，不能让哈希冒充内容。
4. 首次验收和重新验收复用同一投影函数。旧结果只有 hash 时，重审应在 `withRecoveredEvidence` 核验原日志身份后，从该日志重建证据，**不重新执行 Worker**。
5. 证据绑定 `ticketId/runId/sessionId/instructionRevision/resultVersion` 和对应日志边界；保留已有 transcript hash、checkpoint、权限和 fence 校验，不能混入后续回合或其他工单的数据。

### 第二阶段：必要时增加按需读取

长日志可以参考原型的“索引 → 单条证据 → 分页”方式，在现有工单服务内提供受控读取。

但只有当验收执行器具备受控只读工具能力时，才适合让模型自己沿引用读取。当前 `collectAuxiliaryText` 强制 `tools: []`；只在 JSON 中新增一个链接不会修复当前 Bug。第一阶段不必为了分页升级成新的 Agent 循环。

## 不能照搬的设计

### ready 不等于独立验收通过

原型 `src/core/assignments.ts:129`：没有关联 follow 时，Worker 的 ready 报告可以直接结束工单为 completed；有 follow 时还要等待对应线程完成。`prompts/work.md` 要求真实验证和诚实报告，但提示词约定不是独立产物强校验。

原型的 `Eval` 主要指触发消息是否应被接纳、是否有授权，不等同于我们执行后的结果验收。

### 不照搬无审批执行、自动恢复重跑

`docs/003-execution.md` 明确 Executor 以操作者 OS 身份无审批运行命令，命令包装和工作目录不是安全边界。我们的 Router/Worker 权限边界和平台兼容要求应继续保留。

原型恢复会用恢复提示继续已有会话；BenchGo 对执行结果不确定的场景采用 fence、身份校验和核对流程。不能用“让模型继续试一次”替换这些约束，尤其涉及外部副作用时。

### 不重建已有可靠队列

我们已有原子提交、投递队列、过期版本拒绝和执行租约。借鉴原型测试中的“旧请求晚返回不能覆盖新状态”“用户停止期间不得继续投递”等不变量，比迁入整套队列更轻量。

## 建议补充的验证

| 验证 | 必须满足的结果 |
| --- | --- |
| 真实 write/read，磁盘内容正确 | 验收可看到真实返回并通过；不是相信 summary |
| 工具执行失败，但助手声称成功 | 不能通过验收 |
| 没有创建文件，仅口头声称已完成 | 不能通过验收；需单独测试 Reviewer，不能只依赖 Worker 拒绝造假 |
| 旧结果只有 hash，重新验收 | 核验并补证据；不增加 Worker 执行次数 |
| 会话或产物被篡改 | 身份/哈希/检查点拒绝，不能切换到另一份证据 |
| 超长工具结果 | 有明确截断状态和完整读取路径，不静默省略决定性错误 |
| 槽位满时用户追问或停止 | 用户控制不被新任务长期阻塞，停止不被自动消息撤销 |
| 回合结束但后台工作仍在运行 | 不误报任务完成；取消/停用后无遗留副作用任务 |

参考原型测试入口：`tests/tools.spec.ts:348`（会话预览与消息资源；该用例主要验证助手消息，不能据此声称所有工具结果已被测试）、`tests/runtime-concurrency.spec.ts`、`tests/background.spec.ts`。本次仅审阅，未运行这些测试。

## 建议顺序

1. 优先修复 BUG-01 的工具证据投影与旧结果重审补证据。
2. 重跑本次 R06，并补失败工具/虚假摘要的对照测试。
3. 补后台生命周期与用户跟进满负载验证；发现真实缺口后再做小改动。
4. 测试漂移和文档一致性按原诊断修复，不需要引入参考仓库作为产品依赖。

本次只读审查完成；参考仓库保持不变；所有建议尚未落入产品代码。
