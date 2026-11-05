# 持续消息队列后端交付

## 实现

- 新增 `plugins/superagent/src/message-inbox.mjs`，复用既有 `state.requests`，不增加数据库或调度系统。
- `engine.send` 在 Router 运行时接受并持久化新消息，按会话依次分诊；每条消息保留唯一 requestId/messageId，重复提交返回原回执，内容冲突拒绝。
- 回执状态：queued、processing、processed、failed、uncertain、cancelled；processed 仅表示 Router 回合已处理，不代表其委派工单已经完成。
- `history.requests` 与 `engine.requestState(threadId)` 提供回执、时间与尚未完成消息文本，供前端接入。
- 重启时按官方 transcript 精确 messageId 对账。已提交请求不重复投递；旧 prepared 无法确认时转 uncertain，保存可诊断原因；queued 自动继续。
- 会话启动失败转 failed；取消同时终止当前及已排队请求；归档、删除拒绝仍有排队工作的话题；clear 保留请求 ID 与取消回执，避免旧请求重新执行。
- processed 消息正文从队列中释放，正文仍由官方 transcript 保管。
- engine 的 Router 工具提示由并行 Router agent 更新，已保留其自动委派、无探索和不重复接单确认约束。

## 验证

- `eval/continuous-queue-inbox.tap`：7/7，覆盖三请求、重复 ID、重启对账、prepared 不重放、取消、启动失败与精确消息匹配。
- `eval/continuous-queue-engine.tap`：18/18，真实 Harness 生命周期测试，覆盖连续三消息、主会话身份、磁盘恢复、清空竞争、官方 composer、历史、关闭与取消。
- 已停止中途的全 engine 测试，未留下运行进程。其 owned skill invocation 案例在 Router 新禁探索策略下失败，已通知 root/审计代理；不作为本轮通过证据。

## 集成注意

桌面官方 composer 可直接调用 Agent.followup，绕过 engine.send；现有 engine 测试已有原生路径覆盖。仅本改动不能宣称桌面所有输入都走新持久队列，必须由 root 接通服务端入口或向用户前端提供准确协议。没有修改前端、service、OpenAPI 或构建产物，没有执行构建/重启。

此工作未验证真实飞书消息或模型表现；上述三消息测试使用真实 Harness 与测试模型适配器。
