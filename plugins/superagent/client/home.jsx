import { Button } from '../../shared/client/ui/button.jsx';
import React, { useRef, useState } from 'react';
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { PetAvatar } from '../../shared/client/pet-avatar.jsx';
import { petImageUrl } from './pet-state.mjs';
import { UIIcon } from '../../base/client/iconsax.jsx';
import { activityLabels, groupHomeActivity } from './activity-data.mjs';
import { useAssistantActivity } from './use-activity.jsx';
import css from './home.css';

const starters = [
  { title: '梳理重点', detail: '找出下一步', icon: 'filter', tone: 'ink', prompt: '帮我梳理当前目标和待办，找出最值得先推进的三件事；缺少的信息先问我。' },
  { title: '推进目标', detail: '把目标拆成行动', icon: 'flash', tone: 'coral', prompt: '我想推进一个目标：\n\n请先和我明确预期结果与约束，再拆成可执行的步骤。' },
  { title: '整理资料', detail: '提炼结论与待办', icon: 'archive', tone: 'green', prompt: '请帮我整理接下来提供的资料，提炼关键结论、待确认的问题和下一步行动。' },
];

function ActivitySection({ title, rows, tone, onOpenResources }) {
  if (!rows.length) return null;
  return <section className="ba-home-section" data-tone={tone}>
    <header><h2>{title}</h2><Tooltip label="管理任务" side="top" delayMs={350} portal><Button variant="ghost" type="button" className="ba-home-resource" aria-label="管理任务" onClick={() => onOpenResources('tasks')}><UIIcon name="schedules" size={18} /></Button></Tooltip></header>
    <div>{rows.map(row => <article className="ba-home-task" key={row.key}>
      <span className="ba-home-task-status">{activityLabels[row.status] || row.status || '状态未知'}</span>
      <strong>{row.title}</strong>
    </article>)}</div>
  </section>;
}

export function AssistantHome({ api, assistantName, assistantConfig, onOpenResources, input, inputActions }) {
  const { rows, error, loading, refresh, updated } = useAssistantActivity(api);
  const groups = groupHomeActivity(rows || []);
  const hasWork = groups.attention.length + groups.active.length > 0;
  const root = useRef(null), [notice, setNotice] = useState('');
  const canDraft = input?.phase === 'plain' && !input.draft && !input.occurrences?.length;
  const prepare = prompt => {
    if (!canDraft) return;
    const inserted = inputActions.insertText(prompt, inputActions.captureInsertion());
    if (!inserted) { setNotice('输入内容已变化，请在输入框中继续。'); return; }
    inputActions.persistDraft();
    setNotice('已放入输入框，可以修改后发送。');
    root.current?.closest('[data-assistant-chat]')?.querySelector('[data-composer-card] [contenteditable="true"], [data-composer-card] textarea')?.focus();
  };
  return <section className="ba-home" ref={root} aria-label="SuperAgent 工作简报" data-has-work={hasWork}>
    <style>{css}</style>
    <header className="ba-home-intro">
      <div className="ba-home-copy">
        <h1>{hasWork ? <>每一步，<br /><span>都在向前。</span></> : <>把想法，<br /><span>推进成结果。</span></>}</h1>
      </div>
      <div className="ba-home-art" aria-hidden="true">
        <div className="ba-home-paper" />
        <div className="ba-home-mascot"><PetAvatar pet={assistantConfig?.pet} src={petImageUrl(assistantConfig?.pet, document.baseURI)} size="100%" /></div>
        <svg className="ba-home-pencil-marks" viewBox="0 0 272 210" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path className="ba-home-pencil-ink" d="m25 85-13-8m17-1-6-15m213 110 14 4m-18 3 10 10" />
          <path className="ba-home-pencil-coral" d="M221 37c9 1 12-4 14-14 1 12 5 15 14 17-10 2-13 6-15 15-1-10-4-15-13-18Z" />
          <path className="ba-home-pencil-green" d="M18 158c-7 9 8 23 32 26 14 2 21-6 17-11-5-7-19 2-14 10 5 7 22 10 40 5m-9-8 10 8-8 7" />
        </svg>
      </div>
      <div className="ba-home-byline"><span>{(assistantConfig?.name ?? assistantName) || '你的总助手'} · 工作简报</span><span>{updated ? <><span className="ba-home-live" />已同步</> : '从这里开始'}</span></div>
    </header>
    {error && <div className="ba-home-error" role="alert"><span>{rows ? '暂时无法更新，以下为上次同步的任务。' : '暂时无法读取任务。'}<small>{error}</small></span><Button variant="ghost" type="button" onClick={refresh} disabled={loading}>{loading ? '重试中…' : '重试'}</Button></div>}
    {rows === null && !error ? <div className="ba-home-loading" role="status"><span />正在整理工作简报…</div> : <div className="ba-home-brief">
      <ActivitySection title="需要你关注" rows={groups.attention} tone="attention" onOpenResources={onOpenResources} />
      <ActivitySection title="正在推进" rows={groups.active} tone="active" onOpenResources={onOpenResources} />
      {!hasWork && rows !== null && !error && rows.length > 0 && <div className="ba-home-rest"><span>当前没有需要推进的事项。</span><Button variant="ghost" type="button" onClick={() => onOpenResources('tasks')}>查看任务记录</Button></div>}
    </div>}
    <nav className="ba-home-starters" aria-label="开始一项工作">{starters.map(starter => <Button variant="ghost" type="button" key={starter.title} onClick={() => prepare(starter.prompt)} disabled={!canDraft} title={!canDraft ? '请先完成当前草稿，再使用快捷起草' : `起草：${starter.title}`} data-tone={starter.tone}><span className="ba-home-starter-icon"><UIIcon name={starter.icon} size={18} /></span><span className="ba-home-starter-copy"><strong>{starter.title}</strong><small>{starter.detail}</small></span></Button>)}</nav>
    <footer className="ba-home-footer"><span role="status">{notice}</span><Tooltip label="记忆与档案" side="top" delayMs={350} portal><Button variant="ghost" type="button" className="ba-home-resource" aria-label="记忆与档案" onClick={() => onOpenResources('memory')}><UIIcon name="archive" size={18} /></Button></Tooltip></footer>
  </section>;
}
