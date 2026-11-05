# 2026-11-05 晚：定时生命周期与发布边界

## Mandate（开工验收条件）

1. 复用官方 Schedule 的目录、投递记录和现有 Trigger/Ticket；不改计时、投递、恢复逻辑，不新增计时器。
2. 创建、到点触发、关联工单完成/失败，在主聊天 history 返回持久的系统卡片。重复扫描、重复投递和进程恢复不能重复造卡。
3. 只投影当前总助手拥有的会话；不把外部会话、旧投递或用户伪造的 schedule 文本变成事件。
4. 已有 Router 自然交付/返工/问题文本原样沿发布边界传递；模型缺失/不可用显示明确系统身份，不把固定话术作为 AI 报告。
5. 定向测试覆盖四阶段、幂等、会话归属与通知 allowlist；真实定时/主聊天交互仍单独记录，不以受控测试代替。

## 设计与实现边界

新增 `schedule-lifecycle.mjs` 只读投影器，复用 runtime 通知账本和去重键。`schedule-bridge` 在通过宿主证据验证的 occurrence 入账后通知投影器；`service` 在现有 history/notification 读取以及正式工单交付时同步事实。创建来自官方 catalog 的 createdAt，终态只来自关联 Ticket 的 completed/failed。卡片独立标为 `schedule.lifecycle`、`origin=system`，与 Router 交付正文分离，原始任务内容不转发。

新增 history 通知类型，不新增 MCP 工具、HTTP 路由或定时执行入口。客户端使用既有系统通知卡框架；OpenAPI 的 notification 契约需同步。旧用户数据不迁移，读取时按持久事实重建投影，主聊天清空边界沿用既有机制。

接管补充：终态必须回读已持久化 Ticket，并校验来源会话和对应机器 Trigger；同步可从已承接工单恢复触发卡与终态卡，即使官方定时已删除。主聊天等待态额外返回当前双版本匹配的精简结果、未答问题和暂停原因。Router 自然正文保留原文；本地受控配置动作的固定成功通知改为明确系统身份，不伪装 Router 报告。外部投递核实复用各账本的既有状态迁移，通过已认证主人 HTTP action 接线，不暴露给模型工具。

## 验证记录

已实现：主聊天持久系统卡覆盖 created / triggered / completed / failed；使用现有 runtime 通知账本去重，当前归属会话与机器 Trigger 双重校验；重启后可从持久工单和官方最新投递凭据恢复投影；主聊天清空边界仍有效。官方当前 Schedule 使用 `target.sessionId` / `receipt.targetSessionId`，工具适配 `create({timing,target}, actorSessionId)` 与 `edit`，只调整 BenchGo 接线，不修改官方计时、存储或恢复语义。

已实现：Router 交付/返工/阻塞正文和正常最终聊天保留原文；无 Router 正文时继续使用明确系统状态。受控配置动作的固定成功回执改为 `origin=system, systemState.state=action_verified`。history 只返回当前要求版本及结果版本匹配的精简 `currentResult`、未答 `currentAttention` 与 `currentPauseReason`，不暴露原始 Worker 正文。service 同步三模型配置及工单调整/判重工具契约，接入主人认证的 directReplyReconcile / outboxReconcile HTTP actions。

定向验证：`schedule-bridge`、`schedule-lifecycle`、`chat-publication`、`result-delivery`、`notification-publication`、`notification-option`、`router-action-store` 共 42 项通过；挂载真实 Harness 服务的 `service.test.mjs` 1 项通过（覆盖新 HTTP 门禁、Schedule 工具 create/list/update/delete 与 history、当前问题投影、模型工具 schema）。独立 `schedule-host.test.mjs` 1 项通过：官方 Host 实际到点持久化提醒并转为 Trigger/Eval，真实模型请求为 0。

验证命令使用 `node --import ./scripts/source-loader.mjs --test <上述定向测试文件>`。service 旧用例在同一个 human 回合创建 Goal 后再次 delegate，与新增同来源防重规则冲突；经主代理确认后拆为两个真实 human 回合，保持防重门禁，重新验证通过。未在本分支执行全量构建、浏览器四态验收、真实供应商模型调用或发布重载；由主代理统一收尾。
