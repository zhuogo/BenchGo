# 独立监督宿主

本封装只初始化、启动或查看 Watchdog；不操作主宿主进程，不提供重启策略。周期执行由官方 Harness Schedule 负责。运行前准备主侧观察接口的专用凭据文件，不能使用主人 Cookie。

主系统的 `benchgo-plugin` 基础配置须由维护者设置 `watchdogTarget: { enabled: true, targetId, tokenFile }`，由其 SuperAgent 挂载本机观察接口；`targetId` 与下方 `--target-id` 完全一致，两个进程引用同一专用凭据。凭据为 32–256 字符的 base64url 文本，文件不得为符号链接。观察端的 `watchdog` 配置由 `init` 生成，两个入口职责不同。调度心跳取主侧实际完成周期；请求 deadline 或文件检查点覆盖缺失仍保持未知，状态摘要不能解释为完整健康证明。

从仓库根运行，`--directory` 必须是不存在的绝对路径；父目录须已存在：

```powershell
node scripts/watchdog/profile.mjs init --directory C:/BenchGo-Watchdog --target-id main-installation --target-url http://127.0.0.1:54321 --token-file C:/Private/benchgo-watchdog.token
node scripts/watchdog/profile.mjs start --directory C:/BenchGo-Watchdog
node scripts/watchdog/profile.mjs status --directory C:/BenchGo-Watchdog
```

`init` 不启动服务，拒绝覆盖已有目录。可用 `--plugin` 指定已安装的 `benchgo-plugin` 目录，用 `--config` 提供检查间隔、观察窗口、超时、退避、升级次数、暂停和维护配置的 JSON 文件；字段验证与监督服务共用。令牌只通过 `tokenFile` 引用，不写入配置或启动参数。

部署目录内的 `home/` 是独立 `DSH_HOME`，`data/` 是独立 BenchGo 数据根。配置在 `home/profiles/benchgo-watchdog/cordis.patch.yml`；仅安装原 BenchGo 包，保留基础入口并禁用 Harness、SuperAgent、Voice、Link 四个可选入口。独立档案仅配置 `benchgo-watchdog-read-only` 权限档，使用 `read-only` 沙箱与 `ask` 审批；监督权限还由专用 Agent 工具白名单限定。配置变更由维护者完成，模型不能改配置或 Schedule。

`start` 默认使用仓库已构建的官方 `apps/cli/lib/bin.js`；没有构建产物时使用官方 source CLI 与现有 tsx 依赖，需要先完成工作区依赖安装。也可用 `--cli ABSOLUTE_OFFICIAL_BIN_JS` 指定与 `upstream.json` 相符的既有官方 CLI。启动始终传递 `--no-open`，Windows 子进程隐藏窗口。封装与监督进程保持关联，结束封装时仅转交信号给本次启动的监督子进程。

启动锁阻止重复运行；异常退出后不会自动移除旧锁或再启动。维护者核实原监督已退出后才可处理该隔离目录内的 `launch.lock`。状态摘要读取 `data/watchdog/state.json`，将未完成检查、降级与待投信号分开；存在 PID 或 Schedule 投递回执不代表检查健康。监督的原始日志及历史保留在该隔离目录。

定向验证使用临时目录，不启动图形应用或读取真实档案：

```powershell
node --test plugins/superagent/test/watchdog-profile.test.mjs
```

真实官方配置装配测试使用已构建 CLI 的 `--dump-config`，不启动宿主。当前工作树没有已构建 CLI 时，该项会明确跳过；可设置 `BENCHGO_WATCHDOG_TEST_CLI` 指向已核对版本的官方 `bin.js` 后执行同一测试。此检查不替代真实 Schedule、机械检查或信号投递验收。

独立 profile 已对安装版签名只读接口完成真实周期检查及停止隔离验证；故障场景的验收边界见[任务与执行](../../docs/06-superagent/任务与执行.md#外部-watchdog-监督)。此封装默认不改主配置，也不自动启动监督。
