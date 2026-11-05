应用名称为“BenchGo”。图标只从 `assets/brand/benchgo-app.svg`（方标）与 `benchgo-mark.svg`（透明形象）生成，PC 与 Android 使用同一形象，保留母版比例、细节和透明留白。

- `mipmap-*/ic_benchgo.png`：由方标母版生成 48 / 72 / 96 / 144 / 192px 各密度图标。
- `drawable-nodpi/ic_benchgo_art.png`：方标的 432px 位图，供 `drawable/ic_benchgo.xml` 与 Android 8–11 启动页使用，避免位图引用命中自适应 XML。
- `drawable-nodpi/ic_benchgo_foreground_art.png`：108dp（432px）透明画布，等比放置完整透明母版；主体宽 60dp，位于 Android 自适应图标 66dp 安全圆内。
- 普通与圆形 launcher 都使用 `mipmap/ic_benchgo`；Android 8+ 由系统蒙版裁切自适应前景。Android 12+ 启动页使用同一透明前景。
- 背景色 `#E8EAE5` 从方标母版读取，并同步写入 `values/colors.xml`，供自适应图标、启动页及初始原生窗口使用。

`preBuild` 的 `prepareBenchGoBrand` 任务使用已有 Node 与官方 Desktop 锁定的 `sharp` 依赖，在母版或生成器变化时自动生成资源；根目录 `npm run build:android` 和直接 Gradle 构建都遵循此步骤。先运行根目录 `npm run setup` 安装官方依赖。仅同步图标可运行：

```sh
npm run build:android -- --icons-only
```

生成器位于 `plugins/link/mobile/scripts/prepare-brand.mjs`。包名及 Link 配对行为保持不变；不要手改 PNG 或另写简化图形。
