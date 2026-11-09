import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { ResourceIcon } from '../../shared/client/resource-icon.jsx';
import { ResourceState } from './resource-state.jsx';
import { retainAssistantSession } from './session-retain.mjs';
import { reviewActionDetails, reviewApprovalResponse, reviewConnectionError, reviewDisplayText, reviewSessionOpenError, reviewRequestKey, sameReviewOrigin } from './approval-review.mjs';
import css from './approval-review.css';
import { transientRefreshError } from './refresh-error.mjs';

const ApprovalContext = createContext(null), EMPTY_STATUSES = new Map();
export const REVIEW_APPROVAL_SLOT = 'benchgo.assistant.review-approval';
export const reviewApprovalChildren = { [REVIEW_APPROVAL_SLOT]: { kind: 'single', scope: 'session' } };

export function OfficialReviewApproval({ renderFactorySlot }) {
  const { pending, origin, readOrigins, isCurrent, onError } = useContext(ApprovalContext);
  const response = useRef(null);
  if (response.current?.pending !== pending || !sameReviewOrigin(response.current?.origin, origin)) response.current = {
    pending, origin, value: reviewApprovalResponse({ pending, origin, readOrigins, isCurrent }),
  };
  const responder = response.current.value, details = reviewActionDetails(pending);
  const answer = async outcome => { try { onError(''); await responder.answer(outcome); } catch (error) { onError(reviewConnectionError(error)); throw error; } };
  return renderFactorySlot('conversation.approval.card', {
    requestKey: pending.key, callId: pending.callId,
    title: details ? '允许执行这一次外部动作？' : reviewDisplayText(pending.displayReason?.zh || pending.reason || pending.displayReason?.en || '是否允许本次操作？'),
    description: '批准仅覆盖当前请求，不会授予后续动作权限。',
    canAnswer: responder.canAnswer, onAllow: () => answer('allowed-once'), onReject: () => answer('rejected'),
  });
}

function ApprovalDetail({ entry, api, current, SessionProvider, renderSlot }) {
  const [error, setError] = useState(''), alive = useRef(false);
  const { origin, pending, reference } = entry;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, [pending]);
  const details = reviewActionDetails(pending), target = details?.target;
  const source = reviewDisplayText(origin.sourceTitle || (origin.ownerThreadId === 'main' ? '主聊天' : '旁聊'));
  const readOrigins = async () => (await api('approvalOrigins', { sessionId: origin.sessionId, toolName: pending.toolName })).origins || [];
  const content = details?.content?.text ?? (details ? JSON.stringify(details.content, null, 2) : null);
  return <article className="ba-review-detail" aria-label="审核详情">
    <header><span className="ba-review-eyebrow">{source} · {origin.kind === 'worker' ? '任务操作' : '对话操作'}</span><h3>{reviewDisplayText(origin.title || '待授权操作')}</h3></header>
    {details && <section className="ba-review-action" aria-label="本次动作对象与内容"><dl>
      <div><dt>动作</dt><dd>{({ 'external-send': '对外发送与分享', payment: '支付购买', 'password-change': '修改密码', 'account-delete': '删除账号' })[details.category] || details.category}</dd></div>
      <div><dt>对象</dt><dd>{target.channel && <span className="ba-review-target-channel">{target.channel}</span>}{target.chatId || target.conversationId || (typeof target === 'string' ? target : JSON.stringify(target, null, 2))}</dd></div>
      {target.appId && <div><dt>账号</dt><dd>{target.appId}</dd></div>}
      {details.origin && <div><dt>站点</dt><dd>{details.origin}</dd></div>}
    </dl><div className="ba-review-content"><span>最终内容</span><pre>{content}</pre></div><details className="ba-review-target"><summary>完整目标信息</summary><pre>{JSON.stringify(target, null, 2)}</pre></details></section>}
    <ApprovalContext.Provider value={{ pending, origin, readOrigins, isCurrent: () => alive.current && current.current?.some(item => item.pending === pending && sameReviewOrigin(item.origin, origin)), onError: setError }}>
      <SessionProvider session={reference}>{renderSlot(REVIEW_APPROVAL_SLOT, {})}</SessionProvider>
    </ApprovalContext.Provider>
    {error && <p className="ba-review-decision-error" role="alert">{error}</p>}
  </article>;
}

function ConnectionErrors({ items }) {
  return <section className="ba-review-connection-errors" aria-label="会话连接详情"><header><p>以下会话尚未连接，无法确认其中的待审核操作。</p></header><ul>{items.map(item => <li key={item.origin.sessionId}>
    <strong>{reviewDisplayText(item.origin.sourceTitle || (item.origin.ownerThreadId === 'main' ? '主聊天' : '旁聊'))}{item.origin.title ? ` · ${reviewDisplayText(item.origin.title)}` : ''}</strong>
    <span>{({ ensure: '准备对话', retain: '保留会话', open: '打开会话' })[item.stage]}（{item.stage}）</span><pre>{item.error}</pre>
  </li>)}</ul></section>;
}

function releaseConnection(item) { item.controller.abort(); item.unsubscribe?.(); item.reference?.release(); }

/** One owner-scoped index; requests and answers remain in official Session scopes. */
export function ApprovalReview({ ctx, api, SessionProvider, renderSlot, compact = false, active = true, onCountChange }) {
  const [origins, setOrigins] = useState(null), [error, setError] = useState(''), [generation, setGeneration] = useState(0);
  const [connections, setConnections] = useState(new Map()), [selectedKey, setSelectedKey] = useState(null);
  const [lastFailure, setLastFailure] = useState('');
  const originsSnapshot = useRef(null), manualRetry = useRef(false);
  const source = ctx.uiSession?.sessionStatus;
  const statuses = useSyncExternalStore(listener => source?.subscribe(listener) || (() => {}), () => source?.getSnapshot() || EMPTY_STATUSES);
  const retained = useRef(new Map()), current = useRef([]), back = useRef(null), navigation = useRef(null);
  const openDetail = (key, event) => {
    const positions = [];
    for (let node = event.currentTarget.parentElement; node; node = node.parentElement) positions.push([node, node.scrollLeft, node.scrollTop]);
    navigation.current = { opener: event.currentTarget, positions };
    setSelectedKey(key);
  };
  useLayoutEffect(() => {
    if (selectedKey) { back.current?.focus({ preventScroll: true }); return; }
    const saved = navigation.current;
    if (!saved) return;
    for (const [node, left, top] of saved.positions) if (node.isConnected) { node.scrollLeft = left; node.scrollTop = top; }
    if (saved.opener.isConnected) saved.opener.focus({ preventScroll: true });
    navigation.current = null;
  }, [selectedKey]);
  const retry = () => {
    for (const [id, item] of retained.current) if (item.error) { releaseConnection(item); retained.current.delete(id); }
    manualRetry.current = true; setGeneration(value => value + 1);
  };
  useEffect(() => {
    const controller = new AbortController(); let timer, inFlight = false, dirty = false, manual = manualRetry.current;
    manualRetry.current = false;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(tick, 150); };
    const tick = async () => {
      if (controller.signal.aborted || document.hidden) return;
      if (inFlight) { dirty = true; return; } inFlight = true;
      try { const response = await api('approvalOrigins', {}, controller.signal); if (!controller.signal.aborted) { originsSnapshot.current = response.origins || []; setOrigins(originsSnapshot.current); setError(''); setLastFailure(''); } }
      catch (cause) { if (!controller.signal.aborted) { const message = reviewConnectionError(cause); setLastFailure(message); if (manual || originsSnapshot.current === null || !transientRefreshError(cause)) setError(message); } }
      finally { manual = false; inFlight = false; if (dirty && !controller.signal.aborted) { dirty = false; schedule(); } }
    };
    const unsubscribe = source?.subscribe(schedule);
    document.addEventListener('benchgo:assistant-changed', schedule); document.addEventListener('visibilitychange', schedule);
    const fallback = setInterval(tick, 10000); void tick();
    return () => { controller.abort(); clearTimeout(timer); clearInterval(fallback); unsubscribe?.(); document.removeEventListener('benchgo:assistant-changed', schedule); document.removeEventListener('visibilitychange', schedule); };
  }, [api, source, generation]);
  const sessionKey = origins?.map(origin => `${origin.kind}:${origin.ownerThreadId}:${origin.sessionId}`).sort().join('|') || '';
  useEffect(() => {
    const ids = new Set(origins?.map(origin => origin.sessionId) || []);
    const sources = new Map(origins?.map(origin => [origin.sessionId, origin]) || []);
    const publish = () => setConnections(new Map(retained.current));
    for (const [id, item] of retained.current) if (!ids.has(id)) { releaseConnection(item); retained.current.delete(id); }
    for (const id of ids) if (!retained.current.has(id)) {
      const origin = sources.get(id);
      const item = { origin, stage: origin.kind === 'router' ? 'ensure' : 'retain', controller: new AbortController(), reference: null, ready: false, error: '' }; retained.current.set(id, item);
      void (async () => {
        try {
          // Retaining a cold Router can resume its official writer. BenchGo must
          // configure the owning logical conversation before that can happen.
          if (origin.kind === 'router') {
            const ensured = await api('ensure', { threadId: origin.ownerThreadId }, item.controller.signal);
            item.controller.signal.throwIfAborted();
            if (ensured.sessionId !== id) throw new Error('对话已切换，请刷新审核列表');
          }
          item.stage = 'retain';
          const reference = await retainAssistantSession(ctx.sessions, id, item.controller.signal);
          if (item.controller.signal.aborted) { reference.release(); return; } item.reference = reference; item.stage = 'open'; await reference.ready;
          if (!item.controller.signal.aborted) {
            const update = () => {
              if (item.controller.signal.aborted) return;
              const error = reviewSessionOpenError(reference), ready = !error;
              if (item.error !== error || item.ready !== ready) { item.error = error; item.ready = ready; publish(); }
            };
            item.unsubscribe = reference.binding.session.subscribe(update); update();
          }
        } catch (cause) { if (!item.controller.signal.aborted) { item.ready = false; item.error = reviewConnectionError(cause); publish(); } }
      })();
    }
    publish();
  }, [ctx, api, sessionKey, generation]);
  useEffect(() => () => { for (const item of retained.current.values()) releaseConnection(item); retained.current.clear(); }, [ctx]);
  const entries = (origins || []).flatMap(origin => {
    const pending = statuses.get(origin.sessionId)?.pendingInteraction, connection = connections.get(origin.sessionId);
    return connection?.ready && pending?.kind === 'approval' && pending.sessionId === origin.sessionId && pending.answerable
      ? [{ origin, pending, reference: connection.reference, key: reviewRequestKey(origin, pending) }] : [];
  });
  current.current = error ? [] : entries;
  const selected = entries.find(entry => entry.key === selectedKey);
  const connectionErrors = [...connections.values()].filter(item => item.error), connecting = origins?.some(origin => !connections.get(origin.sessionId)?.ready && !connections.get(origin.sessionId)?.error);
  const selectedConnectionError = connectionErrors.find(item => {
    const pending = statuses.get(item.origin.sessionId)?.pendingInteraction;
    return pending && reviewRequestKey(item.origin, pending) === selectedKey;
  });
  const count = error || lastFailure || origins === null || connecting || connectionErrors.length ? null : entries.length;
  useEffect(() => { onCountChange?.(count); }, [count, onCountChange]);
  return <section className={`ba-approval-review${compact ? ' is-compact' : ''}`} aria-label="审核" data-sync-state={lastFailure ? 'reconnecting' : 'ready'} data-sync-error={lastFailure || undefined} hidden={!active} onKeyDown={event => {
    if (selectedKey && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); setSelectedKey(null); }
  }}><style>{css}</style>
    <header className="ba-review-heading"><div>{selectedKey ? <Button ref={back} type="button" variant="ghost" onClick={() => setSelectedKey(null)}><UIIcon name="chevronLeft" size={16} />返回审核列表</Button> : <><h2>审核 <span>{count ?? (entries.length ? `${entries.length}+` : '—')}</span></h2><p>查看待授权的操作，决定这一次是否执行。</p></>}</div><Button type="button" variant="ghost" aria-label="刷新审核" onClick={retry}><UIIcon name="refresh" size={16} />刷新</Button></header>
    <div hidden={!!selectedKey} className="ba-review-overview">
    {!selectedKey && !error && connectionErrors.length > 0 && <ConnectionErrors items={connectionErrors} />}
    {error ? !selectedKey && <ResourceState kind="error" title="审核列表暂时无法读取" description={error} />
      : origins === null || (!entries.length && connecting) ? <ResourceState kind="loading" title="正在同步待审核操作" description="正在连接真实会话，读取仍可答复的授权请求。" />
      : !entries.length && connectionErrors.length ? <ResourceState kind="error" title="部分会话暂未连接" description="暂时无法确认这些会话是否有待审核操作。" />
      : !entries.length ? <ResourceState icon="check" title="没有待审核的操作" description="需要你授权时，Router 会在原聊天里提醒；你可以到这里查看对象与内容。" />
      : <nav className="ba-review-list" aria-label="待审核操作">{entries.map(entry => <button type="button" className="ba-review-row" key={entry.key} onClick={event => openDetail(entry.key, event)}><span className="ba-review-row-icon"><ResourceIcon name="key" size={18} /></span><span className="ba-review-row-copy"><strong>{reviewDisplayText(entry.origin.title || '待授权操作')}</strong><span>{reviewDisplayText(entry.origin.sourceTitle || (entry.origin.ownerThreadId === 'main' ? '主聊天' : '旁聊'))} · {entry.origin.kind === 'worker' ? '任务操作' : '对话操作'}</span><small>等待你的决定</small></span><span className="ba-review-row-arrow"><UIIcon name="chevronLeft" size={16} /></span></button>)}</nav>}
    </div>
    {selectedKey && (error ? <ResourceState kind="error" title="审核列表暂时无法读取" description={error} />
      : selected ? <ApprovalDetail key={selected.key} entry={selected} api={api} current={current} SessionProvider={SessionProvider} renderSlot={renderSlot} />
      : selectedConnectionError ? <ResourceState kind="error" title="此审核所属会话暂未连接" description={selectedConnectionError.error} />
      : origins === null || connecting ? <ResourceState kind="loading" title="正在核对审核状态" />
      : <ResourceState icon="check" title="此审核已处理或失效" description="原请求已不可答复。返回列表查看仍需你决定的操作。" />)}
  </section>;
}

export function mountApprovalReview(ctx) {
  ctx.effect(() => ctx.slots.inject(REVIEW_APPROVAL_SLOT, () => ctx.slots.register({ name: REVIEW_APPROVAL_SLOT }, OfficialReviewApproval)));
}
