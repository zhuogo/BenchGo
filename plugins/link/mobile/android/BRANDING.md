应用名称为“BenchGo”。图标使用 2026-10-26 定稿母版，运行与构建统一引用根目录 `assets/brand/benchgo-logo.svg`。

- `mipmap-*/ic_benchgo.png`：由方标 SVG 栅格化，供 Android 7 及以下启动器使用。
- `drawable/ic_benchgo.xml`：引用上述 PNG，用于旧版启动页。
- `drawable-nodpi/ic_benchgo_foreground_art.png` 与 `drawable/ic_benchgo_foreground.xml`：同一方标，作为自适应图标前景和 Android 12+ 启动图。
- `mipmap-anydpi-v26/ic_benchgo.xml`：墨黑背景 `#222222`。角色落在自适应安全区内。

包名及 Link 配对行为保持不变。更换母版时重新栅格化这些 PNG，不要手写简化路径。
