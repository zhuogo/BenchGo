# benchgo-relay

BenchGo 自托管中继运行时边界。中继独立于工作台，不包含项目、会话、模型或 owner
数据；运行时只转发已授权设备的 Link 流量。

自 0.1.1 起，命令显示版本与包清单、安装脚本默认版本保持一致。Relay 继续独立安装与管理，不会隐式安装工作台；已有配置的中继继续使用下列命令管理，升级 npm 包本身不会重新创建服务。systemd 安装及管理入口用于 Linux，不把 Windows 上的命令测试视为 Linux 服务器真机验收。

```sh
npm install -g benchgo-relay@0.1.1
benchgo-relay run --config /path/to/relay.json
benchgo-relay status
benchgo-relay start
benchgo-relay stop
benchgo-relay restart
benchgo-relay logs
benchgo-relay renew
benchgo-relay renew-status
benchgo-relay diagnose
benchgo-relay uninstall
```

已有证书、密钥和 `relay.json` 后，可使用 `benchgo-relay install --config relay.json`
创建 systemd 服务；公网 IP、证书申请和首次配置仍由设备中心 SSH 向导完成。服务管理需要
root 或免密 sudo。运行包已内置 Link relay runtime。
