import React from 'react';
import routerGoSvg from '../../../assets/brand/routergo.svg';
import brands from './assets/provider-brands/catalog.json';
import { providerBrand, providerInitial } from './provider-brand.mjs';
import { isRouterGo } from './provider-options.mjs';
import { routerGo } from '../shared/builtin-providers.mjs';
import { UIIcon } from './iconsax.jsx';

const vendorBrands = new Map(Object.entries({
  nvidia: 'nvidia', cohere: 'cohere', openai: 'openai', anthropic: 'anthropic',
  'mistral ai': 'mistral', google: 'google', deepseek: 'deepseek', 火山方舟: 'volcengine',
  '智谱 glm': 'zhipu', xai: 'xai', 腾讯: 'tencent', 'moonshot ai': 'kimi',
  蚂蚁百灵: 'bailing', xiaomi: 'xiaomimimo', minimax: 'minimax', meta: 'meta',
  amazon: 'amazon-bedrock', 阿里云百炼: 'qwen', perplexity: 'perplexity', 阶跃星辰: 'stepfun',
  poolside: 'poolside', inception: 'inception', 'liquid ai': 'liquid',
}));

export function ModelVendorIcon({ name }) {
  const src = brands[vendorBrands.get(name.toLowerCase())];
  return src
    ? <img className="cmd-model-vendor-icon" src={src} alt="" width={16} height={16} draggable={false} />
    : <UIIcon name="box" size={16} />;
}

export function ProviderBrandIcon({ id, name, declared = false, size: preferredSize = 20 }) {
  const brand = providerBrand(id, declared), src = brand === 'routergo' ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(routerGoSvg) : brands[brand];
  const size = brand === 'routergo' && preferredSize !== 16 ? preferredSize + 8 : preferredSize;
  return <span className="cmd-provider-brand" data-provider-brand={brand || 'custom'} aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: size, height: size, verticalAlign: 'middle' }}>{src ? <img src={src} alt="" width={size} height={size} draggable={false} style={{ display: 'block', width: size, height: size, objectFit: 'contain', filter: 'none' }} /> : <span className="cmd-provider-brand-initial" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: 5, background: 'var(--dsw-alias-interactive-bg-hover, #8881)', fontSize: Math.max(11, size * .6), fontWeight: 600, lineHeight: 1 }}>{providerInitial(name, id)}</span>}</span>;
}

export function providerOption({ id, name = id, declared, reason, disabled }) {
  const pinned = isRouterGo(id);
  const label = pinned ? routerGo.name : name;
  return { value: id, label, icon: <ProviderBrandIcon id={id} name={label} declared={declared} />, pinned, detail: reason, disabled };
}
