# Discord 语音接入边界

## 当前能力

BenchGo Voice 已有 PCM WAV 转写、实时 ASR 和 PCM TTS。它们是语音模型能力，不代表已经接入 Discord 语音频道。Discord 文字渠道也不能自动获得语音接收能力。

2026-11-03 已实现 Discord 分句近实时语音：主人在文字频道发送 `/join`、`/leave`，在其当前语音频道收音，转写后进入统一 Router，结果使用共享 Voice 配置朗读。只处理允许列表主人的声音，转写失败不会启动另一个模型循环。真实 Discord 语音收发仍待账号与网络环境验收。

## 实施方案

复用官方生态的 `@discordjs/voice`，不自行实现 Discord UDP、加密和 DAVE。核对的 npm 版本为 `0.19.2`，要求 Node.js >=22.12，依赖 `@snazzah/davey`。加入前还需验证 Opus 编解码依赖和目标 Windows 打包环境；依赖缺失应明确提示，不影响文字渠道。

入口放在 Discord 原聊天，现有命令为 `/join`、`/leave`；状态从 BenchGo 资源 → 接入 → 多平台 → Discord 查看，未实现聊天 `/status` 命令。加入前校验操作者与文字会话准入，并检查主人当前语音频道及机器人 ViewChannel/Connect/Speak 权限；仅支持普通语音频道，不支持 Stage。只转写允许用户的音频，不因频道内可听见某人就赋予其助手权限。连接状态由真实语音连接驱动，离开、配置停用和语音连接断开会清理音频流与播放任务。

数据流：Discord 48 kHz 双声道 Opus → PCM 解码与单声道转换 → 复用 ASR → 统一渠道入站 → Router → 原文字会话交付，并按启用状态复用 TTS 播放。每个发言保留用户与频道来源，不创建第二套 Agent 或项目选择器。当前每段最多 20 秒，最多三个待转写片段，450 ms 静音分句；HTTP ASR 不支持仅 WebSocket 的供应商配置，界面明确不可用。

当前单个连接仅维持一个语音会话；再次加入会释放前一会话。语音入站生成独立消息 ID，绑定发言人、文字会话和语音频道；不是关联到一条已存在的文字消息。上述实现以 `plugins/superagent/src/channels/discord-voice.mjs`、`src/channels/discord.mjs` 和 `src/service.mjs` 为准，2026-11-04 本次源码复核不新增真实通话验收结论。

Opus 使用 `opusscript`，DAVE 使用 `@discordjs/voice` 的 `@snazzah/davey` 原生依赖；状态检查实际加载当前平台 DAVE，缺失时不宣称可用。本机 Windows Opus 编解码和 DAVE 加载已核验。现有跨平台 Linux server seed 排除 `.node`，该种子不包含 DAVE；目标 Linux 主机需另行安装匹配平台的生产依赖后才能启用 Discord 语音。本轮不重建或扩展服务器种子。

首期目标是分句近实时交互：说完一句后识别和回复。持续双向音频、插话打断、跨多人混音属于后续能力；未经实现和实测不标记为全双工实时通话。转写失败、语音模型不可用时保留文字渠道并说明原因。

## 参考和验收

协议与交互参考本地 Hermes `50d2adf1cd`：`plugins/platforms/discord/adapter.py`、`adapter_voice_info.py`、`voice_mixer.py`，不修改或依赖该参考仓库。Hermes 的 Python 实现不能直接安装为 BenchGo Cordis 插件。

验收至少覆盖：授权用户加入与退出、未授权发言忽略、真实 DAVE 频道音频接收、分句转写进入 Router、原频道回复与 TTS 播放、断线清理、模型错误降级、Windows 打包后依赖加载。无真实 Discord 凭据与频道测试时，必须如实注明未验收。
