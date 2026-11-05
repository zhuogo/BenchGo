# 普通问答无回复：修复记录

## CHAT-07：发布协议过窄

用户反馈“你是什么模型？”短暂处理后无回复。前版 `projectChatMessages` 只接受 assistant_reply 插件记录，模型通过正常文本结束的答案被静默过滤。此前真实模型测试显式提示调用该工具，未覆盖普通用户路径，属于测试缺口。

现支持官方持久日志中的 completed 终答：限定同一人类请求/turn，取最后一条无工具调用的助手正文；显式发布优先，仍每请求一条。工具前叙述、reasoning、工具结果、异常/取消/截断、无新用户请求的后台回合不发布。历史正常终答无需重跑即可恢复显示，不添加额外模型调用。

实现：`plugins/superagent/src/chat-publication.mjs`、`engine.mjs`；服务契约与 OpenAPI 同步。

## 验证

- 官方 Harness + 普通文本响应的 loader 冒烟通过：`chat-terminal-loader.log`。
- 真实模型直接输入“你是什么模型？”通过：`superagent-20261103/chat-terminal/real-results.json`，26829 ms。未在用户输入中提示发布工具。
- 引擎与发布投影测试 **62/62 通过**：`chat-terminal-tests.tap`。首次仅一条旧断言仍要求隐藏正常终答，修正断言后完整重跑通过；窄范围复测见 `chat-terminal-recheck.tap`。
- `reload:plus` 构建证据：`chat-terminal-build.log`。未做视觉校验。

目标功能核对见 `docs/06-superagent/目标追踪现状.md`：已有结构化执行型目标；追踪型目标工作区、进展账、上下文简报与 Schedule 的 goalId 归属尚待实施。定时执行继续复用官方 Harness 自动化。
