# 2026-11-05 晚：Worker Attention 分流

## Mandate

- 复用官方 `user-questions/request`；Router 先从原 Mandate 查已有明确答案，未知信息才问用户。非阻塞默认仅在原指令明确授权且默认内容有原文依据时可用。
- 权限与计划批准始终交用户，自动回答不生成 human Trigger，不新增权限，不通过回答改变 Worker 工具门禁。
- Router 只读单次流式调用，使用 Router 首模型、`goalBudgetLlm` 计费，45 秒、无重试；失败、超时、配置缺失按可观察系统状态交用户。
- timed 问题分流期间通过官方 `attachWait` 保持前景等待，完成后释放；批量回答必须完整。只让当前 assignment 等待，其他 assignment 不受影响，不宣称同一 assignment 内子步骤可独立推进。

## 设计

独立 `sa_attention_resolutions` 表保存宿主分流事实（原问题、questionId、route self/default/user、依据、答案、系统状态、原 instruction revision），不占人类来源字段。仅 user 项进入现有 Attention/outbox；混合批次由宿主自动答案与真实用户答案合成，重启继续保持完整批次且不重开自答卡。

分流输出采用保守契约：self 仅返回原 Mandate 的逐字依据作为答案；default 要有逐字默认内容与明确授权依据，且判为非阻塞；host 对官方 approval/plan-review 意图及明显批准措辞直接转用户。模型不得凭猜测补授权。所有返回必须包含每个 questionId 一次，格式不合法则整批转用户。

## 验证

已实现。定向 helper/store 7/7（含原渠道/桌面 Attention 回归）通过；官方 Harness 4/4 通过（Router 分流超过 1 秒仍保持原 timed 工具、自答与默认不建卡、原渠道真答、重启及工件防篡改）。混合 self/user 批次重启后仍只保留一张用户卡并返回两个完整答案。额外 1/1 验证同 Ticket 另一 assignment 可在前者 Attention 等待期间领取并续租；未实现或宣称单 assignment 子步骤级暂停。

原文证据强约束有意保守：答案内容采用原指令逐字 excerpt，不生成新事实；default 必须同时有原文授权、原文默认内容及非阻塞判定。权限/计划意图和明确批准措辞固定 user，未知或模型/预算/超时失败有 `systemState` 可见字段。真实供应商与最终用户路径由 live_astra 统一验收，夹具不算真实通过。

## 真实运行发现的事件顺序缺口

2026-11-05 `attention-1-attempt-2` 失败：原 Worker 在 13:05:07Z 完成读取后调用正式 `ask_user_question`（两题、`timeout: -1`），但没有 Attention、resolution 或 Router 分流请求；13:14:51Z 原执行预算到期。证据见 `eval/superagent-evening-20261105/attention-1-attempt-2/`。该调用的检查点已进入 dispatch，排除工具前置审批与 BenchGo 权限检查卡住；`timeout: -1` 不经过 `attachWait`。

官方引擎 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` 的 `packages/api/remotes/src/index.ts` 先注册 `user-questions/request` waterfall，再由 `packages/api/gateway/src/index.ts` 保留待答远程事件；没有 owner Remote Client 时也不调用 `next()`。Worker 后注册的默认顺序监听器因此被阻塞，执行计时也未暂停。修复仅让 BenchGo Worker 通过公开 `{ prepend: true }` 优先接管自己支持渠道的提问，继续保留精确 Agent 身份与渠道过滤；其他请求仍 `next()`。不修改官方源码，不绕过工具审批。新增官方 api-remotes、Gateway 无客户端组合回归后再验真实供应商；此处不把夹具等同真实通过。

该顺序修复及定向 8/8 已通过：`worker-attention-host.test.mjs` 装配真实官方 Agent、userQuestions、api-remotes、Gateway（没有 Remote Client），验证后创建 Worker 先分流并保存 self/user 混合批次、只向用户建一题、完整返回答案、精确 Agent 与不支持渠道继续交官方链、Worker 释放后不残留监听。原 Attention 存储与分流回归同时通过。使用固定无网络 LLM 夹具；发布产物重建与真实供应商复验由主执行统一推进。

## 续做诊断

### 2026-11-06 离线复盘假设清单

| 假设 | 支持证据 | 反证/当前结论 |
| --- | --- | --- |
| A. `waiting` Run 没有在答复入队后转为 `prepared` | 现场 fence 从 1 变 2，续跑未出现后续 Worker 请求 | `claimAssignments` 在 Attention continuation ready 时明确把同一 Run 转为 `prepared`；官方 Host 的 Q-user-only、Q-known→Q-user 两条夹具均通过。基本证伪，仍由真实阶段字段复核 |
| B. 原 Worker session 或 checkpoint 校验失败 | 现场答复后约 1 秒进入 `UNAVAILABLE`，没有后续供应商请求；执行器在 `resume` setup 阶段会校验 transcript、execution effects、checkpoint | attempt-3 已清理隔离 session，无法读取抛错正文；新诊断只记录阶段，不记录敏感异常。尚未证伪 |
| C. `ctx.userQuestions.answer` 或 Attention 批次身份不匹配 | 真实快照只保留 Q-user resolution，答复后没有 Worker 请求；续跑阶段会校验 callId、sessionId、questionId | 离线官方 Host 已通过 Q-user-only 及 Q-known→Q-user、fence 递增、checkpoint、原 Run/session 续做。尚未用真实新运行证伪 |
| D. 恢复后首次 followup/模型请求前的宿主异常 | 现场没有任何答复后的 Worker supplier request，且旧记录只有通用 `UNAVAILABLE` | 旧运行未保留 phase；需要新构建真实运行确认，不能提前定为根因 |

本轮原则：先以新阶段诊断在真实路径区分 B/C/D；同一假设两次无新证据即停止，不盲目连续重跑。未定位前不计 Attention 三连。

`attention-1-attempt-3` 的答复已保存，续做失败发生在下一次供应商请求之前。现存 `UNAVAILABLE` 是多种异常的统一映射，隔离会话已清理，不能推断具体根因或自动重放。执行器记录固定的续做阶段标识，失败记录只接受白名单标识，不保存异常正文、路径、问题或模型内容；未知外部效果仍保持 uncertain。以无网络官方宿主夹具分别验证同进程与重启后的原会话续做，夹具结果不代替真实验收。

定向验证 4/4 通过：同进程续做、重启续做、工件篡改拒绝及失败阶段白名单。两种正常续做均保持原 Run/session，且先前工具效果不重放；未复现真实失败，根因仍未知。

补充桌面官方宿主无网络夹具 2/2：先执行模拟读取并保存真实动作检查点，分别只提出 Q-user、以及先提出自答 Q-known 再提出 Q-user；保存桌面用户答复后以 fence 1→2 恢复同一 Run/session，检查点完整、读取不重放、答案进入下一次请求。attempt-3 快照只保存 Q-user resolution，不能证明 Q-known 实际调用；模拟读取和固定模型输出也不能还原已清理的真实 transcript，现场故障仍未复现。

### 2026-11-06 真实诊断重试

为确认真实续跑前的分流是否稳定，使用固定 Mandate、固定 `routergo/deepseek-v4.1-flash`、全流式请求各运行一次诊断（`attention-1-diagnosis-20261106b`、`attention-1-diagnosis-20261106c`）。两次都在续跑前停止：supplier 请求出现 `finishKind=error`，Router triage 到达 45 秒边界后按设计返回 `systemState=timeout`，Q-known 与 Q-user 均 route=user；`cases.mjs:89` 因已授权 Q-known 未 self 直接终止。两次现场都保留 `isolated-state/`，主配置哈希未变，未产生答复后 Worker 请求，故没有新的 B/C/D 续跑阶段证据。

这两次结果证明当前真实供应商在本轮诊断中先卡在 Attention triage 可用性，不能把它归因于续跑恢复层，也不能把系统兜底路径当成真实三连通过。按同一阻点两次无新证据即停止的规则，本轮不再重放；Attention 三连仍未开始计数，根因暂未定位。
