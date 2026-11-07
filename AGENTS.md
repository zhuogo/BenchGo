# Repository rules

- 用中文精炼交流。新能力优先通过插件、服务与配置组合实现。
- `deepseek-harness/` 是官方 Git 子模块，不修改其中源码。遵守该目录自身的开发规则。
- Desktop 使用 `deepseek-harness/apps/desktop/`，根目录仅维护必要命令封装；不恢复社区版 Stable/Beta/Next 或 runtime patches。
- 更新引擎时从官方 `origin/master` 获取最新提交，同时更新根目录 `upstream.json` 和子模块 pin；升级后重新验证兼容性。
- `reference/` 中的 Hermes、Paseo、CC Switch 是参考仓库，不参与产品依赖或构建，不修改它们。
- `docs/` 只存设计，按六个板块组织；同一板块的小模块可分别维护独立 Markdown，同一主题只保留一份权威正文，通过链接引用，避免重复。板块 `设计.md` 可作范围与模块导航，不要求每板块只有一个文件。全局只保留 `docs/总架构.html` 描述板块关系、机制与流程。服务契约、视觉规范可按独立职责成文，具体实现边界与验收条件随所属模块维护；不新增独立现状、开发清单、验收流水或 `.bak`。历史证据留在 Git、`eval/` 或本地 `artifacts/`。设计内区分已实现与待实施，引用参考代码时说明版本。
- 自有能力统一放在根目录 `plugins/` 的五个源码包：BenchGo 基础层、Harness 聚合、SuperAgent 总助手、Voice 语音和 Link 直连，最终只安装一个 `benchgo-plugin`。保持服务契约明确，不将源码包或规划目录当作额外安装的插件包。
- 应用与插件名称均为 BenchGo；BenchGo 是统一 Logo 与吉祥物 IP，规范及正式素材见 `assets/brand/`，PC、移动端与初始化使用同一形象。
- 供应商模型 ID 按不透明标识处理，不猜测别名或静默改写。配置修改须验证选择、保存、重载与实际请求一致；显式选择优先于默认值，编辑单项不得丢失其他配置，不支持的能力须明确提示。
- 根目录使用 `npm run setup/build/dev/start/check` 调用官方脚本；实际依赖由子模块锁定的 Corepack pnpm 管理。
- 改完 BenchGo 或 Link 的网页后运行 `npm run reload:plus`。它重建 `plugins/benchgo/lib/modules/`、`lib/client.js` 和 `lib/link-web/` 等模块与网页产物，运行中的 Harness 约半秒内热加载；浏览器需刷新。不要为此重启 Web，也不要把服务器种子包算进这次加载。
- `npm run check` 只检查版本、工作区与入口一致性，不代表应用构建或运行成功。按变更运行适当验证，不默认执行整个上游测试套件。
- 图形应用仅在明确要求时启动。保留许可证与第三方版权声明。

# 开发原则

- 开发对象是 BenchGo。官方 `deepseek-harness/` 保持与上游字节级一致，品牌、启动页、托盘、插件注册都放在根目录脚本和 `plugins/`，打包时注入。
- Windows 开发预览启动已打包的 BenchGo，不启动官方 Desktop。`npm run dev` 进入 `scripts/desktop/prepare-dev.mjs`。
- 插件包名是 `benchgo-plugin`。客户端模块注册 id 必须与包名一致，禁止再注册 `benchgo`。
- 五个 Cordis 入口为 `benchgo-plugin`（基础层）、`benchgo-plugin/harness-plugin`、`benchgo-plugin/superagent-plugin`、`benchgo-plugin/voice-plugin`、`benchgo-plugin/link-plugin`。基础层必须使用完整包根入口，供官方 `clientModules` 发现统一客户端，不能替换为子路径别名。SuperAgent 依赖 Harness 的 `commander` 服务；Voice、Link 不硬依赖 Harness 聚合或 SuperAgent。公共服务复用 `plugins/benchgo/src/`、`plugins/benchgo/shared/`，公共组件复用 `plugins/shared/client/`，不为拆包复制实现。
- 供应商模型 ID、工具名和协议值按不透明标识处理。界面状态跟随真实可用性：已安装且可用显示品牌色，不可用显示灰色，不随选中状态改色。
- 新能力优先复用现有插件、服务和配置。改动保持小而可逆，完成后清掉本次临时文件，保留已有用户修改。

# 文件夹结构

- `plugins/benchgo/`：基础层与唯一安装包，承载公共配置、模型、项目、统计、更新与客户端装配。`lib/modules/` 为其他业务模块生成的发布源码，`lib/client.js` 为统一客户端；不把生成目录当作手工维护源码。
- `plugins/harness/`：Harness 聚合源码包，`src/` 承载原生 Agent 运行时、会话存储、委派、MCP 桥、适配器及官方接入，测试在 `test/`。
- `plugins/superagent/`：SuperAgent 总助手源码包，`src/`、`client/`、`test/` 分别承载业务、界面与测试。运行数据目录与既有 `assistant` 协议不随源码改名。
- `plugins/voice/`：Voice 语音源码包，包含语音服务、输入与播放界面、协议适配及测试，随同一插件安装并独立启停。
- `plugins/link/`：多端直连。网页产物在 `dist/`，同样由 `npm run reload:plus` 重建。
- `plugins/shared/client/`：跨源码包共享组件，不是独立安装包。
- `scripts/desktop/`：Windows 打包、启动页、品牌注入和开发启动。`renderer/` 是 BenchGo 启动页，不改官方欢迎页。
- `scripts/server/`：服务端种子与发布辅助。
- `assets/brand/`：BenchGo Logo、方标和吉祥物的唯一素材来源。
- `docs/`：按板块和小模块维护设计，同主题不重复，板块入口链接各模块；全局唯一 `总架构.html`，区分已实现与待实施。
- `deepseek-harness/`：官方引擎子模块，只更新 pin，不改源码。
- `reference/`：Hermes、Paseo、CC Switch 参考仓库，不参与构建。
- `artifacts/`：本地打包结果，不提交安装包和运行目录。



请结合上下文和项目约定，理解需求并直接推进到完成。普通细节自行判断，关键歧义再询问。
- 以高效、轻量、统一、简洁为原则，优先复用现有能力和成熟方案，兼顾性能与维护成本，避免过度设计。
- 涉及前端，考虑完整用户路径，确保有入口、操作顺畅，并兼顾现代审美和产品一致性。视觉遵循 `docs/02-工作台与Agent/前端视觉规范.md`，交付前自查空、加载、错误、有数据四态的实际渲染，用户做最终验收。
- 可独立拆分的任务优先多 Agent 并行，子代理统一继承当前模型；明确任务边界，完成即停止，最终确认所有子代理已结束工作。
- 完成后清理本次改动产生的无用代码和临时内容、无效遗留代码，保留用户已有修改。执行必要验证，避免重复检查和无关排查，未验证的内容如实说明。
- 少说多做，节省 Token，但不牺牲交付质量。回复简洁，每部分说明使用独立代码块。
