# BenchGo

应用与插件名称均为 **BenchGo**。**BenchGo** 同时是统一 Logo 与吉祥物；PC、Android、网页工作台和初始化使用同一形象。

本目录是运行与构建的唯一品牌来源。

## RouterGo 供应商品牌

`routergo.svg` 原样取自 https://zhuogo.github.io/XiaoJiao/vi/routergo/logo.svg（VI 1.0.0，索引 https://zhuogo.github.io/XiaoJiao/vi-manifest.json），用于用户要求的 RouterGo 供应商接入，随客户端内嵌发布。品牌资产不适用本项目源码许可证；公开访问不等于商标或自由再分发授权，外部使用、修改、再分发与商业用途须取得资产所有者授权，不得冒充官方或暗示未授权合作。完整说明：https://zhuogo.github.io/XiaoJiao/BRAND-USAGE.md 。


- `benchgo-app.svg`：带背景的应用图标母版，1024×1024，viewBox 为 840×840。用于桌面窗口、托盘、安装器、启动页、Android 和插件包；`benchgo-app.png` 是它的 1024px 栅格版本。
- `benchgo-mark.svg`：同一形象的透明母版，840×760，用于网页品牌、与名称组合的标识和 favicon；`benchgo-mark.png` 保持同尺寸、透明背景。
- `favicon.svg`：透明母版的发布副本。`favicon.ico`：由透明母版等比生成的 16、24、32、48、64、128、256px 图标。
- `plugins/benchgo/assets/icon.svg`：带背景母版的发布副本，五个 Cordis 入口共用；客户端构建自动从母版同步，最终仍只安装一个 `benchgo-plugin`。

2026-11-01 用户确认此形象为后续正式图标。两份源图分别来自用户提供的 `benchgo-original-app.svg` 和 `benchgo-original-mark.svg`，已统一文件名、SVG 标题及内部阴影 ID；图形、颜色、比例与阴影保持原样。构建只依赖本目录，不依赖临时下载路径或本地设计服务。旧 `benchgo-logo.*` 已移除。

品牌色：暖米白 `#F3EBDF`、深墨 `#222222`、朱红 `#D44A36`、辅助灰 `#B6B1A7`，应用背景为浅灰绿 `#E8EAE5`。不重绘身体、切角、双眼和编辑器条，不拉伸。Android 自适应图标沿用同一形象和浅灰绿背景。
