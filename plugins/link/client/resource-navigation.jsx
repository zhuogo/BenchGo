import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Menu} from '@deepseek-ai/dsh-client-ui-primitives';
import {Tooltip} from '../../shared/client/ui/tooltip.jsx';
import {Loading} from '../../shared/client/ui/loading.jsx';
import {UIIcon} from '../../benchgo/client/iconsax.jsx';
import {deviceStatus,workbenchUrl} from './device-state.mjs';
import {deviceLauncherMode} from './device-navigation.mjs';
import {deviceRequest,normalizeScope,scopeDevices,resourceKey,readResourcePages,mergeResourcePage,sortResourceRecents,sessionActionAccess,canRetryResource,resourceRetryDelay,resourceQueryFailure} from './resource-state.mjs';

export function useResourceNavigation(enabled,showArchived){
  enabled=enabled&&deviceLauncherMode()!=='remote';
  const [scope,setScope]=useState(normalizeScope()),[devices,setDevices]=useState([]),[activeId,setActiveId]=useState('local'),[pages,setPages]=useState({}),[error,setError]=useState(''),[saveError,setSaveError]=useState(''),[saving,setSaving]=useState(false),[ready,setReady]=useState(false),[revision,setRevision]=useState(0);
  const generation=useRef(0),draft=useRef(null),identities=useRef(new Map()),touched=useRef(false),pageRef=useRef({}),requests=useRef(new Map()),deviceVersion=useRef(0),archiveView=useRef(showArchived);
  const [connecting,setConnecting]=useState(false);
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
    const controller=new AbortController();let valid=true,running=false,rerun=false,timer,attempt=0,discovered=false,deferred=false,activeRequest;
    const read=async()=>{
      clearTimeout(timer);
      if(!valid)return;
      if(document.hidden){deferred=true;return;}
      if(running){rerun=true;return;}
      running=true;deferred=false;const request=new AbortController();activeRequest=request;
      const deviceRead=++deviceVersion.current,signal=AbortSignal.any([controller.signal,request.signal,AbortSignal.timeout(15000)]);
      try{
        const result=await deviceRequest('devices',{},signal);
        if(!valid)return;
        if(deviceRead===deviceVersion.current)updateDevices(result);
        const config=await deviceRequest('resourceScope',{},signal);
        if(valid){if(!touched.current)setScope(normalizeScope(config.scope));setReady(true);setError('');setConnecting(false);attempt=0;discovered=true;}
      }catch(e){if(valid&&!controller.signal.aborted&&!request.signal.aborted){const retry=canRetryResource(resourceQueryFailure(e));setError(e.message);setConnecting(retry);setReady(true);if(retry)timer=setTimeout(read,resourceRetryDelay(++attempt));}}
      finally{running=false;if(valid&&rerun){rerun=false;void read();}}
    };
    const visible=()=>{if(document.hidden){clearTimeout(timer);if(running){deferred=true;activeRequest?.abort();}}else if(!discovered||attempt||deferred)void read();};
    void read();document.addEventListener('benchgo:devices-changed',read);document.addEventListener('visibilitychange',visible);window.addEventListener('online',read);
    return()=>{valid=false;clearTimeout(timer);controller.abort();document.removeEventListener('benchgo:devices-changed',read);document.removeEventListener('visibilitychange',visible);window.removeEventListener('online',read);};
  },[enabled,revision]);
  const selected=enabled?scopeDevices(scope,devices,activeId):[],remote=selected.filter(d=>d.id!==activeId),signature=JSON.stringify(remote.map(d=>[d.id,d.hostId,d.authorizationId]));
  useEffect(()=>{
    if(!enabled||!ready)return;
    const id=++generation.current;
    let disposed=false,running=false,rerun=false,timer,controller;
    const schedule=new Map();
    const changed=new Set(remote.filter(device=>identities.current.has(device.id)&&identities.current.get(device.id)!==JSON.stringify([device.hostId,device.authorizationId])).map(device=>device.id));
    const archiveChanged=archiveView.current!==showArchived;archiveView.current=showArchived;
    identities.current=new Map(remote.map(device=>[device.id,JSON.stringify([device.hostId,device.authorizationId])]));
    updatePages(old=>Object.fromEntries(Object.entries(old).filter(([key])=>(!archiveChanged||!key.endsWith('\0recent'))&&remote.some(d=>key.startsWith(d.id+'\0')&&!changed.has(d.id)))));
    const load=async(device,kind,signal)=>{
      const key=device.id+'\0'+kind;
      if(requests.current.has(key)||signal.aborted)return;
      const request=new AbortController(),bounded=AbortSignal.any([signal,request.signal,AbortSignal.timeout(15000)]);
      requests.current.set(key,request);
      const previous=pageRef.current[key];
      updatePages(old=>({...old,[key]:{...old[key],loading:!Array.isArray(old[key]?.items),refreshing:true}}));
      try{
        const page=await readResourcePages(deviceRequest,{deviceId:device.id,kind,archived:showArchived},previous?.items?.length,bounded);
        if(!bounded.aborted&&id===generation.current){
          const attempt=page.available?0:(schedule.get(key)?.attempt||0)+1;
          schedule.set(key,{attempt,next:page.available?Date.now()+30000:canRetryResource(page)?Date.now()+resourceRetryDelay(attempt):Infinity});
          updatePages(old=>({...old,[key]:mergeResourcePage(old[key],page)}));
        }
      }catch(e){
        if(!signal.aborted&&!request.signal.aborted&&id===generation.current){
          const page=resourceQueryFailure(e),attempt=(schedule.get(key)?.attempt||0)+1;
          schedule.set(key,{attempt,next:canRetryResource(page)?Date.now()+resourceRetryDelay(attempt):Infinity});
          updatePages(old=>({...old,[key]:mergeResourcePage(old[key],page)}));
        }
      }finally{
        if(requests.current.get(key)===request){
          requests.current.delete(key);
          if(id===generation.current)updatePages(old=>({...old,[key]:{...old[key],loading:false,refreshing:false}}));
        }
      }
    };
    const refresh=async(force=true)=>{
      clearTimeout(timer);
      if(disposed||document.hidden||!remote.length)return;
      if(running)return;
      running=true;controller=new AbortController();const signal=controller.signal;
      try{
        let cursor=0;const jobs=remote.flatMap(device=>['projects','recent','capabilities'].filter(kind=>{const next=schedule.get(device.id+'\0'+kind)?.next;return next!==Infinity&&(force||!next||next<=Date.now());}).map(kind=>[device,kind]));
        await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{while(cursor<jobs.length&&!signal.aborted){const [device,kind]=jobs[cursor++];await load(device,kind,signal);}}));
        if(!signal.aborted&&id===generation.current){
          const version=++deviceVersion.current,result=await deviceRequest('devices',{},AbortSignal.any([signal,AbortSignal.timeout(15000)]));
          if(!signal.aborted&&id===generation.current&&version===deviceVersion.current)updateDevices(result);
        }
      }catch{
        // Per-device reads retain their own errors; a failed status read must not erase them.
      }finally{
        running=false;
        if(!disposed&&!document.hidden){if(rerun){rerun=false;void refresh();}else timer=setTimeout(()=>refresh(false),Math.max(250,Math.min(30000,...[...schedule.values()].map(value=>value.next-Date.now()))));}
      }
    };
    const visibility=()=>{
      if(document.hidden){clearTimeout(timer);controller?.abort();requests.current.forEach(request=>request.abort());}
      else if(running){rerun=true;}
      else void refresh();
    };
    void refresh();document.addEventListener('visibilitychange',visibility);window.addEventListener('online',visibility);
    return()=>{disposed=true;generation.current++;clearTimeout(timer);controller?.abort();requests.current.forEach(request=>request.abort());requests.current.clear();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('online',visibility);};
  },[enabled,ready,signature,showArchived,revision]);
  const save=async value=>{touched.current=true;setReady(true);draft.current=normalizeScope(value);setScope(draft.current);setSaving(true);setSaveError('');try{const result=await deviceRequest('setResourceScope',{scope:draft.current});setScope(normalizeScope(result.scope||draft.current));draft.current=null;}catch(e){setSaveError('显示范围未保存：'+e.message);}finally{setSaving(false);}};
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
    }catch(e){if(!controller.signal.aborted&&version===generation.current)updatePages(old=>({...old,[key]:mergeResourcePage(old[key],resourceQueryFailure(e))}));}
    finally{
      if(requests.current.get(key)===controller){requests.current.delete(key);if(version===generation.current)updatePages(old=>({...old,[key]:{...old[key],loading:false,refreshing:false}}));}
    }
  };
  // Current/All include the already mounted local workspace even while device
  // discovery is loading or unavailable. Only an explicit selection may hide it.
  const sessionAction=async(row,operation,title)=>{
    const access=sessionActionAccess({remote,pages:pageRef.current},row,operation);
    if(!access.available)throw Error(access.reason);
    const id=row.resourceId??row.id,requestId='sa:'+Date.now()+':'+crypto.randomUUID();
    const result=await deviceRequest('sessionAction',{deviceId:row.deviceId,expectedHostId:row.device.hostId??null,expectedAuthorizationId:row.device.authorizationId??null,id,native:row.native===true,operation,requestId,...(operation==='rename'?{title}:{})},AbortSignal.timeout(15000));
    if(result.accepted!==true||result.id!==id||result.operation!==operation||result.requestId!==requestId)throw Error('所属设备未确认会话操作，请刷新后核验');
    setRevision(v=>v+1);
    return result;
  };
  return {enabled,scope:enabled?scope:normalizeScope(),devices,activeId,selected,remote,pages,error:enabled?(saveError||error):'',saveError:enabled?saveError:'',connecting,saving,ready,save,more,sessionAction,revision,retry:()=>setRevision(v=>v+1),showLocal:!enabled||scope.mode!=='selected'||scope.deviceIds.includes(activeId)};
}
export function ResourceScope({navigation:n}){const [open,setOpen]=useState(false);return <div className="cmd-resource-scope"><Menu className="cmd-resource-scope-anchor" open={open} onClose={()=>setOpen(false)} portal autoFocus compact listClassName="cmd-resource-scope-menu" items={[{type:'label',id:'heading',text:'项目与最近 · 显示范围'},...['current','all','selected'].map((id,i)=>({id,disabled:n.saving,label:['当前设备（工作台主机）','所有已连接设备','指定设备'][i],icon:<span aria-hidden="true">{n.scope.mode===id?'✓':''}</span>}))]} onSelect={mode=>{void n.save({...n.scope,mode});if(mode!=='selected')setOpen(false);}} anchor={<Tooltip label={'显示范围：'+({current:'当前设备',all:'所有已连接设备',selected:'指定设备'})[n.scope.mode]}><button type="button" aria-label="显示范围" aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(!open)}><UIIcon name="filter" size={16}/><span className="cmd-resource-scope-label">显示</span></button></Tooltip>}>
  {n.scope.mode==='selected'&&<div className="cmd-resource-devices">{n.devices.map(device=><label key={device.id}><input type="checkbox" checked={n.scope.deviceIds.includes(device.id)} disabled={n.saving} onChange={event=>void n.save({...n.scope,deviceIds:event.target.checked?[...n.scope.deviceIds,device.id]:n.scope.deviceIds.filter(id=>id!==device.id)})}/><span>{device.name}</span>{deviceStatus(device)&&<small>{deviceStatus(device)}</small>}</label>)}</div>}
  </Menu>{n.error&&<Tooltip label={n.error+(n.saveError?'，点击重试保存':n.connecting?'，正在后台重新连接；点击重试':'；打开设备中心')}><button type="button" className="cmd-resource-save-error" aria-label={n.saveError?'重试保存':n.connecting?'重新连接设备':'设备中心'} disabled={n.saving} onClick={()=>n.saveError?void n.save(n.scope):n.connecting?n.retry():document.querySelector('.dsh-device-launcher')?.click()}><UIIcon name="refresh" size={14}/></button></Tooltip>}</div>;}
function ResourceReadStatus({device,page,onRetry}){
  if(page&&page.available!==false&&(!page.loading||Array.isArray(page.items)))return null;
  const connecting=!page||page.available!==false||canRetryResource(page),label=device.name+' · '+(connecting?'正在自动连接':page.reason||'设备资源暂不可用');
  return <Tooltip label={label+(connecting?'；点击重新连接':'；打开设备中心')}><button type="button" className="cmd-resource-connection" data-resource-state={connecting?'connecting':'unavailable'} aria-label={label} aria-busy={connecting} onClick={connecting?onRetry:()=>document.querySelector('.dsh-device-launcher')?.click()}><UIIcon name={connecting?'refresh':'devices'} size={14}/></button></Tooltip>;
}
export function ResourceDeviceState({navigation:n,device,kind,hideEmpty=false}){const page=n.pages[device.id+'\0'+kind];return <><ResourceReadStatus device={device} page={page} onRetry={n.retry}/>{!hideEmpty&&page?.available&&page.items?.length===0&&<p className="cmd-sidebar-empty">{kind==='projects'?'暂无项目':'暂无最近对话'}</p>}{page?.hasMore&&<button type="button" className="cmd-resource-more" disabled={page.loading||page.refreshing||page.available===false} onClick={()=>void n.more(device,kind)}>加载更多 · {device.name}</button>}</>;}
export function RemoteProjects({navigation:n,filter,onOpen,onDelete,archived,onToggle,renderSession,renderHeader}) {
  const [expanded,setExpanded]=useState({}),[sessions,setSessions]=useState({});
  const generation=useRef(0),requests=useRef(new Map()),sessionRef=useRef({}),retryTimers=useRef(new Map()),retryAttempts=useRef(new Map()),activeProjects=useRef(new Set());
  const identity=JSON.stringify(n.remote.map(d=>[d.id,d.hostId,d.authorizationId]));
  const updateSessions=update=>{sessionRef.current=update(sessionRef.current);setSessions(sessionRef.current);};
  useEffect(()=>{setExpanded({});},[identity]);
  const cancelReads=()=>{generation.current++;requests.current.forEach(controller=>controller.abort());requests.current.clear();retryTimers.current.forEach(clearTimeout);retryTimers.current.clear();retryAttempts.current.clear();};
  useEffect(()=>{cancelReads();updateSessions(()=>({}));return cancelReads;},[identity,archived]);
  useEffect(()=>{cancelReads();},[n.revision]);
  useEffect(()=>{const visibility=()=>{if(document.hidden)cancelReads();};document.addEventListener('visibilitychange',visibility);return()=>document.removeEventListener('visibilitychange',visibility);},[]);
  const load=async(device,p,append=false)=>{
    const key=resourceKey(p),previous=sessionRef.current[key];
    if(document.hidden||requests.current.has(key)||append&&!previous?.hasMore)return;
    if(requests.current.size>=4){
      if(!retryTimers.current.has(key))retryTimers.current.set(key,setTimeout(()=>{retryTimers.current.delete(key);if(activeProjects.current.has(key))void load(device,p,append);},1000));
      return;
    }
    clearTimeout(retryTimers.current.get(key));retryTimers.current.delete(key);
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),version=generation.current;requests.current.set(key,controller);
    let retry=false;
    updateSessions(v=>({...v,[key]:{...v[key],loading:!Array.isArray(v[key]?.items),refreshing:true}}));
    try{
      const input={deviceId:device.id,kind:'sessions',projectId:p.resourceId||p.id,archived};
      let page;
      if(append){const value=await deviceRequest('resources',{...input,offset:previous.items?.length||0,limit:30},signal);page=value.devices?.[0];}
      else page=await readResourcePages(deviceRequest,input,previous?.items?.length,signal);
      if(!page||!Array.isArray(page.items))throw Error('设备资源响应无效');
      if(!signal.aborted&&version===generation.current){retry=canRetryResource(page);if(page.available)retryAttempts.current.delete(key);updateSessions(v=>({...v,[key]:mergeResourcePage(v[key],page,append)}));}
    }
    catch(e){if(!controller.signal.aborted&&version===generation.current){const page=resourceQueryFailure(e);retry=canRetryResource(page);updateSessions(v=>({...v,[key]:mergeResourcePage(v[key],page)}));}}
    finally{
      if(requests.current.get(key)===controller)requests.current.delete(key);
      if(retry&&!controller.signal.aborted&&version===generation.current&&activeProjects.current.has(key)){
        const attempt=(retryAttempts.current.get(key)||0)+1;retryAttempts.current.set(key,attempt);
        retryTimers.current.set(key,setTimeout(()=>{retryTimers.current.delete(key);if(!document.hidden&&version===generation.current&&activeProjects.current.has(key))void load(device,p);},resourceRetryDelay(attempt)));
      }
    }
  };
  const projectVersion=JSON.stringify(n.remote.map(device=>[device.id,n.pages[device.id+'\0projects']?.observedAt,(n.pages[device.id+'\0projects']?.items||[]).map(resourceKey)]));
  useEffect(()=>{
    let disposed=false,cursor=0;
    const jobs=n.remote.filter(device=>expanded[device.id]!==false).flatMap(device=>(n.pages[device.id+'\0projects']?.items||[])
      .filter(p=>!p.isDefault&&(archived||expanded[resourceKey(p)])).map(p=>[device,p]));
    activeProjects.current=new Set(jobs.map(([,p])=>resourceKey(p)));
    for(const [key,controller] of requests.current)if(!activeProjects.current.has(key))controller.abort();
    for(const [key,timer] of retryTimers.current)if(!activeProjects.current.has(key)){clearTimeout(timer);retryTimers.current.delete(key);retryAttempts.current.delete(key);}
    void Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{while(!disposed&&cursor<jobs.length){const [device,p]=jobs[cursor++];await load(device,p);}}));
    return()=>{disposed=true;};
  },[identity,archived,JSON.stringify(expanded),projectVersion,n.revision]);
  const matches=row=>!filter||`${row.title||''} ${row.provider||''} ${row.model||''}`.toLowerCase().includes(filter.toLowerCase());
  return n.remote.map(device=><div className="cmd-resource-group" key={device.id}><button type="button" className="cmd-resource-group-title" data-device-available={n.pages[device.id+'\0projects']?.available===true} aria-expanded={expanded[device.id]!==false} onClick={()=>setExpanded(v=>({...v,[device.id]:v[device.id]===false}))}><UIIcon name="computer" size={13}/><span>{device.name}</span>{deviceStatus(device)&&<small>{deviceStatus(device)}</small>}</button>{expanded[device.id]!==false&&<><ResourceDeviceState navigation={n} device={device} kind="projects"/>{(n.pages[device.id+'\0projects']?.items||[]).filter(p=>!p.isDefault).map(p=>{
    const key=resourceKey(p),page=sessions[key],open=archived||!!expanded[key],title=p.title||p.name||p.path;
    const rows=sortResourceRecents((page?.items||[]).filter(row=>!!row.archived===archived&&matches(row)));
    return <div className="cmd-project" key={key}>{renderHeader({title,titleTooltip:device.name+' · '+(p.path||title),expanded:open,onToggle:()=>{onToggle?.();setExpanded(v=>({...v,[key]:!v[key]}));},onNew:!archived?()=>onOpen(device,{kind:'projects',resourceId:p.resourceId||p.id,intent:'newSession'}):undefined,newLabel:'在 '+device.name+' 的 '+title+' 新聊天',onDelete:!archived&&onDelete?()=>onDelete({...p,remote:true,device,deviceId:device.id,kind:'projects'}):undefined,deleteLabel:'删除 '+device.name+' 的项目 '+title,deleteDisabled:n.pages[device.id+'\0projects']?.available!==true})}{open&&<div className="cmd-project-children">
      <ResourceReadStatus device={device} page={page} onRetry={()=>void load(device,p)}/>
      {rows.map(row=>renderSession({...row,remote:true,device,deviceId:device.id,kind:'sessions'}))}
      {page?.available&&!rows.length&&<p className="cmd-sidebar-empty">{filter?'没有找到对话':archived?'暂无归档对话':'还没有对话'}</p>}
      {page?.hasMore&&<button type="button" className="cmd-resource-more" disabled={page.refreshing||page.available===false} onClick={()=>void load(device,p,true)}>加载更多对话</button>}
    </div>}</div>;
  })}</>}</div>);
}
/** Keep one flat candidate list; the sidebar sorts local and remote rows together once. */
export function remoteRecentRows(n,filter,archived){return n.remote.flatMap(device=>(n.pages[device.id+'\0recent']?.items||[]).filter(row=>!!row.archived===archived&&(!filter||`${row.title||''} ${row.provider||''} ${row.model||''}`.toLowerCase().includes(filter.toLowerCase()))).map(row=>({...row,device,deviceId:device.id,remote:true})));}

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

export function installResourceReceiver(host, { open, newSession, addProject, projectApi, getDefaultProjectId }) {
  const origin = new URLSearchParams(location.hash.slice(1)).get('resourceParentOrigin');
  if (window.parent === window || !origin) return;
  try {
    const parent = new URL(origin);
    if (!['http:', 'https:', 'dsh-app:'].includes(parent.protocol) || (parent.origin !== origin && 'dsh-app://' + parent.host !== origin)) return;
  } catch { return; }
  let disposed = false, pending = Promise.resolve();
  const requests = new Map(), projectRequests = new Map(), cancellations = new Set();
  const projectActions = typeof projectApi === 'function' ? ['browse', 'project', 'clone'] : [];
  if (typeof host.workspaces?.delete === 'function' && typeof getDefaultProjectId === 'function') projectActions.push('deleteProject');
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
          if (action === 'deleteProject') {
            if (typeof args?.id !== 'string' || !args.id || typeof args.path !== 'string' || !args.path) throw Error('项目引用无效，请刷新后重试');
            const defaultId = await getDefaultProjectId();
            if (disposed) throw Error('工作台已关闭');
            if (typeof defaultId !== 'string' || !defaultId) throw Error('默认项目身份尚未就绪，请刷新后重试');
            const project = await loadedValue(host.workspaces.list, snapshot => snapshot.items.find(item => (item.workspaceId || item.id) === args.id), '项目列表');
            if (disposed) throw Error('工作台已关闭');
            if (!project || project.path !== args.path) throw Error('项目身份已变化，请刷新后重试');
            if (project.isDefault || args.id === defaultId) throw Error('默认项目不可删除');
            await host.workspaces.delete(args.id);
            return { type: 'benchgo:project:result', requestId, value: { deleted: true, id: args.id } };
          }
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
            if (resource.native) {
              if (typeof resource.resourceId !== 'string' || !resource.resourceId.startsWith('native:') || resource.resourceId.length <= 7) throw Error('会话引用无效，请刷新后重试');
              await open(resource.resourceId.slice('native:'.length));
            }
            else await openSession(resource.resourceId);
          } else {
            const project = await loadedValue(host.workspaces.list, snapshot => snapshot.items.find(item => (item.workspaceId || item.id) === resource.resourceId), '项目列表');
            if (disposed) throw Error('工作台已关闭');
            if (!project) throw Error('项目不可用，请刷新后重试');
            const id = project.sessionIds?.[0];
            if (id) await openSession(id);
            else throw Error('项目暂无对话，请通过新聊天创建');
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
