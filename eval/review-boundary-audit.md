# Review evidence 边界修复

已实施，仅修改 reader 与对应测试：

- 分页工具参数限制为 2000 字符，并返回 `argumentsLength`、`argumentsTruncated`，避免大参数在每次分页时重复撑大上下文。
- 索引保留最新 256 个工具结果，维持原始顺序及 `omitted` 计数；被索引省略的真实 seq 仍可按需读取。
- 保持 session、完整 transcript hash、lastSeq、summary 校验，未改旧 executionEvidence 投影，保留持久化恢复兼容性。

验证：`node --import ./scripts/source-loader.mjs --test plugins/superagent/test/review-evidence-reader.test.mjs`，5/5 通过。覆盖完整性篡改、非工具 seq、非法分页、隐私块排除、索引最新窗口、旧 seq 可读、5 万字符参数每页截断。

其他审计发现交由主协调处理：内部返工须在通知发布之前分流，避免 `resultDelivery` 把 silent 转回公开失败通知；不能以修改用户需求 revision 的方式发起内部补证据。
