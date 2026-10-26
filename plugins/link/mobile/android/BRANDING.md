应用名称为“BenchGo”。图标使用 `icon/logo-app-gray.svg`，PC 与 Android 使用同一母版。

- `mipmap-*/ic_benchgo.png`：由灰底方标 SVG 栅格化。
- `drawable/ic_benchgo.xml`：引用上述 PNG。
- `drawable-nodpi/ic_benchgo_foreground_art.png`：同一方标，作为自适应图标前景。
- 背景色 `#C8CAC7`，与母版灰底一致。

包名及 Link 配对行为保持不变。更换母版时重新栅格化这些 PNG，不要手写简化路径。
