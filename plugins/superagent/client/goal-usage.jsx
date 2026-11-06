import React from 'react';

/** Read-only usage ledger: tokens and requests are recorded for display, never enforced (budget gates removed 2026-11-06). */
export function GoalUsage({ row }) {
  const usage = row.budgetState?.usage;
  if (!usage) return null;
  return <div className="ba-goal-budget"><p className="ba-note">累计用量（仅统计，不限制执行）</p>
    <div className="ba-goal-fields"><div><span>请求次数：</span><strong>{usage.requests ?? '—'}</strong></div><div><span>Token：</span><strong>{usage.tokens ?? '—'}</strong></div></div>
    {!!usage.unknownTokens && <p className="ba-note">另有 {usage.unknownTokens} 次请求未报告 Token 用量，以上仅为已知累计。</p>}
  </div>;
}
