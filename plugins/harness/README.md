# Harness 聚合

`@benchgo/harness` 是 BenchGo 的私有源码包，通过 `benchgo-plugin/harness-plugin` 加载，统一构建进 `benchgo-plugin`，不单独安装。

- `src/`：原生编码 Agent 运行时、会话存储、委派、MCP 桥、协议适配器、模型选择与官方 Harness 接入。
- `test/`：运行时、适配器和协议夹具测试。

依赖 BenchGo 基础服务并提供 `commander`；SuperAgent 通过该服务委派和跟进任务。Voice 与 Link 不以聚合运行时作为硬依赖。官方 `deepseek-harness/` 是独立上游引擎，此源码包不修改其源码。

公共模型供应商、配置、目录解析和界面能力继续复用 BenchGo。原有 `commander_*` 工具、HTTP 路径、数据目录及 `benchgo-plugin/runtime` 导出保持兼容；发布源码生成在 `plugins/benchgo/lib/modules/harness/`。源码及测试路径调整不等于真实模型或原生安装验收，验证边界见 [源码架构](../../docs/02-工作台与Agent/设计.md#architecture)。
