import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { build as esbuild } from 'esbuild';
import { catalogModels, catalogProviderIds } from '../../../deepseek-harness/packages/llm/llm-pi-ai/src/catalog.ts';
import { getSupportedThinkingLevels } from '../../../deepseek-harness/packages/llm/llm-pi-ai/src/models.ts';

// Read the pinned catalog on clean checkouts before Harness libraries are built.
const harness = new URL('../../../deepseek-harness/', import.meta.url);
let deepSeekCatalog;
function loadDeepSeekCatalog() {
  return deepSeekCatalog ??= esbuild({
    entryPoints: [fileURLToPath(new URL('packages/llm/llm-deepseek/src/model-info.ts', harness))],
    alias: { '@deepseek-ai/dsh-brand': fileURLToPath(new URL('packages/util/brand/src/index.ts', harness)) },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
  }).then(({ outputFiles: [catalog] }) => import(`data:text/javascript;base64,${Buffer.from(catalog.contents).toString('base64')}`));
}

const selector = fileURLToPath(new URL('../client/provider-settings.jsx', import.meta.url));
const deepSeekProvider = fileURLToPath(new URL('../client/deepseek-provider.mjs', import.meta.url));
const routerGoAccount = fileURLToPath(new URL('../client/routergo-account.jsx', import.meta.url));
const accountReference = fileURLToPath(new URL('../shared/routergo-account.mjs', import.meta.url));
const reasoningEditor = fileURLToPath(new URL('../client/model-reasoning.jsx', import.meta.url));
const reasoningState = fileURLToPath(new URL('../client/model-reasoning-state.mjs', import.meta.url));
const capabilityEditor = fileURLToPath(new URL('../client/model-capabilities.jsx', import.meta.url));
const profileMatch = fileURLToPath(new URL('../client/model-profile.jsx', import.meta.url));
const catalogFilter = fileURLToPath(new URL('../client/model-catalog-filter.jsx', import.meta.url));
const textSearch = fileURLToPath(new URL('packages/util/text-search/src/index.ts', harness));
const capabilityFacts = fileURLToPath(new URL('../shared/model-capabilities.mjs', import.meta.url));
const loading = fileURLToPath(new URL('../../shared/client/ui/loading.jsx', import.meta.url));
const select = fileURLToPath(new URL('../../shared/client/select.jsx', import.meta.url));
const disclosure = fileURLToPath(new URL('../../shared/client/ui/collapsible.jsx', import.meta.url));
const installedReasoning = () => Object.fromEntries(catalogProviderIds().flatMap(provider => {
  const entries = [...catalogModels(provider)].flatMap(([id, model]) => {
    if (!model.reasoning) return [];
    const efforts = getSupportedThinkingLevels(model).map(level => [level, model.thinkingLevelMap?.[level] ?? (level === 'off' ? null : level)]);
    return efforts.some(([level]) => level !== 'off') ? [[id, Object.fromEntries(efforts)]] : [];
  });
  return entries.length ? [[provider, Object.fromEntries(entries)]] : [];
}));
const once = (source, before, after, label) => {
  if (source.split(before).length !== 2) throw new Error('Official Models UI changed: ' + label);
  return source.replace(before, after);
};

function adaptProtocolSelect(source) {
  source = once(source, '<select\n', '<Select\n', 'protocol select opening');
  source = once(source, '</select>', '</Select>', 'protocol select closing');
  source = once(source, "className={`${styles['input']} ${styles['selectInput']}`}", 'className="cmd-provider-protocol" placeholder={t(\'customApiUnset\')}', 'protocol select style');
  source = once(source, 'protocolLabel(t, choice)', 't("modelInputImage") === "图片" && choice === "openai-responses" ? "OpenAI 响应" : protocolLabel(t, choice)', 'Chinese Responses protocol label');
  return 'import { Select } from ' + JSON.stringify(select) + ';\n' + source;
}

function foldProtocolField(source, indent) {
  const field = indent + "<div className={styles['field']}>\n" + indent + "  <span className={styles['fieldLabel']}>{t('customApi')}</span>";
  const start = source.indexOf(field);
  const end = source.indexOf('\n' + indent + '</div>', start) + ('\n' + indent + '</div>').length;
  if (start < 0 || end <= start || source.indexOf(field, start + 1) >= 0) throw Error('Official Models UI changed: protocol field');
  const wrapped = indent + '<Disclosure className="cmd-provider-advanced" title="高级连接设置">\n' + source.slice(start, end) + '\n' + indent + '</Disclosure>';
  return 'import { Disclosure } from ' + JSON.stringify(disclosure) + ';\n' + once(source, source.slice(start, end), wrapped, 'advanced protocol setting');
}

function adaptModelCatalog(source, deepSeek) {
  const prefix = deepSeek ? 'props.' : '';
  source = 'import { useState as useFilterState } from "react";\nimport { usePublicModelProfiles } from ' + JSON.stringify(profileMatch)
    + ';\nimport { ModelCatalogFilter, ModelVendorFilter, filterModelRows, useCatalogModelProfiles } from ' + JSON.stringify(catalogFilter) + ';\n' + source;
  source = once(source, '  return (\n    <section className={styles[\'modelCatalog\']}', `  const [filter, setFilter] = useFilterState({ query: '', category: '', vendor: '' })
  const publicRows = usePublicModelProfiles(true)
  const profiles = useCatalogModelProfiles(${prefix}models, publicRows)
  const visibleRows = filterModelRows(rowState.rows.map((row, index) => ({ ...row, index })), filter, profiles,
    capabilityCatalog?.current${deepSeek ? '' : ', inputDefaults, props.defaultInput'})
  return (
    <section className={styles['modelCatalog']}`, 'model catalog filtering');
  const meta = deepSeek
    ? "          <span className={styles['modelCatalogMeta']}>\n            {props.overridden ? props.t('modelsCustomized') : props.t('modelsInherited')}\n          </span>\n"
    : "          {props.overridden === undefined\n            ? null\n            : (\n              <span className={styles['modelCatalogMeta']}>\n                {props.overridden ? t('modelsCustomized') : t('modelsInherited')}\n              </span>\n            )}\n";
  source = once(source, meta, '', 'remove catalog provenance label');
  source = once(source, "className={styles['modelCatalogTitle']}>" + '{' + prefix + "t('models')}</span>\n        </div>", "className={styles['modelCatalogTitle']}>" + '{' + prefix + "t('models')}</span>\n        </div>\n        <ModelCatalogFilter filter={filter} onChange={setFilter} />", 'catalog filter toolbar');
  const nextLine = deepSeek ? "      <AnimatedRows" : "      {models.length === 0";
  source = once(source, '      </div>\n' + nextLine, '      </div>\n      <ModelVendorFilter profiles={profiles} filter={filter} onChange={setFilter} />\n' + nextLine, 'catalog vendor filters');
  source = once(source, '<AnimatedRows className={styles[\'modelList\'] as string} rowKeys={rowState.rows.map(row => String(row.key))} ready resetKey="">', '<div className={styles[\'modelList\']}>', 'direct grid layout');
  source = once(source, '</AnimatedRows>', '</div>', 'close model grid');
  source = once(source, 'AnimatedRows, ', '', 'remove unused row animation');
  source = once(source, '{rowState.rows.map(({ model, key, expanded, order }, index) => (', `{${prefix}models.length > 0 && visibleRows.length === 0 ? <p className={styles['modelEmpty']} role="status">没有匹配的模型</p> : null}
        {visibleRows.map(({ model, key, expanded, order, index }) => {
          const facts = modelCatalogFacts(model.id, profiles.get(model.id), capabilityCatalog?.current)
          return (`, 'render filtered rows');
  source = once(source, '          />\n        ))}', '          />\n          )\n        })}', 'close filtered model rows');
  const add = deepSeek ? "props.onChange([...props.models.map(model => ({ ...model })), { id: '' }])" : "onChange([...models, { id: '' }])";
  return once(source, 'onClick={() => { ' + add + ' }}', "onClick={() => { setFilter({ query: '', category: '', vendor: '' }); " + add + ' }}', 'reveal newly added model');
}

/** Strict build-only adaptation; the official submodule always stays untouched. */
export function officialModelsUi() {
  return { name: 'commander-official-models-ui', setup(build) {
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ModelsSection\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = 'import { ModelSettingsNotice, ProviderSelect, ProviderBrandIcon, prioritizeRouterGo, routerGo } from ' + JSON.stringify(selector) + ';\n' + source;
      source = 'import { RouterGoAccount, RouterGoBrand } from ' + JSON.stringify(routerGoAccount) + ';\n' + source;
      source = 'import { isRouterGoAccountReference } from ' + JSON.stringify(accountReference) + ';\n' + source;
      source = 'import { UIIcon } from ' + JSON.stringify(fileURLToPath(new URL('../client/iconsax.jsx', import.meta.url))) + ';\n' + source;
      source = 'import { Tooltip } from ' + JSON.stringify(fileURLToPath(new URL('../../shared/client/ui/tooltip.jsx', import.meta.url))) + ';\n' + source;
      source = 'import { Loading } from ' + JSON.stringify(loading) + ';\n' + source;
      source = 'import { deepSeekProviderRow, disconnectDeepSeekProvider } from ' + JSON.stringify(deepSeekProvider) + ';\n' + source;
      source = once(source, "displayName: t('deepSeekAccount') } } : row) }", "displayName: t('deepSeekAccount') } } : row.entry.provider === routerGo.id ? { ...row, entry: { ...row.entry, displayName: routerGo.name } } : row) }", 'builtin provider display name');
      source = once(source, 'rows: snapshot.rows.map(row =>', "rows: snapshot.rows.filter(row => row.apiKeyEnv || !row.entry.nativeAuth?.oauth || row.entry.nativeAuth.env.some(ref => /api[_-]?key/i.test(ref) && !/oauth/i.test(ref))).map(row =>", 'hide providers that only support OAuth');
      source = once(source, 'displayName: routerGo.name } } : row) }', 'displayName: routerGo.name } } : deepSeekProviderRow(row, snapshot.namespaces.get(row.entry.settingsNs))) }', 'DeepSeek provider display and removal state');
      source = once(source, 'const [deleteTarget, setDeleteTarget] = useState<EditorTarget | undefined>(undefined)', 'const [deleteTarget, setDeleteTarget] = useState<(EditorTarget & { settingsRevision: SettingsNamespaceView["revision"] }) | undefined>(undefined)', 'DeepSeek connection removal revision');
      source = once(source, '                          setDeleteTarget(target)', '                          setDeleteTarget({ ...target, settingsRevision: namespace.revision })', 'capture provider revision before deletion');
      source = once(source, '    void removeProviderProfile(operations, controller, deleteTarget)', '    void (deleteTarget.provider === "deepseek-official" && deleteTarget.settingsPath.length === 0\n      ? disconnectDeepSeekProvider(operations, controller, deleteTarget.settingsNs, deleteTarget.settingsRevision)\n      : removeProviderProfile(operations, controller, deleteTarget))', 'DeepSeek official connection removal');
      source = once(source, '          : providerCopy(\n            deleteTarget.credentialRef', '          : deleteTarget.provider === "deepseek-official" && deleteTarget.settingsPath.length === 0\n            ? "断开 DeepSeek 官方 API 连接。已有模型参数和凭据会保留。"\n            : providerCopy(\n            deleteTarget.credentialRef', 'DeepSeek removal confirmation copy');
      source = once(source, "        <p className={styles['intro']}>{t('intro')}</p>\n      </div>\n    )\n  }", "        <p className={styles['intro']}>{t('intro')}</p>\n        <Loading label=\"正在加载供应商与模型…\" />\n      </div>\n    )\n  }", 'initial models loading');
      source = source.replaceAll(/^ *<p className=\{styles\['intro'\]\}>\{t\('intro'\)\}<\/p>\n/gm, '');
      source = once(source, [
        "        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>",
        "        <button type=\"button\" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>",
        "          {t('retry')}",
        '        </button>',
      ].join('\n'), [
        "        <h2 className={styles['title']}>{t('title')}</h2>",
        '        <div className="cmd-provider-directory-retry">',
        "          <button type=\"button\" className={styles['secondaryButton']} onClick={() => { void controller.load() }}><span className=\"cmd-routergo-setting-action\"><UIIcon name=\"refresh\" size={14} />{t('retry')}</span></button>",
        '        </div>',
        "        <ModelSettingsNotice key={errorText} message={`${t('loadFailed')}: ${errorText}`} />",
      ].join('\n'), 'provider directory error feedback');
      source = once(source, "const [addMode, setAddMode] = useState<AddMode>('catalog')", "const [addMode, setAddMode] = useState<AddMode>('catalog')\n  const [providerPreset, setProviderPreset] = useState<any>(undefined)", 'preset state');
      const start = source.indexOf('                      <select\n');
      const end = source.indexOf('                      </select>', start);
      if (start < 0 || end < 0 || source.indexOf('                      <select\n', start + 1) !== -1) throw new Error('Official Models UI changed: provider select');
      const original = source.slice(start, end + '                      </select>'.length);
      if (!original.includes('value={draft.target.provider}') || !original.includes('setEditing(targetOf(picked.row))')) throw new Error('Official Models UI changed: provider selection semantics');
      const fieldStart = source.lastIndexOf('                    <div className={styles[\'field\']}>', start);
      const fieldEnd = source.indexOf('                    </div>', end) + '                    </div>'.length;
      if (fieldStart < 0 || fieldEnd < end) throw new Error('Official Models UI changed: provider field');
      source = source.slice(0, fieldStart) + source.slice(fieldEnd);
      source = once(source, '              <div className={styles[\'addModes\']}>', '              <div className={styles[\'addModes\']}>\n' + [
        '                      <ProviderSelect',
        '                        value={mode === "custom" ? providerPreset?.id ?? "__custom" : draft?.target.provider}',
        '                        options={state.rows.filter(row => row.entry.provider !== "deepseek-account" && (row.configured || addable.some(candidate => candidate.row.entry.provider === row.entry.provider))).map(row => ({ id: row.entry.provider, name: row.entry.displayName, declared: row.entry.declared === true }))}',
        "                        label={t('provider')} disabled={catalogBusy || customBusy}",
        '                        taken={state.rows.map(row => row.entry.provider)}',
        '                        customEnabled={customEnabled}',
        '                        onChange={(id) => { const picked = addable.find(candidate => candidate.row.entry.provider === id); setProviderPreset(undefined); if (picked) { setEditing(targetOf(picked.row)); setAddMode("catalog"); setVisited(previous => new Set([...previous, "catalog"])) } else { const row = state.rows.find(candidate => candidate.entry.provider === id); if (row) { setAddOpen(false); setEditing(targetOf(row)) } } }}',
        "                        onPreset={(preset) => { setProviderPreset(preset); setAddMode('custom'); setVisited(previous => new Set([...previous, 'custom'])) }}",
        '                      />',
      ].join('\n'), 'provider picker');
      source = once(source, "                  <span className={styles['rowName']}>{row.entry.displayName}</span>", [
        '                  {isRouterGo ? <RouterGoBrand /> : <>',
        '                    <ProviderBrandIcon id={row.entry.provider} name={row.entry.displayName} declared={row.entry.declared === true} />',
        "                    <span className={styles['rowName']}>{row.entry.displayName}</span>",
        '                  </>}',
      ].join('\n'), 'configured provider brand');
      source = once(source, "                ? renderProviderEditor({\n                  target,\n                  row,", "                ? renderProviderEditor({\n                  target,\n                  row,\n                  hideTitle: true,", 'reuse configured provider heading');
      source = once(source, "'readOnly' | 'onClose'\n> {", "'readOnly' | 'onClose' | 'hideTitle'\n> {", 'provider editor heading option');
      source = once(source, "                </span>\n                <span className={styles['rowActions']}>", "                  {open && target.provider !== target.displayName ? <span className={styles['editorRoute']}>{target.provider}</span> : null}\n                </span>\n                <span className={styles['rowActions']}>", 'show expanded provider route in heading');
      source = once(source, "aria-label={providerCopy(t('editProvider'), target)}", "aria-label={providerCopy(t('editProvider'), target)}\n                        aria-expanded={open}", 'provider editor expanded state');
      source = once(source, '  const configured = state.rows.filter(row => row.configured)', '  const configured = prioritizeRouterGo(state.rows.filter(row => row.configured), undefined, row => row.entry.provider)', 'prioritize RouterGo');
      source = once(source, "      <ul className={styles['rows']}>\n        {configured.map", [
        "      <ul className={styles['rows'] + ' cmd-routergo-provider-list'}>",
        "        {!configured.some(row => row.entry.provider === routerGo.id) ? <li className={styles['rowCard'] + ' cmd-routergo-row'}>",
        "          <RouterGoAccount writable={state.writable && customEnabled} ready={state.status === 'ready'} onSaved={() => announceSaved({ provider: routerGo.id, displayName: routerGo.name })} onEdit={() => {",
        "            setSavedTarget(undefined); setEditing(undefined); setProviderPreset(routerGo); setAddMode('custom'); setVisited(new Set(['custom'])); setAddOpen(true)",
        "            requestAnimationFrame(() => document.querySelector('[data-routergo-manual-draft] input[aria-label]')?.focus())",
        "          }} />",
        '        </li> : null}',
        '        {configured.map',
      ].join('\n'), 'RouterGo first-run card');
      source = once(source, '          if (needsSetup(row, anyUsable) &&', '          const isRouterGo = row.entry.provider === routerGo.id\n          const routerGoAccountConfigured = isRouterGo && isRouterGoAccountReference(row.apiKeyEnv)\n          const routerGoAvailable = row.entry.active && row.credential?.configured === true\n          if (!isRouterGo && row.entry.provider !== "deepseek-official" && needsSetup(row, anyUsable) &&', 'configured DeepSeek and RouterGo own their row actions');
      source = once(source, "          return (\n            <li key={row.entry.provider} className={styles['rowCard']}>\n              <div className={styles['rowHead']}>", [
        '          const renderHeader = (login?: ReactNode, routerGoConnected = false) => (',
        "              <div className={styles['rowHead'] + (isRouterGo ? ' cmd-routergo-head' : '')}>",
      ].join('\n'), 'RouterGo configured header');
      source = once(source, '                  {credentialConfigured\n', '                  {!routerGoConnected && credentialConfigured\n', 'RouterGo connected status in account summary');
      source = once(source, '                    : credentialMissing\n', '                    : !routerGoConnected && credentialMissing\n', 'RouterGo credential indicator when disconnected');
      source = once(source, "                <span className={styles['rowActions']}>", "                <span className={styles['rowActions'] + (isRouterGo ? ' cmd-routergo-actions' : '')}>\n                  {login}", 'RouterGo header login');
      source = once(source, "              </div>\n              {error}\n              {renderSlot(", [
        '              </div>',
        '          )',
        '          return (',
        "            <li key={row.entry.provider} className={styles['rowCard'] + (isRouterGo ? ' cmd-routergo-row' : '')}>",
        "              {isRouterGo ? <RouterGoAccount renderHeader={renderHeader} writable={state.writable} ready={state.status === 'ready'} configuredRef={row.apiKeyEnv} available={routerGoAvailable}",
        '                onSaved={() => { closeAdd(); announceSaved(target) }} /> : renderHeader()}',
        '              {error}',
        '              {renderSlot(',
      ].join('\n'), 'RouterGo configured account actions');
      source = once(source, "                        {t('edit')}\n                      </button>", "                        {isRouterGo ? <span className=\"cmd-routergo-setting-action\"><UIIcon name={routerGoAccountConfigured ? 'cube' : 'key'} size={14} />{routerGoAccountConfigured ? '模型' : 'API 密钥与模型'}</span> : t('edit')}\n                      </button>", 'RouterGo editor action');
      source = once(source, "                        {t('remove')}\n                      </button>", "                        {isRouterGo ? <span className=\"cmd-routergo-setting-action\"><UIIcon name=\"trash\" size={14} /><span className=\"cmd-routergo-remove-label\">{t('remove')}</span></span> : t('remove')}\n                      </button>", 'RouterGo remove action');
      source = once(source, "            : <p role=\"alert\" className={styles['error']}>{row.entry.error}</p>", '            : <Tooltip label={row.entry.error}><span className="cmd-provider-error-mark" tabIndex={0} role="img" aria-label={row.entry.error}><UIIcon name="close" size={16} /></span></Tooltip>', 'provider row error indicator');
      source = once(source, "                <span className={styles['rowActions'] + (isRouterGo ? ' cmd-routergo-actions' : '')}>\n                  {login}", "                <span className={styles['rowActions'] + (isRouterGo ? ' cmd-routergo-actions' : '')}>\n                  {error}\n                  {login}", 'place provider error indicator in header');
      source = once(source, "                onSaved={() => { closeAdd(); announceSaved(target) }} /> : renderHeader()}\n              {error}", "                onSaved={() => { closeAdd(); announceSaved(target) }} /> : renderHeader()}", 'remove separate provider error row');
      source = once(source, "        {deleteFailure === undefined ? null : <p className={styles['error']}>{deleteFailure}</p>}", '        {deleteFailure === undefined ? null : <ModelSettingsNotice key={deleteFailure} message={deleteFailure} />}', 'provider deletion error notification');
      source = once(source, "                  {row.removable\n                    ? (", "                  {row.removable ? (() => {\n                    const removeButton = (", 'RouterGo remove tooltip trigger');
      source = once(source, "                      </button>\n                    )\n                    : null}", "                      </button>\n                    )\n                    return isRouterGo ? <Tooltip label={providerCopy(t('removeProvider'), target)}>{removeButton}</Tooltip> : removeButton\n                  })() : null}", 'RouterGo remove tooltip');
      source = once(source, "            <div className={styles['addCard']}>", "            <div className={styles['addCard']} data-routergo-manual-draft={providerPreset?.id === routerGo.id ? true : undefined}>", 'RouterGo manual draft focus');
      source = once(source, '                    <CustomProviderCard\n', '                    <CustomProviderCard key={providerPreset?.id ?? "custom"} preset={providerPreset}\n', 'custom preset prop');
      source = once(source, "              <div className={styles['addModes']}>", "              <div className={styles['addModes']}>\n                <button type=\"button\" className={styles['iconButton'] + ' cmd-model-add-close'} aria-label={t('close')} disabled={catalogBusy || customBusy} onClick={closeAdd}><UIIcon name=\"close\" size={16} /></button>", 'close provider form from its header');
      source = once(source, "{row.entry.declared === true\n", "{row.entry.declared === true && row.entry.provider !== routerGo.id\n", 'builtin provider classification');
      source = once(source, "                {bothOffered\n", "                {providerPreset ? <div className={styles['editorHeader']}><ProviderBrandIcon id={providerPreset.id} /><span className={styles['editorTitle']}>{providerPreset.name}</span></div> : bothOffered\n", 'builtin provider heading');
      source = once(source, "{t(mode === 'catalog' ? 'addCatalogHint' : 'addCustomHint')}", "{providerPreset ? '填写 API 密钥，获取并选择要使用的模型。' : t(mode === 'catalog' ? 'addCatalogHint' : 'addCustomHint')}", 'builtin provider guidance');
      // The add card opens on BenchGo's gateway instead of the catalog's first row,
      // unless that route already exists; every catalog row stays one choice away.
      source = once(source, [
        '                    const first = addable[0]',
        '                    const initial: AddMode = catalogEnabled ? \'catalog\' : \'custom\'',
        '                    setSavedTarget(undefined)',
        '                    setEditing(first === undefined ? undefined : targetOf(first.row))',
      ].join('\n'), [
        '                    const first = addable[0]',
        '                    const routerFree = customEnabled && !state.rows.some(row => row.entry.provider === routerGo.id)',
        '                    const initial: AddMode = routerFree || !catalogEnabled ? \'custom\' : \'catalog\'',
        '                    setSavedTarget(undefined)',
        '                    setProviderPreset(routerFree ? routerGo : undefined)',
        '                    setEditing(routerFree || first === undefined ? undefined : targetOf(first.row))',
      ].join('\n'), 'default add target');
      source = source.replace(/^  const \[savedTarget, setSavedTarget\].*\n/m, '');
      source = source.replace(/^ *setSavedTarget\(undefined\);? *\n?/gm, '');
      source = source.replace(/  const announceSaved = [\s\S]*?\n  }\n/, '  const refreshProviders = (): void => { void controller.load() }\n');
      source = source.replaceAll('announceSaved(target)', 'refreshProviders()');
      source = source.replaceAll('announceSaved({ provider: routerGo.id, displayName: routerGo.name })', 'refreshProviders()');
      source = once(source, 'const closeEditor = (changed: boolean, target: ProviderIdentity)', 'const closeEditor = (changed: boolean)', 'remove saved row identity from editor close');
      source = source.replaceAll('closeEditor(changed, target)', 'closeEditor(changed)');
      source = once(source, 'closeEditor(changed, draft.target)', 'closeEditor(changed)', 'close the added provider editor');
      source = source.replace(/  \/\/ The saved provider as the directory currently names it\.[\s\S]*?(?=  \/\/ One fact decides both first-run postures)/, '');
      source = source.replace(/^      \{savedIdentity === undefined[\s\S]*?^        \)}\n/m, '');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]CustomProviderCard\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = adaptProtocolSelect(source);
      source = 'import { useRef } from "react";\nimport { resolveModelProfiles } from ' + JSON.stringify(profileMatch) + ';\n' + source;
      source = once(source, '  const [models, setModels] = useState<readonly ModelDraft[]>([])', '  const [models, setModels] = useState<readonly ModelDraft[]>([])\n  const discoveredModels = useRef(new Map<string, ModelDraft>()).current', 'new provider model defaults');
      source = once(source, '        onChange={setModels}', '        onChange={setModels}\n        discoveredModels={discoveredModels}', 'new provider discovery defaults');
      source = once(source, 'models: models.map(model => ({ ...model })),', 'models: reasoning.levelsOnly ? models : await resolveModelProfiles(models, true, false, discoveredModels),', 'save new provider with public model defaults');
      source = 'import { validateModelReasoning } from ' + JSON.stringify(reasoningState) + ';\n' + source;
      const identityStart = source.indexOf("      <div className={styles['field']}>\n        <span className={styles['fieldLabel']}>{t('customRoute')}");
      const identityEnd = source.indexOf("      <div className={styles['field']}>\n        <span className={styles['fieldLabel']}>{t('baseUrl')}", identityStart);
      if (identityStart < 0 || identityEnd < 0) throw Error('Provider identity fields changed');
      source = source.slice(0, identityStart) + '{!props.preset ? <>\n' + source.slice(identityStart, identityEnd) + '</> : null}\n' + source.slice(identityEnd);
      const addressStart = source.indexOf("      <div className={styles['field']}>\n        <span className={styles['fieldLabel']}>{t('baseUrl')}");
      const keyStart = source.indexOf("      <div className={styles['field']}>\n        <span className={styles['fieldLabel']}>{t('keyInput')}");
      const modelsStart = source.indexOf('      <ModelListEditor\n');
      if (addressStart < 0 || keyStart <= addressStart || modelsStart <= keyStart) throw Error('Provider connection fields changed');
      const addressFields = once(source.slice(addressStart, keyStart),
        "      </div>\n      {baseUrlInvalid ? <p className={styles['error']}>{t('customBaseUrlInvalid')}</p> : null}",
        "        {baseUrlInvalid ? <p className={styles['error']}>{t('customBaseUrlInvalid')}</p> : null}\n      </div>", 'address error within field');
      source = source.slice(0, addressStart) + '      <div className="cmd-provider-fields">\n' + source.slice(keyStart, modelsStart) + addressFields + '      </div>\n' + source.slice(modelsStart);
      source = foldProtocolField(source, '      ');
      source = once(source, 'export interface CustomProviderCardProps {', 'export interface CustomProviderCardProps {\n  preset?: { id: string; name: string; baseURL: string; protocol: string }', 'preset interface');
      for (const [name, field] of [['route', 'id'], ['displayName', 'name'], ['baseURL', 'baseURL']]) {
        const capital = name[0].toUpperCase() + name.slice(1);
        source = once(source, "const [" + name + ', set' + capital + "] = useState('')", "const [" + name + ', set' + capital + "] = useState(props.preset?." + field + " ?? '')", 'preset ' + name);
      }
      source = once(source, "const [protocol, setProtocol] = useState(protocols[0] ?? '')", "const [protocol, setProtocol] = useState(() => [props.preset?.protocol, 'openai-responses', ...protocols].find(choice => choice && protocols.includes(choice)) ?? '')", 'default connection protocol');
      source = once(source, '    } finally {\n      setBusy(false)', '    } catch (error) {\n      setFailure(error instanceof Error ? error.message : String(error))\n    } finally {\n      setBusy(false)', 'custom harness failure');
      source = once(source, '  const modelFailure = validateDeepSeekModels(models)', '  const reasoningFailure = validateModelReasoning(models)\n  const modelFailure = validateDeepSeekModels(models)', 'custom reasoning validation');
      source = once(source, '    && keyFailure === undefined', '    && keyFailure === undefined && reasoningFailure === undefined', 'custom reasoning submit gate');
      source = once(source, "        : t('customNeedsModels')", "        : reasoningFailure ?? (models.length === 0 ? '请先填写 API 密钥，并至少添加一个模型' : t('customNeedsModels'))", 'custom reasoning failure hint');
      source = once(source, '  const create = async (): Promise<void> => {\n    setBusy(true)\n    setFailure(undefined)', '  const create = async (): Promise<void> => {\n    if (reasoningFailure !== undefined) { setFailure(reasoningFailure); return }\n    setBusy(true)\n    setFailure(undefined)', 'custom reasoning click feedback');
      source = once(source, "      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}\n", '', 'remove distant create failure');
      const footer = source.match(/      <EditorFooter\n[\s\S]*?\n      \/>/)?.[0];
      if (!footer) throw Error('Custom provider actions changed');
      source = once(source, footer, "      {failure !== undefined ? <p role=\"alert\" className={styles['error']}>{failure}</p> : null}", 'create error');
      source = once(source, '      <ModelListEditor\n', '      <ModelListEditor\n        actions={' + footer.trim().replace('<EditorFooter', '<EditorFooter catalogActions') + '}\n', 'create and discover actions');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ProviderEditor\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = adaptProtocolSelect(source);
      source = 'import { useRef } from "react";\nimport { resolveModelProfiles } from ' + JSON.stringify(profileMatch) + ';\n' + source;
      source = once(source, '  const [busy, setBusy] = useState(false)', '  const discoveredModels = useRef(new Map<string, Record<string, unknown>>()).current\n  const [busy, setBusy] = useState(false)', 'provider model defaults');
      source = 'import { validateModelReasoning, reasoningLevelLabels } from ' + JSON.stringify(reasoningState) + ';\n' + source;
      source = 'import { ProviderBrandIcon } from ' + JSON.stringify(selector) + ';\n' + source;
      source = 'import { isRouterGoAccountReference } from ' + JSON.stringify(accountReference) + ';\n' + source;
      source = 'import { routerGo } from ' + JSON.stringify(selector) + ';\n' + source;
      source = once(source, "  const probeApi = stringAt(draft, 'api') ?? stringAt(fallback, 'api')", [
        '  const managedRouterGo = props.provider === routerGo.id && isRouterGoAccountReference(keyRef)',
        "  const probeApi = managedRouterGo ? routerGo.protocol : stringAt(draft, 'api') ?? stringAt(fallback, 'api')",
      ].join('\n'), 'identify RouterGo account credentials');
      source = once(source, "  const probeBaseURL = stringAt(draft, 'baseURL') ?? stringAt(fallback, 'baseURL')", [
        "  const probeBaseURL = managedRouterGo ? routerGo.baseURL : stringAt(draft, 'baseURL') ?? stringAt(fallback, 'baseURL')",
      ].join('\n'), 'RouterGo account discovery stays on official endpoint');
      source = once(source, '    const next = layout ===', '    let next = layout ===', 'extend official provider draft');
      source = once(source, '      : profileDraft', [
        '      : profileDraft',
        "    if (!props.credentialOnly && layout !== 'unknown' && !reasoning.levelsOnly) {",
        "      const owned = schema.getPath(next, ['models'])",
        "      const rows = Array.isArray(owned) ? owned : inheritedModels()",
        "      const models = modelDrafts(rows)",
        "      const resolved = await resolveModelProfiles(models, layout === 'pi-ai', !Array.isArray(owned), discoveredModels)",
        "      if (resolved !== models) next = schema.setPath(next, ['models'], resolved)",
        "    }",
      ].join('\n'), 'resolve model defaults at save');
      source = once(source, '<DeepSeekModelsEditor\n', '<DeepSeekModelsEditor providerId={props.provider}\n', 'deepseek model capability provider');
      const { modelInfo } = await loadDeepSeekCatalog();
      const deepSeekReasoning = modelInfo({ models: [], defaults: {} }, 'deepseek-official', '').reasoning;
      source = once(source, '    const catalogProps = {', `    const deepSeekLevel = (key: string) => schema.hasPath(draft, [key])
      ? stringAt(draft, key) : stringAt(fallback, key)
    const deepSeekEfforts = ${JSON.stringify(deepSeekReasoning.efforts.map(({ id }) => id))}
    const deepSeekThinkingDisabled = deepSeekLevel('thinking') === 'disabled'
    const defaultReasoningEffort = schema.hasPath(draft, ['reasoning'])
      ? stringAt(draft, 'reasoning') : stringAt(fallback, 'reasoning')
    const catalogProps = {`, 'read engine reasoning defaults');
      source = once(source, "<DeepSeekModelsEditor providerId={props.provider}\n", `<>
                <label className={styles['field']}>
                  <span className={styles['fieldLabel']}>思考档位</span>
                  <Select className={styles['input']} aria-label="思考档位" disabled={disabled || deepSeekThinkingDisabled}
                    value={deepSeekThinkingDisabled ? 'off' : deepSeekLevel('reasoningEffort') ?? ${JSON.stringify(deepSeekReasoning.defaultEffort)}}
                    onChange={event => setField('reasoningEffort', event.target.value)}>
                    {deepSeekEfforts.filter(level => !deepSeekThinkingDisabled || level === 'off').map(level =>
                      <option key={level} value={level}>{reasoningLevelLabels[level]}</option>)}
                  </Select>
                </label>
                <DeepSeekModelsEditor providerId={props.provider}
`, 'direct DeepSeek reasoning control');
      source = once(source, "defaultMaxTokens={typeof defaultMaxTokens === 'number' ? defaultMaxTokens : undefined}\n                />", "defaultMaxTokens={typeof defaultMaxTokens === 'number' ? defaultMaxTokens : undefined}\n                />\n                </>", 'direct DeepSeek reasoning layout');
      source = once(source, '                  catalogProvider={props.declared === true ? undefined : props.provider}', '                  catalogProvider={props.declared === true ? undefined : props.provider}\n                  defaultReasoningEffort={defaultReasoningEffort}', 'reasoning provider editor properties');
      source = once(source, '        {keylessNativeAuth\n', '        {!managedRouterGo && <div className="cmd-provider-fields">\n        {keylessNativeAuth\n', 'connection fields opening');
      source = once(source, '  const [customizedOpen, setCustomizedOpen] = useState(false)\n', '', 'inline retry settings state');
      source = once(source, [
        '        {props.credentialOnly === true ? null : <details',
        "          className={styles['customized']}",
        '          onToggle={(event) => { setCustomizedOpen(event.currentTarget.open) }}',
        '        >',
        "          <summary className={styles['customizedSummary']}>{t('customized')}</summary>",
        "          <div className={styles['customizedBody']}>",
      ].join('\n'), '        {props.credentialOnly === true ? null : <>', 'inline provider fields');
      source = once(source, '            {retryDefaults === undefined', '        </>}\n        </div>}\n        {props.credentialOnly === true ? null : <>\n            {retryDefaults === undefined', 'keep retry policy and models available for managed RouterGo');
      source = once(source, '                  showFailure={customizedOpen}', '                  showFailure', 'show inline retry errors');
      source = once(source, [
        '      {/* A closed fold hides the fields, so a refused stored policy still explains a disabled Apply. */}',
        '      {retryFailure === undefined || customizedOpen',
        '        ? null',
        "        : <p id={`${props.provider}-retry-failure`} className={styles['error']}>{retryFailure.message}</p>}",
      ].join('\n') + '\n', '', 'remove folded retry error');
      source = once(source, '          </div>\n        </details>}', '        </>}', 'inline model list');
      source = foldProtocolField(source, '                ');
      source = once(source, "            <span className={styles['editorTitle']}>{props.displayName}</span>", "            <ProviderBrandIcon id={props.provider} name={props.displayName} declared={props.declared === true} />\n            <span className={styles['editorTitle']}>{props.displayName}</span>", 'provider editor brand');
      source = once(source, '  const modelFailure = validateModels(', "  const reasoningFailure = layout === 'pi-ai' && props.credentialOnly !== true ? validateModelReasoning(schema.getPath(draft, ['models'])) : undefined\n  const modelFailure = validateModels(", 'provider reasoning validation');
      source = once(source, '    if (props.credentialOnly !== true) {', '    if (props.credentialOnly !== true) {\n      if (reasoningFailure !== undefined) return reasoningFailure\n      if (retryFailure !== undefined) return retryFailure.message\n      if (modelFailure !== undefined) return `${t(\'model\')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`', 'provider write validation');
      source = once(source, "      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}", "      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}\n      {props.credentialOnly !== true && reasoningFailure !== undefined ? <p role=\"alert\" className={styles['error']}>{reasoningFailure}</p> : null}", 'provider reasoning failure hint');
      source = once(source, "          || (props.credentialOnly !== true && modelFailure !== undefined)", "          || (props.credentialOnly !== true && (modelFailure !== undefined || reasoningFailure !== undefined))", 'provider reasoning submit gate');
      const footer = source.match(/      <EditorFooter\n[\s\S]*?\n      \/>/)?.[0];
      if (!footer) throw Error('Provider actions changed');
      source = once(source, footer, "      {layout !== 'pi-ai' || props.credentialOnly === true ? editorActions : null}", 'standalone provider actions');
      source = once(source, "  const curatedFields = (family:", '  const editorActions = (' + footer.trim().replace('<EditorFooter', "<EditorFooter catalogActions={layout === 'pi-ai' && props.credentialOnly !== true}") + ')\n  const curatedFields = (family:', 'reuse provider actions');
      source = once(source, '                <ModelListEditor\n', '                <ModelListEditor actions={editorActions} discoveredModels={discoveredModels}\n', 'save and discover actions');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]DeepSeekModelsEditor\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = 'import { useModelProfiles } from ' + JSON.stringify(profileMatch) + ';\n' + source;
      source = 'import { ModelCapabilityEditor, modelCatalogFacts, useModelCapabilities } from ' + JSON.stringify(capabilityEditor) + ';\n' + source;
      source = once(source, 'export interface DeepSeekModelsEditorProps {', 'export interface DeepSeekModelsEditorProps {\n  providerId?: string', 'deepseek model label provider');
      source = once(source, '  const reset = (): void => {\n    rowState.reset()\n    props.onReset()\n  }\n\n', '', 'remove unused deepseek reset');
      const resetStart = source.indexOf('        {props.overridden\n          ? (');
      const resetEnd = source.indexOf('          : null}', resetStart);
      if (resetStart < 0 || resetEnd < 0) throw Error('Official DeepSeek reset control changed');
      source = source.slice(0, resetStart) + source.slice(resetEnd + '          : null}'.length);
      source = once(source, 'export function DeepSeekModelsEditor(props: DeepSeekModelsEditorProps): ReactNode {', 'export function DeepSeekModelsEditor(props: DeepSeekModelsEditorProps): ReactNode {\n  useModelProfiles(props.models, props.onChange, props.disabled, false, !props.overridden)\n  const capabilityCatalog = useModelCapabilities(props.providerId)', 'deepseek profile match');
      source = once(source, '            onFieldChange={(field, value)', '            capabilityFacts={facts}\n            extraSettings={<ModelCapabilityEditor modelId={model.id} capabilities={facts.capabilities} catalog={capabilityCatalog} disabled={props.disabled} styles={styles} />}\n            onFieldChange={(field, value)', 'deepseek model labels');
      source = adaptModelCatalog(source, true);
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ModelInputTypes\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = once(source, '  /** Section copy. */', '  declared: readonly string[]\n  /** Section copy. */', 'declared input prop');
      source = once(source, 'disabled, fallback, t,', 'disabled, fallback, declared, t,', 'directory input types');
      source = once(source, "fallback ?? ['text']", "(declared.some(value => value === 'text' || value === 'image') ? declared : fallback ?? ['text'])", 'show supported directory input defaults');
      const oldChoices = source.match(/        \{\(\['text', 'image'\] as const\)\.map\(modality => \([\s\S]*?\n        \)\)\}/u)?.[0];
      if (!oldChoices) throw Error('Official Models UI changed: input modality controls');
      source = once(source, oldChoices, [
        '        {([["pdf", "PDF"], ["audio", t("modelInputImage") === "图片" ? "音频" : "Audio"],',
        '          ["video", t("modelInputImage") === "图片" ? "视频" : "Video"]] as const).map(([modality, label]) =>',
        '          <Checkbox key={modality} label={label} checked={declared.includes(modality)} disabled onChange={() => {}} />)}',
        '        <Checkbox label={t("modelInputImage")} checked={selected.includes("image")} disabled={disabled}',
        '          onChange={(checked) => {',
        '            const next = { ...model, [field]: checked ? ["text", "image"] : ["text"] }',
        '            if (field === "inputModalities" && !checked) {',
        '              Reflect.deleteProperty(next, "imagePixelBudget")',
        '              Reflect.deleteProperty(next, "imageMaxBytes")',
        '            }',
        '            onChange(next)',
        '          }} />',
        '        <Checkbox label={t("modelInputText")} checked disabled onChange={() => {}} />',
      ].join('\n'), 'input modality controls');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ModelRow\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = 'import { hasTextCapability } from ' + JSON.stringify(capabilityFacts) + ';\n' + source;
      source = once(source, 'interface ModelRowProps {', 'interface ModelRowProps {\n  extraSettings?: ReactNode\n  capabilityFacts: { capabilities: readonly string[]; input: readonly string[] }', 'model extension prop');
      source = once(source, '              <ModelInputTypes\n', '              {hasTextCapability(props.capabilityFacts.capabilities) && <ModelInputTypes\n                declared={props.capabilityFacts.input}\n', 'show input types for text models');
      source = once(source, 't={t} onChange={props.onChange}\n              />', 't={t} onChange={props.onChange}\n              />}', 'close text model inputs');
      source = once(source, "  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'", `  const grid = event.currentTarget.parentElement
  const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 1
  if (columns > 1 && event.currentTarget.dataset.expanded === undefined) {
    const before = event.clientX < rect.left + rect.width / 2
    return before === (getComputedStyle(event.currentTarget).direction !== 'rtl') ? 'before' : 'after'
  }
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'`, 'grid drop direction');
      source = once(source, "      {field === 'name'\n        ? <span className={`${styles['modelFieldLabel']} ${styles['modelNameLabel']}`}>{t('modelName')}</span>\n        : null}", "      <span className={styles['modelFieldLabel']}>{t(field === 'id' ? 'modelId' : 'modelName')}</span>", 'display field labels');
      source = once(source, "placeholder={t(field === 'id' ? 'modelId' : 'modelName')}", "placeholder={field === 'name' ? String(model.id || t('modelNamePlaceholder')) : t('modelId')}", 'display name falls back to raw ID');
      source = once(source, "        onFocus={field === 'name' && !props.expanded ? props.onToggle : undefined}\n", '', 'editing visible fields leaves row expansion unchanged');
      source = once(source, "      data-row-key={props.rowKey}", "      data-row-key={props.rowKey}\n      data-expanded={expanded || undefined}", 'expanded grid row');
      source = 'import { useState as useInitialExpansion } from "react";\n' + source;
      source = once(source, '  const { model, position, t, disabled } = props', "  const { model, position, t, disabled } = props\n  const [newRow, setNewRow] = useInitialExpansion(() => !model.id)\n  const expanded = props.expanded || newRow || !model.id\n  const displayName = String(model.name || model.id || t('modelId'))", 'expand new model');
      source = once(source, 'onClick={(event) => { event.currentTarget.focus(); props.onToggle() }}', 'onClick={(event) => { event.currentTarget.focus(); if (newRow) setNewRow(false); else props.onToggle() }}', 'keep new row expanded while typing');
      source = once(source, "      <div className={styles['modelRow']} data-expanded={props.expanded || undefined}>", "      <div className={styles['modelRow']} data-expanded={expanded || undefined}>", 'row disclosure state');
      source = once(source, "        {modelField('id')}\n        <button", "        <button", 'move ID into expanded body');
      source = once(source, "          className={styles['iconButton']}\n          aria-label={`${t('modelAdvanced')} ${String(position)}`}\n          aria-expanded={props.expanded}", "          className=\"cmd-model-row-summary\"\n          aria-label={`${t('modelAdvanced')} ${String(position)}`}\n          aria-expanded={expanded}\n          disabled={!model.id}", 'use model name as disclosure');
      source = once(source, '          {props.expanded ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}', '          <span title={displayName}>{displayName}</span>\n          {expanded ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}', 'model disclosure content');
      source = once(source, "        {modelField('name')}\n        {props.expanded", '        {expanded', 'show details on expansion');
      source = once(source, "            <div className={styles['modelAdvanced']}>", "            <div className={styles['modelAdvanced']}>\n              {modelField('name')}\n              {modelField('id')}", 'editable display name and ID');
      source = once(source, '              {props.reasoningLevels !== undefined && props.reasoningLevels.length > 0',
        '              {props.extraSettings}\n              {props.reasoningLevelsOnly === true && props.reasoningLevels !== undefined && props.reasoningLevels.length > 0', 'expanded model extension');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ModelListEditor\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = once(source, "from '@deepseek-ai/dsh-util-text-search'", 'from ' + JSON.stringify(textSearch), 'bundle official model discovery search');
      source = 'const installedReasoning = JSON.parse(' + JSON.stringify(JSON.stringify(installedReasoning())) + ')\n' + source;
      source = 'import { useModelProfiles } from ' + JSON.stringify(profileMatch) + ';\nimport { ModelReasoningEditor } from ' + JSON.stringify(reasoningEditor) + ';\n' + source;
      source = 'import { ModelCapabilityEditor, modelCatalogFacts, useModelCapabilities } from ' + JSON.stringify(capabilityEditor) + ';\n' + source;
      source = once(source, 'export interface ModelListEditorProps {', 'export interface ModelListEditorProps {\n  actions?: ReactNode\n  discoveredModels?: Map<string, ModelDraft>\n  defaultReasoningEffort?: string', 'model reasoning and actions props');
      source = once(source, '  const { catalogProvider } = props', '  const { catalogProvider, discoveredModels } = props\n  useModelProfiles(models, onChange, disabled || props.reasoningLevelsOnly === true, true, props.overridden === false, discoveredModels)\n  const capabilityCatalog = useModelCapabilities(probe.provider)', 'public model profiles');
      source = once(source, '    onChange([...keptRows, ...addedRows])', "    for (const index of removedRows) discoveredModels?.delete(textOf(models[index], 'id'))\n    for (const model of addedRows) discoveredModels?.set(textOf(model, 'id'), model)\n    onChange([...keptRows, ...addedRows])", 'record engine defaults for adopted models');
      source = once(source, '              onChange(models.filter((_model, at) => at !== index))', "              discoveredModels?.delete(textOf(model, 'id'))\n              onChange(models.filter((_model, at) => at !== index))", 'discard removed model defaults');
      const resetStart = source.indexOf('        {props.overridden === true && props.onReset !== undefined');
      const resetEnd = source.indexOf('          : null}', resetStart);
      if (resetStart < 0 || resetEnd < 0) throw Error('Official model reset control changed');
      source = source.slice(0, resetStart) + source.slice(resetEnd + '          : null}'.length);
      source = once(source, '        <button\n          type="button"\n          className={styles[\'linkButton\']}\n          disabled={disabled || busy', '        <div className="cmd-model-list-actions">\n        {props.actions}\n        <button\n          type="button"\n          className={styles[\'linkButton\']}\n          disabled={disabled || busy', 'discover and provider controls');
      source = once(source, "        </button>\n      </div>\n      {models.length === 0", "        </button>\n        </div>\n      </div>\n      {models.length === 0", 'model actions end');
      source = once(source, "className={styles['linkButton']}\n          disabled={disabled || busy", "className={styles['secondaryButton'] + ' cmd-model-discover'}\n          aria-busy={busy}\n          disabled={disabled || busy", 'discover button style');
      source = once(source, "      setFailure(answer.kind === 'refused' ? answer.message : undefined)\n    })", "      setFailure(answer.kind === 'refused' ? answer.message : undefined)\n    }).catch(error => { if (current) { setInheritedCatalog({ provider: catalogProvider, models: [] }); setFailure(error instanceof Error ? error.message : String(error)) } })", 'inherited catalog failure');
      // Adoption must remain synchronous: optional public metadata must never gate a user's selection.
      source = once(source, '    } finally {\n      setBusy(false)', '    } catch (error) {\n      setFailure(error instanceof Error ? error.message : String(error))\n    } finally {\n      setBusy(false)', 'model discovery error');
      source = once(source, "          {busy ? t('fetching') : t('fetchModels')}", "          {busy ? t('fetching') : t('fetchModels').replace('获取可用模型', '获取模型').replace('Fetch available models', 'Get models')}", 'text-only discovery label');
      source = once(source, '  const rowState = useModelRows(models, onChange, disabled)', `  const rowState = useModelRows(models, onChange, disabled)
  const [reasoningDrafts, setReasoningDrafts] = useState<Map<number, { id: unknown; mapping: Record<string, string | null> }>>(() => new Map())
  const providerReasoning = probe.provider !== undefined && Object.hasOwn(installedReasoning, probe.provider)
    ? installedReasoning[probe.provider] : undefined
  const retainedReasoning = (key: number, id: unknown) => {
    const previous = reasoningDrafts.get(key)
    return previous?.id === id ? previous?.mapping : undefined
  }`, 'reasoning draft options');
      source = once(source, '            onFieldChange={(field, value)', `            capabilityFacts={facts}
            extraSettings={<><ModelCapabilityEditor modelId={model.id} capabilities={facts.capabilities} catalog={capabilityCatalog} disabled={disabled} styles={styles} />
              {props.reasoningLevelsOnly !== true && <ModelReasoningEditor model={model} position={index + 1} disabled={disabled} styles={styles}
                inherited={typeof model.id === 'string' && providerReasoning && Object.hasOwn(providerReasoning, model.id) ? providerReasoning[model.id] : undefined}
                retained={retainedReasoning(key, model.id)} defaultEffort={props.defaultReasoningEffort}
                onChange={(next: ModelDraft, mapping: Record<string, string | null>) => {
                  setReasoningDrafts(current => new Map(current).set(key, { id: model.id, mapping }))
                  onChange(models.map((row, at) => at === index ? next : row))
                }} />}</>}
            onFieldChange={(field, value)`, 'per-model capability and reasoning settings');
      source = adaptModelCatalog(source, false);
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]EditorFooter\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = once(source, 'export interface EditorFooterProps {', 'export interface EditorFooterProps {\n  catalogActions?: boolean', 'catalog action variant');
      source = once(source, "        {props.busy ? t(props.submitBusyLabelKey) : t(props.submitLabelKey)}", "        {props.busy ? <span className={styles['buttonSpinner']} aria-hidden=\"true\" /> : null}{props.busy ? t(props.submitBusyLabelKey) : t(props.submitLabelKey)}", 'submit spinner');
      source = once(source, "className={styles['primaryButton']}", "className={props.catalogActions ? styles['secondaryButton'] : styles['primaryButton']}", 'unified catalog button style');
      const buttons = source.match(/^(      <button\n[\s\S]*?^      <\/button>)\n(      <button\n[\s\S]*?^      <\/button>)/m);
      if (!buttons) throw Error('Provider action buttons changed');
      source = once(source, buttons[0], () => buttons[2] + "\n      {props.catalogActions && props.cancelLabelKey !== 'close' ? null : (\n" + buttons[1] + '\n      )}', 'omit redundant catalog cancel');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ModelsSection\.module\.css$/ }, async args => {
      const result = await esbuild({ stdin: { contents: 'import styles from ' + JSON.stringify(args.path) + '; export default styles;', resolveDir: dirname(args.path) }, bundle: true, write: false, outdir: join(tmpdir(), 'commander-css-memory'), format: 'cjs', loader: { '.css': 'local-css' }, logLevel: 'silent' });
      const js = result.outputFiles.find(file => file.path.endsWith('.js'));
      const css = result.outputFiles.find(file => file.path.endsWith('.css'));
      if (!js || !css) throw new Error('Official Models CSS module did not compile');
      const module = { exports: {} }; new Function('module', 'exports', js.text)(module, module.exports);
      const { section, rows, rowCard, rowHead, rowIdentity, rowName, rowActions, editor, editorRoute, accountStatus, error, secondaryButton, modelListHead, editorActions, modelList, modelEntry, modelRow, modelName, modelAdvanced, input, iconButton } = module.exports.default;
      const layout = `
        .${section} { min-width: 0; max-width: none; container-type: inline-size; }
        .${rowHead}, .${rowIdentity}, .${accountStatus} { flex-wrap: wrap; }
        .${rowActions} { flex: none; }
        .${rowName}, .${editorRoute}, .${error} { overflow-wrap: anywhere; }
        .${rowCard} > .${editor} { padding: 12px 0 0; border-top: 1px solid var(--dsw-alias-border-l2); border-radius: 0; background: transparent; }
        .${section} > .${error} + .${secondaryButton} { align-self: flex-start; }
        .${modelListHead} { flex-wrap: wrap; align-items: center; justify-content: flex-start; gap: 6px; }
        .${modelListHead} > :first-child { flex: none; }
        .${editorActions} { flex-wrap: wrap; }
        .${modelList} { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: 6px; }
        .${modelList} > :not(.${modelEntry}), .${modelList} > .${modelEntry}[data-expanded] { grid-column: 1 / -1; }
        .${modelEntry} { container: benchgo-model-row / inline-size; min-width: 0; padding: 2px 5px; border-radius: 8px; }
        .${modelEntry}[data-expanded] { padding: 4px 7px 8px; }
        .${modelEntry} .${modelRow} { grid-template-columns: auto minmax(0, 1fr) auto; gap: 4px; }
        .${modelEntry} .${modelRow} .${modelName} { display: flex; grid-area: auto; padding: 0; }
        .${modelEntry} .${modelAdvanced} { border-top: 1px solid var(--dsw-alias-border-l4); padding: 8px 3px 0; gap: 8px 10px; }
        .${modelAdvanced} .${input} { height: 34px; font-size: 13px; }
        @container benchgo-model-row (min-width: 600px) { .${modelAdvanced} { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.2fr) repeat(2, minmax(0, .8fr)); } }
        @media (pointer: coarse) { .${modelEntry} .${iconButton} { width: 40px; height: 44px; } .${modelAdvanced} .${input} { height: 44px; font-size: 16px; } }
        @container (min-width: 540px) { .${modelList} { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        @container (min-width: 740px) { .${modelList} { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
        @container (min-width: 540px) {
          .${modelEntry}:not([data-expanded])::before, .${modelEntry}:not([data-expanded])::after { top: 0; bottom: 0; height: auto; width: 4px; }
          .${modelEntry}:not([data-expanded])::before { inset-inline: -4px auto; }
          .${modelEntry}:not([data-expanded])::after { inset-inline: auto -4px; }
          .${modelEntry}:not([data-expanded])[data-drop-target=before]::before,
          .${modelEntry}:not([data-expanded])[data-drop-target=after]::after { background: var(--dsw-alias-state-business-primary); width: 2px; }
        }
        @container (min-width: 680px) {
          .${rows} { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
          .${rows} > :not(.${rowCard}), .${rowCard}:has(.${rowActions} > [aria-expanded=true]) { grid-column: 1 / -1; }
        }
      `;
      const spinner = '.buttonSpinner{display:inline-block;vertical-align:middle;margin-right:7px;width:12px;height:12px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:commander-button-spin .7s linear infinite}@keyframes commander-button-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.buttonSpinner{animation:none}}';
      module.exports.default.buttonSpinner = 'buttonSpinner';
      return { loader: 'js', contents: `
        export function mountOfficialModelsStyle() {
          const id = 'commander-official-models-style';
          let style = document.getElementById(id);
          if (!style) { style = document.createElement('style'); style.id = id; document.head.append(style); }
          style.textContent = ${JSON.stringify(css.text + layout + spinner)};
          style.dataset.users = String(Number(style.dataset.users || 0) + 1);
          let active = true;
          return () => {
            if (!active) return;
            active = false;
            const users = Math.max(0, Number(style.dataset.users || 1) - 1);
            style.dataset.users = String(users);
            if (!users) style.remove();
          };
        }
        export default ${JSON.stringify(module.exports.default)};
      ` };
    });
  } };
}
