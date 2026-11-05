# 接线

新增 `createDesktopTicketControl`（`plugins/superagent/src/desktop-ticket-control.mjs`）。在 service 持有 `{ctx,database:store.orchestration}` 构造一次。

在当前 mounted root agent 的工具注册处注册 `assistant_ticket_control`：

- JSON schema：`id: string`、`operation: {type:'string',enum:['supplement','cancel']}`，二者 required。
- 调用：`ticketControl.control(args, exec, {ownerAgent,threadId})`。
- 描述：按当前用户要求补充或停止当前会话已有工单。补充直接传递当前用户原文，不接受模型改写 text，不改变任务目标、验收或授权；扩大任务范围使用 assistant_ticket_change。必须明确选择单一 id；模糊时先查询 assistant_tickets 或澄清。无需额外审批。
- Router 工具 allowlist 加入名称，OpenAPI/MCP 按现有工具契约同步。本模块不新增公开 HTTP 路由。
- supplement 回执包含 ticketId/triggerId/duplicate/contextOnly，只代表已持久送入订阅，不代表 Worker 已读取；cancel 返回 ticket.status，cancelling 时不得声称已完全停止。

服务验证当前真实用户 turn、当前 root agent、exec agent、来源 channel/session/thread。复用现有 trigger 与订阅去重，同一原始消息不能投给不同工单。cancel 使用既有 cancelTicket，保留正在执行任务的 cancelling 停止确认语义。

限制：本模块只控制桌面/旁聊自有工单，不允许渠道工单被跨来源控制。无活动订阅会明确失败；不擅自重开已结束任务。
