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
const providerSelection = fileURLToPath(new URL('../client/provider-selection.ts', import.meta.url));
const templates = fileURLToPath(new URL('../shared/provider-templates.mjs', import.meta.url));
const deepSeekProvider = fileURLToPath(new URL('../client/deepseek-provider.mjs', import.meta.url));
const routerGoAccount = fileURLToPath(new URL('../client/routergo-account.jsx', import.meta.url));
const accountReference = fileURLToPath(new URL('../shared/routergo-account.mjs', import.meta.url));
const reasoningEditor = fileURLToPath(new URL('../client/model-reasoning.jsx', import.meta.url));
const reasoningState = fileURLToPath(new URL('../client/model-reasoning-state.mjs', import.meta.url));
const capabilityEditor = fileURLToPath(new URL('../client/model-capabilities.jsx', import.meta.url));
const profileMatch = fileURLToPath(new URL('../client/model-profile.jsx', import.meta.url));
const catalogFilter = fileURLToPath(new URL('../client/model-catalog-filter.jsx', import.meta.url));
const modelOperations = fileURLToPath(new URL('../client/model-operations.jsx', import.meta.url));
const textSearch = fileURLToPath(new URL('packages/util/text-search/src/index.ts', harness));
const capabilityFacts = fileURLToPath(new URL('../shared/model-capabilities.mjs', import.meta.url));
const loading = fileURLToPath(new URL('../../shared/client/ui/loading.jsx', import.meta.url));
const select = fileURLToPath(new URL('../../shared/client/select.jsx', import.meta.url));
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

function replaceSection(source, start, end, replacement, label) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error('Official Models UI changed: ' + label);
  return source.slice(0, from) + replacement + source.slice(to);
}

function adaptProviderAdd(source) {
  source = once(source, 'import { useId, useState }', 'import { useState }', 'remove add tab ids');
  source = once(source, ', Modal, SegmentedControl }', ', Modal }', 'remove add tabs');
  source = replaceSection(source, '/**\n * The two ways the add card', '/** The child slots', '', 'add modes type');
  source = replaceSection(source, '/** A dormant directory row', '/** Values that vary', '', 'add mode types');
  source = replaceSection(source, "  const [addMode, setAddMode]", "  const [deleteTarget", [
    '  const [selection, setSelection] = useState<ProviderSelection | undefined>(undefined)',
    '  const [addBusy, setAddBusy] = useState(false)',
    '',
  ].join('\n'), 'add state');
  source = replaceSection(source, '  /**\n   * Close the add card whole.', '  const closeEditor', [
    '  const closeAdd = (): void => {',
    '    setEditing(undefined)',
    '    setSelection(undefined)',
    '    setAddOpen(false)',
    '    setAddBusy(false)',
    '  }', '',
  ].join('\n'), 'close provider add form');
  source = replaceSection(source, '  const configurable =', '\n  return (', [
    "  const piAi = state.namespaces.get('llm-pi-ai')",
    '  const protocols = protocolChoices(piAi, schema)',
    '  const reasoningLevels = reasoningLevelChoices(piAi, schema)',
    '  const taken = state.rows.map(row => row.entry.provider)',
    '',
  ].join('\n'), 'add choices');
  source = replaceSection(source, '        {addOpen\n', '      <Modal', [
    '        {addOpen ? (',
    "          <div className={styles['addCard']}>",
    '            <ProviderAddForm selection={selection} protocols={protocols}',
    '              busy={addBusy} onSelect={setSelection} onBack={() => setSelection(undefined)} onClose={closeAdd}>',
    '              {selection && piAi !== undefined && (() => {',
    '                const card = <CustomProviderCard key={selection.id}',
    '                preset={selection.type === "custom" ? undefined : selection}',
    '                taken={taken} protocols={protocols} reasoningLevels={reasoningLevels} revision={piAi.revision}',
    '                operations={operations} t={t} readOnly={!state.writable}',
    '                onClose={closeEditor} onBusyChange={setAddBusy} />',
    '                return selection.type === "routergo" ? <RouterGoAdd key={selection.id} providerId={selection.id}',
    '                  writable={state.writable} ready={state.status === "ready"} onSaved={() => { closeAdd(); refreshProviders() }}>{card}</RouterGoAdd> : card',
    '              })()}',
    '            </ProviderAddForm>',
    '          </div>',
    '        ) : protocols.length > 0 && (',
    "          <div className={styles['addActions']}>",
    "            <button type=\"button\" className={styles['addButton']} disabled={!state.writable || state.status !== 'ready'}",
    '              onClick={() => { setEditing(undefined); setAddOpen(true) }}>',
    "              <IconPlusOutlineRegular size={14} />{t('add')}",
    '            </button>',
    '          </div>',
    '        )}',
    '      </div>',
    "      {renderSlot('settings.models.footer', {})}", '',
  ].join('\n'), 'provider add form');
  return source;
}

function adaptProtocolSelect(source) {
  source = once(source, '<select\n', '<Select\n', 'protocol select opening');
  source = once(source, '</select>', '</Select>', 'protocol select closing');
  source = once(source, "className={`${styles['input']} ${styles['selectInput']}`}", 'className="cmd-provider-protocol" placeholder={t(\'customApiUnset\')}', 'protocol select style');
  source = once(source, 'protocolLabel(t, choice)', 't("modelInputImage") === "图片" && choice === "openai-responses" ? "OpenAI 响应" : protocolLabel(t, choice)', 'Chinese Responses protocol label');
  return 'import { Select } from ' + JSON.stringify(select) + ';\n' + source;
}

function adaptModelCatalog(source, deepSeek) {
  const prefix = deepSeek ? 'props.' : '';
  source = 'import { ContextOptimization } from ' + JSON.stringify(modelOperations) + ';\n' + source;
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
  const actions = deepSeek
    ? '        <DeepSeekCatalogSync providerId={props.providerId} models={props.models} onChange={props.onChange} disabled={props.disabled} />\n        <ContextOptimization models={props.models} onChange={props.onChange} disabled={props.disabled} defaultMaxTokens={props.defaultMaxTokens} />'
    : `        {props.syncAction ?? (
          <button type="button" className={styles['secondaryButton'] + ' cmd-model-discover'} aria-busy={busy}
            ref={syncButton} aria-expanded={pickerOpen}
            disabled={disabled || busy || !askable || props.probeBlocked !== undefined}
            title={props.probeBlocked !== undefined ? t(props.probeBlocked) : askable ? undefined : t('fetchNeedsBaseUrl')}
            onClick={() => { if (pickerOpen) closePicker(); else void fetchModels() }}>
            {busy ? '正在同步…' : '同步模型'}
          </button>
        )}
        <ContextOptimization models={models} onChange={onChange} disabled={disabled || busy} baseURL={probe.baseURL} defaultMaxTokens={props.defaultMaxTokens} discoveredModels={discoveredModels} />`;
  source = once(source, '      </div>\n' + nextLine, [
    '        {props.actions && <div className="cmd-model-list-actions">{props.actions}</div>}',
    '      </div>',
    '      <div className="cmd-model-catalog-tools">',
    '        <ModelVendorFilter profiles={profiles} filter={filter} onChange={setFilter} />',
    '        <div className="cmd-model-list-actions">',
    actions,
    '        </div>',
    '      </div>',
    nextLine,
  ].join('\n'), 'catalog secondary toolbar');
  source = once(source, '<AnimatedRows className={styles[\'modelList\'] as string} rowKeys={rowState.rows.map(row => String(row.key))} ready resetKey="">', '<div className={styles[\'modelList\']}>', 'direct grid layout');
  source = once(source, '</AnimatedRows>', '</div>', 'close model grid');
  source = once(source, 'AnimatedRows, ', '', 'remove unused row animation');
  source = once(source, '{rowState.rows.map(({ model, key, expanded, order }, index) => (', `{${prefix}models.length > 0 && visibleRows.length === 0 ? <p className={styles['modelEmpty']} role="status">没有匹配的模型</p> : null}
        {visibleRows.map(({ model, key, expanded, order, index }) => {
          const facts = modelCatalogFacts(model.id, profiles.get(model.id), capabilityCatalog?.current)
          return (`, 'render filtered rows');
  source = once(source, '          />\n        ))}', '          />\n          )\n        })}', 'close filtered model rows');
  const add = deepSeek ? "props.onChange([...props.models.map(model => ({ ...model })), { id: '' }])" : "onChange([...models, { id: '' }])";
  return once(source, 'onClick={() => { ' + add + ' }}', "onClick={() => { setFilter({ query: '', category: '', vendor: '' }); rowState.add() }}", 'expand newly added model');
}

function inlineModelDiscovery(source) {
  source = once(source, 'useEffect, useMemo, useState', 'useEffect, useMemo, useRef, useState', 'model discovery focus refs');
  source = once(source, ', Modal }', ' }', 'remove nested discovery modal');
  source = once(source, "  const [candidateQuery, setCandidateQuery] = useState('')", [
    "  const [candidateQuery, setCandidateQuery] = useState('')",
    '  const syncButton = useRef<HTMLButtonElement>(null)',
    '  const candidateSearch = useRef<HTMLInputElement>(null)',
    '  const pickerOpen = candidates !== undefined',
    '  useEffect(() => { if (pickerOpen) candidateSearch.current?.focus() }, [pickerOpen])',
  ].join('\n'), 'focus inline discovery');
  source = once(source, '  const closePicker = (): void => {', '  const closePicker = (): void => {\n    syncButton.current?.focus()', 'restore discovery trigger focus');
  const start = source.indexOf('      <Modal\n');
  const end = source.indexOf('      </Modal>', start);
  if (start < 0 || end < 0) throw Error('Official model discovery picker changed');
  const picker = source.slice(start, end);
  const bodyStart = picker.indexOf("        <div className={styles['candidateToolbar']}>");
  const footer = picker.match(/        footer=\{\(\n          <>\n([\s\S]*?)\n          <\/>/u)?.[1];
  if (bodyStart < 0 || footer === undefined) throw Error('Official model discovery controls changed');
  const body = once(picker.slice(bodyStart), '            type="search"', '            type="search"\n            ref={candidateSearch}', 'bind discovery search');
  source = once(source, picker + '      </Modal>\n', '', 'move model discovery controls');
  return once(source, '      {models.length === 0', [
    "      {failure !== undefined ? <p className={styles['error']} role=\"alert\">{failure}</p> : null}",
    '      {pickerOpen && <section className="cmd-model-discovery-panel" aria-label={t(\'fetchTitle\')}>',
    "        <h3>{t('fetchTitle')}</h3>",
    body.trimEnd(),
    '        <div className="cmd-model-list-actions">',
    footer,
    '        </div>',
    '      </section>}',
    '      {models.length === 0',
  ].join('\n'), 'render discovery within the current catalog');
}

/** Strict build-only adaptation; the official submodule always stays untouched. */
export function officialModelsUi() {
  return { name: 'commander-official-models-ui', setup(build) {
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ModelsSection\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = 'import { ModelSettingsNotice, ProviderAddForm, ProviderBrandIcon, isRouterGo, prioritizeRouterGo } from ' + JSON.stringify(selector) + ';\n' + source;
      source = 'import { RouterGoAccount, RouterGoAdd, RouterGoBrand } from ' + JSON.stringify(routerGoAccount) + ';\n' + source;
      source = 'import { isRouterGoAccountReference } from ' + JSON.stringify(accountReference) + ';\n' + source;
      source = 'import { UIIcon } from ' + JSON.stringify(fileURLToPath(new URL('../client/iconsax.jsx', import.meta.url))) + ';\n' + source;
      source = 'import { Tooltip } from ' + JSON.stringify(fileURLToPath(new URL('../../shared/client/ui/tooltip.jsx', import.meta.url))) + ';\n' + source;
      source = 'import { Loading } from ' + JSON.stringify(loading) + ';\n' + source;
      source = 'import { deepSeekProviderRow, disconnectDeepSeekProvider } from ' + JSON.stringify(deepSeekProvider) + ';\n' + source;
      source = once(source, 'rows: snapshot.rows.map(row =>', "rows: snapshot.rows.filter(row => row.apiKeyEnv || !row.entry.nativeAuth?.oauth || row.entry.nativeAuth.env.some(ref => /api[_-]?key/i.test(ref) && !/oauth/i.test(ref))).map(row =>", 'hide providers that only support OAuth');
      source = once(source, "displayName: t('deepSeekAccount') } } : row) }", "displayName: t('deepSeekAccount') } } : deepSeekProviderRow(row, snapshot.namespaces.get(row.entry.settingsNs))) }", 'DeepSeek provider display and removal state');
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
      source = 'import type { ProviderSelection } from ' + JSON.stringify(providerSelection) + ';\n' + adaptProviderAdd(source);
      source = once(source, "                  <span className={styles['rowName']}>{row.entry.displayName}</span>", [
        '                  {routerGoRow ? <RouterGoBrand name={row.entry.displayName} /> : <>',
        '                    <ProviderBrandIcon id={row.entry.provider} name={row.entry.displayName} declared={row.entry.declared === true} />',
        "                    <span className={styles['rowName']}>{row.entry.displayName}</span>",
        '                  </>}',
      ].join('\n'), 'configured provider brand');
      source = once(source, "                ? renderProviderEditor({\n                  target,\n                  row,", "                ? renderProviderEditor({\n                  target,\n                  row,\n                  hideTitle: true,", 'reuse configured provider heading');
      source = once(source, "'readOnly' | 'onClose'\n> {", "'readOnly' | 'onClose' | 'hideTitle' | 'renderSyncAction'\n> {", 'provider editor options');
      source = once(source, "                </span>\n                <span className={styles['rowActions']}>", "                  {open && target.provider !== target.displayName ? <span className={styles['editorRoute']}>{target.provider}</span> : null}\n                </span>\n                <span className={styles['rowActions']}>", 'show expanded provider route in heading');
      source = once(source, "aria-label={providerCopy(t('editProvider'), target)}", "aria-label={providerCopy(t('editProvider'), target)}\n                        aria-expanded={open}", 'provider editor expanded state');
      source = once(source, '  const configured = state.rows.filter(row => row.configured)', '  const configured = prioritizeRouterGo(state.rows.filter(row => row.configured), undefined, row => row.entry.provider)', 'prioritize RouterGo');
      source = once(source, "      <ul className={styles['rows']}>\n        {configured.map",
        "      <ul className={styles['rows'] + ' cmd-routergo-provider-list'}>\n        {configured.map", 'configured provider list');
      source = once(source, '          if (needsSetup(row, anyUsable) &&', '          const routerGoRow = isRouterGo(row.entry.provider)\n          const routerGoAccountConfigured = routerGoRow && isRouterGoAccountReference(row.apiKeyEnv)\n          const routerGoAvailable = row.entry.active && row.credential?.configured === true\n          if (!routerGoRow && row.entry.provider !== "deepseek-official" && needsSetup(row, anyUsable) &&', 'configured DeepSeek and RouterGo own their row actions');
      source = once(source, "          return (\n            <li key={row.entry.provider} className={styles['rowCard']}>\n              <div className={styles['rowHead']}>", [
        '          const renderHeader = (login?: ReactNode, routerGoConnected = false) => (',
        "              <div className={styles['rowHead'] + (routerGoRow ? ' cmd-routergo-head' : '')}>",
      ].join('\n'), 'RouterGo configured header');
      source = once(source, '                  {credentialConfigured\n', '                  {!routerGoConnected && credentialConfigured\n', 'RouterGo connected status in account summary');
      source = once(source, '                    : credentialMissing\n', '                    : !routerGoConnected && credentialMissing\n', 'RouterGo credential indicator when disconnected');
      source = once(source, "                <span className={styles['rowActions']}>", "                <span className={styles['rowActions'] + (routerGoRow ? ' cmd-routergo-actions' : '')}>\n                  {login}", 'RouterGo header login');
      source = once(source, "              </div>\n              {error}\n              {renderSlot(", [
        '              </div>',
        '          )',
        '          return (',
        "            <li key={row.entry.provider} className={styles['rowCard'] + (routerGoRow ? ' cmd-routergo-row' : '')}>",
        "              {routerGoRow ? <RouterGoAccount providerId={row.entry.provider} renderHeader={renderHeader} writable={state.writable} ready={state.status === 'ready'} configuredRef={row.apiKeyEnv} available={routerGoAvailable}",
        '                onSaved={() => { closeAdd(); announceSaved(target) }} /> : renderHeader()}',
        '              {error}',
        '              {renderSlot(',
      ].join('\n'), 'RouterGo configured account actions');
      source = once(source, "                        {t('edit')}\n                      </button>", "                        {routerGoRow ? <span className=\"cmd-routergo-setting-action\"><UIIcon name={routerGoAccountConfigured ? 'cube' : 'key'} size={14} />{routerGoAccountConfigured ? '设置与模型' : 'API 密钥与模型'}</span> : t('edit')}\n                      </button>", 'RouterGo editor action');
      source = once(source, "                        {t('remove')}\n                      </button>", "                        {routerGoRow ? <span className=\"cmd-routergo-setting-action\"><UIIcon name=\"trash\" size={14} /><span className=\"cmd-routergo-remove-label\">{t('remove')}</span></span> : t('remove')}\n                      </button>", 'RouterGo remove action');
      source = once(source, "            : <p role=\"alert\" className={styles['error']}>{row.entry.error}</p>", '            : <Tooltip label={row.entry.error}><span className="cmd-provider-error-mark" tabIndex={0} role="img" aria-label={row.entry.error}><UIIcon name="close" size={16} /></span></Tooltip>', 'provider row error indicator');
      source = once(source, "                <span className={styles['rowActions'] + (routerGoRow ? ' cmd-routergo-actions' : '')}>\n                  {login}", "                <span className={styles['rowActions'] + (routerGoRow ? ' cmd-routergo-actions' : '')}>\n                  {error}\n                  {login}", 'place provider error indicator in header');
      source = once(source, "                onSaved={() => { closeAdd(); announceSaved(target) }} /> : renderHeader()}\n              {error}", "                onSaved={() => { closeAdd(); announceSaved(target) }} /> : renderHeader()}", 'remove separate provider error row');
      const editorStart = '              {open\n                ? renderProviderEditor({';
      const editorEnd = '            </li>';
      const start = source.indexOf(editorStart);
      const end = source.indexOf(editorEnd, start);
      if (start < 0 || end < 0) throw Error('Official Models UI changed: configured provider editor');
      const editor = source.slice(start, end).trim().slice(1, -1);
      source = once(source, source.slice(start, end), '              {!routerGoRow && renderEditor()}\n', 'render unmanaged provider editor');
      source = once(source, '          const renderHeader =', '          const renderEditor = (syncing = false, renderSyncAction?: ProviderEditorRenderProps["renderSyncAction"]) => ' +
        editor.replace('hideTitle: true,', 'hideTitle: true, renderSyncAction,').replace('readOnly: !state.writable,', 'readOnly: !state.writable || syncing,')
        + '\n          const renderHeader =', 'reuse editor inside RouterGo account');
      source = once(source, 'available={routerGoAvailable}', 'available={routerGoAvailable} editorOpen={open} renderEditor={renderEditor} refreshProviders={() => controller.load()}', 'RouterGo catalog sync owner');
      source = once(source, "        {deleteFailure === undefined ? null : <p className={styles['error']}>{deleteFailure}</p>}", '        {deleteFailure === undefined ? null : <ModelSettingsNotice key={deleteFailure} message={deleteFailure} />}', 'provider deletion error notification');
      source = once(source, "                  {row.removable\n                    ? (", "                  {row.removable ? (() => {\n                    const removeButton = (", 'RouterGo remove tooltip trigger');
      source = once(source, "                      </button>\n                    )\n                    : null}", "                      </button>\n                    )\n                    return routerGoRow ? <Tooltip label={providerCopy(t('removeProvider'), target)}>{removeButton}</Tooltip> : removeButton\n                  })() : null}", 'RouterGo remove tooltip');
      source = replaceSection(source, '                  {/* Only the adapter can tell a hand-declared route', '                  {/* The store keeps the account row', '', 'remove custom badge');
      source = source.replace(/^  const \[savedTarget, setSavedTarget\].*\n/m, '');
      source = source.replace(/^ *setSavedTarget\(undefined\);? *\n?/gm, '');
      source = source.replace(/  const announceSaved = [\s\S]*?\n  }\n/, '  const refreshProviders = (): void => { void controller.load() }\n');
      source = source.replaceAll('announceSaved(target)', 'refreshProviders()');
      source = once(source, 'const closeEditor = (changed: boolean, target: ProviderIdentity)', 'const closeEditor = (changed: boolean)', 'remove saved row identity from editor close');
      source = source.replaceAll('closeEditor(changed, target)', 'closeEditor(changed)');
      source = source.replace(/  \/\/ The saved provider as the directory currently names it\.[\s\S]*?(?=  \/\/ One fact decides both first-run postures)/, '');
      source = source.replace(/^      \{savedIdentity === undefined[\s\S]*?^        \)}\n/m, '');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]CustomProviderCard\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = adaptProtocolSelect(source);
      source = 'import { useRef } from "react";\nimport { resolveModelProfiles } from ' + JSON.stringify(profileMatch) + ';\n' + source;
      source = 'import { normalizeTemplateBaseURL } from ' + JSON.stringify(templates) + ';\n' + source;
      source = 'import type { ProviderPreset } from ' + JSON.stringify(providerSelection) + ';\n' + source;
      source = once(source, '  const [models, setModels] = useState<readonly ModelDraft[]>([])', '  const [models, setModels] = useState<readonly ModelDraft[]>([])\n  const discoveredModels = useRef(new Map<string, ModelDraft>()).current', 'new provider model defaults');
      source = once(source, '        onChange={setModels}', '        onChange={setModels}\n        discoveredModels={discoveredModels}', 'new provider discovery defaults');
      source = once(source, 'models: models.map(model => ({ ...model })),', 'models: reasoning.levelsOnly ? models : await resolveModelProfiles(models, true, false, discoveredModels),', 'save new provider with public model defaults');
      source = 'import { validateModelReasoning } from ' + JSON.stringify(reasoningState) + ';\n' + source;
      const identityStart = source.indexOf("      <div className={styles['field']}>\n        <span className={styles['fieldLabel']}>{t('customRoute')}");
      const identityEnd = source.indexOf("      <div className={styles['field']}>\n        <span className={styles['fieldLabel']}>{t('baseUrl')}", identityStart);
      if (identityStart < 0 || identityEnd < 0) throw Error('Provider identity fields changed');
      const nameStart = source.lastIndexOf("      <div className={styles['field']}>", source.indexOf("{t('customDisplayName')}", identityStart));
      if (nameStart <= identityStart || nameStart >= identityEnd) throw Error('Provider name field changed');
      const keyStart = source.indexOf("      <div className={styles['field']}>\n        <span className={styles['fieldLabel']}>{t('keyInput')}");
      const modelsStart = source.indexOf('      <ModelListEditor\n');
      if (keyStart <= identityEnd || modelsStart <= keyStart) throw Error('Provider connection fields changed');
      const addressFields = once(source.slice(identityEnd, keyStart),
        "      </div>\n      {baseUrlInvalid ? <p className={styles['error']}>{t('customBaseUrlInvalid')}</p> : null}",
        "        {baseUrlInvalid ? <p className={styles['error']}>{t('customBaseUrlInvalid')}</p> : null}\n      </div>", 'address error within field');
      source = source.slice(0, identityStart) + '{!props.preset ? <>\n' + source.slice(identityStart, nameStart) + '</> : null}\n'
        + '      <div className="cmd-provider-fields">\n'
        + source.slice(nameStart, identityEnd)
        + source.slice(keyStart, modelsStart) + addressFields + '      </div>\n' + source.slice(modelsStart);
      source = once(source, "<div className={styles['editor']}>", "<div className={styles['editor']} data-provider-create>", 'scope new connection form');
      source = once(source, 'export interface CustomProviderCardProps {', 'export interface CustomProviderCardProps {\n  preset?: ProviderPreset', 'preset interface');
      for (const [name, field] of [['route', 'id'], ['displayName', 'name']]) {
        const capital = name[0].toUpperCase() + name.slice(1);
        source = once(source, "const [" + name + ', set' + capital + "] = useState('')", "const [" + name + ', set' + capital + "] = useState(props.preset?." + field + " ?? '')", 'preset ' + name);
      }
      source = once(source, "const [baseURL, setBaseURL] = useState('')", "const [baseURL, setBaseURL] = useState(props.preset?.type === 'template' ? props.preset.template.baseURL : props.preset?.baseURL ?? '')", 'initial template endpoint');
      source = once(source, "const [protocol, setProtocol] = useState(protocols[0] ?? '')", "const [protocol, setProtocol] = useState(() => [props.preset?.type === 'template' ? props.preset.template.protocol : props.preset?.protocol, 'openai-responses', ...protocols].find(choice => choice && protocols.includes(choice)) ?? '')", 'default connection protocol');
      source = once(source, 'const normalizedBaseURL = baseURL.trim()', "const template = props.preset?.type === 'template' ? props.preset.template : undefined\n  const normalizedBaseURL = normalizeTemplateBaseURL(template, baseURL.trim())", 'normalize template connection address');
      source = once(source, 'const keyMissing = protocolNeedsKey(protocol) && keyDraft.trim().length === 0', 'const requiresKey = template !== undefined || protocolNeedsKey(protocol)\n  const keyMissing = requiresKey && keyDraft.trim().length === 0', 'require a template credential');
      source = once(source, 'required={protocolNeedsKey(protocol)}', 'required={requiresKey}', 'template credential field');
      source = once(source, "placeholder={t(BASE_URL_PLACEHOLDERS[protocol] ?? 'customBaseUrlPlaceholder')}", "placeholder={template?.placeholder ?? t(BASE_URL_PLACEHOLDERS[protocol] ?? 'customBaseUrlPlaceholder')}\n          onBlur={() => { setBaseURL(normalizedBaseURL) }}", 'template address guidance');
      source = once(source, "{baseUrlInvalid ? <p className={styles['error']}>{t('customBaseUrlInvalid')}</p> : null}", "{baseUrlInvalid ? <p className={styles['error']}>{t('customBaseUrlInvalid')}</p> : template?.hint && <p className=\"cmd-provider-template-hint\">{template.hint}</p>}", 'template address help');
      source = once(source, '&& !routeTaken\n', '&& (!routeTaken || committed)\n', 'retry credential after profile creation');
      source = once(source, '|| route.length === 0 || routeInvalid || routeTaken || baseUrlInvalid', '|| route.length === 0 || routeInvalid || (routeTaken && !committed) || baseUrlInvalid', 'retry hint after profile creation');
      source = once(source, '      <ModelListEditor\n', '      <ModelListEditor\n        defaultMaxTokens={128_000}\n        startWithNoModelsSelected={template !== undefined}\n', 'template model discovery starts unselected');
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
      source = 'import { normalizeTemplateBaseURL, providerTemplateForRoute } from ' + JSON.stringify(templates) + ';\n' + source;
      source = 'import { useRef } from "react";\nimport { resolveModelProfiles } from ' + JSON.stringify(profileMatch) + ';\n' + source;
      source = once(source, '  const [busy, setBusy] = useState(false)', '  const discoveredModels = useRef(new Map<string, Record<string, unknown>>()).current\n  const [busy, setBusy] = useState(false)', 'provider model defaults');
      source = once(source, 'export interface ProviderEditorProps {', 'export interface ProviderEditorProps {\n  renderSyncAction?: (dirty: boolean) => ReactNode', 'provider catalog sync option');
      source = 'import { validateModelReasoning, reasoningLevelLabels } from ' + JSON.stringify(reasoningState) + ';\n' + source;
      source = 'import { ProviderBrandIcon } from ' + JSON.stringify(selector) + ';\n' + source;
      source = 'import { isRouterGoAccountReference } from ' + JSON.stringify(accountReference) + ';\n' + source;
      source = 'import { isRouterGo, routerGo } from ' + JSON.stringify(selector) + ';\n' + source;
      source = once(source, "  const probeApi = stringAt(draft, 'api') ?? stringAt(fallback, 'api')", [
        '  const managedRouterGo = isRouterGo(props.provider) && isRouterGoAccountReference(keyRef)',
        "  const probeApi = managedRouterGo ? routerGo.protocol : stringAt(draft, 'api') ?? stringAt(fallback, 'api')",
      ].join('\n'), 'identify RouterGo account credentials');
      source = once(source, "  const probeBaseURL = stringAt(draft, 'baseURL') ?? stringAt(fallback, 'baseURL')", [
        '  const template = providerTemplateForRoute(props.provider)',
        "  const draftBaseURL = stringAt(draft, 'baseURL')",
        "  const editedBaseURL = template && draftBaseURL !== stringAt(committedOriginal, 'baseURL')",
        '    ? normalizeTemplateBaseURL(template, draftBaseURL?.trim()) : draftBaseURL',
        "  const probeBaseURL = managedRouterGo ? routerGo.baseURL : editedBaseURL ?? stringAt(fallback, 'baseURL')",
      ].join('\n'), 'RouterGo account discovery stays on official endpoint');
      source = once(source, '    const next = layout ===', '    let next = layout ===', 'extend official provider draft');
      source = once(source, '      : profileDraft', [
        '      : profileDraft',
        "    if (editedBaseURL !== draftBaseURL) next = schema.setPath(next, ['baseURL'], editedBaseURL)",
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
      const nameField = source.match(/                <div className=\{styles\['field'\]\}>\n                  <span className=\{styles\['fieldLabel'\]\}>\{t\('customDisplayName'\)\}<\/span>[\s\S]*?\n                <\/div>/u)?.[0];
      if (!nameField) throw Error('Provider display name field changed');
      source = once(source, '        {keylessNativeAuth\n',
        '        {managedRouterGo && props.credentialOnly !== true && ' + nameField.trim() + '}\n'
        + '        {!managedRouterGo && <div className="cmd-provider-fields">\n        {keylessNativeAuth\n', 'connection fields opening');
      source = once(source, "import { RetryPolicyEditor, retryPolicyDefaults, retryPolicyFailure } from './RetryPolicyEditor.tsx'\n", '', 'remove provider retry editor import');
      source = replaceSection(source, '  const [draft, setDraft]', '  // Undefined is untouched;', "  const [draft, setDraft] = useState(() => draftAt(schema, namespace, settingsPath))\n", 'remove retry draft initialization');
      source = replaceSection(source, '  const retryNode = useMemo(', '  const keyFailure =', '', 'remove inline retry validation');
      source = once(source, '  const [customizedOpen, setCustomizedOpen] = useState(false)\n', '', 'inline retry settings state');
      source = once(source, [
        '        {props.credentialOnly === true ? null : <details',
        "          className={styles['customized']}",
        '          onToggle={(event) => { setCustomizedOpen(event.currentTarget.open) }}',
        '        >',
        "          <summary className={styles['customizedSummary']}>{t('customized')}</summary>",
        "          <div className={styles['customizedBody']}>",
      ].join('\n'), '        {props.credentialOnly === true ? null : <>', 'inline provider fields');
      source = replaceSection(source, '            {retryDefaults === undefined', '            {/* Both families edit the same rows', '        </>}\n        </div>}\n        {props.credentialOnly === true ? null : <>\n', 'remove provider retry fields');
      source = once(source, [
        '      {/* A closed fold hides the fields, so a refused stored policy still explains a disabled Apply. */}',
        '      {retryFailure === undefined || customizedOpen',
        '        ? null',
        "        : <p id={`${props.provider}-retry-failure`} className={styles['error']}>{retryFailure.message}</p>}",
      ].join('\n') + '\n', '', 'remove folded retry error');
      source = once(source, '          || retryFailure !== undefined\n', '', 'remove inline retry submit gate');
      source = once(source, '          </div>\n        </details>}', '        </>}', 'inline model list');
      source = once(source, "            <span className={styles['editorTitle']}>{props.displayName}</span>", "            <ProviderBrandIcon id={props.provider} name={props.displayName} declared={props.declared === true} />\n            <span className={styles['editorTitle']}>{props.displayName}</span>", 'provider editor brand');
      source = once(source, '  const modelFailure = validateModels(', "  const reasoningFailure = layout === 'pi-ai' && props.credentialOnly !== true ? validateModelReasoning(schema.getPath(draft, ['models'])) : undefined\n  const modelFailure = validateModels(", 'provider reasoning validation');
      source = once(source, '    if (props.credentialOnly !== true) {', '    if (props.credentialOnly !== true) {\n      if (reasoningFailure !== undefined) return reasoningFailure\n      if (modelFailure !== undefined) return `${t(\'model\')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`', 'provider write validation');
      source = once(source, "      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}", "      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}\n      {props.credentialOnly !== true && reasoningFailure !== undefined ? <p role=\"alert\" className={styles['error']}>{reasoningFailure}</p> : null}", 'provider reasoning failure hint');
      source = once(source, "          || (props.credentialOnly !== true && modelFailure !== undefined)", "          || (props.credentialOnly !== true && (modelFailure !== undefined || reasoningFailure !== undefined))", 'provider reasoning submit gate');
      const footer = source.match(/      <EditorFooter\n[\s\S]*?\n      \/>/)?.[0];
      if (!footer) throw Error('Provider actions changed');
      source = once(source, footer, "      {layout === 'unknown' || props.credentialOnly === true ? editorActions : null}", 'standalone provider actions');
      source = once(source, "  const curatedFields = (family:", '  const editorActions = (' + footer.trim().replace('<EditorFooter', "<EditorFooter catalogActions={layout !== 'unknown' && props.credentialOnly !== true}") + ')\n  const curatedFields = (family:', 'reuse provider actions');
      source = once(source, '                <DeepSeekModelsEditor providerId={props.provider}', '                <DeepSeekModelsEditor providerId={props.provider} actions={editorActions}', 'DeepSeek catalog save');
      source = once(source, '                <ModelListEditor\n', `                <ModelListEditor actions={editorActions} discoveredModels={discoveredModels}
                  syncAction={managedRouterGo ? props.renderSyncAction?.(
                    busy || JSON.stringify(draft) !== JSON.stringify(committedOriginal ?? {}),
                  ) : undefined}
                  defaultMaxTokens={Number(schema.getPath(draft, ["defaultMaxTokens"]) ?? schema.getPath(fallback, ["defaultMaxTokens"]) ?? 128_000)}
`, 'save and discover actions');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]DeepSeekModelsEditor\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = 'import { useModelProfiles } from ' + JSON.stringify(profileMatch) + ';\n' + source;
      source = 'import { ModelCapabilityEditor, modelCatalogFacts, useModelCapabilities } from ' + JSON.stringify(capabilityEditor) + ';\n' + source;
      source = 'import { DeepSeekCatalogSync } from ' + JSON.stringify(modelOperations) + ';\n' + source;
      source = once(source, 'export interface DeepSeekModelsEditorProps {', 'export interface DeepSeekModelsEditorProps {\n  providerId?: string\n  actions?: ReactNode', 'deepseek model toolbar props');
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
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]useModelRows\.ts$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = once(source, '  expanded: boolean\n', '', 'keep expansion outside the row drafts');
      source = once(source, '  rows: (RowState & { model:', '  rows: (RowState & { expanded: boolean; model:', 'derive row expansion');
      source = once(source, '  toggle: (index: number) => void', '  add: () => void\n  toggle: (index: number) => void', 'add a model draft');
      source = once(source, 'return { key, expanded: false, editing: new Map() }', 'return { key, editing: new Map() }', 'keep only identity and editing state');
      source = once(source, '  const [dragged, setDragged]', '  const [expandedKey, setExpandedKey] = useState<number>()\n  const [dragged, setDragged]', 'track one expanded model');
      source = once(source, '      ...state,\n      model,', '      ...state,\n      model,\n      expanded: state.key === expandedKey,', 'use model identity for expansion');
      source = once(source, [
        '    toggle: (index: number): void => {',
        '      setRows(rows.map((row, at) => at === index ? { ...row, expanded: !row.expanded } : row))',
        '    },',
      ].join('\n'), [
        '    add: (): void => {',
        '      const row = createRow(nextKey.current++)',
        '      setRows([...rows, row])',
        '      setExpandedKey(row.key)',
        "      onChange([...models, { id: '' }])",
        '    },',
        '    toggle: (index: number): void => {',
        '      const key = rows[index]?.key',
        '      setExpandedKey(current => current === key ? undefined : key)',
        '    },',
      ].join('\n'), 'switch expanded model');
      source = once(source, '      setRows(rows.filter((_row, index) => !removed.has(index)))', [
        '      const remaining = rows.filter((_row, index) => !removed.has(index))',
        '      setRows(remaining)',
        '      setExpandedKey(current => remaining.some(row => row.key === current) ? current : undefined)',
      ].join('\n'), 'clear removed expansion');
      source = once(source, 'reset: (): void => { setRows(models.map(() => createRow(nextKey.current++))); endDrag() }',
        'reset: (): void => { setRows(models.map(() => createRow(nextKey.current++))); setExpandedKey(undefined); endDrag() }', 'reset model expansion');
      return { contents: source, loader: 'ts', resolveDir: dirname(args.path) };
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
      source = once(source, "      data-row-key={props.rowKey}", "      data-row-key={props.rowKey}\n      data-expanded={props.expanded || undefined}", 'expanded grid row');
      source = once(source, '  const { model, position, t, disabled } = props', "  const { model, position, t, disabled } = props\n  const displayName = String(model.name || model.id || t('modelId'))", 'show draft model title');
      source = once(source, "        {modelField('id')}\n        <button", "        <button", 'move ID into expanded body');
      source = once(source, "          className={styles['iconButton']}\n          aria-label={`${t('modelAdvanced')} ${String(position)}`}\n          aria-expanded={props.expanded}", "          className=\"cmd-model-row-summary\"\n          aria-label={`${t('modelAdvanced')} ${String(position)}`}\n          aria-expanded={props.expanded}", 'use model name as disclosure');
      source = once(source, '          {props.expanded ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}', '          <span title={displayName}>{displayName}</span>\n          {props.expanded ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}', 'model disclosure content');
      source = once(source, "        {modelField('name')}\n        {props.expanded", '        {props.expanded', 'show display name inside details');
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
      source = once(source, 'export interface ModelListEditorProps {', 'export interface ModelListEditorProps {\n  actions?: ReactNode\n  syncAction?: ReactNode\n  discoveredModels?: Map<string, ModelDraft>\n  defaultMaxTokens?: number\n  defaultReasoningEffort?: string\n  startWithNoModelsSelected?: boolean', 'model reasoning and actions props');
      source = once(source, 'configuredIds.size === 0 || configuredIds.has(id)', '(configuredIds.size === 0 && !props.startWithNoModelsSelected) || configuredIds.has(id)', 'require explicit selection from a new template');
      source = once(source, '  const { catalogProvider } = props', '  const { catalogProvider, discoveredModels } = props\n  useModelProfiles(models, onChange, disabled || props.reasoningLevelsOnly === true, true, props.overridden === false, discoveredModels)\n  const capabilityCatalog = useModelCapabilities(probe.provider)', 'public model profiles');
      source = once(source, '    onChange([...keptRows, ...addedRows])', "    for (const index of removedRows) discoveredModels?.delete(textOf(models[index], 'id'))\n    for (const model of addedRows) discoveredModels?.set(textOf(model, 'id'), model)\n    onChange([...keptRows, ...addedRows])", 'record engine defaults for adopted models');
      source = once(source, '              onChange(models.filter((_model, at) => at !== index))', "              discoveredModels?.delete(textOf(model, 'id'))\n              onChange(models.filter((_model, at) => at !== index))", 'discard removed model defaults');
      const resetStart = source.indexOf('        {props.overridden === true && props.onReset !== undefined');
      const resetEnd = source.indexOf('          : null}', resetStart);
      if (resetStart < 0 || resetEnd < 0) throw Error('Official model reset control changed');
      source = source.slice(0, resetStart) + source.slice(resetEnd + '          : null}'.length);
      source = replaceSection(source, '        <button\n          type="button"\n          className={styles[\'linkButton\']}\n          disabled={disabled || busy', '      </div>\n      {models.length === 0', '', 'move discovery to secondary toolbar');
      source = once(source, "      setFailure(answer.kind === 'refused' ? answer.message : undefined)\n    })", "      setFailure(answer.kind === 'refused' ? answer.message : undefined)\n    }).catch(error => { if (current) { setInheritedCatalog({ provider: catalogProvider, models: [] }); setFailure(error instanceof Error ? error.message : String(error)) } })", 'inherited catalog failure');
      // Adoption must remain synchronous: optional public metadata must never gate a user's selection.
      source = once(source, '    } finally {\n      setBusy(false)', '    } catch (error) {\n      setFailure(error instanceof Error ? error.message : String(error))\n    } finally {\n      setBusy(false)', 'model discovery error');
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
      source = once(source, "      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}\n", '', 'move discovery failure to the toolbar');
      source = inlineModelDiscovery(source);
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]EditorFooter\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = once(source, 'export interface EditorFooterProps {', 'export interface EditorFooterProps {\n  catalogActions?: boolean', 'catalog action variant');
      source = `import { LoadingText } from ${JSON.stringify(loading)};\n` + source;
      source = once(source, "        {props.busy ? t(props.submitBusyLabelKey) : t(props.submitLabelKey)}", "        {props.busy ? <LoadingText label={t(props.submitBusyLabelKey)} /> : t(props.submitLabelKey)}", 'submit loading text');
      source = once(source, "className={styles['primaryButton']}", "className={props.catalogActions ? styles['secondaryButton'] : styles['primaryButton']}", 'unified catalog button style');
      const buttons = source.match(/^(      <button\n[\s\S]*?^      <\/button>)\n(      <button\n[\s\S]*?^      <\/button>)/m);
      if (!buttons) throw Error('Provider action buttons changed');
      source = once(source, buttons[0], () => buttons[2] + "\n      {props.catalogActions && props.cancelLabelKey !== 'close' ? null : (\n" + buttons[1] + '\n      )}', 'omit redundant catalog cancel');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ModelsSection\.module\.css$/ }, async args => {
      const result = await esbuild({ stdin: { contents: 'import styles from ' + JSON.stringify(args.path) + '; export default styles;', resolveDir: dirname(args.path) }, bundle: true, write: false, outdir: join(tmpdir(), 'commander-css-memory'), format: 'cjs', loader: { '.css': 'local-css' }, logLevel: 'silent',
        plugins: [{ name: 'trim-unused-model-settings-styles', setup(cssBuild) {
          cssBuild.onLoad({ filter: /ModelsSection\.module\.css$/ }, async ({ path }) => {
            let css = (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
            css = css.replace(/\/\* Reads as an annotation on the name[\s\S]*?\.rowTag \{[^}]*\}\n/u, '');
            return { contents: replaceSection(css, '/* The add card\'s mode switch', '.addCard,', '', 'remove obsolete provider add styles'), loader: 'local-css', resolveDir: dirname(path) };
          });
        } }],
      });
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
        @media (pointer: coarse) { [data-provider-create] .${modelListHead} > .cmd-model-catalog-filter { order: 1; flex-basis: 100%; } }
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
      return { loader: 'js', contents: `
        export function mountOfficialModelsStyle() {
          const id = 'commander-official-models-style';
          let style = document.getElementById(id);
          if (!style) { style = document.createElement('style'); style.id = id; document.head.append(style); }
          style.textContent = ${JSON.stringify(css.text + layout)};
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
