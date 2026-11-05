# 工单补充和取消

新增后端服务与真实 SQLite 测试，未修改前端、service、engine、核心 schema 或上游。

验证命令：`node --import ./scripts/source-loader.mjs --test plugins/superagent/test/desktop-ticket-control.test.mjs`

结果：4/4 通过。覆盖精确单工单补充、原文保真、mandate 不变、持久去重、拒绝一消息分派多个工单、跨 session/channel/thread 拒绝、内部通知和非 root 拒绝、取消幂等及取消后拒绝补充。

尚需 root 接线和端到端验证，接线说明见 continuous_followup_wiring.md。无需前端改动。
