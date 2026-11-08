# BenchGo 交互回复

私有源码包 `@benchgo/interactive`，随唯一安装包 `benchgo-plugin` 交付，不另设 Cordis 入口。

提供版本化 `benchgo-ui` JSON 协议、React 渲染和官方会话提交桥。支持表单、选项、表格、单序列柱形/折线图。使用现有共享按钮和宿主主题；不执行模型脚本、表达式、任意组件或网络动作。`schemaJson` 仅是兼容的代码块包装名称，**不是完整 OpenTiny 协议兼容层**。

- SuperAgent 主聊、旁聊：在消息正文原位呈现；Link 共享工作台复用同一客户端。
- 官方普通聊天：通过公开 `conversation.chat.turnTail` 追加交互视图，保留原文代码块与官方推理、图片、工具轨迹，尚非原位替换。
- 操作经官方 `sessions.using`、`beginSubmission`、`prompt` 接收，作为普通用户消息继续对话，不覆盖输入草稿，不替代权限审批。
- 未闭合数据显示生成中；中断或不支持格式提供原文与请求重新生成；空表单/图表保留明确空态。提交只在宿主确认后显示成功，失败保留输入和重试标识。

对照评估：`dsh-genui@0.3.3`（https://github.com/lhuans/dsh-genui，2026-11-07），发布包约 6.8 MB，包含 Vue/OpenTiny 运行时及旧宿主服务适配。这里复用其结构化回复与操作回传方式，不复制上游源码，不引入整套运行时。首版刻意限制组件范围，计算器、任意多步应用、OpenTiny 表达式暂不支持。

装配：基础层调用 `mountInteractivePrompt(ctx)`；统一客户端在 `slots`、`sessions` 就绪后调用 `mountInteractiveClient(ctx)`。公开组件为 `InteractiveReply({ text, streaming, onSubmit, disabled, onlyCards })`；服务端提示在 `src/prompt.mjs`。

验证：`node --test plugins/interactive/test/*.test.mjs`。界面真实渲染与行为验收应覆盖空、流式加载、错误、有数据、发送失败重试及窄屏。
