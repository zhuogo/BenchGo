import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Menu} from '@deepseek-ai/dsh-client-ui-primitives';
import {Tooltip} from '../../shared/client/ui/tooltip.jsx';
import {Loading} from '../../shared/client/ui/loading.jsx';
import {UIIcon} from '../../benchgo/client/iconsax.jsx';
import {deviceStatus,workbenchUrl} from './device-state.mjs';
import {deviceLauncherMode} from './device-navigation.mjs';
import {deviceRequest,normalizeScope,scopeDevices,resourceKey,readResourcePages,mergeResourcePage} from './resource-state.mjs';

export function useResourceNavigation(enabled,showArchived){
  enabled=enabled&&deviceLauncherMode()!=='remote';
  const [scope,setScope]=useState(normalizeScope()),[devices,setDevices]=useState([]),[activeId,setActiveId]=useState('local'),[pages,setPages]=useState({}),[error,setError]=useState(''),[saving,setSaving]=useState(false),[ready,setReady]=useState(false),[revision,setRevision]=useState(0);
  const generation=useRef(0),draft=useRef(null),identities=useRef(new Map()),touched=useRef(false),pageRef=useRef({}),requests=useRef(new Map()),deviceVersion=useRef(0);
  const updatePages=update=>{const value=update(pageRef.current);pageRef.current=value;setPages(value);};
  const updateDevices=value=>{
    const next=value.devices||[];
    // Observation timestamps change on every read; unchanged labels need no render.
    const stable=rows=>JSON.stringify(rows.map(({observedAt,...row})=>row));
    setDevices(old=>stable(old)===stable(next)?old:next);
    setActiveId(next.find(device=>device.kind==='local')?.id||'local');
  };
  useEffect(()=>{
    if(!enabled)return;
    const controller=new AbortController();let valid=true,version=0;
    const read=async()=>{
      const current=++version,deviceRead=++deviceVersion.current;
      try{
        const result=await deviceRequest('devices',{},controller.signal);
        if(!valid||current!==version)return;
        if(deviceRead===deviceVersion.current)updateDevices(result);
        const config=await deviceRequest('resourceScope',{},controller.signal);
        if(valid&&current===version){if(!touched.current)setScope(normalizeScope(config.scope));setReady(true);setError('');}
      }catch(e){if(valid&&current===version&&!controller.signal.aborted){setError(e.message);setReady(true);}}
    };
    void read();document.addEventListener('benchgo:devices-changed',read);
    return()=>{valid=false;controller.abort();document.removeEventListener('benchgo:devices-changed',read);};
  },[enabled,revision]);
  const selected=enabled?scopeDevices(scope,devices,activeId):[],remote=selected.filter(d=>d.id!==activeId),signature=JSON.stringify(remote.map(d=>[d.id,d.hostId,d.authorizationId]));
  useEffect(()=>{
    if(!enabled||!ready)return;
    const id=++generation.current;
    let disposed=false,running=false,rerun=false,timer,controller;
    const changed=new Set(remote.filter(device=>identities.current.has(device.id)&&identities.current.get(device.id)!==JSON.stringify([device.hostId,device.authorizationId])).map(device=>device.id));
    identities.current=new Map(remote.map(device=>[device.id,JSON.stringify([device.hostId,device.authorizationId])]));
    updatePages(old=>Object.fromEntries(Object.entries(old).filter(([key])=>remote.some(d=>key.startsWith(d.id+'\0')&&!changed.has(d.id)))));
    const load=async(device,kind,signal)=>{
      const key=device.id+'\0'+kind;
      if(requests.current.has(key)||signal.aborted)return;
      const request=new AbortController(),bounded=AbortSignal.any([signal,request.signal]);
      requests.current.set(key,request);
      const previous=pageRef.current[key];
      updatePages(old=>({...old,[key]:{...old[key],loading:!Array.isArray(old[key]?.items),refreshing:true}}));
      try{
        const page=await readResourcePages(deviceRequest,{deviceId:device.id,kind,archived:showArchived},previous?.items?.length,bounded);
        if(!bounded.aborted&&id===generation.current)updatePages(old=>({...old,[key]:mergeResourcePage(old[key],page)}));
      }catch(e){
        if(!bounded.aborted&&id===generation.current)updatePages(old=>({...old,[key]:mergeResourcePage(old[key],{...old[key],available:false,code:'QUERY_FAILED',reason:e.message})}));
      }finally{
        if(requests.current.get(key)===request){
          requests.current.delete(key);
          if(id===generation.current)updatePages(old=>({...old,[key]:{...old[key],loading:false,refreshing:false}}));
        }
      }
    };
    const refresh=async()=>{
      clearTimeout(timer);
      if(disposed||document.hidden||!remote.length)return;
      if(running)return;
      running=true;controller=new AbortController();const signal=controller.signal;
      try{
        let cursor=0;const jobs=remote.flatMap(device=>['projects','recent'].map(kind=>[device,kind]));
        await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{while(cursor<jobs.length&&!signal.aborted){const [device,kind]=jobs[cursor++];await load(device,kind,signal);}}));
        if(!signal.aborted&&id===generation.current){
          const version=++deviceVersion.current,result=await deviceRequest('devices',{},signal);
          if(!signal.aborted&&id===generation.current&&version===deviceVersion.current)updateDevices(result);
        }
      }catch{
        // Per-device reads retain their own errors; a failed status read must not erase them.
      }finally{
        running=false;
        if(!disposed&&!document.hidden){if(rerun){rerun=false;void refresh();}else timer=setTimeout(refresh,30000);}
      }
    };
    const visibility=()=>{
      if(document.hidden){clearTimeout(timer);controller?.abort();requests.current.forEach(request=>request.abort());}
      else if(running){if(controller?.signal.aborted)rerun=true;}
      else void refresh();
    };
    void refresh();document.addEventListener('visibilitychange',visibility);
    return()=>{disposed=true;generation.current++;clearTimeout(timer);controller?.abort();requests.current.forEach(request=>request.abort());requests.current.clear();document.removeEventListener('visibilitychange',visibility);};
  },[enabled,ready,signature,showArchived,revision]);
  const save=async value=>{touched.current=true;setReady(true);draft.current=normalizeScope(value);setScope(draft.current);setSaving(true);setError('');try{const result=await deviceRequest('setResourceScope',{scope:draft.current});setScope(normalizeScope(result.scope||draft.current));draft.current=null;}catch(e){setError('显示范围未保存：'+e.message);}finally{setSaving(false);}};
  const more=async(device,kind)=>{
    const version=generation.current,key=device.id+'\0'+kind,previous=pageRef.current[key];
    if(document.hidden||requests.current.has(key)||!previous?.hasMore)return;
    const controller=new AbortController();requests.current.set(key,controller);
    updatePages(old=>({...old,[key]:{...old[key],loading:true,refreshing:true}}));
    try{
      const value=await deviceRequest('resources',{deviceId:device.id,kind,offset:previous.items?.length||0,limit:30,archived:showArchived},controller.signal);
      const page=value.devices?.[0];
      if(!page||!Array.isArray(page.items))throw Error('设备资源响应无效');
      if(!controller.signal.aborted&&version===generation.current)updatePages(old=>({...old,[key]:mergeResourcePage(old[key],page,true)}));
    }catch(e){if(!controller.signal.aborted&&version===generation.current)updatePages(old=>({...old,[key]:mergeResourcePage(old[key],{...old[key],available:false,code:'QUERY_FAILED',reason:e.message})}));}
    finally{
      if(requests.current.get(key)===controller){requests.current.delete(key);if(version===generation.current)updatePages(old=>({...old,[key]:{...old[key],loading:false,refreshing:false}}));}
    }
  };
  return {enabled,scope:enabled?scope:normalizeScope(),devices,activeId,selected,remote,pages,error:enabled?error:'',saving,ready,save,more,retry:()=>setRevision(v=>v+1),showLocal:!enabled||scope.mode==='current'||selected.some(d=>d.id===activeId)};
}
export function ResourceScope({navigation:n}){const [open,setOpen]=useState(false);return <div className="cmd-resource-scope"><Menu className="cmd-resource-scope-anchor" open={open} onClose={()=>setOpen(false)} portal autoFocus compact listClassName="cmd-resource-scope-menu" items={[{type:'label',id:'heading',text:'项目与最近 · 显示范围'},...['current','all','selected'].map((id,i)=>({id,disabled:n.saving,label:['当前设备（工作台主机）','所有已连接设备','指定设备'][i],icon:<span aria-hidden="true">{n.scope.mode===id?'✓':''}</span>}))]} onSelect={mode=>{void n.save({...n.scope,mode});if(mode!=='selected')setOpen(false);}} anchor={<Tooltip label={'显示范围：'+({current:'当前设备',all:'所有已连接设备',selected:'指定设备'})[n.scope.mode]}><button type="button" aria-label="显示范围" aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(!open)}><UIIcon name="filter" size={16}/><span className="cmd-resource-scope-label">显示</span></button></Tooltip>}>
  {n.scope.mode==='selected'&&<div className="cmd-resource-devices">{n.devices.map(device=><label key={device.id}><input type="checkbox" checked={n.scope.deviceIds.includes(device.id)} disabled={n.saving} onChange={event=>void n.save({...n.scope,deviceIds:event.target.checked?[...n.scope.deviceIds,device.id]:n.scope.deviceIds.filter(id=>id!==device.id)})}/><span>{device.name}</span>{deviceStatus(device)&&<small>{deviceStatus(device)}</small>}</label>)}</div>}
  </Menu>{n.error&&<span className="cmd-resource-save-error" role="alert">{n.error}<button type="button" disabled={n.saving} onClick={()=>void n.save(n.scope)}>重试保存</button></span>}</div>;}
export function ResourceDeviceState({navigation:n,device,kind,hideEmpty=false}){const page=n.pages[device.id+'\0'+kind];return <>{!page||(page.loading&&!Array.isArray(page.items))?<Loading compact label={'正在读取 '+device.name+'…'}/>:null}{page?.available===false&&<div className="cmd-resource-warning" role="alert">{page.reason||'设备资源暂不可用'}{page.freshness==='stale'&&<span> · 上次结果 · {new Date(page.observedAt).toLocaleString()}</span>}<button type="button" disabled={page.refreshing} onClick={n.retry}>重试</button><button type="button" onClick={()=>document.querySelector('.dsh-device-launcher')?.click()}>设备中心</button></div>}{!hideEmpty&&page?.available&&page.items?.length===0&&<p className="cmd-sidebar-empty">{kind==='projects'?'暂无项目':'暂无最近对话'}</p>}{page?.hasMore&&<button type="button" className="cmd-resource-more" disabled={page.loading||page.refreshing} onClick={()=>void n.more(device,kind)}>加载更多 · {device.name}</button>}</>;}
export function RemoteProjects({navigation:n,filter,onOpen,archived}) {
  const [expanded,setExpanded]=useState({}),[sessions,setSessions]=useState({});
  const generation=useRef(0),requests=useRef(new Map());
  useEffect(()=>{generation.current++;setSessions({});setExpanded({});return()=>{generation.current++;requests.current.forEach(controller=>controller.abort());requests.current.clear();};},[JSON.stringify(n.remote.map(d=>[d.id,d.hostId,d.authorizationId])),archived]);
  const load=async(device,p,retry=false)=>{
    const key=resourceKey(p);setExpanded(v=>({...v,[key]:retry||!v[key]}));if(expanded[key]&&!retry)return;
    requests.current.get(key)?.abort();const controller=new AbortController(),version=generation.current;requests.current.set(key,controller);
    setSessions(v=>({...v,[key]:{loading:true}}));
    try{const result=await deviceRequest('resources',{deviceId:device.id,kind:'sessions',projectId:p.resourceId||p.id,offset:0,limit:30,archived},controller.signal);if(!controller.signal.aborted&&version===generation.current)setSessions(v=>({...v,[key]:result.devices[0]}));}
    catch(e){if(!controller.signal.aborted&&version===generation.current)setSessions(v=>({...v,[key]:{reason:e.message,available:false}}));}
    finally{if(requests.current.get(key)===controller)requests.current.delete(key);}
  };
  return n.remote.map(device=><div className="cmd-resource-group" key={device.id}><button type="button" className="cmd-resource-group-title" data-device-available={n.pages[device.id+'\0projects']?.available===true} aria-expanded={expanded[device.id]!==false} onClick={()=>setExpanded(v=>({...v,[device.id]:v[device.id]===false}))}><UIIcon name="computer" size={13}/><span>{device.name}</span>{deviceStatus(device)&&<small>{deviceStatus(device)}</small>}</button>{expanded[device.id]!==false&&<><ResourceDeviceState navigation={n} device={device} kind="projects"/>{(n.pages[device.id+'\0projects']?.items||[]).filter(p=>!p.isDefault&&(!filter||(p.title||p.name||'').toLowerCase().includes(filter.toLowerCase()))).map(p=>{const key=resourceKey(p),page=sessions[key];return <div className="cmd-project" key={key}><div className="cmd-project-name"><Tooltip label={device.name+' · '+(p.path||p.title)}><button type="button" onClick={()=>onOpen(device,{kind:'projects',resourceId:p.resourceId||p.id})}><UIIcon name="folder" size={16}/><span>{p.title||p.name||p.path}</span></button></Tooltip><button type="button" aria-label={'展开 '+device.name+' 的 '+(p.title||p.name)+' 对话'} aria-expanded={!!expanded[key]} onClick={()=>void load(device,p)}><UIIcon name="chevronDown" size={12}/></button>{!archived&&<button type="button" className="cmd-project-new" aria-label={'在 '+device.name+' 的 '+(p.title||p.name)+' 新聊天'} onClick={()=>onOpen(device,{kind:'projects',resourceId:p.resourceId||p.id,intent:'newSession'})}><UIIcon name="plus" size={16}/></button>}</div>{expanded[key]&&<div className="cmd-project-children">{page?.loading?<Loading compact label="正在读取对话…"/>:page?.available===false?<p role="alert">{page.reason}<button type="button" onClick={()=>void load(device,p,true)}>重试</button></p>:<>{(page?.items||[]).filter(row=>!!row.archived===archived).map(row=><div className="cmd-session-row" key={resourceKey(row)}><button type="button" className="cmd-session" onClick={()=>onOpen(device,{kind:'sessions',resourceId:row.resourceId||row.id,native:row.native===true})}><UIIcon name="chat" size={16}/><span>{row.title||'新对话'}</span></button></div>)}{!page?.items?.length&&<p className="cmd-sidebar-empty">还没有对话</p>}{page?.hasMore&&<button type="button" onClick={()=>onOpen(device,{kind:'projects',resourceId:p.resourceId||p.id})}>在目标工作台查看全部对话</button>}</>}</div>}</div>;})}</>}</div>);
}
/** Keep one flat candidate list; the sidebar sorts local and remote rows together once. */
export function remoteRecentRows(n,filter,archived){return n.remote.flatMap(device=>(n.pages[device.id+'\0recent']?.items||[]).filter(row=>!!row.archived===archived&&(!filter||(row.title||'').toLowerCase().includes(filter.toLowerCase()))).map(row=>({...row,device,deviceId:device.id,remote:true})));}

/** The owner retains its original view and draft while a target's existing workbench renders. */
export function ResourceStage({ target, onClose }) {
  const frame = useRef(null), receiverReady = useRef(false);
  const [entry, setEntry] = useState(null), [ready, setReady] = useState(false), [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0), [container, setContainer] = useState(null);
  const deviceId = target?.device.id;
  const url = entry?.deviceId === deviceId && entry?.attempt === attempt ? entry.url : '';
  useEffect(() => {
    const close = () => onClose();
    const events = ['benchgo:workbench-selected', 'benchgo:assistant-thread', 'benchgo:assistant-tab'];
    events.forEach(name => document.addEventListener(name, close));
    return () => events.forEach(name => document.removeEventListener(name, close));
  }, [onClose]);
  useEffect(() => setContainer(document.querySelector('.cmd-shell-frame [class*="centerCol"]') || document.querySelector('main')), []);
  // Keep the live document when selecting another resource on the same device.
  // An entry ticket is single-use; only explicit retry or a different device reloads it.
  useEffect(() => {
    receiverReady.current = false; setReady(false); setEntry(null); setError('');
    if (!deviceId) return;
    const controller = new AbortController();
    void deviceRequest('select', { deviceId }, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])).then(value => {
      if (controller.signal.aborted) return;
      const next = new URL(workbenchUrl(value.url, location.origin));
      next.hash = new URLSearchParams({ resourceParentOrigin: location.origin }).toString();
      setEntry({ deviceId, attempt, url: next.href });
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [deviceId, attempt]);
  useEffect(() => {
    if (!url || !target) return;
    setReady(false); setError('');
    const origin = new URL(url).origin;
    const send = () => frame.current?.contentWindow?.postMessage({ type: 'benchgo:resource:open', resource: target.resource, requestId: target.requestId }, origin);
    const timeout = setTimeout(() => setError('目标工作台未响应，请重试或在设备中心检查连接与版本'), 15_000);
    const receive = event => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
      if (event.data?.type === 'benchgo:resource:ready') { receiverReady.current = true; send(); }
      if (event.data?.type === 'benchgo:resource:opened' && event.data.requestId === target.requestId) {
        clearTimeout(timeout); setReady(true); setError(event.data.error || '');
      }
    };
    window.addEventListener('message', receive);
    if (receiverReady.current) send();
    return () => { clearTimeout(timeout); window.removeEventListener('message', receive); };
  }, [url, target]);
  useEffect(() => {
    if (!target || !container) return;
    const children = [...container.children].filter(node => !node.classList.contains('cmd-resource-stage'));
    const prior = children.map(node => node.hasAttribute('inert'));
    children.forEach(node => node.setAttribute('inert', ''));
    return () => children.forEach((node, index) => { if (!prior[index]) node.removeAttribute('inert'); });
  }, [target, container]);
  if (!target || !container) return null;
  return createPortal(<div className="cmd-resource-stage">
    {url && <iframe ref={frame} src={url} title={target.device.name + '的资源'} allow="clipboard-read; clipboard-write; microphone" referrerPolicy="no-referrer" onLoad={() => {
      receiverReady.current = false;
      frame.current?.contentWindow?.postMessage({ type: 'benchgo:resource:probe' }, new URL(url).origin);
    }} />}
    <div className="cmd-resource-stage-status" hidden={ready && !error}>{error ? <><p role="alert">{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></> : <Loading label="正在打开远端资源…" />}</div>
  </div>, container);
}

export function installResourceReceiver(host, { open, newSession, addProject, projectApi }) {
  const origin = new URLSearchParams(location.hash.slice(1)).get('resourceParentOrigin');
  if (window.parent === window || !origin) return;
  try {
    const parent = new URL(origin);
    if (!['http:', 'https:', 'dsh-app:'].includes(parent.protocol) || (parent.origin !== origin && 'dsh-app://' + parent.host !== origin)) return;
  } catch { return; }
  let disposed = false, pending = Promise.resolve();
  const requests = new Map(), projectRequests = new Map(), cancellations = new Set();
  const projectActions = typeof projectApi === 'function' ? ['browse', 'project', 'clone'] : [];
  const loadedValue = async (list, pick, label) => {
    const find = () => pick(list.getSnapshot());
    const project = find();
    if (project || list.getSnapshot().phase === 'ready') return project;
    return new Promise((resolve, reject) => {
      let stop = () => {};
      const finish = (error, value) => { clearTimeout(timer); stop(); cancellations.delete(cancel); error ? reject(error) : resolve(value); };
      const cancel = () => finish(Error('工作台已关闭'));
      const timer = setTimeout(() => finish(Error(label + '仍在加载，请重试')), 10_000);
      const read = () => {
        const value = find(), snapshot = list.getSnapshot();
        if (value || snapshot.phase === 'ready') finish(null, value);
        else if (snapshot.error) finish(Error(snapshot.error.message || label + '加载失败，请重试'));
      };
      cancellations.add(cancel); stop = list.subscribe(read); read();
    });
  };
  const openSession = async id => {
    const exists = await loadedValue(host.sessions.list, snapshot => snapshot.ids.includes(id), '会话列表');
    if (disposed) throw Error('工作台已关闭');
    if (!exists) throw Error('会话不可用，请刷新后重试');
    host.uiWorkspace.openSession(id);
  };
  const ready = () => {
    document.documentElement.setAttribute('data-resource-embedded', '');
    window.parent.postMessage({ type: 'benchgo:resource:ready', projectActions }, origin);
  };
  const receive = event => {
    if (event.source !== window.parent || event.origin !== origin) return;
    if (event.data?.type === 'benchgo:resource:probe') { ready(); return; }
    if (event.data?.type === 'benchgo:project:call') {
      const { action, args, requestId } = event.data;
      if (typeof requestId !== 'string' || requestId.length > 200) return;
      if (!projectRequests.has(requestId)) {
        if (projectRequests.size >= 128) {
          const retired = [...projectRequests].find(([, entry]) => entry.done);
          if (retired) projectRequests.delete(retired[0]);
          else { window.parent.postMessage({ type: 'benchgo:project:result', requestId, error: '项目操作繁忙，请稍后重试' }, origin); return; }
        }
        const entry = { done: false };
        entry.promise = Promise.resolve().then(async () => {
          if (disposed) throw Error('工作台已关闭');
          if (!projectActions.includes(action)) throw Error('目标不支持此项目操作，请更新 BenchGo');
          const input = action === 'clone' ? { url: args?.url } : args?.path === undefined ? {} : { path: args.path };
          return { type: 'benchgo:project:result', requestId, value: await projectApi(action, input) };
        }).catch(reason => ({ type: 'benchgo:project:result', requestId, error: reason.message })).finally(() => { entry.done = true; });
        projectRequests.set(requestId, entry);
      }
      void projectRequests.get(requestId).promise.then(result => { if (!disposed) window.parent.postMessage(result, origin); });
      return;
    }
    if (event.data?.type !== 'benchgo:resource:open' || typeof event.data.requestId !== 'string') return;
    const { resource, requestId } = event.data;
    if (!resource || !['projects', 'sessions'].includes(resource.kind)) return;
    if (!requests.has(requestId)) {
      const operation = pending.then(async () => {
        try {
          if (disposed) throw Error('工作台已关闭');
          if (resource.intent === 'addProject') addProject();
          else if (resource.intent === 'newSession') await newSession(resource.resourceId);
          else if (resource.kind === 'sessions') {
            if (resource.native) await open(resource.resourceId);
            else await openSession(resource.resourceId);
          } else {
            const project = await loadedValue(host.workspaces.list, snapshot => snapshot.items.find(item => (item.workspaceId || item.id) === resource.resourceId), '项目列表');
            if (disposed) throw Error('工作台已关闭');
            if (!project) throw Error('项目不可用，请刷新后重试');
            const id = project.sessionIds?.[0];
            if (id) await openSession(id);
            else await newSession(resource.resourceId);
          }
          return { type: 'benchgo:resource:opened', requestId };
        } catch (reason) { return { type: 'benchgo:resource:opened', requestId, error: reason.message }; }
      });
      pending = operation;
      requests.set(requestId, operation);
      if (requests.size > 128) requests.delete(requests.keys().next().value);
    }
    void requests.get(requestId).then(result => { if (!disposed) window.parent.postMessage(result, origin); });
  };
  window.addEventListener('message', receive);
  // The official shell can finish loading before this async sidebar mounts.
  // Announce readiness here, so a one-shot onLoad probe cannot be lost.
  ready();
  return () => { disposed = true; cancellations.forEach(cancel => cancel()); window.removeEventListener('message', receive); };
}
