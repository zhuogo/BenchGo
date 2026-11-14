# BenchGo 官网资源

官网地址为 `https://benchgo.cn`，由已连接的 DraftGo 实例管理；本目录保存自有页面、导航与文档正文，`site.json` 对应实例资源 ID。连接配置与凭据保存在被忽略的 `.draftgo/`，不进入 Git。

## 页面与入口

- `/`：原有官网首页，下载入口连接 `/download`。
- `/download`：实时查询官方 GitHub 正式发布，按真实文件展示 Windows x64、macOS arm64/x64、Android APK 和 Linux x64 服务端。
- `/docs`：复用平台文档中心，提供安装、首次使用、手机连接、Linux 服务端及更新校验五篇指南。
- 三个页面共用 `benchgo-site-nav` 导航。`docs.html` 是现有文档页的兼容修订，保留原布局与文档运行时，搜索框和文章链接使用原生元素。

下载页仅接受 `github.com/zhuogo/BenchGo/releases/download/` 下的 HTTPS 文件，不推测文件 URL。若正式发布提供 `downloads.json` 与签名，页面通过 GitHub asset API 读取，使用 BenchGo 公钥验证 Ed25519 签名后，合并清单中的不可变文件引用；清单读取或验证失败时保留当次发布真实资产与 GitHub 手动入口。无清单的历史发布同样可用。公钥轮换须同步产品更新契约与页面公钥。

Linux 明确是 Ubuntu / Debian x64 + systemd 服务端，macOS 明确未通过 Apple 公证，iPhone / iPad 使用已有工作台的 HTTPS 网页。

## 保存到实例

在 `benchgo-web/` 中使用已安装且连接的 DraftGo CLI。修改前按 `site.json` 中的 ID checkout，对照远端差异保留既有修改，再将本目录相应正文复制到 worktree，运行 `draftgo verify`、`draftgo diff`、`draftgo commit`，随后 `draftgo verify --remote`。页面正文、导航和文档分别使用 `pages`、`nav`、`docs` 类型。不要重复创建已有资源。

示例：下载页 ID 为 31，导航 ID 为 3。先 `draftgo checkout pages 31`，编辑 `.draftgo/worktree/pages/page_31.html`，验证并 `draftgo commit pages 31`；将最终正文同步回 `site/download.html`。导航、文档同理。新增页面时需同步导航与 `menu`，SEO 元数据通过实时 API 契约修改。

## 验证

在 `benchgo-web/` 运行 `node site/test-download.mjs`，需要已安装的 DraftGo CLI（使用其 `playwright-core`）与 Chrome；可用 `CHROME_PATH` 指定浏览器路径。测试使用本地临时 HTTP 服务和独立临时签名密钥，不改线上发布数据。

覆盖加载、空、错误、有数据四态，重试、刷新失败保留内容、375px 窄屏、减少动效、下载来源过滤、有效签名复用与无效签名拒绝，并匿名检查官网路由及共享导航。截图保存在本地 `.draftgo/artifacts/render/`，不提交。

SEO 检查使用 `draftgo verify --seo --url https://benchgo.cn/download --output json`，文档文章同理。通过静态 SEO 检查不代表已被搜索引擎收录。
