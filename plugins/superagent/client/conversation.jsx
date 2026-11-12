import { Button } from '../../shared/client/ui/button.jsx';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AssistantHome } from './home.jsx';
import { quietChatRows } from './quiet-chat.mjs';
import { QuietChat } from './quiet-chat.jsx';
import { ActivityTrigger } from './activity-panel.jsx';
import { ConversationActivity } from './conversation-activity.jsx';
import { conversationActivity } from './reply-stream.mjs';
import activityCss from './quiet-chat.css';
import { PetAvatar } from '../../shared/client/pet-avatar.jsx';
import { latestPetExpression, petActionForSession, petExpressionForAction, petImageUrl, petDesignIntent, isRetiredPetDraft } from './pet-state.mjs';
import { assistantConfigSync } from './config-sync.mjs';
import css from './pet-editor.css';
import { retainAssistantSession } from './session-retain.mjs';
import { ConversationWidth } from './conversation-width.jsx';
import { ResourceState } from './resource-state.jsx';

export const SuperAgentSurfaceContext = createContext(false);
const HomeContext = createContext(null);
const EMPTY_PET_STATUSES = new Map();

export const ASSISTANT_CONVERSATION_SLOT = 'benchgo.assistant.conversation';
export const assistantConversationChildren = {
  [ASSISTANT_CONVERSATION_SLOT]: { kind: 'single', scope: 'session' },
};

function FixedChatView({ renderSlot, useSession, useConversation, useInput, useProjection, inputActions }) {
  const home = useContext(HomeContext);
  const session = useSession(value => value);
  const conversation = useConversation(value => value);
  const input = useInput(value => value);
  const inbox = useProjection?.('inbox');
  const designIntent = useSyncExternalStore(petDesignIntent.subscribe, petDesignIntent.getSnapshot);
  useEffect(() => {
    if (!isRetiredPetDraft(input)) return;
    inputActions.setDraft(''); inputActions.persistDraft();
  }, [input?.phase, input?.draft, input?.occurrences?.length, input?.attachmentIds?.length, inputActions]);
  const showHome = home && session.openState !== 'loading' && session.openState !== 'error'
    && !session.running && !session.promptAttempted && conversation.activeTargets.size === 0
    && (session.blank || session.awaitingFirstTurn)
    && quietChatRows(home.history, home.threadId, session, conversation.views?.get('chat'), inbox).length === 0;
  // Keep the official content factory/composer; never mount its raw execution transcript.
  return <div className="ba-chat-viewport"><div className="ba-chat-feed" data-assistant-scroll="" tabIndex={0} aria-label="聊天记录">{designIntent && home && designIntent.threadId === home.threadId && <div className="ba-note" role="status">{designIntent.kind === 'refine' ? '请在输入框说明希望继续调整的地方。' : '请在输入框描述你希望的形象。'}<Button variant="ghost" type="button" className="ba-quiet" onClick={() => petDesignIntent.clear()}>关闭提示</Button></div>}{showHome && <AssistantHome {...home} input={input} inputActions={inputActions} />}{home && <QuietChat home={home} session={session} chat={conversation.views?.get('chat')} inbox={inbox} />}</div></div>;
}

function PetConversationStatus({ home, session, chat }) {
  const source = home.sessionStatus;
  const statuses = useSyncExternalStore(listener => source?.subscribe(listener) || (() => {}), () => source?.getSnapshot() || EMPTY_PET_STATUSES);
  const pendingInteraction = statuses.get(home.sessionId)?.pendingInteraction;
  const liveConfig = useSyncExternalStore(assistantConfigSync.subscribe, assistantConfigSync.getSnapshot);
  const config = liveConfig || home.assistantConfig || {};
  const name = (config.name ?? home.assistantName) || '未命名';
  const [catalog, setCatalog] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [expression, setExpression] = useState(null);
  const lastEvent = useRef(null);
  const expressionEvent = latestPetExpression([home.petExpression, catalog?.expressionEvent], config.revision);
  useEffect(() => {
    let active = true;
    home.api('petCatalog').then(result => { if (active) { setCatalog(result); setError(''); } }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [home.api, session.running, config.revision]);
  useEffect(() => {
    const event = expressionEvent;
    if (!event || event.revision !== config.revision) { setExpression(null); return; }
    if (event.eventId === lastEvent.current) return;
    lastEvent.current = event.eventId; setExpression(event.expression);
    const timer = setTimeout(() => setExpression(null), 3500);
    return () => clearTimeout(timer);
  }, [expressionEvent?.eventId, config.revision]);
  useEffect(() => { setExpression(null); }, [config.revision]);
  const action = petActionForSession({ ...session, pendingInteraction });
  const activity = conversationActivity(session, chat, pendingInteraction);
  const face = expression || petExpressionForAction(config.pet, action);
  const pet = face && config.pet?.kind !== 'custom' ? { ...(config.pet || { kind: 'builtin', assetId: 'builtin', decorations: [], palette: 'default' }), expression: face } : config.pet;
  const draft = catalog?.draft;
  async function apply() {
    setBusy(true); setError('');
    try { await home.api('petApply', { draftId: draft.draftId, revision: config.revision }); setCatalog(value => ({ ...value, draft: null })); }
    catch (cause) { setError(cause.message); } finally { setBusy(false); }
  }
  async function discard() {
    setBusy(true); setError('');
    try { await home.api('petDiscard', { draftId: draft.draftId }); setCatalog(value => ({ ...value, draft: null })); }
    catch (cause) { setError(cause.message); } finally { setBusy(false); }
  }
  return <div className="ba-pet-chat"><style>{css}{activityCss}</style><div className="ba-chat-heading"><div className="ba-chat-identity"><Button variant="ghost" type="button" className="ba-chat-identity-link" aria-label={`查看${name}的身份`} onClick={() => { if (document.dispatchEvent(new Event('benchgo:assistant-open-identity', { cancelable: true }))) home.onOpenResources('resources'); }}><PetAvatar pet={pet} src={petImageUrl(pet, document.baseURI, face)} size={36} motion={config.cardMotion !== false} action={action} expression={face} /><span>{name}</span></Button><ConversationActivity activity={activity} compact /></div><ActivityTrigger api={home.api} /></div>{draft && <div className="ba-pet-chat-draft"><PetAvatar pet={draft.pet} src={draft.src} size={72} motion={false} /><div><strong>新形象预览</strong><p>应用后仍是同一个助手，记忆与会话保留。</p><div className="ba-pet-editor-actions"><Button variant="default" type="button" className="ba-primary" disabled={busy || session.running} onClick={apply}>{busy ? '应用中…' : '应用形象'}</Button><Button variant="ghost" type="button" className="ba-quiet" onClick={() => { petDesignIntent.request(home.threadId, 'refine'); }}>继续修改</Button><Button variant="ghost" type="button" className="ba-quiet" disabled={busy} onClick={discard}>取消预览</Button></div></div></div>}{error && <p className="ba-note" role="alert">形象信息：{error}</p>}</div>;
}

function OfficialConversation({ useSession, useConversation, renderFactorySlot }) {
  const home = useContext(HomeContext);
  const session = useSession(value => value);
  const conversation = useConversation(value => value);
  const active = conversation.activeTargets.size > 0
    || (!session.blank && !session.awaitingFirstTurn) || session.running;
  if (session.openState === 'error') return <div className="ba-resource-initial"><ResourceState kind="error" title="聊天暂未连接" description="会话连接失败，请重新连接。" actionLabel="重新连接" onAction={home?.reconnect} /></div>;
  const hero = false;
  const phase = !active && session.openState === 'loading' ? 'settling' : 'active';
  return <>{home && <PetConversationStatus home={home} session={session} chat={conversation.views?.get('chat')} />}{renderFactorySlot('conversation.content', { variant: 'main', phase, hero }, {
    slots: home ? { views: FixedChatView, widthControls: ConversationWidth } : { widthControls: ConversationWidth },
  })}</>;
}

/** The official renderer supplies both props through the host's session child declaration. */
export function AssistantConversation({ ctx, sessionId, SessionProvider, renderSlot, api, assistantName, assistantConfig, petExpression, onOpenResources, onOpenExecution, threadId, history, onLoadEarlier, onRefresh, execution = false }) {
  const [retained, setRetained] = useState(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let reference;
    setError(''); setRetained(null);
    void (async () => {
      reference = await retainAssistantSession(ctx.sessions, sessionId, controller.signal);
      if (controller.signal.aborted) { reference.release(); return; }
      await reference.ready;
      if (controller.signal.aborted) return;
      if (reference.binding?.session.getSnapshot().openState === 'error') throw new Error('会话连接失败');
      ctx.uiConversation.binding(sessionId).activate('chat');
      setRetained({ sessionId, reference });
    })().catch(cause => { if (!controller.signal.aborted) { console.warn('[BenchGo] conversation connection failed', cause); setError(execution ? '执行会话暂未连接，重试即可继续。' : '聊天暂未连接，重试即可继续。'); } });
    return () => { controller.abort(); reference?.release(); };
  }, [ctx, sessionId, retry, execution]);
  const reconnect = useCallback(() => setRetry(value => value + 1), []);
  const sessionStatus = ctx.uiSession?.sessionStatus;
  // Every consumer of this context re-renders when its value changes identity.
  const home = useMemo(() => api ? { ctx, api, SessionProvider, renderSlot, assistantName, assistantConfig, petExpression, onOpenResources, onOpenExecution, threadId, history, onLoadEarlier, onRefresh, reconnect, sessionStatus, sessionId } : null,
    [ctx, api, SessionProvider, renderSlot, assistantName, assistantConfig, petExpression, onOpenResources, onOpenExecution, threadId, history, onLoadEarlier, onRefresh, reconnect, sessionStatus, sessionId]);
  if (error) return <div className="ba-resource-initial"><ResourceState kind="error" title={execution ? "执行会话暂未连接" : "聊天暂未连接"} description={error} actionLabel="重新连接" onAction={reconnect} /></div>;
  if (!retained || retained.sessionId !== sessionId) return <div className="ba-resource-initial"><ResourceState kind="loading" title={execution ? "正在连接执行会话" : "正在连接聊天"} /></div>;
  return <div className="ba-official-conversation" data-assistant-chat="" style={{ display: 'flex', flex: '1 1 0', minHeight: 0, minWidth: 0, flexDirection: 'column' }}>
    <SuperAgentSurfaceContext.Provider value={true}><HomeContext.Provider value={home}><SessionProvider session={retained.reference}>
      {renderSlot(ASSISTANT_CONVERSATION_SLOT, {})}
    </SessionProvider></HomeContext.Provider></SuperAgentSurfaceContext.Provider>
  </div>;
}

export function mountAssistantConversation(ctx) {
  ctx.effect(() => ctx.slots.inject(ASSISTANT_CONVERSATION_SLOT, () => ctx.slots.register({
    name: ASSISTANT_CONVERSATION_SLOT,
  }, OfficialConversation)));
}
