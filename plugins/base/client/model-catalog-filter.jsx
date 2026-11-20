import React from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
import { UIIcon } from './iconsax.jsx';
import { ModelVendorIcon } from './provider-brand-icon.jsx';
import chatIcon from './assets/icon-library/Chat_Line.svg';
import { IconDatabaseOutlineRegular, IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { hasTextCapability, modelCapabilityLabels } from '../shared/model-capabilities.mjs';
import { modelCatalogFacts } from './model-capabilities.jsx';

const modalityLabels = { text: '文本', image: '图片 图片输入 视觉 vision', audio: '音频', video: '视频', pdf: 'PDF' };
const normalized = value => String(value ?? '').normalize('NFKC').toLowerCase();
const categories = [
  { id: 'language', label: '大语言模型', artwork: chatIcon.replaceAll('black', 'currentColor'), capabilities: ['text'] },
  { id: 'image', label: '图片生成与编辑模型', icon: 'picture', capabilities: ['image-generation', 'image-edit', 'image-mask'] },
  { id: 'voice', label: '语音模型', icon: 'mic', capabilities: ['tts', 'asr', 'realtime'] },
  { id: 'knowledge', label: '知识库模型', Icon: IconDatabaseOutlineRegular, capabilities: ['embedding', 'rerank'] },
  { id: 'video', label: '视频模型', Icon: IconPlayOutlineRegular, capabilities: ['video'] },
];

function modelCategories(id, capabilities, outputs, hasOverride) {
  const knowledgeId = /(?:^|[/._:-])(embed(?:ding[s]?)?|rerank(?:er)?)(?:$|[/._:-])/i.test(id);
  const groups = categories.filter(({ capabilities: supported }) => supported.some(capability => capabilities.includes(capability)));
  if (hasOverride) return groups;
  if (knowledgeId && !groups.some(group => group.id === 'knowledge')) return [categories[3], ...groups.filter(group => group.id !== 'language')];
  if (groups.length) return groups;
  return outputs.flatMap(output => {
    const group = categories.find(({ id }) => id === ({ audio: 'voice' }[output] ?? output));
    return group ? [group] : [];
  });
}

const vendorOf = profile => typeof profile?.vendor_name === 'string' ? profile.vendor_name.trim() : '';

export function useCatalogModelProfiles(models, publicRows) {
  const byId = React.useMemo(() => {
    const index = new Map();
    for (const profile of publicRows ?? []) {
      const id = profile?.model_id;
      if (typeof id === 'string' && id) index.set(id, index.has(id) ? undefined : profile);
    }
    return index;
  }, [publicRows]);
  return React.useMemo(() => new Map(models.map(({ id }) => [id, byId.get(id)])), [models, byId]);
}

export function filterModelRows(rows, filter, profiles, catalog, defaults = new Map(), defaultInput) {
  const tokens = normalized(filter.query).trim().split(/\s+/u).filter(Boolean);
  if (!tokens.length && !filter.category && !filter.vendor) return rows;
  return rows.filter(({ model }) => {
    const profile = profiles.get(model.id);
    if (filter.vendor && vendorOf(profile) !== filter.vendor) return false;
    if (!tokens.length && !filter.category) return true;
    if (!model.id) return true;
    const remote = catalog?.models.get(model.id);
    const { input, output, capabilities, overridden } = modelCatalogFacts(model.id, profile, catalog);
    const configured = model.input ?? model.inputModalities;
    const inputs = Array.isArray(configured) && configured.length ? configured
      : input.length ? input : defaults.get(model.id) ?? defaultInput ?? ['text'];
    const groups = modelCategories(model.id, capabilities, output, overridden);
    if (filter.category && !groups.some(group => group.id === filter.category)) return false;
    const labels = hasTextCapability(capabilities)
      ? [...inputs, ...input.filter(value => value !== 'text' && value !== 'image')].flatMap(value => [value, modalityLabels[value]]) : [];
    const searchable = [model.id, model.name, remote?.name, profile?.model_name, ...labels, ...groups.map(group => group.label),
      ...(groups.some(group => group.id === 'knowledge') ? ['RAG', '嵌入', '重排序', 'embedding', 'rerank'] : []),
      ...capabilities.flatMap(capability => [capability, modelCapabilityLabels[capability]])];
    return tokens.every(token => searchable.some(value => normalized(value).includes(token)));
  });
}

export function ModelCatalogFilter({ filter, onChange }) {
  return <div className="cmd-model-catalog-filter">
    <div className="cmd-model-category-buttons" role="group" aria-label="模型分类">
      {categories.map(({ id, label, icon, Icon, artwork }) => <Tooltip key={id} label={label}>
        <Button variant="ghost" size="icon" aria-label={label} aria-pressed={filter.category === id}
          onClick={() => onChange({ ...filter, category: filter.category === id ? '' : id })}>
          {artwork ? <span className="cmd-model-category-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: artwork }} />
            : Icon ? <Icon size={15} aria-hidden /> : <UIIcon name={icon} size={15} />}
        </Button>
      </Tooltip>)}
    </div>
    <input type="search" aria-label="搜索模型目录" placeholder="搜索模型" value={filter.query}
      onChange={event => onChange({ ...filter, query: event.target.value })} />
  </div>;
}

export function ModelVendorFilter({ profiles, filter, onChange }) {
  const vendors = React.useMemo(() => [...new Set([filter.vendor, ...Array.from(profiles.values(), vendorOf)].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN')), [profiles, filter.vendor]);
  if (!vendors.length) return null;
  return <div className="cmd-model-vendor-buttons" role="group" aria-label="模型厂商">
    {vendors.map(vendor => <Tooltip key={vendor} label={vendor}>
      <Button variant="ghost" size="icon" aria-label={vendor} aria-pressed={filter.vendor === vendor}
        onClick={() => onChange({ ...filter, vendor: filter.vendor === vendor ? '' : vendor })}>
        <ModelVendorIcon name={vendor} />
      </Button>
    </Tooltip>)}
  </div>;
}
