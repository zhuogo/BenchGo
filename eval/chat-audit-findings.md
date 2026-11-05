# 主聊天只读链路审计（2026-11-03）

范围：QuietChat、reply-stream、message-actions、conversation、index 的 history 合并及 engine.history；对照当前锁定的官方子模块契约。未修改源码、未读取用户凭据、未触发模型请求。

## 已确认

1. **P1 重复回显**：根代理已定位并正在修复的 engine.history 删除 seq，破坏 quietChatRows 的历史/官方节点关联。官方 `packages/client/ui-conversation/src/client/contract/records.ts:42` 明确 UserMessageNode 的稳定定位字段为 seq；不要按文本去重（两次 hi 是合法两条消息）。
2. **P2 历史分页被实时节点穿透**：quietChatRows 遍历全部 `chat.legacy.nodes`，任何未出现在当前 history 页中的 user 都补为 provisional。engine.history 默认只给最后 100 条公开消息；较早已加载官方 user 节点仍可补进来，而其 assistant 不补，造成旧用户消息单独出现、未点“查看更早”也展示。应以已加载历史范围/最新持久序号建立实时接管边界；不要用文本或时间模糊去重。
3. **P2 流式受轮询身份窗口阻塞**：reply-stream 需要 `history.activeReply` 且 `users.has(active.requestId)`，而 index 的 refreshHistory 在每次 state/ensure/history 完成后再等待 1500ms。刚发消息已有 runningCalls 时仍可能等待一轮轮询才能显示显式回复流；短回复可能全程只有圆点然后整段出现。普通最终文本仍只在 turn/end.completed 发布，此处是刻意防止过程泄漏的限制，不能无条件暴露原始 assistant text。
4. **P2 失败提示直接泄漏底层错误**：HistoryNotice 原样渲染 history.error、failure.reason；engine.history 直接提供 lastEnd.error.message。因此 retain 错误单独被友好化，不代表主聊天其他运行错误都被隔离。服务/供应商原始错误可能直接进主聊天；建议面向用户的简明可行动消息与 Activity 中的诊断详情分离，保留恢复入口，不伪装成功。

## 需运行证据的疑点（不应当作已证实 bug）

- 截图 17000 tok/s：使用官方 StatsPills/sessionStats，公式 decodeTokens/(decodeMs/1000)。官方 turn-metrics 的 decodeMs 来自首 token 与最终消息时间；若供应商缓冲或只一次发出，极短间隔会产生很大读数。不能据截图断言实际生成快或插件计算错误；应检查该次请求的 chunk 时间戳，并明确总会话统计不同于本条回复用量。
- 每 1500ms 的 state→ensure→history 与 history 的整段事件投影，对长主会话有增长成本。未测到卡顿，不建议本轮泛化改写存储；可后续优先用现有订阅事件唤醒刷新。
- `ba-message-actions` 固定最小 36px 加 margin-top5，article margin-bottom28：两条极短消息之间至少约69px额外空间；截图宽松间距符合样式，不是模型重复输出。是否压缩属于产品调整。

## 不应误改

- 当前官方已把旧 steering/message 规范化为 user/message；不要因 legacy 节点名 steering 就另造旧事件解析。
- 原始工具、推理和 Worker 内容继续仅在 Activity 中；用户回显修复不应解禁它们。
- 无真实用量时维持“未记录用量”，不补估算值，不把整个会话 token 当单条 hi 的成本。
