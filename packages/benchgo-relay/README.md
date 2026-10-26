# benchgo-relay

BenchGo 自托管中继运行时边界。中继独立于工作台，不包含项目、会话、模型或 owner
数据；运行时只转发已授权设备的 Link 流量。

```sh
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
