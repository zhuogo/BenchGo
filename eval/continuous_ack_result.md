# 持久接单确认实现

- `ticket-ack.mjs` 使用既有 sa_outbox，工单创建事务内写入固定确认，与 ticketId/requestId/原来源绑定；独立唯一键，不复用结果去重键。
- 桌面 acceptDesktop 已接线，不依赖 Worker 执行或内存 Promise；事务失败没有假确认。重启保留、重复请求不重复创建。
- `notification-publication.mjs` 允许经过固定文本校验的 ticket.accepted，桌面持久通知保留 ticketId/requestId/sourceEventId。
- `result-delivery.mjs` 抑制终结工单、已有结果的迟到确认，以及来源不一致的确认。现有 runtime 单条串行发送避免本地确认在最终结果之后送出。
- 不迁移或补发历史工单；未改前端，不构建、不重启。
- 渠道 accept 的 orchestration-store 接线由父代理按 continuous_ack_wiring.md 完成。

验证：`node --import ./scripts/source-loader.mjs --test plugins/superagent/test/ticket-ack.test.mjs plugins/superagent/test/result-delivery.test.mjs plugins/superagent/test/goal-budget-store.test.mjs`，15/15 通过。

真实飞书外发未验证。发送异常仍沿用既有 uncertain，不盲目重发，结果通知不会被确认的 uncertain 阻塞。
