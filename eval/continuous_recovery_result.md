# 持续会话：验收恢复结果

## 诊断

只读检查生产 ticket `a5745e53-51ed-48d1-bd8d-8aadf0ddf74c`：assignment uncertain，verificationAttempts=2，原执行证据存在。旧代码将 review 抛异常与执行不确定共用 catch，自动核验两次耗尽后没有结果版本，也无恢复入口，造成无限悬挂。旧记录未持久化具体模型错误，无法证实历史异常到底来自流式供应商、格式还是超时。原 `review-second-message.json` 是 stream:false HTTP 桥，不能证明官方 Harness 流式路径通过。

## 修复

- review 抛异常转为持久 waiting + retryable + diagnostic(stage/code/at)，不保存供应商原文，不把已完成执行变 uncertain。
- waiting 自动隔 30 秒仅复核最多两轮，重复内部失败不再发通知；保留 owner 重试能力。执行/取消信号仍抛出，不吞授权/停止。
- 旧 resultVersion=0 的 open/uncertain 可用现有 ticketRetryReview 恢复：锁原 session，验完成标记/hash/run/fence/修订/授权，拒绝待处理上下文，排 verificationOnly，不执行 Worker。
- assignment 失败增加脱敏 lastFailure；恢复完成和结果/outbox 仍事务提交。
- 配合 intake：explicit 消息即使线程有活跃订阅仍入 candidate，不吞新请求。

## 文件

`orchestration-runtime.mjs`, `orchestration-store.mjs`, `assignment-worker.mjs`, `ticket-review.mjs`, `review-continuation.mjs`, `review-result-commit.mjs` 及对应测试。docs 持续主会话后端补充实现。

## 验证

- `continuous-recovery-tests.tap`：53/53（验收、恢复、store、worker、runtime）。
- `continuous-recovery-continuation.tap`：最终补测自动恢复、重复内部失败不通知与 owner 修复旧 uncertain；结果见 TAP。
- 真实数据只读，未变更旧工单、未发送外部消息、未 build/restart。
- service 已有 owner ticketRetryReview 接线；root 需更新 OpenAPI 的 expectedResultVersion=0 语义（无需新增动作）。
