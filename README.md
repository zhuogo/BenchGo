# BenchGo

<p align="center">
  <img src="assets/brand/benchgo-logo.svg" width="128" height="128" alt="BenchGo">
</p>

<p align="center">BenchGo 工作台。项目、会话和模型留在你的机器上，手机和平板连接同一台工作台。</p>

BenchGo 基于官方 DeepSeek Harness，不修改其源码。桌面、网页和 Android 使用同一个 BenchGo 形象。

## 两个产品

| | BenchGo | BenchGo Relay |
| --- | --- | --- |
| 是什么 | 完整工作台 | 中继服务器 |
| 安装包 | `benchgo` | `@benchgo/relay` |
| 做什么 | 项目、会话、模型、设备连接 | 只转发已授权设备的流量 |
| 中继 | 可以连接一台外部中继，本身不是中继 | 单独安装，不含工作台 |

同一局域网直接连接，不需要中继。手机在外网、工作台在内网时，才在另一台 Linux 上安装 Relay。

## 安装工作台

Windows 安装包见 [Releases](https://github.com/zhuogo/BenchGo/releases)。安装后即包含 BenchGo、Voice 和 Link，不需要再装插件。

Linux：

```sh
npm install -g benchgo
benchgo install
```

也可以 `npx benchgo install`。需要 Node.js 22+。

## 安装中继

只在单独的中继服务器上执行：

```sh
npm install -g @benchgo/relay
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

```text
plugins/commander     BenchGo 插件，含 Voice
plugins/link          设备连接、桌面设置、移动界面和 Android
packages/benchgo-cli  工作台命令 benchgo
packages/benchgo-relay 中继命令 benchgo-relay
assets/brand          BenchGo 形象
Design                设计与实现记录
deepseek-harness      官方引擎，子模块，不修改
```

Windows 安装包、Android APK 和 npm 发布由 GitHub Actions 构建。正式签名密钥不进入仓库。

## 许可

项目遵循 [MIT](LICENSE)。官方引擎、图标和字体遵循各自许可证，见 [NOTICE](plugins/commander/NOTICE)。
