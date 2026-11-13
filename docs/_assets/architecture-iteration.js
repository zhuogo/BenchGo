'use strict';
(() => {
  const data = JSON.parse(document.getElementById('architecture-data').textContent);
  const config = data.iteration;
  if (!config) return;
  const nodes = new Map(data.nodes.map(node => [node.id, node]));
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const fields = [['trigger','触发条件'],['actor','执行主体'],['via','通过什么'],['reads','读取来源'],['writes','写到哪里'],['use','后续怎么用'],['current','实现与验证边界']];
  const list = flow => {
    const dl = make('dl');
    for (const [key, label] of fields) if (flow[key]) {
      const dt = make('dt', label), dd = make('dd', flow[key]);
      if (key === 'current') dd.className = 'iteration-current';
      dl.append(dt, dd);
    }
    return dl;
  };
  const panel = make('dialog', undefined, 'iteration-panel');
  panel.id = 'iteration-files'; panel.setAttribute('aria-labelledby', 'iteration-files-title');
  const top = make('header', undefined, 'iteration-top');
  const title = make('div');
  const heading = make('h2', '自我迭代 · 文件与流向'); heading.id = 'iteration-files-title';
  title.append(heading, make('small', '一个大组 · 四个小组 · 11 项职责 · 源码接线与效果验证分开'));
  const close = make('button', '×', 'btn icon'); close.type = 'button'; close.setAttribute('aria-label', '关闭文件与流向');
  top.append(title, close); panel.append(top, make('p', config.intro));
  const nav = make('nav', undefined, 'iteration-nav'); nav.setAttribute('aria-label', '文件与流向目录'); panel.append(nav);
  const section = (id, name) => {
    const block = make('section', undefined, 'iteration-section'); block.id = `iteration-${id}`;
    block.append(make('h3', name)); panel.append(block);
    const button = make('button', name, 'btn outline'); button.type = 'button';
    button.onclick = () => block.scrollIntoView({block:'start'}); nav.append(button);
    return block;
  };
  const root = section('roots', '1 · 根目录与数据面');
  root.append(make('p', config.roots), make('pre', config.currentTree), make('p', config.currentNote, 'iteration-note'));
  const target = section('target-files', '2 · 文件职责与按需生成');
  target.append(make('p', config.targetNote), make('pre', config.targetTree));
  const workflow = section('workflow', '3 · 触发与写入链');
  workflow.append(make('pre', config.pipeline), make('p', config.writerBoundary, 'iteration-note'));
  workflow.append(make('h4', '后台任务说明文件（单执行器按任务读取）'), make('pre', config.prompts), make('p', config.promptNote));
  const flows = section('flows', '4 · 11 个模块逐项对应');
  const all = make('button', '展开全部模块', 'btn outline'); all.type = 'button'; all.setAttribute('aria-expanded', 'false');
  all.onclick = () => { const open = all.getAttribute('aria-expanded') !== 'true'; for (const details of flows.querySelectorAll('details')) details.open = open; all.setAttribute('aria-expanded', String(open)); all.textContent = open ? '收起全部模块' : '展开全部模块'; };
  flows.append(all);
  for (const group of config.groups) {
    const block = make('section', undefined, 'iteration-group'); block.append(make('h4', group.title)); flows.append(block);
    for (const id of group.nodes) {
      const node = nodes.get(id); if (!node?.flow) continue;
      const details = make('details', undefined, 'iteration-module'); details.id = `flow-${id}`;
      const summary = make('summary'); summary.append(make('span', node.title), make('span', node.state === 'implemented' ? '源码已接线' : node.state === 'planned' ? '待实施' : '部分实现', 'iteration-state'));
      const onMap = make('button', '在图中查看', 'btn outline iteration-node-link'); onMap.type = 'button';
      onMap.onclick = () => { panel.close(); if (location.hash === `#${id}`) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = id; };
      details.append(summary, list(node.flow), onMap); block.append(details);
    }
  }
  const injection = section('injection', '5 · 哪些进入上下文');
  const table = make('table', undefined, 'iteration-injection');
  const caption = make('caption', 'Router 的文件分层、职责与使用'); caption.style.textAlign='left';caption.style.marginBottom='10px';
  const head = make('thead'), tr = make('tr'); for (const label of ['文件或数据','存储与职责','读取与使用']) {const th=make('th',label);th.scope='col';tr.append(th);}head.append(tr);
  const body=make('tbody');for(const row of config.injection){const tr=make('tr');for(const cell of row)tr.append(make('td',cell));body.append(tr);}
  table.append(caption,head,body);injection.append(table,make('p',config.injectionNote,'iteration-note'));
  const example=section('example','6 · 一条信息怎样流转');example.append(make('pre',config.example),make('p',config.boundary,'iteration-note'));
  document.body.append(panel);
  let lastFocus=null;
  const open = id => {
    lastFocus=document.activeElement;
    if(!panel.open)panel.showModal();
    for(const shortcut of document.querySelectorAll('.iteration-shortcut'))shortcut.setAttribute('aria-expanded','true');
    if(id&&id!=='learning'){
      const details=document.getElementById(`flow-${id}`);
      if(details){details.open=true;details.scrollIntoView({block:'start'});details.querySelector('summary').focus({preventScroll:true});return;}
    }
    panel.scrollTop=0;close.focus({preventScroll:true});
  };
  close.onclick=()=>panel.close();
  panel.addEventListener('keydown',event=>{if(event.key==='Escape')event.stopPropagation();});
  panel.addEventListener('close',()=>{for(const shortcut of document.querySelectorAll('.iteration-shortcut'))shortcut.setAttribute('aria-expanded','false');if(lastFocus?.isConnected)lastFocus.focus({preventScroll:true});});
  for(const shortcut of document.querySelectorAll('.iteration-shortcut')){
    shortcut.setAttribute('aria-controls','iteration-files');shortcut.setAttribute('aria-expanded','false');
    shortcut.addEventListener('click',event=>{event.preventDefault();open();});
  }
  // The shared diagram owns selection; only this page augments its detail view.
  const detail=document.getElementById('detail');
  const flow=make('section',undefined,'detail-block iteration-flow');flow.hidden=true;flow.setAttribute('aria-label','触发与读写路径');
  const sourceBlock=document.getElementById('detail-sources').closest('.detail-block');detail.insertBefore(flow,sourceBlock);
  const refresh=()=>{
    const id=window.architecture?.getState().selected,node=nodes.get(id);
    flow.replaceChildren();flow.hidden=!node?.flow;
    if(node?.flow)flow.append(make('h3','触发与读写路径'),list(node.flow));
    const links=document.getElementById('detail-links');
    if((id==='learning'||node?.flow)&&!links.querySelector('[data-iteration-link]')){
      const button=make('button',id==='learning'?'文件树与全部流向':'文件与流向','btn primary');button.type='button';button.dataset.iterationLink='';button.onclick=()=>open(id);links.prepend(button);
    }
  };
  new MutationObserver(refresh).observe(document.getElementById('detail-title'),{childList:true});refresh();
  for(const zone of document.querySelectorAll('#zones .zone'))if(zone.textContent.startsWith('自我迭代 ·'))zone.classList.add('iteration-zone');
  if(location.hash==='#iteration-files')open();
  window.addEventListener('hashchange',()=>{if(location.hash==='#iteration-files')open();});
})();
