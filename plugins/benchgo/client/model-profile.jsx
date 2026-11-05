import React from 'react';
import { applyModelProfile, matchModelProfile } from './model-profile-match.mjs';

let catalog;
function loadCatalog() {
  // One bounded request shared by a batch; only successful directories are cached.
  catalog ??= fetch(new URL('api/commander/tooling', document.baseURI), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'modelProfiles' }), signal: AbortSignal.timeout(18000) })
    .then(async response => { if (!response.ok) throw Error('catalog unavailable'); const body = await response.json(); if (body?.success !== true || !Array.isArray(body.data)) throw Error('invalid catalog'); return body.data; })
    .catch(() => { catalog = undefined; return []; });
  return catalog;
}

/** Enrich only IDs introduced during this edit, in one update against the latest draft. */
export function useNewModelProfiles(models, onChange, disabled, reasoning = true) {
  const seen = React.useRef(new Set(models.map(model => model.id).filter(Boolean)));
  const latest = React.useRef({ models, onChange, disabled });
  latest.current = { models, onChange, disabled };
  const signature = JSON.stringify(models);
  React.useEffect(() => {
    if (disabled) return;
    const added = models.filter(model => model.id && !seen.current.has(model.id));
    if (!added.length) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const rows = await loadCatalog();
      if (cancelled || latest.current.disabled) return;
      for (const model of added) seen.current.add(model.id);
      if (!rows.length) return;
      const originals = new Map(added.map(model => [model.id, JSON.stringify(model)]));
      let changed = false;
      const next = latest.current.models.map(model => {
        // Editing/removing a pending row invalidates its enrichment rather than overwriting it.
        if (originals.get(model.id) !== JSON.stringify(model)) return model;
        const row = matchModelProfile(model.id, rows);
        if (!row) return model;
        const result = applyModelProfile(model, row, { reasoning });
        if (!result.matched || JSON.stringify(result.model) === JSON.stringify(model)) return model;
        changed = true; return result.model;
      });
      if (changed) latest.current.onChange(next);
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [signature, disabled, reasoning]);
}
