# 晚间隔离真实验收

范围和断言先冻结于 [MANDATE.md](MANDATE.md)。仅此运行器调度真实模型请求。使用现有精确供应商配置，凭据只进入内存和隔离子进程环境；不修改主配置，不启动 GUI，不向真实外部渠道发消息。

```powershell
node eval/superagent-evening-20261105/preflight.mjs
node eval/superagent-evening-20261105/run-live.mjs
```

以上均不发模型请求。统一构建完成并由主代理通知后，逐项执行：

```powershell
node eval/superagent-evening-20261105/run-live.mjs --run --case attention-1 --output-dir eval/superagent-evening-20261105/attention-1-attempt-1
```

场景为 `attention-1`、`attention-2`、`attention-3`、`pause-resume`、`adjustment`。每次仅执行一个场景；同一阻点两次即停止。前三项连续通过才能计作 Attention 三连；不以重跑覆盖失败历史。金额 cost 未有可靠计价源，明确记为 unsupported，不发假费用测试。

`results.json` 与 `evidence.json` 保存原始任务、隔离测试用户动作、真实身份/验收/回执；`stream-frames.jsonl` 仅保存官方流事件元信息；`supplier-requests.jsonl` 仅保存实际请求精确模型、流式方式与时序计数，不保存正文/推理/参数。`loader.log` 脱敏。运行结束停止自建 loader 并校验主配置内容哈希；只有场景通过且校验通过才删除该次 `isolated-state/`。失败、异常或中断保留此目录，可能包含敏感数据，不提交或共享；确定无需原会话续做后由操作者手动删除。保留状态不等于已经验证可续做。

原始请求为了触发问答包含验证流程，属于隔离受控真实供应商运行；没有修改 Worker 输入、review 或验收结果。它不等于自然发生或真实桌面全链验收。

保留状态的恢复入口：

```powershell
node eval/superagent-evening-20261105/resume-live.mjs --attempt-dir eval/superagent-evening-20261105/ATTEMPT
node eval/superagent-evening-20261105/resume-live.mjs --attempt-dir eval/superagent-evening-20261105/ATTEMPT --run
```

首条仅离线预检，第二条启动隔离 loader 并可能产生模型请求。仅支持保留快照和数据库都能确认唯一原 Ticket、Assignment、Run 和两端持久会话，且工单处于 paused 的情况；不会代答或新建工单。恢复记录写入独立 `resume-*`，状态始终保留。等待态、缺少完整身份、多 Run 和已删除的 attempt-3 均不支持此入口。完成只代表核对原身份、真实验收与投递，不替代原场景的全部验收断言。

本机验收根目录继承的 ACL 含 Everyone 完全访问。新运行会在写入数据前将新建证据目录限制为当前用户和 SYSTEM 并验证；恢复已有状态只检查 ACL，不自动修改，权限不符合则阻止执行。凭据通过进程环境注入，写配置前检查已知凭据值。
