# 日常助手修复记录

- 默认日常全能助手；直接请求不要求项目或用户书写验收标准。
- 渠道 answer/ask 不建工单；持久去重、原来源、发送前授权、回执及不确定发送保护。
- 最近已发送的直接回复按线程用于澄清上下文；排除未送达内容。
- 搜索、文件工作、执行继续走 Worker 和结果验收；桌面及旁聊支持无项目的研究委派。
- 主人 HTTP connectionReplies 供渠道直接回复查询；assistant_delegate 工具 projectId 改为可选。未新增高级设置或跨渠道读取模型工具。
- 保留旧消息处置，没有回放之前的“你好”或热点搜索。

验证：定向回归 44/44；后续上下文与交付回归 14/14；开发同步 14/14；实际 Harness HTTP 加载通过（模型模拟）；实际配置主模型研判 6/6（HTTP bridge，不是完整真实 Worker 执行）。测试集合有重叠，不按相加统计独立场景。

真实模型首次暴露问候答案缺 reason，已加强结构化输出必填约定，使用真实 AGENTS.md 重测通过。启动时暴露前次开发同步误将第三方依赖记为官方共享服务，已修复登记并补再次同步回归。

证据：daily-final-regression.tap、daily-context-tests.tap、daily-dev-sync-tests.tap、daily-real-assessment.json、daily-live-loader.log、daily-build.log。

真实飞书验证：用户新发“你好”（seq 22）处置 answer，回复状态 sent，飞书回执 `om_x100b61ab336340a4cf5a5a60d8135ee`，未创建工单；用户新发热点搜索（seq 23）处置 accept，无项目，创建工单 `6e95cee9-42bf-48b4-96ab-5f5cdbf13db8`，Worker 已开始执行。搜索结果交付仍在观察中。未主动编造或回放测试消息。
