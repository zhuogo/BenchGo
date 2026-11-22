import React, { useEffect, useRef, useState } from 'react';
import { UIIcon } from '../../base/client/iconsax.jsx';
import { Button } from '../../shared/client/ui/button.jsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../../shared/client/ui/dialog.jsx';

function createDocumentation({ url, token, relay, relayTarget }) {
  const request = body => JSON.stringify({ path: '/api/commander/assistant', body }, null, 2);
  return [
  '# BenchGo 外部集成 API',
  '',
  '请根据以下契约编写 BenchGo 接入代码，把地址和 Token 放在运行环境配置中。',
  '',
  '## 请求与认证',
  '',
  '- 在 BenchGo「多平台 → 外部集成」中启用并保存配置。',
  url ? `请求地址：POST ${url}${relay ? '（Link 中继）' : ''}` : '请求地址：当前没有可用地址。连接 Link 中继或从 BenchGo 的 HTTPS 网页打开文档。',
  '',
  '```http',
  'Content-Type: application/json',
  `Authorization: Bearer ${token || '<启用并保存后显示 API Token>'}`,
  ...(relayTarget ? [`X-BenchGo-Relay-Target: ${relayTarget}`] : []),
  '```',
  '',
  'API Token 代表设备组拥有者。轮换后，使用新 Token 更新调用方。请求里的 `path` 指定 BenchGo API，`body` 是原接口的 JSON。省略 `method` 时使用 POST。',
  '',
  '## 提交消息',
  '',
  '```json',
  request({ action: 'connectionAction', channel: 'api', operation: 'submit', requestId: 'req-001', conversationId: 'demo-chat', text: '请总结这段项目进展：……' }),
  '```',
  '',
  '- 每次新提交生成唯一的 `requestId`，重试同一提交时沿用它。同一 `conversationId` 用于续聊。',
  '- 响应返回 `accepted`、`requestId`、`threadId` 和 `result`。保存返回的 `threadId`，直接回复可按 `result.trigger.id`（如果存在）与回复中的 `triggerId` 关联。`accepted` 仅表示接收阶段，处理结果需另查。',
  '',
  '## 查询直接回复',
  '',
  '```json',
  request({ action: 'connectionReplies', channel: 'api', threadId: '<提交响应中的 threadId>' }),
  '```',
  '',
  '返回 `replies`，其中包含 `triggerId`、`text` 和 `state`。',
  '',
  '## 查询任务状态',
  '',
  '```json',
  request({ action: 'tasks', taskId: '<已知的 taskId>' }),
  '```',
  '',
  '返回 `tasks`。已知任务 ID 时按 ID 查询。请检查 HTTP 状态和响应中的 `error`，异步查询使用有限次数的轮询。',
  ].join('\n');
}

export function IntegrationApiDocs({ api, enabled }) {
  const preview = useRef(null);
  const pending = useRef(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [details, setDetails] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => pending.current?.abort(), []);
  const origin = window.location.origin;
  const direct = new URL(window.location.href);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(direct.hostname);
  const fallback = !direct.pathname.startsWith('/link/') && (direct.protocol === 'https:' || direct.protocol === 'http:' && local)
    ? `${origin}/api/commander-integration` : undefined;
  const documentation = createDocumentation({ url: fallback, ...details?.endpoint, token: details?.token });
  const load = async (operation = 'read') => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setBusy(true); setError(''); setCopyStatus('');
    try {
      const result = await api('integrationToken', { operation, revision: details?.revision }, request.signal);
      if (!request.signal.aborted) {
        setDetails(result);
        if (operation === 'rotate' && result.token) setCopyStatus('已轮换');
      }
    } catch (cause) {
      if (!request.signal.aborted) { setDetails(null); setError(cause.message || '暂时无法读取 API Token'); }
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  };
  const copy = async event => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(documentation);
    } catch {
      const field = preview.current;
      if (!field) return;
      field.focus({ preventScroll: true });
      field.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { /* Keep the text selected for manual copying. */ }
      if (!copied) { setCopyStatus('请手动复制已选中的文档'); return; }
      button.focus({ preventScroll: true });
    }
    if (button.isConnected) setCopyStatus('已复制');
  };

  return <Dialog onOpenChange={open => {
    if (open) { setDetails(null); void load(); }
    else { pending.current?.abort(); setDetails(null); }
  }}>
    <DialogTrigger asChild><Button variant="outline"><UIIcon name="document" size={16} />API 文档</Button></DialogTrigger>
    <DialogContent className="ba-integration-docs" closeLabel="关闭 API 文档">
      <DialogTitle>外部集成 API 文档</DialogTitle>
      <DialogDescription>包含认证要求和请求示例。复制内容可以直接分享给 AI。</DialogDescription>
      {details?.token && <p className="ba-integration-docs-sensitive">文档及复制内容包含当前拥有者 Token。仅分享给你信任的接收方。</p>}
      <textarea ref={preview} className="ba-integration-docs-preview" aria-label="API 文档内容" value={documentation} readOnly spellCheck={false} />
      <footer className="ba-integration-docs-actions">
        <span role="status">{error || (busy ? '正在读取 API Token…' : copyStatus)}</span>
        {error && <Button variant="outline" onClick={() => load()}>重试</Button>}
        {enabled && details?.token && <Button variant="outline" disabled={busy} onClick={() => load('rotate')}>轮换 Token</Button>}
        <Button disabled={busy || enabled && !details?.token} onClick={copy}><UIIcon name="copy" size={16} />复制给 AI</Button>
      </footer>
    </DialogContent>
  </Dialog>;
}
