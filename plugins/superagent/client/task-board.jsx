import React, { useRef } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { groupTasks } from './task-board.mjs';
import css from './task-board.css';

export function TaskViewControls({ view, onViewChange, archiveScope, onArchiveScopeChange, query, onQueryChange, archiveAction, children, disabled = false, panelId, tabIdPrefix }) {
  const search = useRef(null);
  const clear = () => { onQueryChange(''); search.current?.focus(); };
  return <div className="ba-task-view-controls"><style>{css}</style>
    {onArchiveScopeChange && <SegmentedControl label="任务记录" value={archiveScope} onChange={onArchiveScopeChange} disabled={disabled} options={[
      { value: 'active', label: '当前任务', tooltip: '当前任务（含未归档的已结束任务）', iconOnly: true, icon: <UIIcon name="box" size={18} /> },
      { value: 'archived', label: '已归档', tooltip: '已归档任务', iconOnly: true, icon: <UIIcon name="archive" size={18} /> },
    ]} />}
    <SegmentedControl label="任务视图" value={view} onChange={onViewChange} disabled={disabled} panelId={panelId} tabIdPrefix={tabIdPrefix} options={[
      { value: 'list', label: '列表', tooltip: '列表视图', iconOnly: true, icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg> },
      { value: 'board', label: '看板', tooltip: '看板视图', iconOnly: true, icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="7" height="16" rx="2" /><rect x="14" y="4" width="7" height="10" rx="2" /></svg> },
    ]} />
    <div className="ba-task-search"><UIIcon name="search" size={16} /><input ref={search} type="search" aria-label="搜索任务" placeholder="搜索名称、要求或来源" value={query} disabled={disabled} onChange={event => onQueryChange(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); clear(); } }} />
      {query && <Button variant="ghost" type="button" className="ba-task-search-clear" aria-label="清除搜索" title="清除搜索" disabled={disabled} onClick={clear}><UIIcon name="close" size={14} /></Button>}
    </div>
    {archiveAction && <div className="ba-task-archive-action">{archiveAction}</div>}
    {children}
  </div>;
}

export function TaskBoard({ rows, renderTask }) {
  return <div className="ba-task-board-frame"><style>{css}</style><div className="ba-task-board" aria-label="任务看板">
    {groupTasks(rows).map(lane => <section key={lane.id} className="ba-task-lane" data-lane={lane.id} aria-label={`${lane.title}，${lane.rows.length} 项`}>
      <header><h3>{lane.title}</h3><span>{lane.rows.length}</span></header>
      <div className="ba-task-lane-rows">{lane.rows.length ? lane.rows.map(renderTask) : <p className="ba-task-lane-empty">{lane.empty}</p>}</div>
    </section>)}
  </div></div>;
}
