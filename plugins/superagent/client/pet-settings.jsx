import React, { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { IconDownloadOutlineRegular, IconSparkleRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { Button } from '../../shared/client/ui/button.jsx';
import { CustomSelect } from '../../shared/client/custom-select.jsx';
import { saveOriginalFile } from '../../shared/client/file-save.mjs';
import { PetAvatar } from '../../shared/client/pet-avatar.jsx';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import { UIIcon } from '../../base/client/iconsax.jsx';
import { applyPetDraft, petActionOptions, petExpressionForAction, petImageUrl, petWorkEvents } from './pet-state.mjs';
import { assistantConfigSync } from './config-sync.mjs';
import { ResourceState } from './resource-state.jsx';
import css from './pet-editor.css';

const fileData = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('文件读取失败，请重试。'));
  reader.onabort = reader.onerror;
  reader.readAsDataURL(file);
});

const categories = [['expression', '表情'], ['action', '动作'], ['palette', '配色'], ['decoration', '装饰']]
  .map(([value, label]) => ({ value, label }));
const assetTabs = [
  { value: 'library', label: '素材库' },
  { value: 'actions', label: '工作动作' },
];
const expressionImports = [
  { id: 'happy', label: '开心' }, { id: 'think', label: '思考' },
  { id: 'waiting', label: '等待' }, { id: 'wink', label: '眨眼' },
];

function AssetLibrary({ catalog, pet, category, setCategory, busy, previewBuiltin, previewVariant, play, onEmptyAction }) {
  const id = useId();
  const base = pet?.kind === 'builtin' ? pet : { kind: 'builtin', assetId: 'builtin', expression: 'standard', decorations: [], palette: 'default' };
  const variants = category === 'palette' ? pet?.appearance?.palettes : pet?.appearance?.decorations;
  const rows = category === 'action' ? petActionOptions(pet).map(item => ({ id: item.value, label: item.label, run: () => play(item.value) }))
    : category === 'expression' ? (catalog.expressions || []).map(item => ({ ...item, sample: { ...base, expression: item.id }, selected: pet?.kind === 'builtin' && base.expression === item.id, run: () => previewBuiltin({ ...base, expression: item.id }) }))
    : category === 'palette' ? (catalog.palettes || []).map(item => ({ ...item, colors: [item.body, item.corner, item.ink], selected: pet?.kind === 'builtin' && base.palette === item.id, run: () => previewBuiltin({ ...base, palette: item.id }) }))
    : (catalog.decorations || []).map(item => ({ ...item, sample: { ...base, decorations: [item.id] }, selected: pet?.kind === 'builtin' && base.decorations.includes(item.id), run() {
      const group = ['hat-', 'glasses-'].find(prefix => item.id.startsWith(prefix));
      const selected = base.decorations.includes(item.id);
      const decorations = base.decorations.filter(value => value !== item.id && (selected || !group || !value.startsWith(group)));
      return previewBuiltin({ ...base, decorations: selected ? decorations : [...decorations, item.id] });
    } }));
  if (category === 'expression') for (const expression of Object.keys(pet?.expressions || {})) rows.push({
    id: `custom:${expression}`, label: expression, src: petImageUrl(pet, document.baseURI, expression), run: () => play('', expression),
  });
  if (category === 'palette' || category === 'decoration') for (const variant of Object.keys(variants || {})) rows.push({
    id: `custom:${variant}`, label: variant, src: petImageUrl({ ...pet, appearance: { ...pet.appearance, variant } }, document.baseURI),
    selected: pet.appearance.variant === variant, run: () => previewVariant(pet.appearance.variant === variant ? null : variant),
  });
  return <>
    <SegmentedControl label="素材分类" value={category} onChange={setCategory} tabIdPrefix={id} panelId={id + '-panel'} options={categories} />
    <div id={id + '-panel'} role="tabpanel" aria-labelledby={`${id}-${category}`}>
      {rows.length ? <div className="ba-pet-thumbnail-grid">{rows.map(item => <Button variant="ghost" type="button" className="ba-pet-choice" key={item.id} disabled={busy} aria-pressed={item.selected} onClick={() => item.run()}>
        {(item.sample || item.src) && <PetAvatar pet={item.sample} src={item.src || petImageUrl(item.sample, document.baseURI)} size={42} motion={false} alt="" />}
        {item.colors && <span className="ba-pet-swatches" aria-hidden="true">{item.colors.map((color, index) => <i key={index} style={{ backgroundColor: color }} />)}</span>}
        <span>{item.label || item.id}</span>
      </Button>)}</div> : <ResourceState icon="brush" title="暂无素材" description="可以导入形象包添加素材。" actionLabel="前往导入" onAction={onEmptyAction} />}
    </div>
  </>;
}

export function PetSettings({ api, config: initialConfig, identityFields, onChanged, onDesign, focusAssets, active = true }) {
  const synced = useSyncExternalStore(assistantConfigSync.subscribe, assistantConfigSync.getSnapshot);
  const config = synced && synced.revision >= initialConfig.revision ? synced : initialConfig;
  const [catalog, setCatalog] = useState(null), [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true), [catalogError, setCatalogError] = useState(''), [request, setRequest] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [preview, setPreview] = useState(null), [assetTab, setAssetTab] = useState('library');
  const [category, setCategory] = useState('expression'), [orientation, setOrientation] = useState('horizontal');
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false), [exportFeedback, setExportFeedback] = useState(null);
  const importButton = useRef(null), expressionId = useRef('');
  const files = useRef(null), legacy = useRef(null), expressionFile = useRef(null), assets = useRef(null), assetLayout = useRef(null), running = useRef(false);
  const draftOperation = useRef(0);
  const id = useId();
  useLayoutEffect(() => {
    const node = assetLayout.current;
    const update = () => {
      if (node.clientWidth) setOrientation(node.clientWidth >= 510 ? 'vertical' : 'horizontal');
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const startedAt = draftOperation.current;
    setLoading(true); setCatalogError('');
    api('petCatalog').then(value => {
      if (!live) return;
      setCatalog(value);
      if (!running.current && draftOperation.current === startedAt) setDraft(value.draft || null);
    })
      .catch(cause => { if (live) setCatalogError(cause.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [api, request, active]);
  useEffect(() => { if (!active) setImportOpen(false); }, [active]);
  useEffect(() => {
    if (active && focusAssets) assets.current?.focus();
  }, [active, focusAssets]);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => setPreview(null), 1800);
    return () => clearTimeout(timer);
  }, [preview]);
  const pet = draft?.pet || config.pet;
  const options = petActionOptions(pet);
  const expressions = pet?.kind === 'custom' ? Object.keys(pet.expressions || {}).map(id => ({ id, label: id })) : (catalog?.expressions || []);
  const play = (action, face) => setPreview({ action, face, key: Date.now() });
  const previewFace = preview?.face || petExpressionForAction(pet, preview?.action);
  const src = previewFace ? petImageUrl(pet, document.baseURI, previewFace) : draft?.src || petImageUrl(pet, document.baseURI);
  async function run(work) {
    if (running.current) return;
    draftOperation.current++;
    running.current = true; setBusy(true); setError(''); setNotice(''); setPreview(null);
    try { await work(); } catch (cause) { setError(cause.message); }
    finally { running.current = false; setBusy(false); }
  }
  const makePreview = (action, args) => run(async () => { setDraft(await api(action, args)); });
  async function commit(work) {
    await work(); setDraft(null); setNotice('已应用形象');
    void Promise.resolve(onChanged?.()).catch(cause => setNotice('已应用；刷新失败：' + cause.message));
  }
  function receive(event, kind) {
    const file = event.target.files?.[0], expression = expressionId.current;
    event.target.value = '';
    if (!file) return;
    void run(async () => {
      const isPackage = kind === 'package';
      if (file.size > (isPackage ? 24 : 8) * 1024 * 1024) throw new Error(isPackage ? '形象包不能超过 24 MiB' : '图片不能超过 8 MiB');
      if (isPackage && !file.name.toLowerCase().endsWith('.zip')) throw new Error('请选择 ZIP 形象包');
      const dataUrl = await fileData(file);
      setDraft(await (isPackage ? api('petUploadPackage', { base64: dataUrl.slice(dataUrl.indexOf(',') + 1) })
        : api('petUpload', { dataUrl, ...(kind === 'expression' ? { expression } : {}) })));
    });
  }
  function importFile(kind) {
    setImportOpen(false);
    if (kind === 'package') files.current?.click();
    else if (kind === 'image') legacy.current?.click();
    else { expressionId.current = kind; expressionFile.current?.click(); }
  }
  async function exportPackage() {
    setExporting(true); setExportFeedback(null);
    let url;
    try {
      const { filename, base64 } = await api('petExportPackage');
      if (!filename || !base64) throw new Error('服务未返回形象包。');
      const binary = atob(base64), bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const mimeType = 'application/zip';
      url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
      const result = await saveOriginalFile({ url, filename, mimeType, localObjectUrl: true });
      if (result.status !== 'cancelled') setExportFeedback({ message: result.status === 'saved' ? '已保存形象包' : '已开始下载形象包' });
    } catch (cause) { setExportFeedback({ error: true, message: `导出失败：${cause.message || '请重试。'}` }); }
    finally { if (url) URL.revokeObjectURL(url); setExporting(false); }
  }

  return <div className="ba-pet-settings">
    <style>{css}</style>
    <div className="ba-pet-identity-grid">
      <div className="ba-pet-identity-stage" data-draft={!!draft}>
        <PetAvatar key={preview?.key || 'portrait'} pet={pet} src={src} action={preview?.action} motion={active} size={112} />
        <span>{draft ? '形象预览' : pet?.appearance?.name || '当前形象'}</span>
      </div>
      <div className="ba-pet-identity-fields">
        <div className="ba-pet-toolbar">
          {onDesign && <Button variant="outline" size="sm" data-tone="generate" disabled={busy} onClick={() => onDesign(draft?.source === 'ai' ? 'refine' : 'design')}>
            <IconSparkleRegular size={16} />生成
          </Button>}
          <Button ref={importButton} variant="outline" size="sm" data-tone="import" disabled={busy} aria-haspopup="menu" aria-expanded={importOpen}
            onClick={() => setImportOpen(open => !open)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setImportOpen(true); } }}>
            <UIIcon name="folderOpen" size={16} />导入
          </Button>
          <Button variant="outline" size="sm" data-tone="export" disabled={busy || exporting} aria-busy={exporting} onClick={() => void exportPackage()}>
            <IconDownloadOutlineRegular size={16} />导出
          </Button>
        </div>
        <Menu open={importOpen} anchor={null} anchorRef={importButton} onClose={() => setImportOpen(false)} onSelect={importFile} portal autoFocus compact items={[
          { id: 'package', label: '选择 ZIP 形象包', icon: <UIIcon name="folderOpen" size={16} /> },
          { id: 'image', label: '上传单张图片', icon: <UIIcon name="picture" size={16} /> },
          ...(config.pet?.kind === 'custom' ? [{ id: 'expression', label: '上传表情图', submenu: expressionImports }] : []),
        ]} />
        {exportFeedback && <p className={exportFeedback.error ? 'ba-error' : 'ba-pet-notice'} role={exportFeedback.error ? 'alert' : 'status'}>{exportFeedback.message}</p>}
        {identityFields}
      </div>
    </div>
    <section className="ba-pet-assets" aria-labelledby={id + '-title'} aria-busy={busy}>
      <header className="ba-pet-assets-heading">
        <h2 id={id + '-title'} ref={assets} tabIndex={-1}>形象资产</h2>
        <div className="ba-pet-test">
          <CustomSelect aria-label="试播" value="" placeholder="试播" disabled={busy} options={[
            ...options.map(item => ({ ...item, value: `action:${item.value}` })),
            ...expressions.map(item => ({ value: `expression:${item.id}`, label: item.label || item.id })),
          ]} onChange={value => value.startsWith('action:') ? play(value.slice(7)) : play('', value.slice(11))} />
        </div>
      </header>
      <input ref={files} hidden type="file" aria-label="形象包文件" accept=".zip,application/zip" onChange={event => receive(event, 'package')} />
      <input ref={legacy} hidden type="file" aria-label="形象图片文件" accept="image/png,image/jpeg,image/webp" onChange={event => receive(event, 'image')} />
      <input ref={expressionFile} hidden type="file" aria-label="表情图片文件" accept="image/png,image/jpeg,image/webp" onChange={event => receive(event, 'expression')} />
      {error && <p className="ba-error" role="alert">{error}</p>}
      {draft && <div className="ba-pet-editor-actions">
        <Button variant="default" type="button" disabled={busy} onClick={() => run(() => commit(() => applyPetDraft(api, config, draft)))}>应用形象</Button>
        <Button variant="ghost" type="button" disabled={busy} onClick={() => run(async () => { await api('petDiscard', { draftId: draft.draftId }); setDraft(null); })}>取消预览</Button>
      </div>}
      <div ref={assetLayout} className="ba-pet-asset-layout" data-orientation={orientation}>
        <SegmentedControl navigation label="形象资产分类" options={assetTabs} value={assetTab} onChange={setAssetTab} orientation={orientation} tabIdPrefix={id} panelId={id + '-asset-panel'} />
        <div id={id + '-asset-panel'} className="ba-pet-asset-panel" role="tabpanel" tabIndex={0} aria-labelledby={`${id}-${assetTab}`}>
          {assetTab === 'actions' && (
            <div className="ba-pet-work-actions">{Object.entries(petWorkEvents).map(([event, label]) => <div className="ba-pet-work-field" key={event}>
              <span>{label}</span><CustomSelect aria-label={label} value={pet?.appearance?.bindings?.[event] || 'default'} disabled={busy}
                options={[{ value: 'default', label: '默认动作' }, { value: 'none', label: '静止' }, ...options]}
                onChange={value => {
                  const bindings = { ...pet?.appearance?.bindings };
                  if (value === 'default') delete bindings[event]; else bindings[event] = value;
                  void makePreview('petPreview', { bindings, draftId: draft?.draftId });
                  if (value !== 'default' && value !== 'none') play(value);
                }} />
            </div>)}</div>
          )}
          {assetTab === 'library' && <>
            {loading && !catalog && <ResourceState kind="loading" title="正在读取形象资产" />}
            {catalogError && <ResourceState kind="error" title="形象资产暂时无法载入" description={catalogError} onAction={() => setRequest(value => value + 1)} />}
            {catalog && <AssetLibrary catalog={catalog} pet={pet} category={category} setCategory={setCategory} busy={busy} onEmptyAction={() => {
              if (busy) return;
              importButton.current?.focus(); setImportOpen(true);
            }}
              previewBuiltin={value => run(async () => {
                if (value.decorations.length > 3) throw new Error('最多搭配三件装饰。');
                setDraft(await api('petPreview', { pet: value, draftId: draft?.draftId }));
              })}
              previewVariant={variant => makePreview('petPreview', { variant, draftId: draft?.draftId })} play={play} />}
          </>}
        </div>
      </div>
      {(config.petHasPrevious || config.pet) && <div className="ba-pet-editor-actions ba-pet-restore">
        {config.petHasPrevious && <Button variant="ghost" type="button" disabled={busy} onClick={() => run(() => commit(() => api('petRestore', { revision: config.revision })))}>恢复上一版</Button>}
        {config.pet && <Button variant="ghost" type="button" disabled={busy} onClick={() => run(() => commit(() => api('petRestore', { revision: config.revision, default: true })))}>恢复默认形象</Button>}
      </div>}
      {(busy || notice) && <p className="ba-pet-notice" role="status">{busy ? '正在处理形象…' : notice}</p>}
    </section>
  </div>;
}
