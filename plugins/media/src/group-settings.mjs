import { settingsFingerprint } from '../../base/shared/settings-adapter-utils.mjs';
import { normalizeSharedVoiceSettings } from './config.mjs';
import { normalizeMediaCategorySettings } from './generation.mjs';

const storageKey = 'benchgo-plugin/group-media';
const generationKinds = ['image', 'video', 'audio'];
const voiceDefaults = normalizeSharedVoiceSettings({});
const sections = [...generationKinds, ...Object.keys(voiceDefaults)];
const defaultFor = section => voiceDefaults[section] ?? { enabled: false, routes: [] };
const isGeneration = section => generationKinds.includes(section);
const fingerprint = settingsFingerprint;
const same = (left, right) => fingerprint(left) === fingerprint(right);
const invalid = () => new Error('设备组媒体配置无效');

function normalize(section, value) {
  return isGeneration(section) ? normalizeMediaCategorySettings(value, section)
    : normalizeSharedVoiceSettings({ [section]: value })[section];
}

function translate(section, value, providers) {
  if (isGeneration(section)) {
    if (value.routes.some(route => route.credentialRef || !providers.has(route.providerId))) return;
    return { ...value, routes: value.routes.map(route => ({ ...route, providerId: providers.get(route.providerId) })) };
  }
  if (!value?.providerId) return value;
  const providerId = providers.get(value.providerId);
  if (providerId) return { ...value, providerId };
}

function validateEntries(input) {
  if (!Array.isArray(input) || input.length > sections.length) throw invalid();
  const seen = new Set();
  return input.map(entry => {
    const { section, revision, writer, value } = entry ?? {};
    if (!sections.includes(section) || seen.has(section) || !Number.isSafeInteger(revision) || revision < 1
      || revision >= Number.MAX_SAFE_INTEGER || !/^sha256:[A-Za-z0-9+/]{43}=$/u.test(writer ?? '')
      || value === undefined || Buffer.byteLength(JSON.stringify(value)) > 120_000) throw invalid();
    seen.add(section);
    const normalized = normalize(section, value);
    if (isGeneration(section) && normalized.routes.some(route => route.credentialRef)) throw invalid();
    return { section, revision, writer, value: normalized };
  });
}

function wins(incoming, local) {
  if (!local) return true;
  if (incoming.revision !== local.revision) return incoming.revision > local.revision;
  // A concurrent reset must not be undone by an edit based on the same revision.
  const fallback = defaultFor(incoming.section);
  const reset = same(incoming.value, fallback), localReset = same(local.value, fallback);
  return reset !== localReset ? reset : incoming.writer > local.writer;
}

/** Only used from Link's authenticated, purpose-bound group exchange. */
export function createGroupMedia({ voice, generation, credentials, providerBindings }) {
  let queue = Promise.resolve();
  const serial = operation => {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  };
  const read = async () => structuredClone((await credentials.readRecord(storageKey))?.payload);
  const save = state => credentials.modifyRecord(storageKey, () => ({ kind: 'grant', payload: state }));
  async function currentSettings() {
    const expected = voice.settingsSnapshot();
    const voiceSettings = normalizeSharedVoiceSettings(voice.value);
    const media = await generation.getSettings();
    return { expected, revision: media.revision, values: { ...voiceSettings,
      ...Object.fromEntries(generationKinds.map(kind => [kind, media[kind]])) } };
  }
  async function apply(current, patch, active) {
    const media = Object.fromEntries(generationKinds.filter(kind => Object.hasOwn(patch, kind)).map(kind => [kind, patch[kind]]));
    const speech = Object.keys(patch).some(section => !isGeneration(section));
    if (speech && active()) {
      await voice.configure(Object.fromEntries(Object.keys(voiceDefaults).map(section => [section,
        Object.hasOwn(patch, section) ? patch[section] : current.values[section]])), { replace: true, expected: current.expected });
    }
    if (Object.keys(media).length && active()) await generation.updateSettings(media, current.revision);
  }

  async function restore(state, active) {
    const current = await currentSettings(), patch = {};
    for (const [section, baseline] of Object.entries(state.baseline)) {
      if (!Object.hasOwn(baseline, 'before')) continue;
      const value = current.values[section];
      if ((fingerprint(value) === baseline.fingerprint || fingerprint(value) === baseline.pending)
        && !same(value, baseline.before)) patch[section] = baseline.before;
    }
    await apply(current, patch, active);
    if (active()) await credentials.deleteRecord(storageKey);
  }

  async function reconcile({ groupId, hostId, entries = [], active }) {
    const incoming = validateEntries(entries);
    if (!active()) return;
    let state = await read();
    if (state && state.groupId !== groupId) { await restore(state, active); state = undefined; }
    state ??= { groupId, entries: {}, baseline: {} };
    const before = structuredClone(state);
    const bindings = await providerBindings(groupId);
    const sharedIds = new Map([...bindings].map(([id, route]) => [route, id]));
    const current = await currentSettings(), patch = {}, localOnly = new Set();
    for (const section of sections) {
      const value = current.values[section], hash = fingerprint(value);
      const baseline = state.baseline[section];
      const portable = translate(section, value, sharedIds);
      const entry = state.entries[section];
      const edited = !baseline || (hash !== baseline.fingerprint && hash !== baseline.pending);
      if (edited || baseline.unmapped && portable !== undefined) {
        state.baseline[section] = { fingerprint: hash,
          ...(baseline && Object.hasOwn(baseline, 'before') && { before: baseline.before }),
          ...(portable === undefined && { unmapped: true }),
        };
        if (portable !== undefined && (entry ? !same(portable, entry.value) : !same(portable, defaultFor(section)))) {
          const revision = (entry?.revision ?? 0) + 1;
          if (revision >= Number.MAX_SAFE_INTEGER) throw invalid();
          state.entries[section] = { section, revision, writer: hostId, value: portable };
        }
      }
      if (state.baseline[section].unmapped) localOnly.add(section);
    }
    for (const entry of incoming) if (wins(entry, state.entries[entry.section])) state.entries[entry.section] = entry;
    for (const { section, value } of Object.values(state.entries)) {
      if (localOnly.has(section)) continue;
      const resolved = translate(section, value, bindings);
      if (resolved === undefined) continue;
      const baseline = state.baseline[section];
      if (same(resolved, current.values[section])) {
        baseline.fingerprint = fingerprint(resolved);
        delete baseline.pending;
        continue;
      }
      if (!Object.hasOwn(baseline, 'before')) baseline.before = current.values[section];
      baseline.pending = fingerprint(resolved);
      patch[section] = resolved;
    }
    if (!active()) return;
    // Commit the desired versions before applying them. A retry can recognize
    // a write completed by either settings store before a failure or restart.
    if (!same(state, before)) await save(state);
    await apply(current, patch, active);
    if (active() && Object.keys(patch).length) {
      for (const section of Object.keys(patch)) {
        state.baseline[section].fingerprint = state.baseline[section].pending;
        delete state.baseline[section].pending;
      }
      await save(state);
    }
    if (active()) return Object.values(state.entries);
  }

  return {
    exchange: input => serial(() => reconcile(input)),
    leave: ({ groupId, active }) => serial(async () => {
      const state = await read();
      if (state?.groupId === groupId && active()) await restore(state, active);
    }),
  };
}
