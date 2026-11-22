# BenchGo

<p align="center">
  <img src="assets/brand/benchgo-mark.svg" width="128" alt="BenchGo">
</p>

<p align="center"><strong>集成 SuperAgent 总助手、实时语音和跨设备协作的 AI 工作台</strong></p>

<p align="center">
  <a href="https://benchgo.cn/download">下载 BenchGo</a> ·
  <a href="https://benchgo.cn/docs">使用文档</a> ·
  <a href="https://github.com/zhuogo/BenchGo/releases">GitHub Releases</a>
</p>

在同一个对话里商量、派发任务，再回来查看进展和成果。可以打字、听写或开一场实时语音通话，也可以用手机连接原来的工作台，接着处理同一会话。项目与会话保存在承载工作台的电脑或服务器上。

## 核心特性

- **SuperAgent 总助手**：在主聊天里交代工作，助手记住偏好和项目背景，把任务交给执行 Agent。执行期间可以继续聊，任务页可查看进展、待处理问题和产物，结果回到发起任务的会话。详见[总助手设计](docs/06-superagent/设计.md)。
- **Voice 语音交互**：麦克风听写成可编辑草稿，回复可以流式朗读。实时通话支持自然停顿和插话，使用当前会话的 Agent。听写、朗读和通话可分别开启，通话需要配置支持流式识别与合成的供应商。详见[实时语音设计](docs/03-实时语音/设计.md)。
- **Link 跨设备协作**：桌面、Android 和移动浏览器可以连接同一台工作台，继续原有项目和会话。局域网可扫码直连，外网可使用可达的 HTTPS 地址或自建中继。详见[设备与远程连接](docs/01-设备与远程连接/设计.md)。
- **项目、会话与产物**：统一浏览项目和会话，查看任务进展、处理审批、恢复会话并预览文件产物。详见[工作台与 Agent](docs/02-工作台与Agent/设计.md)。
- **原生 Agent 与模型配置**：在官方 DeepSeek Harness 基础上接入已有的 Codex、Claude Code 等工具，按项目选择工具和可用模型，集中管理供应商与技能。配置相应模型后也可生成媒体。详见[模型与工具](docs/04-模型与工具/设计.md)。

## 安装工作台

Windows x64 提供 EXE，macOS Apple Silicon / Intel 提供 DMG 和 ZIP，Android 提供 APK。桌面安装包含基础层、Harness 聚合、SuperAgent、Voice 和 Link，开箱即可配置使用。Android 通过 Link 连接已有工作台。安装包与校验文件见 [Releases](https://github.com/zhuogo/BenchGo/releases)。macOS 当前采用 ad-hoc 签名，未经过 Apple 公证；Windows 未宣称发行者认证。

### 命令行与服务器

自 CLI 0.1.1 起，使用 `npx --yes benchgo@0.1.1 install` 安装统一工作台，也可全局安装 `benchgo@0.1.1` 后运行 `benchgo install`。入口支持 Windows x64、macOS arm64/x64 和 Linux x64，需要 Node.js 24.9+；Windows 已完成隔离安装、复用与启停验证，macOS/Linux CLI 仍需真机验收。本机交互终端默认打开浏览器，SSH、无头会话及 `--no-open` 保持后台运行；`status/start/stop` 管理同一工作台。CLI 与新版 Desktop 共用同一用户目录和 `profiles/desktop`，优先连接已登记实例；未知旧工作区或不兼容引擎会明确拒绝接管并保留原环境。复用运行资源不代表首次客户端安装包无需下载。安装、资源复用及平台边界见[更新与发布设计](docs/05-更新与发布/设计.md)。源码开发入口仍为 `node bin/benchgo.mjs install`。

需要 SSH/systemd 常驻部署时，使用发行版中的 `benchgo-<version>-linux-server.tar.gz`，支持 Ubuntu / Debian x64 和 systemd 用户服务。校验同页 SHA256SUMS 后解压，在解压目录执行：

```sh
(umask 077; bash install.sh github connect > connection.json)
```

`connection.json` 含设备授权凭据，请私密保管。也可在 BenchGo「设备中心 → 设备 → 添加设备 → 安装到服务器」完成部署与连接。此包是无桌面窗口的服务端，不是 Linux Desktop，不支持 ARM64；内置离线插件，首次安装仍需联网获取固定版本官方 Harness 和必要时的 Node.js 24.9+。具体要求、更新与服务管理以包内 README 为准。

## 连接手机与平板

1. 在工作台启用 Link。Android 使用 BenchGo App，iPhone 和 iPad 使用移动浏览器。
2. 同一局域网内，使用 Android App 扫码，或在浏览器打开配对链接，再在桌面确认授权。默认端口为 `48721`。
3. 外网连接使用工作台可达的 HTTPS 地址，或通过另行部署的 BenchGo Relay 转发已授权设备的流量。部署中继见[自建中继](docs/01-设备与远程连接/自建中继.md)。

## 源码开发

```sh
git clone https://github.com/zhuogo/BenchGo.git
cd BenchGo
git submodule update --init --recursive
npm run setup
```

源码开发使用 Node.js `^22.19.0 || >=24.0.0` 和官方锁定的 Corepack pnpm。Windows 预览先按 [桌面构建说明](scripts/desktop/README.md) 打包，再运行 `npm run dev`，启动 `artifacts/windows/win-unpacked/BenchGo.exe` 并同步当前插件。`npm run start` 仍是官方 Desktop 命令封装，不作为 BenchGo 开发预览入口。网页变更执行 `npm run reload:plus` 后刷新浏览器；`npm run check` 只核对引擎与入口一致性，不代表构建或运行验收。

```text
plugins/base          BenchGo 基础层与唯一安装包 benchgo-plugin
plugins/harness       Harness 聚合：原生 Agent、会话、委派与 MCP
plugins/superagent    SuperAgent 总助手：对话、任务、记忆与产物
plugins/media         Media：媒体生成、听写、朗读与实时通话
plugins/link          设备连接、桌面设置、移动界面和 Android
plugins/shared/client 跨包共享界面组件
packages/benchgo-cli   工作台命令 benchgo
packages/benchgo-relay 中继命令 benchgo-relay
assets/brand           BenchGo 形象
docs                   各模块设计与实现边界
deepseek-harness       官方 DeepSeek Harness 子模块
```

Windows EXE、macOS 双架构 DMG/ZIP、Android 发行签名 APK 和 Linux 服务端归档由统一 GitHub Actions 流程构建；全平台验证通过后发布不可变版本及签名下载清单。npm 发布使用独立手动入口。正式签名密钥不进入仓库。iOS 当前使用浏览器访问 Link，不提供原生 IPA。

BenchGo 通过插件扩展官方 DeepSeek Harness，保持上游源码原样。五个源码包统一交付为 `benchgo-plugin`，可在插件详情中分别管理五个 Cordis 入口。整体机制见[总架构](docs/总架构.html)，目录、依赖及验证边界见[源码架构](docs/02-工作台与Agent/源码架构.md)，发布流程见[更新与发布设计](docs/05-更新与发布/设计.md)。

## 许可

项目遵循 [MIT](LICENSE)。官方引擎、图标和字体遵循各自许可证，见 [NOTICE](plugins/base/NOTICE)。
