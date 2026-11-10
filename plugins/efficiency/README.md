# BenchGo 执行与上下文增强

内部源码包，由 `benchgo-plugin` 基础入口装配；不增加安装包或 Cordis 顶层入口。

- `dsh-ops@0.5.0`：使用其公开 `dsh-ops/integration`，对官方 `standard`、`ptc`、`cordis` 预设提供原生文件工具、结果分页与按需发现。保留官方工具；Bash 默认关闭，可单独启用。`minimal` 不增加工具；外部 Codex、Claude Code 等 CLI 的工具不受影响。
- `smart-compaction@0.3.15`：注册 `context_status` 与 `compact_now`，使用官方会话投影和现有压缩服务。`safePointRatio:false`，不增加第二套自动压缩触发。SuperAgent 辅助模型压缩路由继续有效。
- SuperAgent Router 只允许本模块实际拥有的上下文工具定义；文件操作仍委派 Worker。同名替代工具不会继承信任。

`mountEfficiency(ctx, { directory })` 在 `connection` 就绪后调用，内部独立等待官方服务。返回的服务通过 `ctx.benchgoEfficiency` 使用；`snapshot()` 返回宿主装配状态，`diagnose(agent)` 才查询具体会话的工具与压缩可用性。宿主装配成功不代表性能提升或一次真实任务已成功。

`GET /api/benchgo/efficiency` 返回配置版本与能力状态。`POST` 使用 `{ revision, features: { ops?: { enabled?, shell? }, compaction?: { enabled? } } }` 合并保存，版本冲突返回 409。配置存入数据目录的 `efficiency.json`，成功保存后仅重挂变化的能力；停用保留配置与所有会话数据。路由继承官方 owner 认证，并检查请求来源。

参考版本与许可证：

- [dsh-ops](https://github.com/T-Auto/dsh-ops)，0.5.0，MIT；其原生载荷包含第三方许可证，随依赖完整保留。
- [smart-compaction](https://github.com/JoblessJoe/smart-compaction)，0.3.15，MIT。

适配器未复制上游实现，不修改官方 Harness。发布依赖由唯一安装包锁定；所有 `@deepseek-ai/*` 包必须复用宿主单例。

验证：`node --import ./scripts/source-loader.mjs --test plugins/efficiency/test/*.test.mjs`。第三方集成测试使用真实 Cordis、ToolRuntime、scope 与已发布插件；测试中的模型、会话投影和宿主环境为隔离夹具，不调用外部模型。
