# BenchGo UI

Locally maintained shadcn/ui component composition using Radix primitives, CVA and
Tailwind CSS v4. JavaScript components keep the existing React + esbuild stack.

Button, Collapsible and Dialog follow the shadcn `new-york` registry composition
(https://ui.shadcn.com/r/styles/new-york/button.json,
https://ui.shadcn.com/r/styles/new-york/collapsible.json,
https://ui.shadcn.com/r/styles/new-york/dialog.json; reviewed 2026-11-03).
BenchGo adapts the styles, JSX imports, icons and stylesheet lifecycle to its host.
The upstream MIT notice is retained in `licenses/shadcn-ui.txt` and shipped with
the generated dependency notices. These sources are maintained here, not an
additional installable BenchGo plugin.

Import from `ui/index.jsx` or individual component files. `Button`, `Collapsible`
and `DialogContent` automatically install one shared stylesheet. No page-level
style injection is required. `Disclosure` accepts `title`, `description`,
`defaultOpen`, or controlled `open` / `onOpenChange`.

`Button` variants: `default`, `secondary`, `ghost`, `outline`, `destructive`,
`link`; sizes: `default`, `sm`, `lg`, `icon`. Ordinary actions use `ghost`, primary
commit actions use `default`. Headings and toolbars should not receive a border
or panel background just because they contain controls.

`shared-ui.mjs` compiles `bg:`-prefixed utility candidates from all six client
source directories. No Tailwind preflight or global element reset is loaded.
The plugin externalizes React; Link aliases all Radix imports to its own React.
CSS keeps the existing host theme aliases and explicit standalone dark fallbacks.

`components.json` documents shadcn conventions for maintenance. Add components
deliberately and adapt their default styles to this prefix and theme rather than
running the CLI over existing files. UI dependency licenses are emitted into
`lib/UI-LICENSES.txt` and `dist/web/UI-LICENSES.txt` during the builds.

The npm archive for `react-remove-scroll-bar@2.3.8` omits its license file.
`licenses/react-remove-scroll-bar.txt` preserves the upstream MIT license from
https://github.com/theKashey/react-remove-scroll-bar/blob/master/LICENSE
(retrieved 2026-11-03); the bundler uses this only when the archive lacks it.
