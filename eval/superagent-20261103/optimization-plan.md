# SuperAgent 优化清单与实施状态

2026-11-03。本文取代此前“正常路径直接取消验收”的建议，不改变历史评估结果。用户随后授权实施：真实工具证据、历史补证、重审去重、主辅配置、过期测试和接口说明已落地，见 `optimization-verification.json`。以下保留方案细节，完成边界见文末。

## 依据和边界

- BenchGo 定版：`docs/06-superagent/设计.md:155–166`；任务细则：`docs/06-superagent/任务与通知.md:82–88`。Worker 交结果包，Router 对照工单验收，宿主控制关闭。
- DSH 参考版本：`6337fc823ce20251c8de8085948165c81aaa701e`。`src/core/evals.ts` 是接单准入，不是成果质量验收；`src/core/assignments.ts:99–132` 接收 Worker 报告，按状态和 follows 生命周期结束任务。不能把准入 Gate 宣称为已实现通用成果证明器。
- 用户提供的实验数字只作为调度方向证据，本轮未独立复核文章；不据此承诺真实编码质量或生产性能收益。
- 本地已有证据：可控模型 30/30，真实模型 6/7；BUG-01 是实际文件存在但验收缺少可读执行证据，重审同一结果仍 wait。不是所有分派、订阅、权限机制都缺失。

## 按优先级实施

### P1-01 结果包与关闭门禁（BUG-01）

现状：`plugins/superagent/src/execution-evidence.mjs:16` 仅投影 assistant 文本与日志哈希；`assignment-executor.mjs:204` 组装结果；`ticket-review.mjs:4` 模型研判；`orchestration-runtime.mjs:18` 映射状态；`orchestration-store.mjs:747` 提交。

优化：Worker 显式提交状态、检查、产物、未尽事项；宿主从运行记录绑定 ticket/assignment/run/session、目标版本、工具结果和产物引用。Router 使用可读证据对照验收标准；宿主复核授权、归属、版本、未应用消息、必要检查状态及验收结论后原子提交。AI passed 不能绕过确定性失败，ready/idle 不能直接关闭。自由文本语义质量不能声称由 schema 或哈希自动证明。

验证：原 R06 完整交付；伪造摘要、错任务证据、旧版本结果、失败检查即使 AI passed 仍不可关闭；证据有效且验收通过才完成。不新增第二套状态机。

### P1-02 缺证据时定向补证，停止无效重审

现状：`plugins/superagent/src/review-continuation.mjs` 重新送审旧结果；`auxiliary-request.mjs` 请求禁用工具。诊断见 `real-artifact-diagnostic.json`。

优化：区分缺证据、执行失败、待用户决定；宿主按受限引用投影已有工具结果，仍不足才交原 Worker 补检查。验收器不获得写权限；结果与标准均未变化时不反复消耗模型重判；交付失败只补投。

验证：补证不重复原副作用；重复重试幂等；交付失败不重跑 Worker。

### P1-03 保留并补齐架构强制分工

现状：`plugins/superagent/src/engine.mjs:149` 安装 Router 权限门禁；`router-permissions.mjs`、`worker-permissions.mjs` 已存在；`assessment-policy.mjs:23` 代码复核准入。

优化：沿用现有门禁，覆盖通用 shell/write/edit、MCP 和未知工具绕过路径；持久副作用必须绑定有效工单。接单 AI 建议仍由当前策略与有效规则复核；不靠加强 prompt 替代代码。

验证：越权工具被拒；未启用规则、策略变更不能凭旧研判接单。已有能力做回归，不重写。

### P1-04 订阅直通与批处理量化

现状：`plugins/superagent/src/intake.mjs:31` 已有订阅直达；`assessment-runner.mjs:28` 批量 claimEval；`orchestration-store.mjs:774` 防未应用消息时关闭。

优化：验证唯一订阅命中后无需 Router 重判；多订阅歧义才进入处置。新增目标/权限不得靠订阅隐式扩权。复用批处理，补观察指标，不新增保守并发限制。

验证：同一消息流比较 Router 调用量、缓存读取 token、p50/p95、重复开单率、遗漏率；直达消息不触发无意义研判，目标变化后旧结果不能关闭。

### P1-05 主辅模型统一配置

现状：`plugins/superagent/src/assessment-policy.mjs:20` 传递辅助配置；`auxiliary-request.mjs`、`store.mjs` 和 `test/auxiliary-config.test.mjs` 已有后端能力。

优化：同页配置主模型、辅助模型和用途勾选；未配置/未勾选跟随当前主模型；展示实际使用模型。复用现有配置协议，不默认强制轻量模型。

验证：选择→保存→重载→真实请求一致；修改单项保留其他配置；模型 ID 原样传递。

### P2-01 证据按需读取与上下文限长

现状：`plugins/superagent/src/assessment-context.mjs:2` 已有头 5 条及触发前后各 5 条、截断长度与指针；执行结果投影尚不足。

优化：复用已有 ID 账本和读取能力，把结果证据也组织为简短摘要、全长、hash、受限指针；不重复注入整段日志，不新建记忆系统。

验证：截断内容可追溯、跨工单读取受限、token 成本可观测。

### P2-02 修正过期测试与能力说明

现状：`plugins/superagent/test/activity-panel.test.mjs:9` 仍依赖旧 task；当前实现为 `client/activity-data.mjs:4` 的 activityTask。README 辅助能力描述与服务能力需同步。

优化：测试对齐现行入口；只删除已确认无引用的旧代码。区分后端已实现、UI 已开放、需配置启用。schedule-host 并发超时独立重跑通过，不列为已确认产品故障，不开展并发治理。

### P2-03 更新评估与 HTML 报告

沿用 `eval/`，保留历史数据；将上述验收、授权、直达和配置边界加入回归。报告分别列确定性校验、真实模型表现、调度性能和未验证范围。门禁测试要求 100% 通过；模型成功率与性能按实测报告，不用 DSH 数字作 BenchGo 验收承诺。

## 实施顺序

结果包/关闭门禁 → 定向补证 → 分工与订阅回归 → 主辅配置 → 测试文档与报告。官方子模块和参考仓库只读；复用现有 lease/fence/outbox，不增加额外安装包。

## 本轮交付

132 项定向回归通过；隔离真实 Harness HTTP 30/30 通过；真实模型文件交付与虚假完成反例 2/2 通过。BUG-01 复测中实际 write/read 证据到达验收器，文件内容 VERIFIED_391，review passed、completed、sent 均成立。历史证据保留在原目录，新复测在 after/。

本轮复用现有宿主结果包和关闭门禁，没有新增 Worker 报告专用工具、通用成果证明器或模型主动分页读证据机制。超长证据标记截断，无法证实时不关闭；自动驱动 Worker 补做检查仍待扩展。配置入口已构建热加载，视觉验收交由用户。外部聊天渠道与生产压力未做本轮端到端验证。
