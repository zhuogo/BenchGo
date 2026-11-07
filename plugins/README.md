# BenchGo 插件

自有能力统一放在本目录，不修改 `deepseek-harness/` 官方源码。五个源码包最终交付为一个 `benchgo-plugin`，不要求用户分别安装。

| 源码目录 | 包名 | 职责 | Cordis 入口 |
| --- | --- | --- | --- |
| [benchgo](benchgo/README.md) | `benchgo-plugin` | 基础服务、公共配置与界面、统计、更新、统一装配 | `benchgo-plugin` |
| [harness](harness/README.md) | `@benchgo/harness` | Harness 聚合、原生 Agent 运行时、委派与 MCP | `benchgo-plugin/harness-plugin` |
| [superagent](superagent/README.md) | `@benchgo/superagent` | SuperAgent 总助手对话、任务、目标、记忆与产物 | `benchgo-plugin/superagent-plugin` |
| [voice](voice/README.md) | `@benchgo/voice` | 听写、流式朗读与实时通话 | `benchgo-plugin/voice-plugin` |
| [link](link/README.md) | `@benchgo/link` | 设备配对、直连、远程会话与移动端 | `benchgo-plugin/link-plugin` |

## 组合方式

- 基础层提供 `benchgo` 公共服务；其余能力通过各自入口启停，客户端仅注册一次 `benchgo-plugin`。基础层使用完整包根入口，官方 `clientModules` 据此发现统一客户端；四个业务入口使用子路径。
- Harness 聚合提供 `commander`；SuperAgent 依赖该服务及官方会话能力，并提供已有 `assistant` 服务。总助手停用释放自己的后台工作器、监听与路由，保留持久化数据。
- Voice 与 Link 不硬依赖 Harness 聚合或 SuperAgent。Link 的连接、设备身份与访问权限独立工作；请求可选助手服务时探测实际可用性，不直接读取助手私有存储。Voice 复用官方会话与现有适配器，不重新实现推理循环。
- 公共服务、HTTP 边界和配置解析复用 `benchgo/src/`、`benchgo/shared/`；界面组件复用 `shared/client/`，不为拆包复制代码。
- 插件互调走显式服务契约和依赖注入，不读取其他插件的私有存储。

`benchgo/lib/modules/` 是 Harness、SuperAgent、Voice 发布源码的生成目录，Link 服务与网页继续使用现有构建产物。最终运行不依赖源码仓库的同级目录，也不引入额外常驻进程。目录与启停验证边界见 [源码架构](../docs/02-工作台与Agent/设计.md#architecture)，各业务未验收项统一在对应板块设计中维护。

## 开发约定

BenchGo 需要安装到官方 profile 才会加载；桌面发行包通过初始化完成统一安装。四个私有源码包不单独发布或安装。网页修改后执行根目录 `npm run reload:plus`，重建业务模块和网页并刷新浏览器；该流程不构建服务器种子、不重启 Web，完整发布仍走既有构建与打包流程。

进入实现时，先验证官方扩展接口及外部包加载路径，再添加各插件自己的包、依赖和构建配置；不使用上游工作区内部的 `workspace:*` 作为外部依赖。不为接入插件修改官方 pnpm workspace 或锁文件。

公共契约应明确版本、能力探测、取消、错误、事件顺序与资源释放。外部 Agent 适配器报告真实能力，不支持的操作返回不可用。保留第三方许可证和版权声明。
