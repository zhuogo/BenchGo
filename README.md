# BenchGo

<p align="center">
  <img src="assets/brand/benchgo-mark.svg" width="128" alt="BenchGo">
</p>

<p align="center">BenchGo 工作台。项目、会话和模型留在你的机器上，手机和平板连接同一台工作台。</p>

BenchGo 基于官方 DeepSeek Harness，不修改其源码。桌面、网页和 Android 使用同一个 BenchGo 形象。

## 两个产品

| | BenchGo | BenchGo Relay |
| --- | --- | --- |
| 是什么 | 完整工作台 | 中继服务器 |
| 安装包 | `benchgo` | `benchgo-relay` |
| 做什么 | 项目、会话、模型、设备连接 | 只转发已授权设备的流量 |
| 中继 | 可以连接一台外部中继，本身不是中继 | 单独安装，不含工作台 |

同一局域网直接连接，不需要中继。手机在外网、工作台在内网时，才在另一台 Linux 上安装 Relay。

## 安装工作台

Windows 安装包见 [Releases](https://github.com/zhuogo/BenchGo/releases)。安装后包含 BenchGo 基础层、Harness 聚合、SuperAgent、Voice 和 Link，无需逐项安装插件。

Linux：

```sh
npm install -g benchgo
benchgo install
```

也可以 `npx benchgo install`。需要 Node.js 22+。

## 安装中继

只在单独的中继服务器上执行：

```sh
npm install -g benchgo-relay
benchgo-relay install --config /path/to/relay.json
```

`relay.json` 需要已准备的 TLS 证书、私钥和 token。安装工作台不会安装中继。

## 连接

局域网：工作台启用 Link，手机安装 Android App，扫码后在桌面确认。需要同一网络可达，默认端口 48721。

公网：工作台填写自己可达的 HTTPS 地址。Android 首版没有 iOS 原生包，iPhone 使用手机网页。

## 源码

```sh
git clone https://github.com/zhuogo/BenchGo.git
cd BenchGo
git submodule update --init --recursive
npm run setup
```

源码开发使用 Node.js `^22.19.0 || >=24.0.0` 和官方锁定的 Corepack pnpm。Windows 预览先按 [桌面构建说明](scripts/desktop/README.md) 打包，再运行 `npm run dev`，启动 `artifacts/windows/win-unpacked/BenchGo.exe` 并同步当前插件。`npm run start` 仍是官方 Desktop 命令封装，不作为 BenchGo 开发预览入口。网页变更执行 `npm run reload:plus` 后刷新浏览器；`npm run check` 只核对引擎与入口一致性，不代表构建或运行验收。

```text
plugins/benchgo       BenchGo 基础层与唯一安装包 benchgo-plugin
plugins/harness       Harness 聚合：原生 Agent、会话、委派与 MCP
plugins/superagent    SuperAgent 总助手：对话、任务、记忆与产物
plugins/voice         Voice：听写、朗读与实时通话
plugins/link          设备连接、桌面设置、移动界面和 Android
plugins/shared/client 跨包共享界面组件
packages/benchgo-cli  工作台命令 benchgo
packages/benchgo-relay 中继命令 benchgo-relay
assets/brand          BenchGo 形象
docs                  设计与实现记录
deepseek-harness      官方引擎，子模块，不修改
```

Windows 安装包、Android APK 和 npm 发布由 GitHub Actions 构建。正式签名密钥不进入仓库。

五个源码包统一交付为一个 `benchgo-plugin`，在 DSH 的 BenchGo 插件详情中通过五个 Cordis 入口分别管理。基础层提供公共服务；SuperAgent 依赖 Harness 聚合，Voice 与 Link 不硬依赖总助手或聚合运行时。客户端仍只注册 `benchgo-plugin`，已有接口与数据标识保持兼容。目录、依赖及验证边界见 [源码架构](docs/02-工作台与Agent/源码架构.md)。

## 许可

项目遵循 [MIT](LICENSE)。官方引擎、图标和字体遵循各自许可证，见 [NOTICE](plugins/benchgo/NOTICE)。
