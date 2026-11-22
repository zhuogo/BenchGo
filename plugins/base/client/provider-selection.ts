import type { routerGo } from '../shared/builtin-providers.mjs';
import type { providerTemplates } from '../shared/provider-templates.mjs';

export type ProviderPreset =
  | ({ type: 'routergo'; id: string } & Omit<typeof routerGo, 'id'>)
  | { type: 'template'; id: string; name: string; template: typeof providerTemplates[number] };

export type ProviderSelection = ProviderPreset | { type: 'custom'; id: string; name: string };
