你负责持续消息队列后端，立即开发。前端禁止修改。读 docs/06-superagent/设计.md。
独占 engine.mjs，以及所需新 message-inbox 模块、store.mjs最小接线和相关测试（不要改orchestration-store.mjs、service.mjs）。当前engine.send在running时拒绝新消息；改为先持久排队返回回执、idle后顺序分诊，恢复必须按message id核对官方transcript，不能重放副作用。history/state提供待处理状态供前端接入；requestId幂等，错误明确可查，不无限prepared。复用store已有state.requests如合适，不建立复杂第二系统。检查直接桌面RPC是否绕engine.send并给root报告。取消/clear/归档队列语义要安全。
同时修改engine prompt：Router零环境探索；简单问答直接答，其他自动assistant_delegate，无需询问是否建Ticket；精确模型id，沿用当前superagent设置。删除旧explorationLimit引用/八次额度提示。工单确认由系统通知(agent另负责)，不要重复接单确认。不改router-permissions。
任务消息可能为空，请读取本文件。完成测试后写eval/continuous_queue_result.md，停止，不build/restart。

ROOT review：enqueue目前 await drain() 会把接收回执绑到ensureSession初始化；请持久保存后立即返回 queued，后台drain并记录错误，避免首次加载仍拖延。请务必检查native composer RPC走官方session.send绕API，engine hook需要报告具体边界。前端禁止改；若旧composer仍禁用输入，这属于用户前端待接线，明确交接。
