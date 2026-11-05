# 聊天即时交互修复

- 气泡空白：正文块跟随工具栏最小宽度伸展。正文改为独立 fit-content、靠右并约束最大宽度。
- 用户消息延迟：自有聊天只消费 1500ms 轮询历史，漏接官方 pendingSubmissions。现在直接复用同步回声，再由官方用户事件桥接到历史，以 rpcId / seq 去重；失败由官方状态撤回，不包装发送、不加定时器。
- 等待：只有三点动效，加载中文字仅保留无障碍标签。
- 正式回复流式：只接受顶层 assistant_reply.text 的官方 PartialArguments，校验会话与活动请求；不开放普通 partial text、推理、工具过程或 Worker 原文。成功回执桥接到持久消息；普通 completed 终答仍为非流式兜底。后台验收流程未改变。

验证：chat-immediacy-tests.tap 共 78 项，初次 77 通过 / 1 测试桩失败（CSS mock 空对象没有 props）。修正测试遍历后 quiet-chat 4/4 重跑通过，见 chat-immediacy-ui-rerun.tap；OpenAPI 8/8，见 chat-immediacy-openapi.tap。86 个相关用例均已通过验证。reload:plus 成功，见 chat-immediacy-build.log。

未进行视觉验收或真实供应商流式验证；流式增量使用官方 PartialArguments 实例测试，非假打字动画。主聊和旁聊共用路径；外部渠道仍按其已有协议发送，不承诺渠道流式。
