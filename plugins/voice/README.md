# BenchGo 语音

语音输入、朗读回复与实时通话的当前协议、配置、降噪和恢复行为统一见[实时语音设计](../../docs/03-实时语音/设计.md)。[STREAMING.md](STREAMING.md) 与 [VERIFICATION.md](VERIFICATION.md) 为历史记录，不作为当前能力说明。

模块随唯一安装包 `benchgo-plugin` 交付，不修改官方引擎。Voice 与 SuperAgent 独立启停，复用现有会话、供应商配置、Agent 与人工审批。

## 使用

在「设置 → 媒体 → 语音」中分别启用语音输入、朗读回复和实时通话，填写供应商支持的原始模型 ID、接口与音色后保存。

- 语音输入：输入工具栏麦克风开始/停止，转录进入可编辑草稿，不自动发送。
- 朗读回复：扬声器开关跟随当前对话的新回复，按句合成并流式播放。
- 实时通话：通话按钮启动，停说后的最终转录提交当前 Agent；插话取消相应生成与播放，挂断释放媒体资源。

通话要求流式 ASR 与 TTS；供应商原生实时协议不可用时可显式选择 SSE。SSE 是分段上传音频后的流式文字输出。采集使用本地 RNNoise 降噪及语音概率，多片预览在停说后由完整语段最终识别替换。真实麦克风、外放回声和蓝牙效果需按设备验收。

## 开发

```sh
npm --prefix plugins/benchgo install --ignore-scripts
npm run build:voice
npm run test:voice
```

网页变更后执行 `npm run reload:plus`。构建脚本生成本地降噪 WASM 与 AudioWorklet，并收录进统一插件产物；来源与许可证见 [licenses/SOURCE.md](licenses/SOURCE.md)。不手工修改生成目录。
