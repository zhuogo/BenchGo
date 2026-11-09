import { fileURLToPath } from 'node:url';

/** Isolated browser tests exercise the pinned upstream public Tooltip source
 * when this checkout has no generated official client package. */
export function officialTooltipSource() {
  return { name: 'official-tooltip-source', setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({
      path: fileURLToPath(new URL('../../../deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx', import.meta.url)),
    }));
  } };
}
