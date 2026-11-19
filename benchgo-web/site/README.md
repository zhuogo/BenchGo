# BenchGo 官网资源

官网地址为 `https://benchgo.cn`，由已连接的 DraftGo 实例管理；本目录保存自有页面、导航与文档正文，`site.json` 对应实例资源 ID。连接配置与凭据保存在被忽略的 `.draftgo/`，不进入 Git。

浏览器图标复用唯一品牌来源 `assets/brand/favicon.svg`，通过全局 `site.logo` 配置引用 `site.logo.*` 系统图片资源。当前资源为 `/api/system/assets/site.logo.03534a3edf1c/content`，首页、下载和文档页由壳层加载配置后统一设置 favicon 与触屏图标；不要在 iframe 正文中另行覆盖。更换素材时上传新的系统图片资源、按当前版本更新配置，并核验匿名访问和页面运行时图标。壳层启动前的静态 HTML 仍使用平台内置兜底图标。

## 页面与入口

- `/`：原有官网首页，下载入口连接 `/download`。
- `/download`：实时查询官方 GitHub 正式发布，按真实文件展示 Windows x64、macOS arm64/x64、Android APK 和 Linux x64 服务端。
- `/docs`：复用平台文档中心，提供安装、首次使用、手机连接、Linux 服务端及更新校验五篇指南。
- 首页、下载页、共享导航及文档正文中进入完整 `/docs` 路由的链接使用普通新标签页链接，避免在 iframe 内嵌套官网；文档中心自身的目录、搜索及上一篇/下一篇继续复用原有文章切换。
- iframe 正文中跨完整页面的链接须显式指定 `target="_top"`（当前标签顶层跳转）或 `target="_blank" rel="noopener noreferrer"`（新标签）。禁止依赖默认 `_self` 加载完整官网；页内 `#` 锚点仍在当前正文内处理。文档正文清洗后统一补回 `_blank`，通过 `window.top.open` 打开正常新标签，覆盖点击、Enter 与中键；保留原文章沙箱，禁止正文脚本执行。
- 三个页面共用 `benchgo-site-nav` 导航。`docs.html` 是现有文档页的兼容修订，保留原布局与文档运行时，搜索框和文章链接使用原生元素。

下载页仅接受 `github.com/zhuogo/BenchGo/releases/download/` 下的 HTTPS 文件，不推测安装文件 URL。若正式发布提供 `downloads.json` 与签名，页面从同仓 `release-metadata` 分支的 `releases/vX.Y.Z/` 读取自动同步的原始文件，避免 GitHub Release 资产重定向的浏览器跨域限制。固定使用 `raw.githubusercontent.com/zhuogo/BenchGo/`，不接受可配置代理地址。使用 BenchGo 公钥验证 Ed25519 签名，并核对版本与发布的完整 `target_commitish` 后，合并清单中的不可变文件引用；清单读取或验证失败时保留当次发布真实资产与 GitHub 手动入口。无清单的历史发布同样可用。公钥轮换须同步产品更新契约与页面公钥。

Linux 明确是 Ubuntu / Debian x64 + systemd 服务端，macOS 明确未通过 Apple 公证，iPhone / iPad 使用已有工作台的 HTTPS 网页。

设备中心的一键命令使用 `https://benchgo.cn/api/x/install/linux.sh`，由 DraftGo 自定义服务 `install`（ID 1）返回仓库根目录的 `install-server.sh`。更新时先在 `benchgo-web/` checkout 服务 1，用 `node ../scripts/server/generate-install-service.mjs` 生成完整 Go 源码写入检出的服务文件。提交并验证草稿后发布该版本，再匿名下载与仓库脚本逐字节核对。旧文件链接供已发布客户端继续使用。

下载区使用一排四个平台图标，只展示当前平台的下载选项；根据当前设备给出初始平台，显式选择在刷新后保留。macOS 默认展示 Apple 芯片与 Intel 的 DMG，ZIP 收入「其他格式」；缺失平台明确提示，不能将选择状态当作可下载状态。iPhone / iPad 提供网页连接指南。采用 Emil 的轻量动效：40ms 错峰进入、160ms 按压与悬停反馈、180ms 平台内容切换；仅使用 transform / opacity，键盘操作和减少动态模式即时切换。

## 保存到实例

在 `benchgo-web/` 中使用已安装且连接的 DraftGo CLI。修改前按 `site.json` 中的 ID checkout，对照远端差异保留既有修改，再将本目录相应正文复制到 worktree，运行 `draftgo verify`、`draftgo diff`、`draftgo commit`，随后 `draftgo verify --remote`。页面正文、导航和文档分别使用 `pages`、`nav`、`docs` 类型。不要重复创建已有资源。

示例：下载页 ID 为 31，导航 ID 为 3。先 `draftgo checkout pages 31`，编辑 `.draftgo/worktree/pages/page_31.html`，验证并 `draftgo commit pages 31`；将最终正文同步回 `site/download.html`。导航、文档同理。新增页面时需同步导航与 `menu`，SEO 元数据通过实时 API 契约修改。

## 验证

在 `benchgo-web/` 运行 `node site/test-download.mjs`，需要已安装的 DraftGo CLI（使用其 `playwright-core`）与 Chrome；可用 `CHROME_PATH` 指定浏览器路径。测试使用本地临时 HTTP 服务和独立临时签名密钥，不改线上发布数据。

覆盖加载、空、错误、有数据四态，重试、刷新失败保留内容、375px 窄屏、减少动效、下载来源过滤、有效签名复用与无效签名拒绝，并匿名检查官网路由及共享导航。截图保存在本地 `.draftgo/artifacts/render/`，不提交。

仅验证签名目录传输与来源绑定可运行 `node site/test-download.mjs --catalog-only`，覆盖有效清单复用、签名有效但来源 SHA 不匹配、无效签名拒绝，不重复四态与线上路由检查。

下载页本地迭代可运行 `node site/test-download.mjs --local-only`，覆盖四态、四个平台、Mac 格式、320px / 375px 单行入口、键盘切换、刷新保留平台选择及减少动态；不重复线上检查。

站内跳转回归在仓库根目录运行 `node scripts/test-website-navigation.mjs`，扫描全部 HTML 正文并在真实双层页面中点击下载与页脚链接、用 Enter 返回首页；1440px / 375px 均递归检查所有 iframe 中只存在一个顶层导航。保存到实例后运行 `node scripts/test-website-navigation.mjs --live`，额外检查全部官网路由和文章的实际链接，并通过点击、Enter、中键验证文档下载链接打开的新标签能运行下载页脚本。新增 HTML 自动纳入静态扫描；共享壳层导航与文档中心受控文章切换单独识别。

SEO 检查使用 `draftgo verify --seo --url https://benchgo.cn/download --output json`，文档文章同理。通过静态 SEO 检查不代表已被搜索引擎收录。
