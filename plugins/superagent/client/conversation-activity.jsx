import React from 'react';

export function ConversationActivity({ activity, compact = false }) {
  if (!activity) return compact ? <span className="ba-conversation-ready">就绪</span> : null;
  return <span className={`ba-chat-work${compact ? ' ba-chat-work-compact' : ''}`} role={compact ? 'img' : 'status'} aria-label={activity.label} data-activity={activity.kind}>
    {activity.subtle ? <span className="ba-chat-dots" aria-hidden="true"><i /><i /><i /></span> : <span className="ba-chat-work-label">{activity.label}</span>}
  </span>;
}
