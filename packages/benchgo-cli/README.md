# benchgo

BenchGo 工作台命令。安装和管工作台，可以连接外部中继，不安装中继服务。

```sh
npm install -g benchgo
benchgo install
benchgo server status
```

也可以：

```sh
benchgo update
benchgo server <install|update|status|start|stop|restart>
```

中继服务器是另一个包：

```sh
npm install -g benchgo-relay
benchgo-relay install --config /path/to/relay.json
```

`benchgo install` 需要 Linux、Node.js 22+ 和 systemd 用户服务。资源目录不在当前工作区时，用 `BENCHGO_ROOT` 或 `--root`。
