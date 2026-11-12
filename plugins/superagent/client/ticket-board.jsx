import React, { useRef } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { groupTickets } from './ticket-board.mjs';
import css from './ticket-board.css';

export function TicketViewControls({ view, onViewChange, archiveScope, onArchiveScopeChange, query, onQueryChange, archiveAction, children, disabled = false, panelId, tabIdPrefix }) {
  const search = useRef(null);
  const clear = () => { onQueryChange(''); search.current?.focus(); };
  return <div className="ba-ticket-view-controls"><style>{css}</style>
    {onArchiveScopeChange && <SegmentedControl label="工单记录" value={archiveScope} onChange={onArchiveScopeChange} disabled={disabled} options={[
      { value: 'active', label: '当前工单', tooltip: '当前工单（含未归档的已结束工单）', iconOnly: true, icon: <UIIcon name="box" size={18} /> },
      { value: 'archived', label: '已归档', tooltip: '已归档工单', iconOnly: true, icon: <UIIcon name="archive" size={18} /> },
    ]} />}
    <SegmentedControl label="工单视图" value={view} onChange={onViewChange} disabled={disabled} panelId={panelId} tabIdPrefix={tabIdPrefix} options={[
      { value: 'list', label: '列表', tooltip: '列表视图', iconOnly: true, icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg> },
      { value: 'board', label: '看板', tooltip: '看板视图', iconOnly: true, icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="7" height="16" rx="2" /><rect x="14" y="4" width="7" height="10" rx="2" /></svg> },
    ]} />
    <div className="ba-ticket-search"><UIIcon name="search" size={16} /><input ref={search} type="search" aria-label="搜索工单" placeholder="搜索名称、要求或来源" value={query} disabled={disabled} onChange={event => onQueryChange(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); clear(); } }} />
      {query && <Button variant="ghost" type="button" className="ba-ticket-search-clear" aria-label="清除搜索" title="清除搜索" disabled={disabled} onClick={clear}><UIIcon name="close" size={14} /></Button>}
    </div>
    {archiveAction && <div className="ba-ticket-archive-action">{archiveAction}</div>}
    {children}
  </div>;
}

export function TicketBoard({ rows, renderTicket }) {
  return <div className="ba-ticket-board-frame"><style>{css}</style><div className="ba-ticket-board" aria-label="工单看板">
    {groupTickets(rows).map(lane => <section key={lane.id} className="ba-ticket-lane" data-lane={lane.id} aria-label={`${lane.title}，${lane.rows.length} 项`}>
      <header><h3>{lane.title}</h3><span>{lane.rows.length}</span></header>
      <div className="ba-ticket-lane-rows">{lane.rows.length ? lane.rows.map(renderTicket) : <p className="ba-ticket-lane-empty">{lane.empty}</p>}</div>
    </section>)}
  </div></div>;
}
