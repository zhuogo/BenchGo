# BenchGo 移动端

`android/` 是 Kotlin 原生 Android 壳。配对、扫码使用 `WebViewAssetLoader` 中的本地 Link 页面；电脑允许设备后，App 打开同源 `/link/workbench/` 官方网页工作台，通过配对主机的系统 HTTPS 信任或二维码 SPKI 验证加载资源。网页中的完整 Harness UI、设置、命令和会话不复制到 App。语音需要 Android 麦克风授权；文件选择器由原生壳呈现。

## 构建

先构建 Link Web 资源，再安装 JDK 17、Android SDK Platform 35 / Build Tools 35，并通过 `ANDROID_HOME` 或本机 `android/local.properties` 提供 SDK 路径。

```sh
# 仓库根目录：先构建共享网页，再构建 APK
npm ci --prefix plugins/link
npm run build:android
# 安装到连接的真机
adb install -r plugins/link/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

debug 包仅用于本轮验收。正式分发需使用自己的 release keystore 和发布签名，禁止提交密码、keystore 或 local.properties。iOS 原生 App 不在此目录交付范围，首版可使用公网 HTTPS 手机网页。

## 配对与安全边界

- 本地桌面显示 `benchgo://pair?url=<HTTPS_BASE>&pin=<BASE64_SHA256_SPKI>&code=<一次性码>`，同时兼容旧 `dshlink://pair`；云工作台优先域名 HTTPS 配对页。新品牌协议需重新构建并安装 Android APK，旧 APK 仍可扫描 HTTPS 配对页。公网使用系统证书链和标准主机名校验，局域网使用 QR SPKI。摄像头不可用时可返回粘贴完整配对地址。
- 局域网使用二维码固定主机 SPKI 公钥，仅严格匹配该公钥且有效的证书通过；pin 模式仅允许配对 URL 的主机名，接受该公钥对应证书的 SAN 与局域网 IP 不同。公网无 pin 时使用系统证书信任链及标准主机名校验。禁止 HTTP 和重定向，不使用全局信任所有证书。
- Android Keystore 中的 AES-GCM 密钥加密配对身份，应用备份关闭；移除设备删除该设备的本机记录与令牌，保留其他设备和共享 Keystore 密钥。服务器端撤销仍由桌面执行。
- JS bridge 仅存在于本地配对页；跳入工作台前移除。工作台导航和子资源仅允许已配对 HTTPS 主机的 `/link/workbench/`，同源资源由 Link TLS listener 提供；其它外部导航交给系统浏览器。局域网自签证书只接受扫码中的精确 SPKI 与有效证书。
- 工作台 HttpOnly cookie 由已配对设备令牌换取，限定 `/link/workbench/` 路径。Android 原生 JSON 网络桥仍限制为 `/link/api/*`，工作台本身使用 WebView 同源 cookie 请求。
- 工作台顶部设备按钮通过 `BenchGoDevices` 来源限定消息通道返回本机设备列表；只接受当前 WebView、已配对 HTTPS 来源及 `/link/workbench/` 主 frame。工作台不注入 `LinkNative`，不能通过该通道添加设备、访问凭据或执行 SSH。
- App 注入公开设备名 `__DSH_DEVICE_NAVIGATION__={name}` 并发送 `dsh-devices:navigation`；网页回报 `dsh-devices:ready` 后隐藏原生 44px 返回栏，`dsh-devices:show` 返回设备列表，`dsh-devices:unready` 恢复原生入口。导航开始、页面加载错误、缓存工作台切换均恢复原生入口并重新等待 ready；旧主机或不支持 `WEB_MESSAGE_LISTENER` 的 WebView 始终保留原生入口。
- 前台轮询由共享 UI 管理；本版本不承诺后台保活或系统强制停止后的实时接收。
- 可保存多个已授权主机，设备列表支持切换、改名和移除；最多同时保留 4 个工作台页面。切换不清除其他设备凭据，旧单主机记录会迁入多设备存储。移除本机记录不等于在主机撤销旧设备，撤销需从桌面设备列表执行。

## 原生桥接

`window.LinkNative.bootstrap()` 返回 JSON `{url,pin,code,name,localName,token}`；`name` 是被控主机名称，`localName` 是本机名称。`saveIdentity(json)`、`clearIdentity()`、`scan()` 返回 JSON 结果；`clearIdentity()` 是返回设备列表的兼容入口，不删除凭据，删除指定设备走设备管理的 `remove` 操作。设备列表包含可改名的本机行；远端改名仅保存本地备注。工作台打开显示加载遮罩，失效会话使用已保存的设备凭据恢复，不重新配对；主动撤销的凭据仍会被拒绝。

`request(JSON.stringify({id,method,path,body,headers}))` 异步执行并调用 `window.__linkNativeResult(id,jsonString)`，结果为 `{ok,status,body}`（body 已解析 JSON），失败为 `{ok:false,status:0,error}`。扫码或收到深链后发出 `link:bootstrap` 事件。

## 当前验证

2026-10-20：工作台设备导航与网页标题栏统一，原生返回栏仅在网页导航可用后收起。已通过 Kotlin 编译及设备导航 / 原生外观 11 项 JVM 测试，覆盖主 frame、配对来源、路径边界、ready 生命周期、缓存隔离与失败回退；本轮不发布 APK，真机 WebView 导航、缓存切换与错误回退待验收。

2026-10-17 第四轮：配对后改为复用完整网页工作台，包含输入命令、语音配置、模型、Agent 预设和内置插件设置；官方网页 UI、组件状态和配置不另维护移动副本。Android 编译通过，真实配对浏览器已打开工作台、设置项与 `/help` 输入通过；无横向溢出。APK 尚未重打包，已安装版本不包含新 WebView 工作台桥接。

2026-10-17 第三轮：共享 Web 默认进入跨项目「最近」，侧边栏管理会话、新建和连接；移除底栏和首页项目选择，增加搜索、时间分组、运行中筛选、会话草稿保留及全页深浅色。

2026-10-17：移动 Web 改为紧凑配对、工作台、会话和连接管理；`/mobile` 作为兼容入口跳转到真实 `/link/` 配对流程。原生扫码页改用专用 JourneyApps 界面，含返回、手电筒、相机权限恢复和失败重试；网络超时、DNS 与证书错误分别反馈。已执行 Kotlin 编译和异常映射验证；本轮等待前端验收后再生成新 APK，已有 APK 不包含这些更新。

2026-10-16：已安装隔离 JDK 17、Android SDK 35 与 Gradle 8.9，真实 `assembleDebug` 构建成功。验收包位于 `artifacts/android/benchgo-link-0.1.0-debug.apk`，分发下载见仓库 Releases；源码目录的原始产物位于 `android/app/build/outputs/apk/debug/app-debug.apk`。

本地配对网页包含在 APK 离线 assets 内。当前没有连接 Android 设备，未完成真机安装、扫码、软键盘、WebView 麦克风、证书拒绝提示或切后台恢复验收。debug APK 有调试签名，不是正式 release 签名包。
