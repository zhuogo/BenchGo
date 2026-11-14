# BenchGo 执行与上下文增强

内部源码包，由 `benchgo-plugin` 基础入口装配；不增加安装包或 Cordis 顶层入口。

- 执行工具：内置启用，对官方 `standard`、`ptc`、`cordis` 预设提供原生文件工具、结果分页与按需发现。保留官方工具与审批；不增加额外 Bash。`minimal` 不增加工具；外部 Codex、Claude Code 等 CLI 的工具不受影响。
- 上下文管理：内置 `context_status` 与 `compact_now`，使用官方会话投影和现有压缩服务。`safePointRatio:false`，不增加第二套自动压缩触发。SuperAgent 辅助模型压缩路由继续有效。
- SuperAgent Router 仅保留专属产品管理、协调与已装配的上下文工具，通用执行工具由角色工具门排除；Worker 保留当前作用域实际可用的执行增强。工具热注册、移除与替换遵循官方注册表，不能借重名或热注册获得 Router 执行权限。分工见[任务与执行](../../docs/06-superagent/任务与执行.md#router-与持续主会话)，授权见[自有会话角色装配](../../docs/06-superagent/模型与上下文.md#自有会话角色装配)。

`mountEfficiency(ctx, { directory })` 在 `connection` 就绪后调用，内部独立等待官方服务。返回的服务通过 `ctx.benchgoEfficiency` 使用；`snapshot()` 返回宿主装配状态，`diagnose(agent)` 才查询具体会话的工具与压缩可用性。宿主装配成功不代表性能提升或一次真实任务已成功。

两项能力按内置策略装配，不注册设置页面、通用配置适配器或 HTTP 配置接口；不再读写旧 `efficiency.json`，既有文件与会话保持原样。宿主服务生命周期仍由 Cordis 管理，服务缺失如实显示为不可用。

参考版本与许可证：

- [dsh-ops](https://github.com/T-Auto/dsh-ops)，0.5.0，MIT；其原生载荷包含第三方许可证，随依赖完整保留。
- [smart-compaction](https://github.com/JoblessJoe/smart-compaction)，0.3.15，MIT。

适配器未复制上游实现，不修改官方 Harness。发布依赖由唯一安装包锁定；所有 `@deepseek-ai/*` 包必须复用宿主单例。

验证：`node --import ./scripts/source-loader.mjs --test plugins/efficiency/test/*.test.mjs`。第三方集成测试使用真实 Cordis、ToolRuntime、scope 与已发布插件；测试中的模型、会话投影和宿主环境为隔离夹具，不调用外部模型。
