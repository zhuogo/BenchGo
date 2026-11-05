import { Button } from '../../shared/client/ui/button.jsx';
import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { PetEditor } from './pet-editor.jsx';
import { petImageUrl } from './pet-state.mjs';
import { assistantConfigSync, saveConfigPatch } from './config-sync.mjs';
import { CustomSelect } from '../../shared/client/custom-select.jsx';
import { PetAvatar } from '../../shared/client/pet-avatar.jsx';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';

export function PetSettings({ api, config: initialConfig, onChanged, onDesign }) {
  const syncedConfig = useSyncExternalStore(assistantConfigSync.subscribe, assistantConfigSync.getSnapshot);
  const config = syncedConfig && syncedConfig.revision >= initialConfig.revision ? syncedConfig : initialConfig;
  const [catalog, setCatalog] = useState(null), [draft, setDraft] = useState(null);
  const [catalogLoading, setCatalogLoading] = useState(true), [catalogError, setCatalogError] = useState(''), [catalogRequest, setCatalogRequest] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [motionNotice, setMotionNotice] = useState('');
  const [selection, setSelection] = useState(config.pet?.kind === 'builtin' ? config.pet : null);
  const [revision, setRevision] = useState(config.revision);
  const [displayExpression, setDisplayExpression] = useState(null);
  const [expressionId, setExpressionId] = useState('happy');
  const [appearanceTab, setAppearanceTab] = useState('expression');
  const appearanceId = useId();
  const expressionInput = useRef(null);
  useEffect(() => { setDisplayExpression(null); setSelection(config.pet?.kind === 'builtin' ? config.pet : null); }, [config.revision]);
  useEffect(() => {
    let active = true;
    setCatalogLoading(true); setCatalogError('');
    api('petCatalog').then(value => { if (active) { setCatalog(value); if (value.draft) setDraft(value.draft); } })
      .catch(cause => { if (active) setCatalogError(cause.message); })
      .finally(() => { if (active) setCatalogLoading(false); });
    return () => { active = false; };
  }, [api, catalogRequest]);
  useEffect(() => { if (!draft) setRevision(config.revision); }, [config.revision, draft]);
  async function run(work) { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await work(); } catch (cause) { setError(cause.message); } finally { setBusy(false); } }
  async function commit(action, args) {
    const response = await api(action, args); setDraft(null); setRevision(response.revision ?? response.config?.revision);
    setNotice('已应用，记忆与会话保持不变。');
    Promise.resolve(onChanged?.()).catch(cause => setNotice('已应用；刷新失败：' + cause.message));
  }
  const base = selection || { kind: 'builtin', assetId: 'builtin', expression: catalog?.expressions?.[0]?.id, decorations: [], palette: catalog?.palettes?.[0]?.id };
  const preview = patch => run(async () => { const next = { ...base, ...patch }; const result = await api('petPreview', { pet: next }); setSelection(next); setDraft(result); setRevision(config.revision); });
  const upload = (file, expression) => run(async () => {
    if (file.size > 8 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择不超过 8 MB 的 PNG、JPEG 或 WebP 图片');
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file); });
    setDraft(await api('petUpload', { dataUrl, ...(expression ? { expression } : {}) })); setRevision(config.revision);
  });
  function toggleDecoration(id) {
    const current = base.decorations || [];
    if (current.includes(id)) return preview({ decorations: current.filter(value => value !== id) });
    const group = id.startsWith('hat-') ? 'hat-' : id.startsWith('glasses-') ? 'glasses-' : null;
    const next = group ? current.filter(value => !value.startsWith(group)) : current;
    if (next.length >= 3) { setError('最多搭配三件装饰，请先取消一件。'); return; }
    return preview({ decorations: [...next, id] });
  }
  return <div className="ba-pet-settings">
    <PetEditor name={config.name} pet={draft?.pet || config.pet} currentSrc={petImageUrl(config.pet, document.baseURI, displayExpression)} previewSrc={draft?.src} motion={config.cardMotion !== false} motionNotice={motionNotice} busy={busy} canRestore={config.petHasPrevious === true}
      expressions={Object.keys(config.pet?.expressions || {}).map(id => ({ id, label: id }))} onExpression={setDisplayExpression}
      onUpload={file => upload(file)}
      onApply={() => run(() => commit('petApply', { draftId: draft.draftId, revision }))} onCancel={() => run(async () => { await api('petDiscard', { draftId: draft.draftId }); setDraft(null); setNotice('预览已取消，当前形象保持不变。'); })}
      onRestore={() => run(() => commit('petRestore', { revision: config.revision }))} onReset={() => run(() => commit('petRestore', { revision: config.revision, default: true }))}
      onMotionChange={cardMotion => run(async () => { setMotionNotice(''); const next = await saveConfigPatch(api, config, { cardMotion }); if (JSON.stringify(next.pet) === JSON.stringify(config.pet)) setRevision(next.revision); setMotionNotice(cardMotion ? '已开启' : '已关闭'); Promise.resolve(onChanged?.()).catch(cause => setMotionNotice('已保存；刷新失败：' + cause.message)); })} onDesign={onDesign} />
    {config.pet?.kind === 'custom' && <section className="ba-pet-composition" aria-label="自己的表情"><h3>添加自己的表情</h3><p className="ba-note">上传同一形象的表情图，预览后保存。更换主形象时会移除旧表情绑定。</p><div className="ba-pet-editor-actions"><label>表情 <CustomSelect value={expressionId} disabled={busy} onChange={setExpressionId} options={[['happy', '开心'], ['shy', '害羞'], ['think', '思考'], ['waiting', '等待'], ['wink', '眨眼']].map(([value, label]) => ({ value, label }))} /></label><Button variant="secondary" type="button" className="ba-secondary" disabled={busy} onClick={() => expressionInput.current?.click()}>上传表情图</Button></div><input ref={expressionInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file, expressionId); }} /></section>}
    {config.cardHtml && <p className="ba-note">侧栏仍使用你的自定义名片。可在“信息 → 名片”选择“当前形象”，聊天与首页已使用这里的外观。</p>}
    <section className="ba-pet-composition" aria-label="基准形象装扮" aria-busy={catalogLoading}><header><div><h3>基准形象装扮</h3><p className="ba-note">点击即可预览，应用后生效。原创形象使用自己上传的图片与表情。</p></div><UIIcon name="brush" size={20} /></header>
      {catalogLoading && !catalog && <div className="ba-pet-catalog-state" role="status"><UIIcon name="refresh" size={26} /><strong>正在准备装扮</strong><p>载入表情、配色与装饰。</p><div className="ba-pet-catalog-skeleton" aria-hidden="true"><span /><span /><span /><span /></div></div>}
      {catalogError && <div className="ba-pet-catalog-state" role="alert"><UIIcon name="brush" size={26} /><strong>装扮暂时没有载入</strong><p>{catalogError}</p><Button variant="secondary" type="button" disabled={catalogLoading} onClick={() => setCatalogRequest(value => value + 1)}><UIIcon name="refresh" size={16} />重新加载</Button></div>}
      {catalog && <><SegmentedControl label="装扮分类" value={appearanceTab} onChange={setAppearanceTab} tabIdPrefix={appearanceId} panelId={appearanceId + '-panel'} options={[{ value: 'expression', label: '表情' }, { value: 'palette', label: '配色' }, { value: 'decoration', label: '装饰' }]} /><div id={appearanceId + '-panel'} role="tabpanel" aria-labelledby={`${appearanceId}-${appearanceTab}`} >
      <div className="ba-pet-options" hidden={appearanceTab !== 'expression'}><h4>表情</h4><div className="ba-pet-thumbnail-grid">{catalog.expressions?.map(item => { const pet = { ...base, expression: item.id }; return <Button variant="ghost" type="button" className="ba-pet-choice" key={item.id} disabled={busy} aria-pressed={base.expression === item.id} onClick={() => preview({ expression: item.id })}><PetAvatar pet={pet} src={petImageUrl(pet, document.baseURI)} size={48} motion={false} /><span>{item.label || item.id}</span></Button>; })}</div></div>
      <div className="ba-pet-options" hidden={appearanceTab !== 'palette'}><h4>配色</h4><div className="ba-pet-palette-list">{catalog.palettes?.map(item => <Button variant="ghost" type="button" className="ba-pet-choice ba-pet-palette" key={item.id} disabled={busy} aria-pressed={base.palette === item.id} onClick={() => preview({ palette: item.id })}><span className="ba-pet-swatches" aria-hidden="true">{[item.body, item.corner, item.ink].map((color, index) => <i key={index} style={{ backgroundColor: color }} />)}</span><span>{item.label || item.id}</span></Button>)}</div></div>
      <div className="ba-pet-options" hidden={appearanceTab !== 'decoration'}><h4>装饰 <small>最多三件，同类帽子或眼镜自动替换</small></h4><div className="ba-pet-thumbnail-grid">{catalog.decorations?.map(item => { const pet = { ...base, decorations: [item.id] }; return <Button variant="ghost" type="button" className="ba-pet-choice" key={item.id} disabled={busy} aria-pressed={base.decorations.includes(item.id)} onClick={() => toggleDecoration(item.id)}><PetAvatar pet={pet} src={petImageUrl(pet, document.baseURI)} size={48} motion={false} /><span>{item.label || item.id}</span></Button>; })}</div></div>
      {!(catalog[appearanceTab === 'expression' ? 'expressions' : appearanceTab === 'palette' ? 'palettes' : 'decorations'] || []).length && <div className="ba-pet-catalog-state"><UIIcon name="brush" size={26} /><strong>还没有可用装扮</strong><p>可以先上传自己的图片，或稍后重新加载。</p><Button variant="secondary" type="button" disabled={catalogLoading} onClick={() => setCatalogRequest(value => value + 1)}>重新加载</Button></div>}
    </div></>}
    </section>
    {error && <p className="ba-error" role="alert">{error}<Button variant="ghost" type="button" disabled={busy} onClick={() => run(async () => { const latest = await api('state'); setRevision(latest.config.revision); setCatalog(await api('petCatalog')); onChanged?.(); setNotice('已载入最新配置，预览保留，请核对后重新应用。'); })}>载入最新配置</Button></p>}
    {(busy || notice) && <p className="ba-pet-notice" role="status"><UIIcon name={busy ? 'refresh' : 'check'} size={16} />{busy ? '正在处理，请稍候…' : notice}</p>}
  </div>;
}
