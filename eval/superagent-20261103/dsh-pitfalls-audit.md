# DSH 实验风险对照校验

> 后续修复：ALIGN-01/02 已修复并通过集成探针，结果见 `dsh-pitfalls-fixed.json`；主聊天探索边界已加入代码门禁，详见 `../../../docs/06-superagent/设计.md`。下文保留修复前校对事实。

2026-11-03。以用户提供的 DSH 实验结论作为设计约束，不争论其实验有效性。能力范围更广不能推出调度更好或正确率更高。本轮校对未修改产品代码。

## 已有代码保障

- 分工权限：`plugins/superagent/src/router-permissions.mjs` 拦截通用写入、shell、未知工具，按工具定义身份而非模型声称授权。`orchestration-runtime.mjs:118` 对已接单任务由代码创建 Assignment，无需 Router 再决定是否派工。
- 准入：`assessment-policy.mjs` 与 `assessment-runner.mjs` 复核当前策略、身份和启用规则；AI 不能自己授予 Mandate。
- 订阅直通：`intake.mjs:31` 唯一订阅直接投递，`orchestration-store.mjs` 不为已订阅线程反复建立候选。此前 300 消息宿主实验 280 跟进直达；不等价于实测缓存 token 节省。
- 上下文：`orchestration-store.mjs:205` 只读线程头及触发前后窗口，`assessment-context.mjs` 限长，`assessment-source.mjs` 按 ID 受限分页。
- 有界恢复：`orchestration-store.mjs:153` 超时最多重排两次，再 unavailable；成果提交保留授权、版本、归属、待应用消息和产物校验。

## 两项已复现缺口

### ALIGN-01：跨线程研判串行等待

`assessment-runner.mjs:24–39` 在 for 循环内 await assess，且 tick 全局合并。同线程批处理不等于跨线程相互独立。探针挂住第一个线程时，第二线程没有开始；释放后才进入第二次研判。默认研判超时 120 秒，因此慢线程可能放大其他任务的排队尾延迟。此处是静态代码与确定性探针结论，不是生产压力测量。

建议：独立线程独立研判生命周期；同线程保持 lease/顺序/批处理，不额外增加保守限流。验证慢线程不阻塞其他线程，以及策略撤销、停止和错误收集。

### ALIGN-02：接单研判未使用勾选的辅助模型

`client/model-settings.mjs:5` 宣称 review 覆盖接单研判；`assessment-policy.mjs:19` 提供 auxiliary，但 `assessment-runner.mjs:39` 只传 policy.model/models；`assessment.mjs:8` 从主模型建立路由。探针配置辅助 review 后，两次研判仍收到 main-opaque，辅助配置未传递。成果验收使用辅助模型的实现不能证明准入研判也生效。

建议：接单研判复用辅助用途选择与主模型回退语义，同时保持其受限原文读取工具，不能简单换成 tools=[] 的通用辅助文本请求。覆盖勾选、取消、无辅助配置和精确模型 ID。

## 尚有风险但不冒充已复现 bug

- 桌面 Router 保留 read/grep/web 等只读工具。持久副作用无法绕过 Worker，但长篇研究任务仍可能被主会话自行处理；没有证明所有复杂只读任务都会分派。不得用“写权限已剥离”代替“0/5 问题已完全消除”的结论。出处：router-permissions.mjs、engine.mjs:150、desktop-delegation-service.mjs。
- 独立成果 LLM 验收是 BenchGo 自有扩展，不是 DSH 实验验证过的提速方案。证据包已补齐和重审去重不代表这层成本为零；需另测其请求量与尾延迟。
- worker 并发数可配置；本轮不新增限流，不进行上游负载治理。

## 证据

复现命令：`node --import ./scripts/source-loader.mjs eval/audit-dsh-pitfalls.mjs`。

结果：`dsh-pitfalls-audit.json`。使用真实宿主 runner 与内存数据库、注入受控 assessment；不请求真实供应商，不修改生产数据。结论：核心制度方向对齐，但尚不能声称已避开实验揭示的全部风险，也不能据功能数量声称优于 DSH。
