import React, { useEffect, useId, useState } from 'react';
import { SkillsLibrary } from './skills-library.jsx';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import { readJsonResponse } from './http-response.mjs';
import css from './tools-page.css';

async function skillsApi(action, args = {}, signal) {
  const url = new URL('api/commander/assistant', document.baseURI);
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }), signal });
  if (response.status === 404 || response.status === 503) throw new Error('技能服务不可用，请在插件中启用 SuperAgent 后重试。');
  return readJsonResponse(response, url);
}

export function ToolsPage({ OfficialPage, ...props }) {
  const [tab, setTab] = useState('plugins');
  const panelId = useId();
  const view = props.useStore(state => state.view);
  // A cross-plugin deep link must reveal the official destination even from Skills.
  useEffect(() => { setTab('plugins'); }, [view]);
  return <section className="bg-tools-page"><style>{css}</style>
    <header className="bg-tools-header"><h1>工具</h1><SegmentedControl options={[{ value: 'plugins', label: '插件' }, { value: 'skills', label: '技能' }]} value={tab} onChange={setTab} label="工具分类" panelId={panelId} /></header>
    <div className="bg-tools-content" id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${tab}`}>
      <div className="bg-tools-official" hidden={tab !== 'plugins'}><OfficialPage {...props} /></div>
      {tab === 'skills' && <div className="bg-tools-skills"><SkillsLibrary ownedApi={skillsApi} /></div>}
    </div>
  </section>;
}

export function mountToolsPage(ctx) {
  ctx.effect(() => {
    const entry = ctx.slots.entries('main').find(item => item.options?.key === 'plugins');
    if (!entry) throw new Error('Official plugin manager entry is unavailable');
    const original = entry.component;
    const wrapped = props => <ToolsPage {...props} OfficialPage={original} />;
    entry.component = wrapped;
    return () => { if (entry.component === wrapped) entry.component = original; };
  });
}
