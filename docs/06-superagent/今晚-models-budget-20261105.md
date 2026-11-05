# 三角色模型与金额预算核查（2026-11-05 晚）

## 任务书与验收条件

1. 角色模型（Router）、工作模型（Worker）、辅助模型分别配置；各自保留首选/备用次序。选择、保存、重载和实际请求使用相同的供应商与模型 ID，不猜测别名。
2. 显式模型选择优先；修改单一角色不丢失其他角色、能力开关及无关配置；不恢复 `keyPools`。
3. Worker 未独立配置时明确显示跟随 Router；新建工单省略模型时用 Worker 队列，显式指定模型仍优先。辅助模型按现有用途开关使用，失败回 Router；不把 Worker 队列混入 Router/辅助回退。
4. 金额预算仅在存在可靠计价源时开放并跑真实耗尽/补额闭环；不能以 token/request 数或自行猜测价格代替金额。

## 已实现接线

- 保留 `config.models` 为 Router 队列，兼容已有用户数据和公开接口；新增 `config.workerModels` 数组，缺省/空数组表示继承 Router。辅助配置继续使用 `config.auxiliary`。
- `routing.roleModels(primary, config, role)` 统一角色队列，保留 opaque ID 和显式优先。`assignment-executor` 只读 Worker 路由；`assessment-policy` 传递 Router/Worker 队列；桌面委派模型参数可选且必须成对。
- 模型设置复用原有模型卡片、选择器、空状态和 Disclosure，增加“工作模型 Worker”区域。保存补丁新增 `workerModels`，其余 UI 由现有设置页处理加载/错误。
- 公开配置增加 `workerModels`；`assistant_delegate` 的 `provider`/`model` 改为可选成对。MCP 工具和 OpenAPI 已同步实际服务契约。

## 金额预算现状

基础层 `plugins/benchgo/src/` 未提供金额计价服务；当前 `goal-budget-usage.mjs`、`goal-budget-gate.mjs` 均记录 `cost: null`。官方 `TokenUsage` 仅提供 token 计数，没有金额/币种。`service.goalBudgetUpdate` 保留明确“不支持可靠计价”的错误，避免把未计量费用当作 0。第 3 项真实金额补额验收因此阻塞，不能标为通过。

## 验证记录

- 已有定向验证（前任交接）：六个测试文件首批 70 项，加上 assessment 新增 2 项，共 72 个不同测试通过；这是定向范围，不能表述为全量测试通过。
- 本次 API 契约验证单独记录：`node --import ./scripts/source-loader.mjs --test plugins/benchgo/test/superagent-openapi.test.mjs`，17 项通过（原有 10 项、新增 7 项），不并入上述 72 项。
- API 验证覆盖三角色配置保存/重载与实际路由、记忆来源及版本链、owner 核实入口与回执边界、独立顶层 outbox 核实记录和原 payload 幂等、四阶段 schedule.lifecycle 与 history 当前投影、tickets.tickets[] 的 attentionResolutions、委派可选成对模型及 completed 原单保留的新关联单。
- 金额 cost 仍无可靠计价源，保持 `null` 并明确 unsupported；没有验证真实金额耗尽/补额闭环，不能以请求数或 token 数替代。
- 未运行全量构建、上游全套测试或真实模型调用。真实供应商和用户视觉验收不属于本文件的受控测试结论。
