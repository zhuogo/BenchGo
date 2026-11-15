# benchgo

自 0.1.1 起，BenchGo CLI 提供本机工作台统一安装与复用入口，首次安装需要 Node.js 24.9+。Windows x64 已完成隔离安装、复用和启停验证；macOS arm64/x64、Linux x64 的入口需要匹配原生发行资源，尚未完成真机验证。中继独立使用 `benchgo-relay`。

```sh
npm install -g benchgo@0.1.1
benchgo install
benchgo status
benchgo stop
benchgo start
benchgo update
```

本机交互终端安装后默认打开浏览器；SSH、CI、无图形 Linux 默认只启动服务并显示本机连接地址。`--no-open` 禁止打开浏览器，`--open` 显式打开。服务只监听 `127.0.0.1`，认证地址属于当前用户，不要公开分享。

CLI 与新版 BenchGo Desktop 共用 `DSH_HOME/profiles/desktop`、安装记录和进程租约。重复安装会复用已有安装和运行实例；已安装 Desktop 时，CLI 可使用其官方引擎和匹配 Node 载体，在浏览器运行工作台。Desktop 运行中直接复用其地址；CLI 不会强制退出 Desktop。切换宿主或更新前检查运行、等待交互和已安排的任务，未确认完整关闭时不接管。

单独通过标准 npm 前缀安装的官方 Harness，会在 PATH 对应的常见安装目录中验证精确版本与官方包身份后复用；其他位置可用 `--runtime` 指定。发现已有但不兼容的引擎时明确提示升级原引擎，不会悄悄再下载一套；旧 profile 不会被搬迁。

```sh
benchgo install --no-open --json
benchgo install --offline --root /path/to/native/benchgo/seed --runtime /path/to/dsh
benchgo prefetch --source github
benchgo update --source github
```

发行资源使用固定版本、签名和摘要验证，不会静默更换下载源或使用其他平台的包。Windows 获取完整原生插件；Linux 获取服务器种子；macOS 当前需获取匹配架构的完整 Desktop ZIP，首次下载仍较大。`prefetch` 只准备资源，不代表离线安装已经准备好官方引擎。

`--home` 只选择 Harness 目录，不是系统用户沙盒。BenchGo 数据目录仍遵循产品配置；并发数据所有权检查会阻止未登记旧宿主重复运行。未登记的旧 Desktop 工作区请先用新版 Desktop 登记；CLI 不会自动搬迁原有官方 profile 或改写其配置。

既有 Linux/systemd SSH 服务保留独立的有效管理入口，不会被本机安装覆盖。检测到已有服务器部署时，本机安装会提示使用原入口：

```sh
benchgo server install
benchgo server status
benchgo server start
benchgo server stop
benchgo server restart
benchgo server update
```

命令包只携带共享安装契约、公钥和固定发行描述，按需取得匹配资源；不再内置旧 Linux 服务器种子。源码发布前运行 `npm run prepare:resources`；`npm pack`/`npm publish` 的 `prepack` 会自动生成相同资源。

## 旧全局命令占用

推荐使用固定版本 `npx --yes benchgo@0.1.1 install`。若曾全局安装旧 `benchgo-plugin`，全局安装新 `benchgo` 时可能遇到同名命令占用；先将旧插件升级为 `benchgo-plugin@0.1.5`，再安装 `benchgo@0.1.1`。确认不再使用旧插件时也可先卸载它。新插件只注册 `commander`；无需为使用工作台而额外安装插件包，也不自动删除用户已有命令。

若此前用 `--force` 让 CLI 覆盖了旧插件的同名命令，npm 在随后升级旧插件时可能删除 `benchgo` 入口；升级插件后重新执行 `npm install -g benchgo@0.1.1` 即可恢复。已在隔离 Windows/npm 环境验证此恢复顺序；固定版本 `npx` 调用仍可用。
