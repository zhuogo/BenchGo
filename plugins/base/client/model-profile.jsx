import React from 'react';
import { applyModelProfile, matchModelProfile } from '../shared/model-profile-match.mjs';

let catalog;
function loadCatalog() {
  // One bounded request shared by a batch; only successful directories are cached.
  catalog ??= fetch(new URL('api/commander/tooling', document.baseURI), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'modelProfiles' }), signal: AbortSignal.timeout(3500) })
    .then(async response => { if (!response.ok) throw Error('catalog unavailable'); const body = await response.json(); if (body?.success !== true || !Array.isArray(body.data)) throw Error('invalid catalog'); return body.data; })
    .catch(() => { catalog = undefined; return []; });
  return catalog;
}

export function usePublicModelProfiles(enabled) {
  const [rows, setRows] = React.useState(undefined);
  React.useEffect(() => {
    if (!enabled) return;
    let active = true;
    void loadCatalog().then(result => { if (active) setRows(result); });
    return () => { active = false; };
  }, [enabled]);
  return rows;
}

function resolvedProfiles(rows, models, reasoning, inherited, discovered) {
  if (!rows.length) return models;
  const options = { reasoning, inputField: reasoning ? 'input' : 'inputModalities' };
  const next = models.map(model => {
    const defaults = inherited ? model : discovered?.get(model.id);
    const row = matchModelProfile(model.id, rows);
    if (!row) return model;
    const result = applyModelProfile(model, row, options, defaults);
    return result.matched && Object.keys(result.model).some(key => JSON.stringify(result.model[key]) !== JSON.stringify(model[key]))
      ? result.model : model;
  });
  return next.some((model, index) => model !== models[index]) ? next : models;
}

export async function resolveModelProfiles(models, reasoning, inherited, discovered) {
  if (!models.some(model => model.id)) return models;
  return resolvedProfiles(await loadCatalog(), models, reasoning, inherited, discovered);
}

/** Reconcile public facts against the latest draft while keeping explicit edits. */
export function useModelProfiles(models, onChange, disabled, reasoning = true, inherited = false, discovered = undefined) {
  const latest = React.useRef({ models, onChange, disabled });
  latest.current = { models, onChange, disabled };
  const signature = JSON.stringify(models);
  React.useEffect(() => {
    if (disabled || !models.some(model => model.id)) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const rows = await loadCatalog();
      if (cancelled || latest.current.disabled) return;
      if (!rows.length) return;
      const current = latest.current.models;
      const next = resolvedProfiles(rows, current, reasoning, inherited, discovered);
      if (next !== current) latest.current.onChange(next);
    }, inherited ? 0 : 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [signature, disabled, reasoning, inherited, discovered]);
}
