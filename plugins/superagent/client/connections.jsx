import React, { useEffect, useRef, useState } from 'react';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import { ChannelBrandIcon } from '../../shared/client/channel-brand-icon.jsx';
import { CustomSelect } from '../../shared/client/custom-select.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import css from './connections.css';
import feishuCss from './feishu-settings.css';
import { Disclosure } from '../../shared/client/ui/collapsible.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import QRCode from 'qrcode';

const textConfig = config => Object.fromEntries(Object.entries(config || {}).map(([key, value]) => [key, Array.isArray(value) && key !== 'groups' ? value.join('\n') : value]));
const listField = field => ['list', 'array', 'string[]', 'textarea'].includes(field.type) || Array.isArray(field.default);
const available = status => status?.enabled === true;
const stateLabel = status => !status?.enabled ? '' : ({ connected: '已连接', connecting: '连接中', reconnecting: '重连中', failed: '连接失败', stopped: '已停止', listening: '监听中', idle: '待连接', error: '连接失败', unavailable: '不可用', disabled: '' })[status?.connection?.state] || '未连接';
const connectionTone = status => !status?.enabled ? 'neutral' : ['connected', 'listening'].includes(status?.connection?.state) ? 'success' : ['failed', 'error', 'unavailable'].includes(status?.connection?.state) ? 'error' : 'pending';
function ConnectionState({ icon = 'link', title, description, loading = false, children }) {
  return <div className="ba-connection-placeholder" role="status" aria-busy={loading}><span className="ba-connection-placeholder-icon"><UIIcon name={icon} size={26} /></span><strong>{title}</strong><p>{description}</p>{loading && <div className="ba-connection-skeleton" aria-hidden="true"><span /><span /><span /></div>}{children}</div>;
}
export function Connections({ api, onDirtyChange }) {
  const [catalog, setCatalog] = useState([]), [channel, setChannel] = useState('feishu');
  const [base, setBase] = useState(null), [draft, setDraft] = useState(null), [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [secrets, setSecrets] = useState({});
  const [login, setLogin] = useState(null);
  const [chatList, setChatList] = useState(null), [chatError, setChatError] = useState('');
  const [chatSearch, setChatSearch] = useState(''), [manualChatId, setManualChatId] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const generation = useRef(0), loginSession = useRef(null), retryAction = useRef(null), form = useRef(null);
  const cancelLogin = () => {
    const current = loginSession.current; loginSession.current = null; setLogin(null);
    if (current) void api('connectionAction', { channel: current.channel, operation: 'cancelLogin', loginId: current.loginId }).catch(() => {});
  };
  const loginAction = async operation => {
    retryAction.current = () => loginAction(operation);
    setBusy(true); setError(''); setNotice('');
    const request = generation.current;
    try {
      const value = await api('connectionAction', { channel, operation, ...(loginSession.current ? { loginId: loginSession.current.loginId } : {}) });
      if (request !== generation.current) { if (value.loginId) void api('connectionAction', { channel, operation: 'cancelLogin', loginId: value.loginId }).catch(() => {}); return; }
      if (operation === 'startLogin') {
        loginSession.current = { channel, loginId: value.loginId };
        const image = await QRCode.toDataURL(value.qrContent, { width: 224, margin: 2 });
        if (request !== generation.current) return;
        setLogin({ ...value, image });
      } else if (value.status === 'confirmed') {
        loginSession.current = null; setLogin(null);
        setDraft(current => ({ ...current, accountId: value.config.accountId, tokenRef: value.config.tokenRef, baseUrl: value.config.baseUrl, ...(!current.ownerIds?.trim() && value.config.ownerIds?.length ? { ownerIds: value.config.ownerIds.join('\n') } : {}) }));
        setNotice('扫码成功，凭据已安全保存。请保存更改后启用连接。');
      } else if (value.status === 'expired') { loginSession.current = null; setLogin(null); setNotice('二维码已过期，请重新扫码连接。'); }
      else setLogin(current => ({ ...current, status: value.status }));
    } catch (cause) { setError(cause.message); } finally { if (request === generation.current) setBusy(false); }
  };
  const definition = catalog.find(item => item.id === channel);
  const fields = (definition?.fields || []).filter(field => field.key !== 'enabled').map(field => definition?.capabilities?.qrLogin && ['accountId', 'tokenRef'].includes(field.key) ? { ...field, advanced: true } : field);
  const feishu = channel === 'feishu';
  const visibleFields = fields.filter(field => !field.hidden && (!feishu || !['accessMode', 'directMessages', 'groups', 'otherGroups', 'chatIds', 'botOpenId'].includes(field.key)) && (!feishu || field.key !== 'ownerOpenIds' || draft?.accessMode !== 'platform'));
  const dirty = !!base && (JSON.stringify(draft) !== JSON.stringify(textConfig(base.config)) || Object.values(secrets).some(Boolean));
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  const load = async (target = channel, refreshCatalog = false) => {
    retryAction.current = () => load(target, refreshCatalog);
    const request = ++generation.current;
    cancelLogin(); setBusy(true); setError(''); setNotice(''); setSecrets({}); setChatList(null); setChatError(''); setChatLoading(false); setChatSearch(''); setManualChatId('');
    try {
      const [value, state, listing] = await Promise.all([api('connections', { channel: target }), api('connectionStatus', { channel: target }), refreshCatalog ? api('connectionCatalog') : null]);
      if (request !== generation.current) return;
      if (listing) setCatalog(listing.channels || []);
      const nextDraft = textConfig(value.config);
      if (target === 'feishu' && value.revision === 0 && !value.config.appId && !value.config.appSecretRef && !value.config.ownerOpenIds?.length && !value.config.chatIds?.length) Object.assign(nextDraft, { accessMode: 'platform', groups: [], directMessages: true, otherGroups: 'disabled' });
      setBase(value); setDraft(nextDraft); setStatus(state);
      setCatalog(items => items.map(item => item.id === target ? { ...item, status: state } : item));
    } catch (cause) { if (request === generation.current) setError(cause.message); }
    finally { if (request === generation.current) setBusy(false); }
  };
  useEffect(() => { void load('feishu', true); return () => { generation.current++; cancelLogin(); }; }, []);
  const choose = next => {
    if (next === channel || busy || (dirty && !window.confirm('切换渠道会放弃未保存的修改。'))) return;
    setSecrets({}); setChannel(next); setBase(null); setDraft(null); setStatus(null); void load(next);
  };
  const updateStatus = state => { setStatus(state); setCatalog(items => items.map(item => item.id === channel ? { ...item, status: state } : item)); };
  useEffect(() => {
    if (busy || !base?.config.enabled) return;
    let cancelled = false, timer;
    const request = generation.current;
    const refreshStatus = async () => {
      try {
        const next = await api('connectionStatus', { channel });
        if (!cancelled && request === generation.current) updateStatus(next);
      } catch { /* Keep the last confirmed status; manual verification reports errors. */ }
      finally { if (!cancelled) timer = setTimeout(refreshStatus, 3000); }
    };
    timer = setTimeout(refreshStatus, 3000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [channel, busy, base?.config.enabled, api]);
  const save = async event => {
    retryAction.current = () => form.current?.requestSubmit();
    event.preventDefault(); if (busy) return; setBusy(true); setError(''); setNotice('');
    try {
      const missingChoice = draft.enabled && visibleFields.find(field => field.options && field.required && (draft[field.key] == null || draft[field.key] === ''));
      if (missingChoice) throw new Error(`请选择${missingChoice.label || missingChoice.key}`);
      const missingAdvanced = draft.enabled && visibleFields.find(field => field.advanced && field.required && !String(field.key.endsWith('Ref') ? secrets[field.key] || draft[field.key] || '' : draft[field.key] ?? '').trim());
      if (missingAdvanced) { setAdvancedOpen(true); throw new Error(`请填写${missingAdvanced.label || missingAdvanced.key}`); }
      const savedDraft = { ...draft };
      for (const [field, secret] of Object.entries(secrets)) {
        if (!secret) continue;
        const value = await api('connectionCredential', { channel, field, secret });
        if (!value.ref) throw new Error('凭据保存失败，请重试');
        savedDraft[field] = value.ref;
        setDraft(current => ({ ...current, [field]: value.ref }));
        setSecrets(current => ({ ...current, [field]: '' }));
      }
      const previous = textConfig(base.config), patch = {};
      for (const key of new Set(['enabled', ...fields.map(field => field.key), ...(feishu ? ['accessMode', 'directMessages', 'groups', 'otherGroups'] : [])])) {
        if (JSON.stringify(savedDraft[key]) === JSON.stringify(previous[key])) continue;
        const field = fields.find(item => item.key === key);
        patch[key] = key === 'groups' ? savedDraft[key] : field && (listField(field) || Array.isArray(base.config[key])) ? String(savedDraft[key] || '').split('\n').map(value => value.trim()).filter(Boolean) : field?.type === 'number' ? (savedDraft[key] === '' ? null : Number(savedDraft[key])) : savedDraft[key];
      }
      const value = await api('connectionConfigure', { channel, patch, revision: base.revision });
      setBase(value); setDraft(textConfig(value.config)); setNotice('已保存');
      try { updateStatus(await api('connectionStatus', { channel })); } catch (cause) { setError('已保存，但状态刷新失败：' + cause.message); }
    } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  const verify = async () => {
    retryAction.current = verify;
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await api('connectionVerify', { channel });
      if (value.config) { setBase(value); setDraft(textConfig(value.config)); }
      updateStatus(value.status || value);
      setNotice('验证完成；认证、接收和发送状态分别显示，实际收发请在原渠道确认。');
    } catch (cause) { setError(cause.message); try { updateStatus(await api('connectionStatus', { channel })); } catch {} }
    finally { setBusy(false); }
  };
  const listChats = async (more = false) => {
    const request = generation.current;
    setBusy(true); setChatLoading(true); setChatError('');
    try {
      const value = await api('connectionAction', { channel, operation: 'listChats', ...(more && chatList?.nextPageToken ? { pageToken: chatList.nextPageToken } : {}) });
      if (request !== generation.current) return;
      setChatList(current => ({ chats: [...new Map([...(more ? current?.chats || [] : []), ...(value.chats || [])].map(chat => [chat.chatId, chat])).values()], nextPageToken: value.nextPageToken }));
    } catch (cause) { if (request === generation.current) setChatError(cause.message); }
    finally { if (request === generation.current) { setBusy(false); setChatLoading(false); } }
  };
  const updateGroup = (chat, mode) => setDraft(current => {
    const groups = current.groups || [];
    return { ...current, groups: groups.some(row => row.chatId === chat.chatId) ? groups.map(row => row.chatId === chat.chatId ? { ...row, mode } : row) : [...groups, { chatId: chat.chatId, ...(chat.name ? { name: chat.name } : {}), mode }] };
  });
  const groupRows = [...new Map([...(chatList?.chats || []), ...(draft?.groups || [])].map(chat => [chat.chatId, chat])).values()].filter(chat => !chatSearch || `${chat.name || ''} ${chat.chatId}`.toLowerCase().includes(chatSearch.toLowerCase()));
  const renderField = field => {
    const { key, label, required, options } = field;
    const isList = listField(field) || Array.isArray(base.config[key]);
    const common = { id: `ba-channel-${key}`, required: !!required && !!draft.enabled, value: draft[key] ?? '', onChange: event => setDraft({ ...draft, [key]: event.target.value }) };
    if (key.endsWith('Ref')) return <div key={key} className="ba-connection-field">
      <label htmlFor={common.id}>{label || key}{required && ' *'}</label>
      <div className={feishu ? 'ba-feishu-secret-row' : undefined}><input id={common.id} type="password" required={common.required && !draft[key]} value={secrets[key] || ''} onChange={event => setSecrets(values => ({ ...values, [key]: event.target.value }))} autoComplete="new-password" placeholder={draft[key] ? '已配置，留空保持不变' : '输入密钥'} />
      {feishu && (secrets[key] || draft[key]) && <Button variant="outline" type="button" onClick={() => { if (secrets[key]) setSecrets(values => ({ ...values, [key]: '' })); else setDraft(values => ({ ...values, [key]: '' })); }}>{secrets[key] ? '取消输入' : '清除'}</Button>}</div>
      {!feishu && (secrets[key] || draft[key]) && <span className="ba-row-actions">
        {!!secrets[key] && <Button variant="ghost" type="button" onClick={() => setSecrets(values => ({ ...values, [key]: '' }))}>取消输入</Button>}
        {!!draft[key] && <Button variant="ghost" type="button" onClick={() => { setDraft(values => ({ ...values, [key]: '' })); setSecrets(values => ({ ...values, [key]: '' })); }}>清除</Button>}
      </span>}
      {!feishu && (field.help || field.description) && <small>{field.help || field.description}</small>}
    </div>;
    return <div key={key} className="ba-connection-field"><label htmlFor={common.id}>{label || key}{required && ' *'}</label>
      {field.type === 'boolean' ? <input id={common.id} type="checkbox" checked={!!draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.checked })} /> : options ? <CustomSelect id={common.id} aria-label={label || key} aria-required={common.required || undefined} disabled={busy} value={String(common.value)} onChange={value => setDraft(current => ({ ...current, [key]: value }))} options={options.map(option => ({ value: String(option.value ?? option), label: option.label ?? option, disabled: !!option.disabled }))} /> : isList ? <textarea {...common} rows={3} placeholder={field.placeholder || '每行一个 ID'} /> : <input {...common} type={field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'} min={field.min} max={field.max} autoComplete="off" spellCheck={false} placeholder={field.placeholder} />}
      {!feishu && (field.help || field.description) && <small>{field.help || field.description}</small>}
    </div>;
  };
  const enableControl = draft && <label className="ba-connection-switch"><input type="checkbox" role="switch" aria-label={`启用${definition?.label}`} disabled={busy} checked={!!draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /><span>{feishu ? '启用连接' : '启用'}</span></label>;
  const verification = [
    { label: '平台认证', value: status?.authentication === 'verified' ? '已验证' : status?.authentication === 'host-authenticated' ? '主机认证' : status?.authentication === 'failed' ? '认证失败' : '未验证', tone: ['verified', 'host-authenticated'].includes(status?.authentication) ? 'success' : status?.authentication === 'failed' ? 'error' : 'neutral' },
    { label: '消息接收', value: status?.events === 'verified' ? '已验证' : '未验证', tone: status?.events === 'verified' ? 'success' : 'neutral' },
    { label: '结果发送', value: status?.sending === 'pull' ? '工单 / API 取结果' : status?.sending === 'verified' ? '已验证' : status?.sending === 'accepted' ? '已受理' : '未验证', tone: ['verified', 'pull'].includes(status?.sending) ? 'success' : status?.sending === 'accepted' ? 'pending' : 'neutral' },
  ];
  return <section className="ba-group ba-connections" data-channel={channel}><style>{css + feishuCss}</style>
    {!!catalog.length && <SegmentedControl options={catalog.map(item => ({ value: item.id, label: item.label, icon: <ChannelBrandIcon channel={item.id} available={available(item.id === channel ? status : item.status)} size={18} /> }))} value={channel} onChange={choose} disabled={busy} label="多平台渠道" tabIdPrefix="ba-channel" panelId="ba-channel-panel" />}
    {error && <div className="ba-error ba-connection-error" role="alert"><UIIcon name="link" size={18} /><div><strong>连接操作未完成</strong><p>{error}</p></div><Button variant="outline" type="button" disabled={busy} onClick={() => retryAction.current?.()}>重试</Button></div>}
    <div id="ba-channel-panel" role="tabpanel" aria-labelledby={`ba-channel-${channel}`} aria-busy={busy}>
      {!draft || !definition ? <ConnectionState icon={busy ? 'refresh' : 'link'} title={busy ? '正在读取连接配置' : error ? '暂时无法读取配置' : '暂未提供可配置渠道'} description={busy ? '正在同步平台信息与连接状态。' : error ? '配置保留在原处，恢复连接后即可继续。' : '刷新渠道目录后，再选择要接入的应用。'} loading={busy}>{!busy && <Button variant="outline" type="button" onClick={() => load(channel, true)}>重新加载</Button>}</ConnectionState> : <form ref={form} className="ba-connection-form" onSubmit={save} onInvalidCapture={event => { if (event.target.closest('.ba-channel-advanced')) setAdvancedOpen(true); }}>
        <section className="ba-connection-overview" aria-label="连接状态"><div><div className="ba-channel-title"><ChannelBrandIcon channel={channel} available={available(status)} size={28} /><strong>{definition.label}</strong><span className="ba-channel-status" data-tone={connectionTone(status)} role="status"><span className={`ba-connection-dot is-${status?.enabled ? status?.connection?.state || 'stopped' : 'stopped'}`} aria-hidden="true" />{status?.enabled ? stateLabel(status) : '未启用'}</span></div>{definition.description && <p>{definition.description}</p>}</div>
          {enableControl}
        </section>
        {status?.error && <div className="ba-error ba-connection-error" role="alert"><UIIcon name="link" size={18} /><div><strong>渠道连接需要检查</strong><p>{typeof status.error === 'string' ? status.error : status.error.message || '渠道暂不可用'}</p></div><Button variant="outline" type="button" disabled={busy || dirty} onClick={verify}>重新验证</Button></div>}
        {!feishu && definition.capabilities?.notes && <p className="ba-connection-inline-note">{Array.isArray(definition.capabilities.notes) ? definition.capabilities.notes.join('；') : definition.capabilities.notes}</p>}
        {!feishu && (status?.callback || definition.callback) && <div className="ba-connection-inline-note">{(status?.callback || definition.callback).path && <p>回调地址：<code>{(status?.callback || definition.callback).path}</code></p>}{(status?.callback || definition.callback).reason && <p>{(status?.callback || definition.callback).reason}</p>}</div>}
        {!feishu && definition.help && <p className="ba-connection-inline-note">{definition.help}</p>}
        {!feishu && definition.setupUrl && <p className="ba-connection-inline-note"><a href={definition.setupUrl} target="_blank" rel="noreferrer">打开官方配置页面</a></p>}
        <fieldset disabled={busy}>
          {definition.capabilities?.qrLogin && <section className="ba-connection-section ba-channel-login"><strong>微信扫码连接</strong><p className="ba-connection-inline-note">用微信扫描二维码并确认授权，无需手动填写账号与 Token。</p>{login ? <><img src={login.image} width="224" height="224" alt="微信连接二维码" /><p role="status">{login.status === 'scanned' ? '已扫码，请在微信确认授权。' : '等待扫码，完成后点击检查扫码状态。'}</p><div className="ba-row-actions"><Button variant="ghost" type="button" onClick={() => loginAction('pollLogin')}>检查扫码状态</Button><Button variant="ghost" type="button" onClick={cancelLogin}>取消扫码</Button></div></> : <Button variant="ghost" type="button" onClick={() => loginAction('startLogin')}>扫码连接</Button>}</section>}
          <section className="ba-connection-section ba-channel-setup">
            <div className="ba-connection-section-head"><div><h3><UIIcon name="settings" size={17} />{feishu ? '应用凭据' : '连接配置'}</h3><p>填写平台凭据，保存后验证连接。</p></div>{feishu && definition.setupUrl && <Button asChild variant="outline" size="sm"><a href={definition.setupUrl} target="_blank" rel="noreferrer">飞书开放平台 <UIIcon name="external" size={14} /></a></Button>}</div>
            <div className="ba-goal-fields">{visibleFields.filter(field => !field.advanced && (!feishu || field.key !== 'ownerOpenIds')).sort((a, b) => Number(!!b.required) - Number(!!a.required)).map(renderField)}</div>
            {fields.some(field => field.key.endsWith('Ref')) && <p className="ba-channel-credentials"><UIIcon name="check" size={15} />密钥加密保存；已配置的密钥留空即可保留。</p>}
            {feishu && (definition.help || definition.capabilities?.notes) && <Disclosure className="ba-feishu-guide" title="查看飞书端配置说明"><div className="ba-feishu-guide-copy">{definition.help && <p>{definition.help}</p>}{definition.capabilities?.notes && <p>{Array.isArray(definition.capabilities.notes) ? definition.capabilities.notes.join('；') : definition.capabilities.notes}</p>}</div></Disclosure>}
          </section>
          {feishu && <section className="ba-connection-section ba-channel-conversations">
            <div className="ba-connection-section-head"><div><h3><UIIcon name="userlib" size={17} />对话范围</h3><p>决定谁能发起任务，以及在哪些会话中响应。</p></div><span className="ba-channel-summary">{draft.groups == null ? '原有会话范围' : `${draft.groups.filter(group => group.mode !== 'disabled').length} 个群已开启`}</span></div>
            <div className="ba-goal-fields">
              <div className="ba-connection-field"><label htmlFor="ba-channel-accessMode">谁能发起任务</label><CustomSelect id="ba-channel-accessMode" value={draft.accessMode || 'owners'} onChange={value => setDraft(current => ({ ...current, accessMode: value }))} disabled={busy} options={[{"value":"platform","label":"沿用飞书应用可用范围"},{"value":"owners","label":"仅指定成员"}]} /></div>
              <div className="ba-connection-field"><label htmlFor="ba-channel-directMessages">机器人私聊</label><CustomSelect id="ba-channel-directMessages" value={draft.directMessages === false ? 'off' : 'on'} onChange={value => setDraft(current => ({ ...current, directMessages: value === 'on' }))} disabled={busy} options={[{"value":"on","label":"开启，无需 @"},{"value":"off","label":"关闭"}]} /></div>
              {visibleFields.filter(field => field.key === 'ownerOpenIds').map(renderField)}
            </div>
            {draft.groups == null ? <div className="ba-channel-legacy"><p className="ba-connection-inline-note">当前保留原有会话范围：{draft.chatIds ? '仅配置的会话' : '所有会话'}。切换为按群配置后，私聊独立控制，未选择的群将停用。</p>{fields.find(field => field.key === 'chatIds') && renderField(fields.find(field => field.key === 'chatIds'))}<Button variant="ghost" type="button" onClick={() => setDraft(current => ({ ...current, groups: String(current.chatIds || '').split('\n').filter(Boolean).map(chatId => ({ chatId, mode: 'mentions' })), otherGroups: 'disabled' }))}>改为按群配置</Button></div> : <>
              <div className="ba-channel-groups-head"><strong>群聊</strong><Button variant="outline" type="button" disabled={busy || dirty || !base.config.appId || !base.config.appSecretRef} onClick={() => listChats()}>刷新群列表</Button></div>
              {chatError && <div className="ba-error ba-connection-error" role="alert"><UIIcon name="link" size={18} /><div><strong>群列表暂时无法读取</strong><p>{chatError}。也可以手动添加群 ID。</p></div><Button variant="outline" type="button" disabled={busy} onClick={() => listChats()}>重试</Button></div>}
              {!!groupRows.length || chatSearch ? <input className="ba-channel-group-search" type="search" aria-label="搜索群名称或 ID" placeholder="搜索群名称或 ID" value={chatSearch} onChange={event => setChatSearch(event.target.value)} /> : null}
              <div className="ba-channel-group-list">{groupRows.map(chat => {
                const configured = draft.groups.find(row => row.chatId === chat.chatId);
                const mode = configured?.mode || draft.otherGroups || 'disabled';
                return <div className="ba-channel-group-row" key={chat.chatId}><label htmlFor={`ba-group-${chat.chatId}`}><strong><span className={`ba-connection-dot ${mode !== 'disabled' ? 'is-connected' : ''}`} aria-hidden="true" />{chat.name || chat.chatId}</strong>{chat.name && <small>{chat.chatId}</small>}{!configured && draft.otherGroups === 'mentions' && <small>沿用其他群设置</small>}</label><CustomSelect id={`ba-group-${chat.chatId}`} value={mode} onChange={value => updateGroup(chat, value)} disabled={busy} options={[{"value":"disabled","label":"停用"},{"value":"mentions","label":"仅 @ 时响应"},{"value":"all","label":"接收讨论作为上下文"}]} /></div>;
              })}</div>
              {!groupRows.length && !chatError && <ConnectionState icon={chatLoading ? 'refresh' : chatSearch ? 'search' : 'userlib'} title={chatLoading ? '正在读取群列表' : chatSearch ? '没有匹配的群' : '还没有配置群聊'} description={chatLoading ? '正在同步机器人已加入的群。' : chatSearch ? '试试其他名称，或清除搜索查看全部群聊。' : '保存应用凭据后刷新群列表，或通过群 ID 手动添加。'} loading={chatLoading}>{!chatLoading && (chatSearch ? <Button variant="ghost" type="button" onClick={() => setChatSearch('')}>清除搜索</Button> : <Button variant="outline" type="button" onClick={() => setManualOpen(true)}>手动添加群</Button>)}</ConnectionState>}
              {chatList?.nextPageToken && <Button variant="outline" type="button" onClick={() => listChats(true)}>加载更多群</Button>}
              <Disclosure className="ba-channel-manual" open={manualOpen} onOpenChange={setManualOpen} title={<span className="ba-feishu-disclosure-title">手动添加群 ID<small>{manualOpen ? '收起' : '展开'}</small></span>}><div className="ba-channel-manual-row"><input id="ba-feishu-manual-chat" aria-label="群 ID" placeholder="填写飞书 chat_id" value={manualChatId} onChange={event => setManualChatId(event.target.value)} /><Button variant="secondary" type="button" disabled={!manualChatId.trim()} onClick={() => { updateGroup({ chatId: manualChatId.trim() }, 'mentions'); setManualChatId(''); }}>添加群</Button></div></Disclosure>
            </>}
          </section>}
          {(visibleFields.some(field => field.advanced) || feishu) && <Disclosure className="ba-connection-section ba-channel-advanced" title={feishu ? <span className="ba-feishu-disclosure-title">高级设置<small>{advancedOpen ? '收起' : '展开'}</small></span> : '高级设置'} description={feishu ? undefined : '协议参数与平台扩展配置，按需调整'} open={advancedOpen} onOpenChange={setAdvancedOpen}><div className="ba-goal-fields">{visibleFields.filter(field => field.advanced).map(renderField)}{feishu && draft.groups != null && <div className="ba-connection-field"><label htmlFor="ba-channel-otherGroups">其他群</label><CustomSelect id="ba-channel-otherGroups" value={draft.otherGroups || 'disabled'} onChange={value => setDraft(current => ({ ...current, otherGroups: value }))} disabled={busy} options={[{"value":"disabled","label":"不响应"},{"value":"mentions","label":"仅 @ 时响应"}]} /></div>}{feishu && <div className="ba-connection-field"><label htmlFor="ba-channel-botOpenId">机器人身份（自动识别）</label><input id="ba-channel-botOpenId" readOnly value={draft.botOpenId || ''} placeholder="保存凭据后验证连接" /></div>}</div></Disclosure>}
        </fieldset>
        {status?.voice && <section className="ba-connection-section"><h3>实时语音</h3><p className="ba-connection-inline-note">{status.voice.available ? '在 Discord 文字频道发送 /join 加入、/leave 退出；需要主人已在语音频道。' : status.voice.reason || '当前环境暂不支持实时语音。'}</p></section>}
        <section className="ba-connection-section ba-channel-verification"><div className="ba-connection-section-head"><div><h3><UIIcon name="scan" size={17} />连接验证</h3><p>{dirty ? '先保存更改，再验证当前连接。' : '检查平台认证、消息接收与发送状态。'}</p></div><Button variant="outline" type="button" disabled={busy || dirty || (feishu ? !base.config.appId || !base.config.appSecretRef : !base.config.enabled)} onClick={verify}>验证连接</Button></div>
          {feishu && status?.botName && <p className="ba-connection-inline-note">机器人：{status.botName}</p>}
          <div className="ba-connection-checks" role="status">{verification.map(item => <div key={item.label} className="ba-connection-check" data-tone={item.tone}><span>{item.label}</span><strong><span className="ba-connection-dot" aria-hidden="true" />{item.value}</strong></div>)}</div>
        </section>
        <footer className="ba-identity-save" data-dirty={dirty}><span role="status">{notice || (dirty ? '有未保存的修改' : feishu ? '当前配置已保存' : '')}</span><div className="ba-row-actions">
          <Button variant={feishu ? 'outline' : 'ghost'} type="button" disabled={busy} onClick={() => { if (!dirty || window.confirm('重新加载会放弃未保存的修改。')) void load(channel, true); }}>重新加载</Button>

          <Button className="ba-primary" disabled={busy || !dirty} type="submit">{busy ? '处理中…' : '保存更改'}</Button>
        </div></footer>
      </form>}
    </div>
  </section>;
}
