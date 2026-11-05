# 接单确认接线

新增 `ticket-ack.mjs` 导出 `enqueueTicketAck({db,ticket,trigger})`。桌面 acceptDesktop 已在事务末尾调用。

请 orchestration-store 负责人 import 此函数，并在 decide 的 accept 分支 `ticket = insertTicket(...)` 之后调用：

```js
if (gate.strength === 'explicit') enqueueTicketAck({ db, ticket, trigger: triggerValue(triggerRow(candidate.trigger_id)) });
```

不要放入通用 insertTicket，避免后台主动与模型配置类工单额外通知。与工单创建同事务，失败回滚。无需迁移或补发旧工单。

新增 outbox payload type `ticket.accepted`，含 ticketId/requestId/sourceEventId/source/text；复用现有 outbox 传输和持久 desktop notify。notificationPublication 已允许固定文本确认，保留关联字段。deliverySuppression 会在已有结果、终结工单时抑制迟到确认，避免确认晚于最终交付。

请同步 OpenAPI 通知 type 枚举（如有）和用户前端交接文档。禁止前端修改。
