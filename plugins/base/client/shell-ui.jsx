import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { mountToolsPage } from './tools-page.jsx';
import { AppFrame } from '../../../deepseek-harness/packages/client/ui-layout/src/client/AppFrame.tsx';
import { createResponsiveLayoutActions, mobileLayoutSnapshot, subscribeMobileLayout } from './responsive-layout.mjs';
import { SidebarRoot } from '../../../deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.tsx';
import { SettingsRoot } from '../../../deepseek-harness/packages/client/ui-settings-general/src/client/SettingsRoot.tsx';
import { SETTINGS_SHELL_SLOT, findSettingsShell } from './settings-shell.mjs';
/** Reversible views retain the official owner's stores, injections and child-slot declarations. */
export function recentTranslation(locale,original){return function(namespace,key,params){return key==='workspace.defaultName'?(locale.getLocale().active==='zh'?'最近':'Recent'):original.call(this,namespace,key,params);};}

function ResponsiveAppFrame(props) {
  const actions = useMemo(() => createResponsiveLayoutActions(props.actions), [props.actions]);
  const mobileNavigation = useSyncExternalStore(subscribeMobileLayout, mobileLayoutSnapshot);
  const [resourceEmbedded, setResourceEmbedded] = useState(() => document.documentElement.hasAttribute('data-resource-embedded'));
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setResourceEmbedded(root.hasAttribute('data-resource-embedded'));
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-resource-embedded'] });
    sync();
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => actions.dispose(), [actions]);
  return <AppFrame {...props} actions={actions} resourceEmbedded={resourceEmbedded} mobileNavigation={mobileNavigation} />;
}

function HiddenNativeUpdateBadge() { return null; }

function watchOfficialView(slots, name, find, component) {
  let current, original;
  const restore = () => {
    if (current?.component === component) current.component = original;
  };
  const update = () => {
    const next = find(slots);
    if (next === current) return;
    restore();
    current = next;
    original = next?.component;
    if (next) next.component = component;
  };
  update();
  const unsubscribe = slots.subscribe(name, update);
  return () => { unsubscribe(); restore(); };
}

function SkipPreviewNotice({ complete }) {
  const completed = useRef(false);
  useEffect(() => {
    if (completed.current) return;
    completed.current = true;
    complete();
  }, [complete]);
  return null;
}

export function mountShellUi(ctx){
  mountToolsPage(ctx);
  // The native shell already omits this browser onboarding step.
  if (!('dshDesktop' in globalThis)) {
    ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
      name: 'settings.onboarding', id: 'welcome-notice', order: -100, priority: -10,
    }, SkipPreviewNotice));
  }
  for(const [name,owns,component] of [['root','sidebar',ResponsiveAppFrame],['sidebar','sidebar.workspaces',SidebarRoot]])ctx.effect(()=>{
    const entry=ctx.slots.entries(name).find(item=>item.children?.[owns]);if(!entry)throw Error('Official shell entry is unavailable: '+name);
    const original=entry.component;entry.component=component;return ()=>{if(entry.component===component)entry.component=original;};
  });
  // The official settings shell can arrive after the client's access policy.
  ctx.effect(() => watchOfficialView(ctx.slots, SETTINGS_SHELL_SLOT, findSettingsShell, SettingsRoot));
  // The settings owner also registers a rail badge for the same native update.
  // Hide that specific registration, preserving unrelated badges and its service.
  const badgeSlot = 'sidebar.toggle.badge';
  ctx.effect(() => watchOfficialView(ctx.slots, badgeSlot,
    slots => slots.entries(badgeSlot).find(entry => entry.locale === 'settings'), HiddenNativeUpdateBadge));
  // Preserve the official stable bound translators, including already-mounted views.
  ctx.effect(()=>{
    const locale=ctx.locale,original=locale.translate;
    if(typeof original!=='function')throw Error('Official locale translation adapter is unavailable');
    const translate=recentTranslation(locale,original);
    locale.translate=translate;return ()=>{if(locale.translate===translate)locale.translate=original;};
  });
}
