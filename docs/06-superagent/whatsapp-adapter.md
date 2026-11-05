# WhatsApp 接入

更新：2026-11-04，源码已实现；真实 Meta 账号收发尚未验收。

实现范围：Meta WhatsApp Business Cloud API，通过签名验证的 Webhook 接收私聊，经统一 `ingest` 进入 Router，使用 Graph API 在原对话回复。适配器不创建独立 Agent 或项目选择器。

配置仅保存 Phone Number ID、Graph API 版本、凭据引用、主人和允许通信的号码。Access Token、App Secret、Verify Token 使用主机凭据服务。回调必须校验 App Secret HMAC 与目标 Phone Number ID；验证请求使用 Verify Token。消息幂等交由统一入口处理。

首期文本、交互式文字回复和媒体 caption 可作为文字进入助手；没有 caption 的媒体消息显示类型及“媒体正文暂不支持”提示。原始媒体元数据随事件保留，但不提供媒体下载、内容识别或实时通话。发送普通文本受 Meta 客服会话窗口限制，超窗错误明确返回，不擅自发模板。个人 WhatsApp Web 桥接与实时通话属于待实施范围。

公开回调为 `/api/commander/assistant/channels/whatsapp`：GET 校验 `hub.verify_token` 并返回 challenge，POST 校验 `X-Hub-Signature-256` 的 `sha256=<hex>`（覆盖原始请求体），正文上限 1 MB。配置默认 Graph API `v23.0`，按用户所填版本请求，不推测别名。认证、接收和发送状态分别记录，验证凭据成功不等于完成真实收发。

实现依据：`plugins/superagent/src/whatsapp.mjs`、`src/channels/whatsapp.mjs`、`src/channel-runtime.mjs`；定向夹具见 `plugins/superagent/test/whatsapp.test.mjs`。

协议参考：本地 Hermes `50d2adf1cd` 的 `plugins/platforms/whatsapp_cloud/adapter.py`，不复制或修改参考仓库。上线前需真实 Meta 应用、Webhook 订阅和收发验收。
