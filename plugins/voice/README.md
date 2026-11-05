# BenchGo 语音

协议配置、使用方式与验证范围见 [STREAMING.md](STREAMING.md)。仅支持 OpenAI 兼容接口，默认流式；供应商仍须实际支持所选音频接口与模型。

BenchGo 内置语音模块，目录 `plugins/voice/`，随 `benchgo-plugin` 包交付。不修改官方引擎，复用官方输入框、消息流、模型选择、Agent 与人工审批。

## 使用

在「设置 → 媒体 → 语音」中分别启用语音转文本、朗读回复、实时通话，选择共享供应商或填写独立 API 地址、原始模型 ID、密钥和 TTS 音色后保存。ASR 默认流式转录，可切换普通转录或 OpenAI WebSocket 持续识别；TTS 默认边生成边播放，可关闭流式。三项功能默认关闭，不预填或推断供应商模型。旧厂商专用协议保持原配置并提示不可用，必须明确选择受支持方式后保存。

媒体设置入口由基础层保留，供应商目录复用基础模型服务。Voice 与 SuperAgent 可独立启停：关闭 Voice 不影响图片/视频配置，关闭 SuperAgent 不影响语音配置；不可用的面板明确提示对应模块未启用。

- **语音转文本**：输入工具栏的麦克风开始/停止；普通 HTTP/SSE 每约 1.5 秒上传一个 WAV 片段，按顺序实时更新可编辑草稿。不会自动发送。用户编辑导致草稿 revision 变化时保留完整转录，不覆盖用户输入；停止后可复制或恢复到草稿。
- **朗读回复**：点击独立扬声器图标切换，悬停显示开启/关闭气泡。开启后跟随新生成的当前对话输出，按句预取合成、按顺序流式播放；最终消息按 turn/step 关联流式 attempt，只补读尚未推送的后缀，不重读已推送正文或历史。
- **实时通话**：点击「通话」，停说并识别完成后提交给当前对话的原有 Agent。仅发送真实转录文字，不追加内部播放状态。用户再次开口立即清空本地播放、取消当前生成，隔离迟到结果；工具权限仍须在原有屏幕界面确认，语音不自动批准。点击「挂断」释放采集、识别、合成、播放与通话租约。

浏览器需要 HTTPS 或 localhost，以及麦克风授权；远程服务部署时使用已配置的 HTTPS 入口。本机请求复用 Harness 鉴权，远程 Link 使用已批准设备的工作台会话，可经已配置的 Link 中继传输，不额外部署语音中继。ASR 接收音频，TTS 接收经过过滤的回复文本，当前 Agent 接收转录文本，实际数据出口取决于你填写的服务地址。

## 模型接口

ASR 默认采用 OpenAI 兼容 `POST <baseURL>/audio/transcriptions`：multipart 字段包含 `file`（24 kHz 单声道 PCM16 WAV）、`model`、`response_format: json`。`transcriptions` 接收 JSON `text`；`transcriptions-sse` 额外发送 `stream=true`，接收转录增量。SSE 是分段上传后的流式输出，不是持续音频输入。

持续 PCM 输入显式选择 `openai-websocket`，使用 OpenAI session/delta 协议，默认 `<baseURL>/realtime?intent=transcription`。复用 20 ms PCM 采集、独立二进制 WebSocket、有界发送队列、服务端 WSS 和取消机制；不会根据域名、模型名称或供应商 ID 改写路由。`asr.realtime.url` 可配置完整 HTTP(S)/WS(S) 地址及非敏感查询参数，`asr.realtime.query` 支持非敏感路由字段与 `{model}` 占位符。切换供应商会清理旧实时路由覆盖。

TTS 仅支持 `speech`，使用 OpenAI 兼容 `POST <baseURL>/audio/speech`，发送 `model`、`voice`、`input`、`speed`、`response_format: pcm`。默认 `tts.stream: true` 直接转发音频；关闭时服务端有界收集当前片段，再交给播放器，不发送厂商扩展字段。播放合同统一为 **PCM16LE / 24000 Hz / 单声道**，拒绝冲突的采样率或声道元数据；MP3、WAV、其他采样率不在当前适配范围。并非任意文字模型 API 都支持语音接口。

API Key 仅存服务端，通过上游 `Authorization` 请求头传递，禁止放入实时 URL 或查询参数。配置文件权限 0600，目录权限 0700。前端只获得已配置标记和掩码；留空密钥保留原值，明确点击清除才删除。存储为 `~/.benchgo/voice/config.json`，首次启动在目标不存在时迁移旧 `$DSH_HOME/voice/`；插件配置 `dataDir` 可覆盖。

## 安装与构建

```sh
npm --prefix plugins/benchgo install --ignore-scripts
npm run build:voice
npm run test:voice
```

向官方 profile 的 `package.json` 添加 `dependencies: {"benchgo-plugin":"link:/absolute/path/plugins/benchgo"}`，并在 `dsh.profile.bundles` 数组加入 `benchgo-plugin`，在该 profile 安装依赖后由官方 `dsh web` / Desktop 加载。BenchGo 桌面发行包沿用初始化安装流程；其他 profile 需自行安装。不改上游工作区、源码或锁文件。

## 机制与边界

复用历史实时语音处理层的生命周期、取消隔离和播放确认思路。本文描述本插件实际实现，不能把原项目的全部能力视为已经迁移。

- AudioWorklet 连续采集和播放，保留重采样相位；24 kHz PCM16LE。实际消费完整片段后确认播放，收到数据不等于听到。
- 浏览器 AEC / NS / AGC，自适应 RMS VAD、预卷和停说判定。已使用持续 windowed-sinc 重采样与自适应起播缓冲；**未移植 TEN VAD、RNNoise**，外放建议先用耳机验证。
- 实时上行待发送队列最多 600 ms，拥塞淘汰旧帧并提示，避免延迟累积；不会因此直接挂断。播放 60–180 ms 自适应起播、短暂欠载不解除回声保护，插话确认 200 ms、停说 320 ms（实现值，非端到端性能保证）。
- 文本可朗读过滤、首句/首分句及时合成、3 路 TTS 预取、有序播放、有限缓冲；过滤不等于完备敏感数据防护。
- 单会话单主动设备，45 秒租约，15 秒心跳，最长 30 分钟；进程重启不恢复旧音频、不重放工具。
- 挂断、断网、切换会话、插件卸载传播取消；配置更新按影响范围取消，未变化的保存不打断媒体。取消不会撤销已经完成的工具操作。
- 播放确认仅用于本地片段队列与播放状态，不发送给 Agent，也不追加到用户消息。官方 `conversation.send(text)` 将文本原样提交为用户消息，不承诺模型知道用户实际听到的位置。发送失败保留待发转录，可重试、复制或挂断后转为草稿；静音不丢弃已识别待发内容。恢复内容在当前页面内存中绑定原会话，返回该会话可恢复，不自动发送给其他会话；刷新页面后不会持久保留。

验证包含本地模拟协议与真实本机 WebSocket、取消、租约、音频采样/队列、输出过滤、恢复、客户端 Agent 事件桥接及首段 PCM 播放链路。当前协议未用真实供应商账号联调；真实手机麦克风、外放回声和弱网长通话未验证。历史厂商专用协议探测不等于当前标准协议兼容性验证。具体记录见 VERIFICATION.md。
