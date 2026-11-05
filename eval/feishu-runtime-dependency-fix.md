# 飞书入站排查

实际群消息 `om_x100b61ab5f3b6cb4b4c896873612ac5` 正确提及已配置机器人。认证、历史读取及长连接端点获取均成功，但当时入站账本无飞书记录。

确定故障：已安装开发预览包解析 `@larksuiteoapi/node-sdk` 返回 `MODULE_NOT_FOUND`。开发同步只补齐官方依赖，漏掉新增渠道 SDK。

已修复 `scripts/desktop/sync-dev-plugin.mjs`：补齐缺失第三方运行依赖，校验本地版本，复用完整依赖树，不覆盖用户实体依赖目录。14 项同步回归通过；重启后从实际安装目录加载 SDK，`WSClient` 与 `EventDispatcher` 均为 function。

边界：尚未确认重启后的真实消息收发；未发送或回放用户消息。
