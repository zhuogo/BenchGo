你负责验收悬挂根因与恢复，读docs/06-superagent/设计.md。前端禁止修改。
独占 orchestration-runtime.mjs、orchestration-store.mjs、assignment-worker.mjs、review-continuation.mjs、ticket-review.mjs、review-input.mjs、review-result-commit.mjs及其测试；不要改result-delivery/engine/service。
实测ticket a5745e53-51ed-48d1-bd8d-8aadf0ddf74c在真实DB C:/Users/DraftGo/.benchgo/assistant/assistant.db 为open，assignment uncertain，verificationAttempts=2，无结果版本无outbox。原始执行证据已存在。离线真实模型复核通过(eval/review-second-message.json)，生产却三次异常。先诊断根因，不能凭空说是模型格式；补可诊断失败记录，禁止无限悬挂。模型/格式/临时故障与未完成执行区分，已完成execution不再执行副作用，复核应可靠waiting可重试。必要增安全的owner retry路径接口由root接service；恢复必须验来源run/hash/授权/fence。源代码修复和tests，真实数据只读，勿修改状态或外发。运行stream与offline差异需要考证。项目写入返工当前明确不支持，勿用空worktree冒充成果。
ack代理需要orchestration-store很小接线，root协调。完成写eval/continuous_recovery_result.md，不build/restart。

ROOT store integration：请将eval/continuous_ack_wiring.md的enqueueTicketAck import及显式accept分支接线一起完成；intake代理说明eval/continuous_intake_wiring.md，显式human即使有subscription也需candidate。这些store改动由你统一做，root不碰避免覆盖。请明确write结果文件。
