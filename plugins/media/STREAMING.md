# 流式语音协议与验证

本文保留历史协议与验证记录。当前协议、降噪、转录分片及最终识别行为以[实时语音设计](../../docs/03-实时语音/设计.md)为准。

记录版本：2026-11-03。随 `benchgo-plugin` 交付，不修改官方引擎或参考仓库。

## 协议与配置

设置 → 媒体 → 语音，仅提供 OpenAI 兼容协议。供应商仍须支持所选音频接口、模型及音色；不兼容时明确报错，不静默改写选择。

| 方式 | 上游接口 | 行为 |
| --- | --- | --- |
| `transcriptions-sse`（默认） | `/audio/transcriptions`，multipart + `stream=true` | WAV 分段上传，增量返回文字 |
| `transcriptions` | `/audio/transcriptions` | WAV 分段上传，返回 JSON text |
| `openai-websocket` | `/realtime?intent=transcription` | 持续 PCM 输入，停说后提交，接收增量与最终转录 |
| `speech` | `/audio/speech` | 默认流式 PCM；`tts.stream=false` 等当前合成片段完整返回 |

删除 Step/MiMo 专用适配与模型名称推断。旧专用协议保留原值、标记不可用，用户明确改选后保存；不改写模型 ID、密钥和音色。新配置不预填模型。

TTS 请求使用 model、voice、input、speed、response_format=pcm，不发送厂商专属 sample_rate/stream 字段。标准 HTTP PCM 响应本身可渐进读取；关闭流式采用有界缓冲，不等待整个 Agent 回复完成。播放合同为 PCM16LE、24 kHz、单声道。

## 延迟路径

停说判定 → 最终转录 → 原会话 Agent 首段正文 → 首段 TTS PCM → 播放。

- 输入采集 20 ms 帧，浏览器 AEC/NS/AGC 与自适应能量 VAD、220 ms 预卷。普通起音确认 100 ms、播放期间插话确认 200 ms、停说 320 ms、播放结束保护 220 ms。
- HTTP 识别约每 1.5 秒或停说后上传 WAV。流式返回不等同持续音频输入；供应商支持时，OpenAI WSS 可在说话期间持续上行。
- 服务端 SSE 与客户端最终转录事件及时收尾，不再等待 HTTP EOF。只有最终文本发送 Agent，不用不稳定 partial 提前触发工具或消息。
- 完整句或合格首分句及时提交 TTS；三路有界预取、有序播放。PCM 到达即进入播放队列，无额外合包计时等待。
- AudioContext 准备与通话租约申请并行；分句补切定时器仅在有待处理正文时运行，空闲 Voice 不再每 25 ms 轮询。控制请求有 12 秒超时，错误明确返回。
- 起播缓冲 60 ms，欠载按 20 ms 增加至最高 180 ms，稳定后回落；播放器背压 2 秒。欠载保持回声保护；插话清除本地播放并取消生成。
- 实时待发最多 30 帧/600 ms、最多 12 帧在途；过期或拥塞音频提示重说，不让延迟无限积累。下行背压，不静默丢弃朗读正文。

以上为实现参数，不是端到端延迟保证。模型计算、上游排队、网络 RTT 与设备延迟仍影响效果，未实测不能声称达到或超过端到端 Realtime。

## 恢复与一致性

转录冲突和发送失败保留可恢复文本，提供复制、恢复草稿与通话重试。恢复文本绑定原会话，不自动送入其他会话；不覆盖用户对草稿的编辑。恢复焦点时刷新配置，设置保存只提交变更字段。

无变化保存不打断媒体；ASR、TTS 和开关按影响范围取消。通话遵守原会话工具审批，不自动批准，不撤销已完成的工具操作，不重放工具或旧音频。

## WSS 路由与鉴权

默认从 baseURL 构建 `/realtime?intent=transcription`。`asr.realtime.url` 支持显式 HTTP(S)/WS(S) 地址，`query` 支持非敏感字段与 `{model}` 占位符；禁止凭据、用户名密码、token 或授权字段。供应商 Key 仅在服务端 Authorization 请求头使用。

已鉴权 asr.start 颁发一次性、10 秒有效 ticket，浏览器连接 `/api/voice/realtime`。Desktop 复用官方 connection.openWebSocket；Link 复用配对和设备本地代理身份。二进制帧头是 epoch/utteranceId/sequence 三个 little-endian uint32，随后 PCM16。控制为 attach/commit/clear，返回 ready/ack/partial/final/error/closed。clear 与取消隔离旧 epoch，迟到文本和音频不进入新轮。

反向代理须透传 Upgrade/Connection；不新增公网端口，不绕过鉴权。服务器种子包不属于 reload 范围。

## 验证边界

AudioWorklet 消费 ACK 只维护本地队列和播放状态，不向模型伪称用户听到了哪些文字。conversation.send(text) 仅提交转录。

自动验证见 VERIFICATION.md。TEN VAD、RNNoise 未引入；真实供应商、麦克风、外放回声、蓝牙、移动后台和弱网长通话仍需真机验收。下文是历史记录，不表示已移除的专用协议仍受支持。


## 供应商实例与历史验证

以下为特定供应商、模型和部署环境的历史事实，不定义通用协议或当前默认配置。

### 早期 RouterGo 探测记录（已由下方正确路由复测更新）

仅使用服务生成的短测试语音，无历史消息或用户录音。密钥仅服务器内读取，未输出到日志或文档。

| 请求 | 实际结果 |
| --- | --- |
| Step TTS stepaudio-2.5-tts / cixingnansheng / pcm / 24000 | 200，audio/pcm，103680 bytes，PCM16 mono24k 为 2.16 秒 |
| MiMo TTS mimo-v2.5-tts / alloy / pcm | 400，参数校验失败 |
| MiMo ASR mimo-v2.5-asr / chat/completions stream | 503 |
| Step /audio/asr/sse | 404；本次探测使用 stream 模型，非 SSE 合规模型 |
| WSS `/realtime/asr/stream` | 旧探测路径不适用于 RouterGo |
| RouterGo WSS `/api/v1/realtime?model=stepaudio-2.5-asr-stream&intent=transcription&exit_id=stepfun.audio.transcriptions.websocket` | 101 Switching Protocols；握手后保持连接，尚未完成真实音频会话验证 |

协议实现和 mock 验证完成；RouterGo Step WSS 已完成 101 握手验证，真实音频事件闭环和延迟仍待账号联调。MiMo/Step SSE 已有真实接口验证。真实手机麦克风、外放回声、弱网长通话未验证。TEN VAD、RNNoise 尚未迁移；持续 sinc 重采样与自适应起播缓冲已在本轮实现。

协议依据：Step 官方 api-reference/audio/asr-stream.md、asr-sse.md，以及 MiMo Speech Recognition API 文档。


### 正确 RouterGo 路由复测与修复（2026-10-16）

使用服务端现存供应商凭据，生成一句合成测试语音，不使用用户录音、不输出密钥，不修改官方引擎。

- MiMo `mimo-v2.5-asr`、Step `stepaudio-2.5-asr`：正确接口均为 `POST /audio/transcriptions`，multipart `file/model/response_format=json/stream=true`，`Accept: text/event-stream`。真实均 200，收到多个 `transcript.text.delta` 和最终 `transcript.text.done`；测试音正确转写。模型列表支持 ASR 不表示网关支持厂商私有路径。
- 2026-10-17 同一段 2.84 秒测试音复测：MiMo 首 partial/final 为 2253/2439 ms；Step `stepaudio-2.5-asr` 为 4365/4388 ms；Step `stepaudio-3-asr-max` 为 4845/4911 ms。此前对 RouterGo 旧路径的 404/503 探测已被纠正：正确 `/api/v1/realtime` 路由可完成 101 握手。
- RouterGo `stepaudio-2.5-asr-stream`（实时转写）和 `stepaudio-3-realtime-preview`（实时对话）均已确认可 101 升级；前者可通过 BenchGo 的 Step adapter 与显式实时路由配置接入，后者是完整双向对话协议，当前自有 Agent + ASR + TTS 架构暂不直接使用。
- 早期 `/chat/completions` MiMo 请求仍返回 503 `model_unavailable`，私有 Step `/audio/asr/sse` 使用正确非 stream 模型也为 404。因此新增明确的 `transcriptions-sse` 协议，不再将两个失败接口误判为 ASR 模型本身不可用。
- 插件真实处理器复测：Step TTS 200，41 个 PCM 包、122880 字节；合成音进入 MiMo ASR 后，NDJSON 返回 8 次 partial 和 final，文本为“你好，这是流式语音测试。”。单样本 TTS 首包约 3226 ms，ASR 首 partial 约 3171 ms、final 3422 ms；只是当次服务端时间，不是浏览器端整轮延迟或性能保证。
- ASR 属于持续采集、分段提交、响应增量的组合架构。RouterGo 原生双向 WSS 已完成握手验证，完整音频事件闭环仍待真实账号联调；不能将 SSE 描述为持续 PCM 双向识别。
- 历史迁移曾针对已知 RouterGo MiMo/Step 文件模型补齐 `transcriptions-sse`。当前迁移不判断 RouterGo 域名或供应商 ID，只对无协议字段的明确旧模型兼容推断；显式协议保留。迁移生效于启动内存快照，下次用户保存设置时持久化。
- 媒体 socket 的 `clear` 替换上游 socket，等待新 `session.updated`，保留浏览器 session id 与媒体连接，旧 socket epoch 事件全部丢弃，避免不支持 clear 的供应商污染新输入；原 HTTP 清空入口已删除。
- TTS 采样率/声道元数据若与 24 kHz mono 矛盾立即拒绝；保持 PCM 半样本跨包拼接和取消传播。错误仅向前端返回状态与有界机器码，不转发供应商原始错误消息。

### `MALFORMED_RESPONSE` 根因

线上默认 `deepseek-official` 适配器被配置到 RouterGo `/messages`。真实短请求返回 200 SSE，但只有 `message_delta` 和 `message_stop`，无 `message_start` 或内容块。官方引擎按合同拒绝并报 `event precedes message_start`；朗读只消费已有 Agent 输出，不制造这些事件。相同模型 RouterGo `/chat/completions` 返回正常 `chat.completion.chunk`。应使用共享供应商 `routergo` 的 `openai-completions` 路由，不伪造缺失事件，也不修改官方翻译器。


### 历史部署路由修复

当时该部署的默认路由已在 `.local/web/router.overlay.yml` 与 Web profile patch 持久改为 `routergo / deepseek-v4.1-flash`，修改前文件保存在 `.local/web/backups/voice-route-*`（目录 0700、文件 0600）。当前已加载、空闲且使用不兼容默认路由的失败会话通过官方 `session/selectModel` 切到同一模型的 RouterGo 路由，并用 `session/list` 复核；未编辑任何 Session append-only 日志，其他工具/模型选择未改变。服务重启由主部署流程执行。

### 技术方案边界

后端对应技术方案的职责包括：固定 24 kHz PCM16 mono 媒体合同、受限并发、流式转录/合成、取消传播、配置失效、原生 ASR 连接 epoch 隔离和清空、供应商路由实测。不把 SSE 音频文件识别标成原生双向识别，不把有限真实样本延迟当作性能保证。TEN VAD、RNNoise、Go 服务实现不在本后端移植范围；前端轮次/安全断句/连续播放/ACK 的具体实现以对应源码与验证记录为准。


### 可朗读过滤实现记录

跨增量保留行内代码内容；代码块、表格、裸 URL 分别每轮至多一次替代提示。Markdown 链接仅读标签，长未闭合链接/围栏仅保留有界状态。过滤短动作/舞台描述与表情，保留普通括号解释；仍使用同步有界处理进入现有三并发 PCM 队列，不等待网络或播放。断句保留完整句优先和安全 idle 补切。
