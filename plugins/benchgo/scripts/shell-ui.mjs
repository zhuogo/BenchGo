import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {build as esbuild} from 'esbuild';
const linkIcon = JSON.parse(await readFile(new URL('../client/assets/iconsax/catalog.json', import.meta.url), 'utf8')).link.linear.replace('<svg ', '<svg aria-hidden="true" ').replaceAll('width="24"', 'width="16"').replaceAll('height="24"', 'height="16"');
const once=(source,before,after)=>{if(source.split(before).length!==2)throw Error('Official shell changed: '+before.slice(0,80));return source.replace(before,after);};
export function shellUi(){return {name:'commander-shell-ui',setup(build){
  build.onLoad({filter:/ui-settings-general[\\/]src[\\/]client[\\/]SettingsRoot\.tsx$/},async({path})=>{
    let source=(await readFile(path,'utf8')).replaceAll('\r\n','\n');
    source=once(source,'className={css.overlay} role="presentation"', "className={css.overlay + ' cmd-settings-overlay'} role=\"presentation\"");
    // BenchGo owns the only update entry; connection recovery keeps its own row.
    source=once(source,'className={clsx(css.triggerRow, !wide && css.railRow)}', "className={clsx(css.triggerRow, !wide && css.railRow, 'cmd-sidebar-footer')}");
    const status=source.match(/        <ConnectionIndicator\n[\s\S]*?          t=\{t\} view=\{desktopUpdate\} onOpen=\{openDesktopUpdate\} \/>/u)?.[0];
    if(!status)throw Error('Official settings status controls changed');
    const connection=once(status.slice(0,status.indexOf('        <DesktopUpdateIndicator')).trimEnd(),
      "state={wide && desktopUpdate.presentation?.phase !== 'installing' ? connectionIndicator : undefined}",
      'state={wide ? connectionIndicator : undefined}');
    source=once(source,status,'');
    source=once(source,"import { DesktopUpdateIndicator } from './DesktopUpdateIndicator.tsx'\n",'');
    source=once(source,'useDesktopUpdate, openDesktopUpdate, useStore, actions, useShortcuts,','useStore, actions, useShortcuts,');
    source=once(source,'  const desktopUpdate = useDesktopUpdate(state => state)\n','');
    source=once(source,"        {renderSlot('settings.launcher', {", '        <div className="cmd-sidebar-status">\n'+connection+'\n        </div>\n'+"        {renderSlot('settings.launcher', {");
    source=once(source,'function navIcon(id: string) {',
      'function navIcon(id: string) {\n'+
      '  if (id === "link") return <span className={css.navIcon} style={{ display: "inline-flex", width: 16, height: 16 }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: '+JSON.stringify(linkIcon)+' }} />\n'+
      '  if (id === "harness-tools") return <svg className={css.navIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>\n'+
      '  if (id === "media") return <svg className={css.navIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" /></svg>\n'+
      '  if (id === "voice") return <svg className={css.navIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M3 10v4m4-7v10m5-14v18m5-14v10m4-7v4" /></svg>');
    return {contents:source,loader:'tsx',resolveDir:dirname(path)};
  });
  build.onLoad({filter:/ui-sidebar[\\/]src[\\/]client[\\/]SidebarRoot\.tsx$/},async({path})=>{
    let source=(await readFile(path,'utf8')).replaceAll('\r\n','\n');
    // Published Hosts can use the same release number before panel icons moved
    // into a Factory. Keep its registered Factory when present; the lazy
    // fallback only exercises the old owner's child slot on older Hosts.
    source=once(source,'  & PropsRenderFactories\n', "  & PropsRenderFactories\n  & PropsRenderSlots<'sidebar.panellist'>\n");
    source=once(source,'/** Each panel row subscribes only to its own selection state. */',
      "function LegacyPanelIcon({ id, size, active, renderSlot }: { id: string; size: number; active: boolean } & PropsRenderSlots<'sidebar.panellist'>) {\n"+
      "  return renderSlot('sidebar.panellist', { size, active }, { only: id })\n"+
      '}\n\n/** Each panel row subscribes only to its own selection state. */');
    source=once(source,'setPinned, trackEntryClick, renderFactorySlot,', 'setPinned, trackEntryClick, renderFactorySlot, renderSlot,');
    source=once(source,'  const active = usePanelInfo(info => info.activePanelId === id)',
      "  const active = usePanelInfo(info => info.activePanelId === id)\n"+
      '  const iconProps = { id, size: wide ? 16 : 18, active }\n'+
      '  const legacyIcon = <LegacyPanelIcon {...iconProps} renderSlot={renderSlot} />');
    source=once(source,"{renderFactorySlot('sidebar.panel.icon', { id, size: wide ? 16 : 18, active })}",
      "{renderFactorySlot?.('sidebar.panel.icon', iconProps, { fallback: legacyIcon }) ?? legacyIcon}");
    source=once(source,'                  renderFactorySlot={renderFactorySlot}',
      '                  renderFactorySlot={renderFactorySlot}\n                  renderSlot={renderSlot}');
    source=once(source,"import clsx from 'clsx'", "import { createPortal } from 'react-dom'\nimport clsx from 'clsx'");
    source=once(source,"  const toggleLabel = collapsed ? t('toggle.open') : t('toggle.collapse')", "  const [captionCollapsed, setCaptionCollapsed] = useState<boolean | null>(null)\n  useEffect(() => {\n    if (!document.documentElement.hasAttribute('data-windows-titlebar')) return\n    const sync = (event: Event) => { const value = (event as CustomEvent).detail?.collapsed; setCaptionCollapsed(typeof value === 'boolean' ? value : null) }\n    document.addEventListener('benchgo:desktop-sidebar-state', sync)\n    return () => document.removeEventListener('benchgo:desktop-sidebar-state', sync)\n  }, [])\n  const toggleLabel = (captionCollapsed ?? collapsed) ? t('toggle.open') : t('toggle.collapse')");
    source=once(source,'        onClick={() => { toggleSidebar() }}', "        onClick={() => {\n          if (windowsTitlebar && !document.dispatchEvent(new Event('benchgo:sidebar-toggle', { cancelable: true }))) return\n          toggleSidebar()\n        }}");
    // The one caption control must stay usable while a retained remote page
    // makes the local shell inert. Keep the official button, tooltip and action.
    source=once(source,'{!darwinDesktop && toggle}', '{!darwinDesktop && (windowsTitlebar ? createPortal(toggle, document.body) : toggle)}');
    source=once(source,'const wide = drawer || (windowsTitlebar ? !collapsed : !collapsed || !settled)','const wide = drawer || !collapsed');
    source=once(source,'style={wide ? { width: !drawer && collapsed ? lastWideWidth.current : width } : undefined}', "style={{ width: '100%', minWidth: 0 }}");
    source=once(source,'css.root, !wide && css.collapsed, !wide && animateRail.current && css.railIn,', "css.root, 'cmd-shell-sidebar', !wide && css.collapsed,");
    // The web rail centers this row with a transform. On Windows that would
    // contain the fixed caption toggle inside the clipped, zero-width sidebar.
    source=once(source,'<div className={css.logoRow} data-window-drag>',
      '<div className={css.logoRow} style={windowsTitlebar ? { transform: \'none\' } : undefined} data-window-drag>');
    // Keep official panel behavior, but let BenchGo place it after its quick
    // actions in the workspace slot. DOM and keyboard order stay identical.
    const panels=source.match(/          \{panels\.length > 0 && \(\n[\s\S]*?          \)\}\n(?=          <div className=\{css\.regionArea\}>)/u)?.[0];
    if(!panels)throw Error('Official sidebar panel navigation changed');
    const navigation=once(panels.trim().slice(1,-1),
      '<nav className={css.panelList}',
      '<nav className={css.panelList + \' cmd-sidebar-panels\'}');
    source=once(source,panels,'');
    source=once(source,'  return (\n    <div\n      ref={column}', '  const panelNavigation = (\n'+navigation+'\n  )\n\n  return (\n    <div\n      ref={column}');
    source=once(source,"            {renderSlot('sidebar.workspaces', {\n              wide,", "            {renderSlot('sidebar.workspaces', {\n              wide, panelNavigation,");
    return {contents:source,loader:'tsx',resolveDir:dirname(path)};
  });
  build.onLoad({filter:/ui-layout[\\/]src[\\/]client[\\/]AppFrame\.tsx$/},async({path})=>{
    let source=(await readFile(path,'utf8')).replaceAll('\r\n','\n');source=once(source,'className={css.frame}', "className={css.frame + ' cmd-shell-frame'}");
    source=once(source,'data-animating={animateTracks || undefined}', 'data-animating={animateTracks || undefined}\n      data-plus-shell');
    // Only the fullscreen right panel consumes this axis. Updating an inherited
    // variable on the frame invalidates styles throughout the conversation on
    // every pointer move, even though that content does not use the variable.
    source=once(source,'function RightbarColumn(props: { children?: ReactNode; inert: boolean })', 'function RightbarColumn(props: { children?: ReactNode; inert: boolean; sidebarWidth?: number })');
    source=once(source,'<div className={css.rightbarCol} data-rightbar-col', '<div className={css.rightbarCol} style={props.sidebarWidth === undefined ? undefined : { ...{ \'--dsh-windows-sidebar-width\': `${props.sidebarWidth}px` } }} data-rightbar-col');
    source=once(source,"        ...(windowsTitlebar\n          ? { '--dsh-windows-sidebar-width': `${cols.sidebar}px` } : {}),\n",'');
    source=once(source,'<RightbarColumn inert={drawerOpen}>', '<RightbarColumn inert={drawerOpen} sidebarWidth={windowsTitlebar ? cols.sidebar : undefined}>');
    return {contents:source,loader:'tsx',resolveDir:dirname(path)};
  });
  build.onLoad({filter:/(?:ui-layout|ui-sidebar|ui-settings-general)[\\/]src[\\/]client[\\/].*\.module\.css$/},async({path})=>{
    const result=await esbuild({stdin:{contents:'import styles from '+JSON.stringify(path)+'; export default styles;',resolveDir:dirname(path)},bundle:true,write:false,outdir:join(tmpdir(),'commander-shell-css-memory'),format:'cjs',loader:{'.css':'local-css'},logLevel:'silent'});
    const js=result.outputFiles.find(f=>f.path.endsWith('.js')),css=result.outputFiles.find(f=>f.path.endsWith('.css'));if(!js||!css)throw Error('Shell stylesheet failed');const module={exports:{}};new Function('module','exports',js.text)(module,module.exports);
    const id='commander-shell-'+path.split(/[\\/]/u).at(-1);return {loader:'js',contents:'const id='+JSON.stringify(id)+';if(!document.getElementById(id)){const style=document.createElement("style");style.id=id;style.textContent='+JSON.stringify(css.text)+';document.head.append(style);}export default '+JSON.stringify(module.exports.default)+';'};
  });
}};}
