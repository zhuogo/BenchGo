import React from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import typographyCss from '../../shared/client/chat-typography.css';
import css from './quiet-chat.css';

export function ChatNotice({ message, children, noticeKey, alert = true }) {
  return <article className="ba-chat-message" data-role="assistant" data-chat-key={noticeKey}>
    <div className="ba-chat-body"><div className="ba-chat-content ba-chat-notice">
      {message && <p role={alert ? 'alert' : undefined}>{message}</p>}
      {children}
    </div></div>
  </article>;
}

export function ChatNoticeFeed({ message, onRetry, retryLabel = '重新连接' }) {
  return <div className="ba-chat-viewport"><div className="ba-chat-feed" aria-label="聊天记录" tabIndex={0}>
    <style>{css}{typographyCss}</style>
    <section className="ba-quiet-chat"><div className="ba-quiet-chat-column">
      <ChatNotice message={message}>
        {onRetry && <Button variant="ghost" type="button" onClick={onRetry}>{retryLabel}</Button>}
      </ChatNotice>
    </div></section>
  </div></div>;
}
