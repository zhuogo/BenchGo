应用名称为“BenchGo”。PC 与 Android 图标均由 [统一品牌母版](../../../../assets/brand/README.md) 生成。

- `mipmap-*/ic_benchgo.png`：由方标母版生成 48 / 72 / 96 / 144 / 192px 各密度图标。
- `drawable-nodpi/ic_benchgo_art.png`：方标的 432px 位图，供 Android 8–11 启动页使用。
- `drawable-nodpi/ic_benchgo_foreground_art.png`：108dp（432px）透明画布，居中放置宽约 60dp 的吉祥物，供 Android 12+ 系统启动页使用。
- 普通与圆形 launcher 均使用透明的 `mipmap/ic_benchgo`。桌面启动器可以按系统主题添加外框。
- `values/colors.xml` 维护原生窗口及启动页的背景色。

`preBuild` 的 `prepareBenchGoBrand` 任务使用已有 Node 与官方 Desktop 锁定的 `sharp` 依赖，在母版或生成器变化时自动生成资源；根目录 `npm run build:android` 和直接 Gradle 构建都遵循此步骤。先运行根目录 `npm run setup` 安装官方依赖。仅同步图标可运行：

```sh
npm run build:android -- --icons-only
```

生成器位于 `plugins/link/mobile/scripts/prepare-brand.mjs`。包名及 Link 配对行为保持不变；不要手改 PNG 或另写简化图形。
