import React, { useRef } from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { SegmentedControl } from '../../shared/client/segmented-control.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { groupTickets } from './ticket-board.mjs';
import css from './ticket-board.css';

export function TicketViewControls({ view, onViewChange, query, onQueryChange, count, total, disabled = false, panelId, tabIdPrefix }) {
  const search = useRef(null);
  const clear = () => { onQueryChange(''); search.current?.focus(); };
  return <div className="ba-ticket-view-controls"><style>{css}</style>
    <SegmentedControl label="工单视图" value={view} onChange={onViewChange} disabled={disabled} panelId={panelId} tabIdPrefix={tabIdPrefix} options={[
      { value: 'list', label: '列表' }, { value: 'board', label: '看板' },
    ]} />
    <div className="ba-ticket-search"><UIIcon name="search" size={16} /><input ref={search} type="search" aria-label="搜索工单" placeholder="搜索名称、要求或来源" value={query} disabled={disabled} onChange={event => onQueryChange(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); clear(); } }} />
      {query && <Button variant="ghost" type="button" className="ba-ticket-search-clear" aria-label="清除搜索" title="清除搜索" disabled={disabled} onClick={clear}><UIIcon name="close" size={14} /></Button>}
    </div>
    <span className="ba-ticket-count" role="status">{query ? `${count} / ${total} 项` : `${total} 项工单`}</span>
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
