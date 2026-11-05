import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { build as esbuild } from 'esbuild';

const selector = fileURLToPath(new URL('../client/provider-settings.jsx', import.meta.url));
const reasoningEditor = fileURLToPath(new URL('../client/model-reasoning.jsx', import.meta.url));
const reasoningState = fileURLToPath(new URL('../client/model-reasoning-state.mjs', import.meta.url));
const profileMatch = fileURLToPath(new URL('../client/model-profile.jsx', import.meta.url));
const once = (source, before, after, label) => {
  if (source.split(before).length !== 2) throw new Error('Official Models UI changed: ' + label);
  return source.replace(before, after);
};

/** Strict build-only adaptation; the official submodule always stays untouched. */
export function officialModelsUi() {
  return { name: 'commander-official-models-ui', setup(build) {
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ModelsSection\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = 'import { ProviderSelect, ProviderBrandIcon, routerGo } from ' + JSON.stringify(selector) + ';\n' + source;
      source = once(source, "displayName: t('deepSeekAccount') } } : row) }", "displayName: t('deepSeekAccount') } } : row.entry.provider === routerGo.id ? { ...row, entry: { ...row.entry, displayName: routerGo.name } } : row) }", 'builtin provider display name');
      source = once(source, "        <p className={styles['intro']}>{t('intro')}</p>\n      </div>\n    )\n  }", "        <p className={styles['intro']}>{t('intro')}</p>\n        <p role=\"status\" aria-live=\"polite\"><span className={styles['buttonSpinner']} aria-hidden=\"true\" /> 正在加载供应商与模型…</p>\n      </div>\n    )\n  }", 'initial models loading');
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
      source = once(source, "                  <span className={styles['rowName']}>{row.entry.displayName}</span>", "                  <ProviderBrandIcon id={row.entry.provider} name={row.entry.displayName} declared={row.entry.declared === true} />\n                  <span className={styles['rowName']}>{row.entry.displayName}</span>", 'configured provider brand');
      source = once(source, '  const configured = state.rows.filter(row => row.configured)', '  const configured = state.rows.filter(row => row.configured && !(row.entry.provider === "deepseek-official" && row.credential?.configured !== true))', 'hide unconfigured official deepseek');
      source = once(source, '                    <CustomProviderCard\n', '                    <CustomProviderCard key={providerPreset?.id ?? "custom"} preset={providerPreset}\n', 'custom preset prop');
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
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]CustomProviderCard\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = 'import { validateModelReasoning } from ' + JSON.stringify(reasoningState) + ';\n' + source;
      source = 'import { ProviderHarnessField, useProviderHarness, ProviderBrandIcon } from ' + JSON.stringify(selector) + ';\n' + source;
      const identityStart = source.indexOf("      <div className={styles['field']}>\n        <span className={styles['fieldLabel']}>{t('customRoute')}");
      const identityEnd = source.indexOf("      <div className={styles['field']}>\n        <span className={styles['fieldLabel']}>{t('baseUrl')}", identityStart);
      if (identityStart < 0 || identityEnd < 0) throw Error('Provider identity fields changed');
      source = source.slice(0, identityStart) + '{!props.preset ? <>\n' + source.slice(identityStart, identityEnd) + '</> : null}\n' + source.slice(identityEnd);
      source = once(source, 'export interface CustomProviderCardProps {', 'export interface CustomProviderCardProps {\n  preset?: { id: string; name: string; baseURL: string; protocol: string }', 'preset interface');
      for (const [name, field] of [['route', 'id'], ['displayName', 'name'], ['baseURL', 'baseURL']]) {
        const capital = name[0].toUpperCase() + name.slice(1);
        source = once(source, "const [" + name + ', set' + capital + "] = useState('')", "const [" + name + ', set' + capital + "] = useState(props.preset?." + field + " ?? '')", 'preset ' + name);
      }
      source = once(source, "const [protocol, setProtocol] = useState(protocols[0] ?? '')", "const [protocol, setProtocol] = useState(props.preset?.protocol && protocols.includes(props.preset.protocol) ? props.preset.protocol : protocols[0] ?? '')", 'preset protocol');
      source = once(source, "  const [keyDraft, setKeyDraft] = useState('')", "  const harness = useProviderHarness(route)\n  const [keyDraft, setKeyDraft] = useState('')", 'custom harness draft');
      source = once(source, "    <div className={styles['editor']}>", "    <div className={styles['editor']} data-commander-provider-editor='true'>\n      <ProviderHarnessField value={harness} disabled={disabled} />", 'custom harness field');
      source = once(source, '      props.onClose(true)', '      await harness.save()\n      props.onClose(true)', 'custom harness save');
      source = once(source, '    } finally {\n      setBusy(false)', '    } catch (error) {\n      setFailure(error instanceof Error ? error.message : String(error))\n    } finally {\n      setBusy(false)', 'custom harness failure');
      source = once(source, '  const modelFailure = validateDeepSeekModels(models)', '  const reasoningFailure = validateModelReasoning(models)\n  const modelFailure = validateDeepSeekModels(models)', 'custom reasoning validation');
      source = once(source, '    && keyFailure === undefined', '    && keyFailure === undefined && reasoningFailure === undefined', 'custom reasoning submit gate');
      source = once(source, "        : t('customNeedsModels')", "        : reasoningFailure ?? (models.length === 0 ? '请先填写 API 密钥，并至少添加一个模型' : t('customNeedsModels'))", 'custom reasoning failure hint');
      source = once(source, '  const create = async (): Promise<void> => {\n    setBusy(true)\n    setFailure(undefined)', '  const create = async (): Promise<void> => {\n    if (reasoningFailure !== undefined) { setFailure(reasoningFailure); return }\n    setBusy(true)\n    setFailure(undefined)', 'custom reasoning click feedback');
      source = once(source, "      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}\n", '', 'remove distant create failure');
      source = once(source, '      <EditorFooter', '      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 12 }}>\n      {failure !== undefined ? <p role="alert" className={styles[\'error\']} style={{ margin: 0 }}>{failure}</p> : null}\n      <EditorFooter', 'create failure row');
      source = once(source, '        onSubmit={() => { void create() }}\n      />', '        onSubmit={() => { void create() }}\n      />\n      </div>', 'create failure row close');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ProviderEditor\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = 'import { validateModelReasoning } from ' + JSON.stringify(reasoningState) + ';\n' + source;
      source = 'import { ProviderHarnessField, useProviderHarness, ProviderBrandIcon } from ' + JSON.stringify(selector) + ';\n' + source;
      source = once(source, "            <span className={styles['editorTitle']}>{props.displayName}</span>", "            <ProviderBrandIcon id={props.provider} name={props.displayName} declared={props.declared === true} />\n            <span className={styles['editorTitle']}>{props.displayName}</span>", 'provider editor brand');
      source = once(source, '  const { namespace, schema, settingsPath, operations, t } = props', '  const { namespace, schema, settingsPath, operations, t } = props\n  const harness = useProviderHarness(props.provider)', 'provider harness draft');
      source = once(source, "    <div className={props.credentialOnly === true ? styles['addBlock'] : styles['editor']}>", "    <div className={props.credentialOnly === true ? styles['addBlock'] : styles['editor']} data-commander-provider-editor={props.credentialOnly === true ? undefined : 'true'}>\n      {props.credentialOnly === true ? null : <ProviderHarnessField value={harness} disabled={disabled} />}", 'provider harness field');
      source = once(source, '      props.onClose(true)', '      if (props.credentialOnly !== true) await harness.save()\n      props.onClose(true)', 'provider harness save');
      source = once(source, '    } finally {\n      setBusy(false)', '    } catch (error) {\n      setFailure(error instanceof Error ? error.message : String(error))\n    } finally {\n      setBusy(false)', 'provider harness failure');
      source = once(source, "  const modelFailure = validateModels(schema.getPath(draft, ['models']))", "  const reasoningFailure = layout === 'pi-ai' && props.credentialOnly !== true ? validateModelReasoning(schema.getPath(draft, ['models'])) : undefined\n  const modelFailure = validateModels(schema.getPath(draft, ['models']))", 'provider reasoning validation');
      source = once(source, '    if (props.credentialOnly !== true) {', '    if (props.credentialOnly !== true) {\n      if (reasoningFailure !== undefined) return reasoningFailure', 'provider reasoning write gate');
      source = once(source, "      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}", "      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}\n      {props.credentialOnly !== true && reasoningFailure !== undefined ? <p role=\"alert\" className={styles['error']}>{reasoningFailure}</p> : null}", 'provider reasoning failure hint');
      source = once(source, "          || (props.credentialOnly !== true && modelFailure !== undefined)", "          || (props.credentialOnly !== true && (modelFailure !== undefined || reasoningFailure !== undefined))", 'provider reasoning submit gate');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]DeepSeekModelsEditor\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = 'import { useNewModelProfiles } from ' + JSON.stringify(profileMatch) + ';\n' + source;
      source = once(source, '  const reset = (): void => {\n    rowState.reset()\n    props.onReset()\n  }\n\n', '', 'remove unused deepseek reset');
      const resetStart = source.indexOf('        {props.overridden\n          ? (');
      const resetEnd = source.indexOf('          : null}', resetStart);
      if (resetStart < 0 || resetEnd < 0) throw Error('Official DeepSeek reset control changed');
      source = source.slice(0, resetStart) + source.slice(resetEnd + '          : null}'.length);
      source = once(source, 'export function DeepSeekModelsEditor(props: DeepSeekModelsEditorProps): ReactNode {', 'export function DeepSeekModelsEditor(props: DeepSeekModelsEditorProps): ReactNode {\n  useNewModelProfiles(props.models, props.onChange, props.disabled, false)', 'deepseek profile match');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ModelRow\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = once(source, 'interface ModelRowProps {', 'interface ModelRowProps {\n  extraSettings?: ReactNode', 'model extension prop');
      source = once(source, [
        '              {props.reasoningLevels !== undefined && props.reasoningLevels.length > 0',
        '                ? (',
        '                  <ModelReasoningEfforts',
        '                    model={model} levels={props.reasoningLevels} position={position} disabled={disabled} t={t} onChange={props.onChange}',
        '                  />',
        '                )',
        '                : null}',
      ].join('\n'), '              {props.extraSettings}', 'expanded model extension');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ModelListEditor\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = 'import { useNewModelProfiles } from ' + JSON.stringify(profileMatch) + ';\nimport { UIIcon } from ' + JSON.stringify(fileURLToPath(new URL('../client/iconsax.jsx', import.meta.url))) + ';\nimport { ModelReasoningEditor } from ' + JSON.stringify(reasoningEditor) + ';\n' + source;
      source = once(source, '  const { catalogProvider } = props', '  const { catalogProvider } = props\n  useNewModelProfiles(models, onChange, disabled)', 'silent new model profiles');
      const resetStart = source.indexOf('        {props.overridden === true && props.onReset !== undefined');
      const resetEnd = source.indexOf('          : null}', resetStart);
      if (resetStart < 0 || resetEnd < 0) throw Error('Official model reset control changed');
      source = source.slice(0, resetStart) + source.slice(resetEnd + '          : null}'.length);
      source = once(source, "className={styles['linkButton']}\n          disabled={disabled || busy", "className={styles['linkButton'] + ' cmd-model-discover'}\n          aria-busy={busy}\n          disabled={disabled || busy", 'discover button style');
      source = once(source, "      setFailure(answer.kind === 'refused' ? answer.message : undefined)\n    })", "      setFailure(answer.kind === 'refused' ? answer.message : undefined)\n    }).catch(error => { if (current) { setInheritedCatalog({ provider: catalogProvider, models: [] }); setFailure(error instanceof Error ? error.message : String(error)) } })", 'inherited catalog failure');
      // Adoption must remain synchronous: optional public metadata must never gate a user's selection.
      source = once(source, '    } finally {\n      setBusy(false)', '    } catch (error) {\n      setFailure(error instanceof Error ? error.message : String(error))\n    } finally {\n      setBusy(false)', 'model discovery error');
      source = once(source, "          {busy ? t('fetching') : t('fetchModels')}", "          {busy ? <span className={styles['buttonSpinner']} aria-hidden=\"true\" /> : <UIIcon name=\"plus\" size={15} />}{busy ? t('fetching') : t('fetchModels')}", 'discovery loading spinner');
      source = once(source, '            onFieldChange={(field, value)', '            extraSettings={<ModelReasoningEditor model={model} position={index + 1} disabled={disabled} styles={styles} onChange={(next) => { onChange(models.map((row, at) => at === index ? next : row)) }} />}\n            onFieldChange={(field, value)', 'per-model reasoning settings');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]EditorFooter\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = once(source, "        {props.busy ? t(props.submitBusyLabelKey) : t(props.submitLabelKey)}", "        {props.busy ? <span className={styles['buttonSpinner']} aria-hidden=\"true\" /> : null}{props.busy ? t(props.submitBusyLabelKey) : t(props.submitLabelKey)}", 'submit spinner');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ModelsSection\.module\.css$/ }, async args => {
      const result = await esbuild({ stdin: { contents: 'import styles from ' + JSON.stringify(args.path) + '; export default styles;', resolveDir: dirname(args.path) }, bundle: true, write: false, outdir: join(tmpdir(), 'commander-css-memory'), format: 'cjs', loader: { '.css': 'local-css' }, logLevel: 'silent' });
      const js = result.outputFiles.find(file => file.path.endsWith('.js'));
      const css = result.outputFiles.find(file => file.path.endsWith('.css'));
      if (!js || !css) throw new Error('Official Models CSS module did not compile');
      const module = { exports: {} }; new Function('module', 'exports', js.text)(module, module.exports);
      const spinner = '.buttonSpinner{display:inline-block;vertical-align:middle;margin-right:7px;width:12px;height:12px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:commander-button-spin .7s linear infinite}@keyframes commander-button-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.buttonSpinner{animation:none}}';
      module.exports.default.buttonSpinner = 'buttonSpinner';
      return { loader: 'js', contents: 'const id="commander-official-models-style"; if (!document.getElementById(id)) { const style=document.createElement("style"); style.id=id; style.textContent=' + JSON.stringify(css.text + spinner) + '; document.head.append(style); } export default ' + JSON.stringify(module.exports.default) + ';' };
    });
  } };
}
