# 执行证据修复交接

责任范围：仅 `execution-evidence.mjs`、`assignment-executor.mjs`、`execution-evidence.test.mjs` 与新增 `docs/06-superagent/执行证据投影.md`。先写设计再开发。

结果包新增 `toolEvidence: { entries, total, omitted, failedCount, truncated }`。entry 含 seq、callId、name、arguments、text、isError、argumentsLength、textLength、truncated、hash。源自真实 Session 工具调用及结果，保留不透明工具名，剔除 reasoning/二进制；最近 64 条以内，合计约 24k 字符，参数 2k、结果 4k，全部遗漏与截断显式标记。failedCount 是全部历史工具错误数量，不应自动一票否决：Worker 可能已完成补救。

恢复时比对原 transcript hash；新投影若被篡改拒绝。旧结果没有 toolEvidence 时，在锁内从已核实原日志重建后送给 review，因此旧 waiting 重审能获得已有证据，不重跑 Worker。

主代理/其他代理请勿重写这些文件；review 可使用以上新字段，但缺投影的外部/旧测试结果兼容性需自行考虑。不新增 MCP/HTTP 路由。

验证：使用 `node --import ./scripts/source-loader.mjs --test` 执行 execution-evidence、review-continuation、orchestration-runtime、assignment-executor 共 26 项全部通过。最初直接 node --test 因未使用仓库 loader 而缺官方包，已按约定重跑成功。未重复真实模型评估，留给集成阶段。
