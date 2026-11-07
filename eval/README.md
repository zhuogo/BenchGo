# BenchGo SuperAgent 本地评估

打开 [HTML 报告](index.html)。全部场景、原始证据、量化指标和问题诊断均保存在本目录。

补充审查：[DeepSeek SuperAgent 原型对照与借鉴建议](superagent-20261103/reference-comparison.md)，包含参考提交版本、已实现机制、差异与待实施方案。

## 文件

- `run-superagent.mjs`：复用仓库的真实 Harness loader 冒烟启动器，生成隔离 profile，不改官方源码。
- `superagent-cases.mjs`：30 个可控模型场景，以及 7 个真实模型扩展。逐项给出判据，失败继续执行。
- `check-installed.mjs`：对已经运行的打包实例进行 5 项只读 HTTP 边界检查；默认本轮发现的本地端口，可用 `BENCHGO_EVAL_HOST` 指定。
- `build-report.mjs`：从实测 JSON 计算指标，生成可离线查看、搜索和筛选的 HTML。
- `verify-report.mjs`：验证统计一致性、证据链接、内联脚本和筛选行为，不做视觉验收。
- `superagent-20261103/`：本轮报告数据、完整基线 TAP、原始工单、真实模型结果与诊断。
- `design/direction.json`：报告样式来源，Achromatic ledger，seed 752076510；使用正式 BenchGo 标志。

## 复现

在仓库根目录运行：

```powershell
node eval/run-superagent.mjs
node eval/run-superagent.mjs --real
node eval/run-superagent.mjs --real --extra
node eval/run-superagent.mjs --real --diagnostic
node eval/check-installed.mjs
node eval/build-report.mjs
node eval/verify-report.mjs
```

真实模型模式读取本机 `.dsh/profiles/desktop/cordis.patch.yml` 中明确选择的默认模型及相应凭据，不修改原配置；会产生实际模型请求。当前启动器支持已有 `openai-completions` 路由，其他协议明确拒绝。环境中的 `BENCHGO_ASSISTANT_SMOKE_*` 不应被用于覆盖可控测试。

运行需要已安装、构建好的官方引擎与 `benchgo-plugin` 发布产物。测试在临时目录建立 profile 和 Git 项目，通过官方 Web API 发起任务；退出时关闭子进程并删除临时目录。默认不启动 GUI、不访问外部聊天渠道、不修改产品代码。重复执行会覆盖本轮同名结果，需保留旧轮次时先复制结果目录。

## 评估口径

- 可控模型的 30 项通过率只代表服务契约、工具边界和状态链路；固定返回的 Worker/Reviewer 不能证明智能质量。
- 真实模型 7 项单独计分，诊断重跑不作为额外成功样本；一次样本不表示稳定性统计。
- R06 要求**文件存在、内容正确、review passed、delivery sent**全部满足。只有通知送达或只有文件正确都不算全链路通过。
- R07 中 Worker 实际拒绝了诱导虚假声明，验收拒绝缺失产物；该结果不独立证明 Reviewer 能识别所有伪造摘要。
- 基线单测、真实 HTTP、真实模型、正在运行的打包实例边界检查分别记录，不能互相替代。UI 点击、视觉、外部渠道、进程崩溃恢复未做本轮端到端验收。
- 首轮 `controlled-initial-harness.json` 和 `diagnostic-initial-harness.json` 保留评估脚本调试证据。前者涉及上下文提示解析、接口返回解包和操作前置条件；后者为评估客户端 20 秒超时短于真实重审时限，均不作为产品失败计数。

## 本次变更边界

优化后报告仍为 `index.html`，顶部展示本轮 132 项定向回归、30 场景 HTTP 和 2 项真实模型复测；下方保留修复前基线。生成顺序：`node eval/finalize-optimization.mjs` → `node eval/build-report.mjs` → `node eval/verify-report.mjs`。

初始评估仅新增 `eval/`，未修改产品实现。后续用户授权优化，方案见 `superagent-20261103/optimization-plan.md`，设计见 `../docs/06-superagent/设计.md`；修复后复测使用 `--output-dir eval/superagent-20261103/after` 保留原始证据。

`node --import ./scripts/source-loader.mjs eval/measure-subscription-routing.mjs` 测量 300 条消息的订阅直通与去重，只统计宿主入口和候选数量，不宣称实际模型调用、缓存 token 或编码质量收益。
