# 渠道持续准入修复

已修改 intake、assessment-runner、assessment、direct-reply-delivery 及对应测试，未修改前端、store、官方、构建产物。

- 明确人类请求不再因为消息迟到被直接丢弃；不自动注入已有工单订阅。陈旧消息仍不能回答当前 attention。
- 明确请求交 Router 独立分诊，已有 tickets 已随上下文提供，继续/新任务分别 attach/accept；增加禁止询问是否派 Ticket 的规则。
- freshness 传入可信研判时间、原始消息时间、同人同渠道新消息标记；旧问候由结构化 ignore 决策处理，非关键词硬拦截，实质任务不能仅因迟到丢弃。
- 合法已排队 answer/ask 不再因为后续新消息出现而被发送层静默抑制。
- 增加单/多活跃订阅下连续新请求测试、迟到请求保留测试，修正旧发送抑制测试。

验证四个文件共 30 项，目前 28 通过、2 项失败均为 store 尚未接线：ingest 条件须将 `!subscribed` 改为 `(!subscribed || input.gate?.strength === 'explicit')`。已通知 recovery，root 可接线后仅重跑 intake。assessment-runner 新增 freshness 断言后再次 7/7 通过。direct-reply-delivery 和 assessment 全部已通过。

接线及 unavailable 状态反馈 API 见 continuous_intake_wiring.md。当前 sourceMessageSuperseded 仅用作 freshness 标记与阻止迟到消息回答当前 attention，并不再取消用户请求。
