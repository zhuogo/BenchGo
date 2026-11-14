/** The host supplies the durable default identity; titles and directory spellings are never identity. */
export function isRecentWorkspace(workspace){return workspace?.isDefault===true;}
export const recentWorkspace=projects=>projects.find(isRecentWorkspace);
export const projectWorkspaces=projects=>projects.filter(project=>!isRecentWorkspace(project));
export function recentRows(rows,projects){const defaults=new Set(projects.filter(isRecentWorkspace).map(p=>p.id??p.workspaceId));return rows.filter(row=>defaults.has(row.projectId)||projects.some(p=>isRecentWorkspace(p)&&typeof p.path==='string'&&p.path.length>0&&p.path===row.cwd));}
/** Completion is an unread notification owned and acknowledged by the official main view. */
export function sidebarSessionStatus(official,ui,native){
  if(ui?.pendingInteraction||native?.status==='waiting')return 'waiting';
  if((ui?.running??official?.running)||native?.status==='running')return 'running';
  if(native?.status==='connecting'||native?.status==='failed')return native.status;
  if(ui?.completionUnread===true)return 'completed';
  if(native)return native.status==='completed'?'idle':native.status;
  return undefined;
}
/** Activity includes official sessions and their native delegates, even without a cwd. */
export function workspaceActivity(project,liveSessions){
  if(!project)return null;
  const id=project.id??project.workspaceId,path=project.path,sessionIds=new Set(project.sessionIds??[]);
  const priority={connecting:1,running:2,waiting:3};
  let activity=null;
  for(const session of liveSessions){
    if(session.archived||!priority[session.status])continue;
    const belongs=(id&&session.projectId===id)||(path&&session.cwd===path)
      ||(session.id&&sessionIds.has(session.id))||(session.ownerSessionId&&sessionIds.has(session.ownerSessionId));
    if(belongs&&(priority[session.status]>(priority[activity]??0)))activity=session.status;
  }
  return activity;
}
/** The official workspace snapshot is authoritative once ready, including an empty list. */
export function sidebarWorkspaces(snapshot,fallback=[],defaultId){
  const items=snapshot?.items;
  const source=snapshot?.phase==='ready'||items?.length>0?items??[]:fallback;
  const previous=new Map(fallback.map(project=>[project.id??project.workspaceId,project]));
  return source.map(project=>{
    const id=project.workspaceId??project.id;
    return {...project,id,sessionIds:project.sessionIds??[],isDefault:defaultId!=null?id===defaultId:(previous.get(id)?.isDefault??project.isDefault)===true};
  });
}
/** Missing active identity must never match an absent owner; delegates remain independent rows. */
export function isSidebarSessionSelected(session,activeSessionId){
  return typeof activeSessionId==='string'&&activeSessionId.length>0&&(session.id===activeSessionId||(session.native===true&&session.ownerSessionId===activeSessionId&&(!session.parentId||session.harnessAdopted===true)));
}
/** Official subagents use parent navigation; voice activity keeps ordinary blank sessions visible. */
export function isSidebarSessionVisible(session){return !!session&&session.origin!=='subagent'&&(!session.blank||session.projectionValues?.benchgoVoice?.used===true);}
/** The host display title falls back to cwd; a voice-only Session has a meaningful title of its own. */
export function sidebarSessionTitle(session){return session?.title||(session?.projectionValues?.benchgoVoice?.used===true?'语音对话':session?.displayTitle)||'新对话';}
export function sidebarSessionUpdatedAt(session){
  const voice=session?.projectionValues?.benchgoVoice;
  return voice?.used===true?Math.max(Number(session.updatedAt)||Date.parse(session.updatedAt)||0,Number(voice.lastActivityAt)||0):session?.updatedAt;
}
/** Resolve the newest adopted native session once per catalog, not once per row. */
export function latestSidebarNativeSessions(sessions){
  const owners=new Map();
  for(const session of sessions){
    const owner=session.ownerSessionId;
    if(!owner||(session.parentId&&!session.harnessAdopted))continue;
    const previous=owners.get(owner);
    if(!previous||Number(session.updatedAt)-Number(previous.updatedAt)>0)owners.set(owner,session);
  }
  return owners;
}
/** Documents discovery is optional when the Profile recovery service can create Recent. */
export async function ensureSidebarWorkspace(host,recover){
  let initial;
  try{initial=await host.workspaces.initializeDefault();}catch{/* Recovery owns a writable Profile fallback. */}
  return recover({workspaceId:initial?.workspaceId});
}
const creatingSessions=new WeakMap(),recentCreation=Symbol('recent');
/** New Chat creates an independent identity; opening a workspace may reuse its old blank/draft. */
export function startSidebarSession(host,projects,projectId,defaultId,ensureRecent){
  let pending=creatingSessions.get(host);
  if(!pending){pending=new Map();creatingSessions.set(host,pending);}
  const key=projectId??recentCreation;
  if(pending.has(key))return pending.get(key);
  const operation=(async()=>{
    const current=sidebarWorkspaces(host.workspaces.list?.getSnapshot(),projects,defaultId);
    let target=projectId??recentWorkspace(current)?.id;
    if(projectId==null&&ensureRecent)target=(await ensureRecent())?.workspaceId;
    if(!target){const initialized=await host.workspaces.initializeDefault();target=initialized?.workspaceId;}
    if(!target)throw Error('最近工作区创建失败，请重试');
    const sessionId=await host.sessions.create({workspaceId:target});
    host.uiWorkspace.openSession(sessionId);
    return target;
  })();
  pending.set(key,operation);
  operation.finally(()=>{pending.delete(key);if(!pending.size)creatingSessions.delete(host);}).catch(()=>{});
  return operation;
}

/** Optional startup failures stay visible without hiding conversations. */
export function sidebarCapabilityWarning(capabilities) {
  return [['delegation', '原生委派'], ['fonts', '界面字体']].flatMap(([id, label]) => {
    const value = capabilities?.[id];
    if (value?.available !== false || !value.error) return [];
    const detail = String(value.error).replace(/\s+/g, ' ').trim().slice(0, 200);
    return [label + '暂不可用：' + detail];
  }).join('\n');
}
