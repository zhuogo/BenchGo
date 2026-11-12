'use strict';
(() => {
  const root = new URL('../../', document.currentScript.src);
  const $ = id => document.getElementById(id);
  const viewport = $('viewport'), world = $('world');
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  document.addEventListener('selectstart', e => e.preventDefault(), true);
  document.addEventListener('dragstart', e => e.preventDefault(), true);
  document.addEventListener('pointerdown', () => window.getSelection()?.removeAllRanges(), true);
  try {
    const data = JSON.parse($('architecture-data').textContent);
    if (!data.nodes?.length) throw new Error('当前页面没有架构节点');
    const nodes = data.nodes, edges = data.edges || [], byId = new Map(nodes.map(n => [n.id, n]));
    const canvasWidth = data.canvas?.width || 1580, canvasHeight = data.canvas?.height || 950;
    const nodeWidth = n => n.compact ? 220 : 260, nodeHeight = n => n.compact ? 96 : 154;
    world.style.width = canvasWidth + 'px'; world.style.height = canvasHeight + 'px';
    world.querySelector('.edges').style.width = canvasWidth + 'px'; world.querySelector('.edges').style.height = canvasHeight + 'px';
    for (const e of edges) if (!byId.has(e.a) || !byId.has(e.b)) throw new Error('连线引用了不存在的节点');
    const original = nodes.map(({id,x,y}) => ({id,x,y}));
    const storageKey = 'benchgo-architecture-v1-' + data.id;
    const state = { camera: {x:0,y:0,k:1}, selected:null, step:-1 };
    let drag = null, pan = null, pinch = null, resized = null;
    const pointers = new Map();
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (saved?.version === data.version) for (const p of saved.positions || []) {
        const n = byId.get(p.id);
        if (n && Number.isFinite(p.x) && Number.isFinite(p.y)) Object.assign(n, {x:clamp(p.x,20,canvasWidth-nodeWidth(n)-30),y:clamp(p.y,130,canvasHeight-nodeHeight(n)-16)});
      }
    } catch { /* A restricted file origin still supports the complete diagram. */ }
    const save = () => { try { localStorage.setItem(storageKey, JSON.stringify({version:data.version,positions:nodes.map(({id,x,y})=>({id,x,y}))})); } catch {} };
    const make = (tag, className, text) => { const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el; };
    const link = (label,path,className='source') => {const el=make('a',className,label+' ↗');el.href=new URL(path,root);el.target='_blank';el.rel='noopener';return el;};
    const statuses = {implemented:'已有实现',partial:'部分实现',planned:'设计目标'};
    $('canvas-title').textContent=data.title;
    $('canvas-subtitle').textContent=data.subtitle;
    $('boundary').textContent=data.boundary;
    $('sheet-no').textContent=`BENCHGO / ${data.id === '00' ? 'OVERVIEW' : data.id} · 2026.11`;
    for (const z of data.zones || []) {
      const el=make('div','zone');Object.assign(el.style,{left:z.x+'px',top:z.y+'px',width:z.w+'px',height:z.h+'px'});el.append(make('span','',z.label));$('zones').append(el);
    }
    for (const [i,n] of nodes.entries()) {
      const el=make('button','node'+(n.compact?' compact':''));el.type='button';el.id='node-'+n.id;el.dataset.id=n.id;el.dataset.kind=n.kind;el.dataset.state=n.state;el.style.left=n.x+'px';el.style.top=n.y+'px';el.setAttribute('aria-label',`${String(i+1).padStart(2,'0')} ${n.title}，${statuses[n.state]}`);el.setAttribute('aria-pressed','false');
      const kicker=make('div','node-kicker'),label=make('span');label.append(make('i'),document.createTextNode(n.kicker));kicker.append(label,make('em','',String(i+1).padStart(2,'0')));
      el.append(kicker,make('h3','',n.title),make('p','',n.sub),make('code','',n.symbol));
      if(n.state!=='implemented')el.append(make('span','node-state',statuses[n.state]));
      el.addEventListener('click',()=>{if(!el._moved)select(n.id,true);el._moved=false;});
      el.addEventListener('pointerdown',e=>{
        if(e.button!==0 || drag || pointers.size)return;e.preventDefault();e.stopPropagation();el.focus({preventScroll:true});drag={id:e.pointerId,n,el,sx:e.clientX,sy:e.clientY,x:n.x,y:n.y,moved:false};el._moved=false;el.setPointerCapture(e.pointerId);el.classList.add('dragging');
      });
      el.addEventListener('pointermove',e=>{
        if(!drag||e.pointerId!==drag.id)return;const dx=e.clientX-drag.sx,dy=e.clientY-drag.sy;if(Math.hypot(dx,dy)>5)drag.moved=true;if(!drag.moved)return;
        n.x=clamp(drag.x+dx/state.camera.k,20,canvasWidth-nodeWidth(n)-30);n.y=clamp(drag.y+dy/state.camera.k,130,canvasHeight-nodeHeight(n)-16);el.style.left=n.x+'px';el.style.top=n.y+'px';drawEdges();
      });
      const end=e=>{if(!drag||drag.id!==e.pointerId)return;el._moved=drag.moved||e.type==='pointercancel';el.classList.remove('dragging');drag=null;save();};
      el.addEventListener('pointerup',end);el.addEventListener('pointercancel',end);el.addEventListener('lostpointercapture',end);$('nodes').append(el);
    }
    const ns='http://www.w3.org/2000/svg';
    edges.forEach((e,i)=>{const p=document.createElementNS(ns,'path');p.id='edge-'+i;p.setAttribute('class','edge '+(e.kind||''));$('edge-paths').append(p);const t=document.createElementNS(ns,'text');t.id='label-'+i;t.setAttribute('class','edge-label');t.textContent=e.label||'';$('edge-labels').append(t);});
    function anchor(n,side){const w=nodeWidth(n),h=nodeHeight(n);return side==='l'?{x:n.x,y:n.y+h/2}:side==='r'?{x:n.x+w,y:n.y+h/2}:side==='t'?{x:n.x+w/2,y:n.y}:{x:n.x+w/2,y:n.y+h};}
    const vectors={l:[-1,0],r:[1,0],t:[0,-1],b:[0,1]};
    function route(e){
      const a=anchor(byId.get(e.a),e.from),b=anchor(byId.get(e.b),e.to),av=vectors[e.from],bv=vectors[e.to];
      const start={x:a.x+av[0]*28,y:a.y+av[1]*28},end={x:b.x+bv[0]*28,y:b.y+bv[1]*28};
      const rects=nodes.map(n=>({l:n.x-15,r:n.x+nodeWidth(n)+15,t:n.y-15,b:n.y+nodeHeight(n)+15}));
      const xs=[...new Set([20,canvasWidth-20,start.x,end.x,...nodes.flatMap(n=>[n.x-30,n.x+nodeWidth(n)+30])])].sort((x,y)=>x-y);
      const ys=[...new Set([120,canvasHeight-20,start.y,end.y,...nodes.flatMap(n=>[n.y-30,n.y+nodeHeight(n)+30])])].sort((x,y)=>x-y);
      const blocked=(p,q)=>rects.some(r=>p.x===q.x?p.x>r.l&&p.x<r.r&&Math.max(p.y,q.y)>r.t&&Math.min(p.y,q.y)<r.b:p.y>r.t&&p.y<r.b&&Math.max(p.x,q.x)>r.l&&Math.min(p.x,q.x)<r.r);
      const sx=xs.indexOf(start.x),sy=ys.indexOf(start.y),ex=xs.indexOf(end.x),ey=ys.indexOf(end.y);
      const heap=[],costs=new Map(),parents=new Map(),key=(x,y,d)=>`${x},${y},${d}`;
      const push=v=>{heap.push(v);let i=heap.length-1;while(i){const p=(i-1)>>1;if(heap[p].f<=v.f)break;heap[i]=heap[p];i=p;}heap[i]=v;};
      const pop=()=>{const top=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let j=i*2+1;if(j+1<heap.length&&heap[j+1].f<heap[j].f)j++;if(last.f<=heap[j].f)break;heap[i]=heap[j];i=j;}heap[i]=last;}return top;};
      const initial=key(sx,sy,av[0]?0:1);costs.set(initial,0);push({x:sx,y:sy,d:av[0]?0:1,k:initial,g:0,f:0});let goal=null;
      while(heap.length){const cur=pop();if(cur.g!==costs.get(cur.k))continue;if(cur.x===ex&&cur.y===ey){goal=cur.k;break;}
        for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]){const nx=cur.x+dx,ny=cur.y+dy;if(nx<0||nx>=xs.length||ny<0||ny>=ys.length)continue;const p={x:xs[cur.x],y:ys[cur.y]},q={x:xs[nx],y:ys[ny]};if(blocked(p,q))continue;const dir=dx?0:1,g=cur.g+Math.abs(q.x-p.x)+Math.abs(q.y-p.y)+(cur.d===dir?0:24),k=key(nx,ny,dir);if(g>=(costs.get(k)??Infinity))continue;costs.set(k,g);parents.set(k,cur.k);push({x:nx,y:ny,d:dir,k,g,f:g+Math.abs(q.x-end.x)+Math.abs(q.y-end.y)});}
      }
      if(!goal)return[a,start,end,b];
      const middle=[];for(let k=goal;k;k=parents.get(k)){const[x,y]=k.split(',').map(Number);middle.unshift({x:xs[x],y:ys[y]});}
      const points=[a,...middle,b],simple=[];
      for(const p of points){while(simple.length>1){const u=simple.at(-2),v=simple.at(-1);if((u.x===v.x&&v.x===p.x)||(u.y===v.y&&v.y===p.y))simple.pop();else break;}simple.push(p);}
      return simple;
    }
    function rounded(points){let d=`M${points[0].x},${points[0].y}`;for(let i=1;i<points.length;i++){const p=points[i];if(i===points.length-1){d+=` L${p.x},${p.y}`;continue;}const a=points[i-1],b=points[i+1],r=Math.min(10,Math.hypot(p.x-a.x,p.y-a.y)/2,Math.hypot(b.x-p.x,b.y-p.y)/2),u={x:p.x+Math.sign(a.x-p.x)*r,y:p.y+Math.sign(a.y-p.y)*r},v={x:p.x+Math.sign(b.x-p.x)*r,y:p.y+Math.sign(b.y-p.y)*r};d+=` L${u.x},${u.y} Q${p.x},${p.y} ${v.x},${v.y}`;}return d;}
    function drawEdges(){const occupied=[];edges.forEach((e,i)=>{
      const points=route(e);$('edge-'+i).setAttribute('d',rounded(points));
      const width=Math.max(45,(e.label||'').length*11),candidates=[];
      for(let j=1;j<points.length;j++){const a=points[j-1],b=points[j],horizontal=a.y===b.y,length=Math.abs(a.x-b.x)+Math.abs(a.y-b.y);if(length<45)continue;const x=horizontal?(a.x+b.x)/2:a.x+12,y=horizontal?a.y-12:(a.y+b.y)/2;const box={x:horizontal?x-width/2:x,y:y-11,w:width,h:17};const overlap=occupied.filter(o=>box.x<o.x+o.w+8&&box.x+box.w+8>o.x&&box.y<o.y+o.h+5&&box.y+box.h+5>o.y).length;const nodeHit=nodes.some(n=>box.x<n.x+nodeWidth(n)&&box.x+box.w>n.x&&box.y<n.y+nodeHeight(n)&&box.y+box.h>n.y);candidates.push({x,y,box,horizontal,score:length+(horizontal?100:0)-overlap*10000-(nodeHit?10000:0)});}
      candidates.sort((a,b)=>b.score-a.score);const chosen=candidates[0]||{x:points[0].x,y:points[0].y-12,horizontal:true,box:{x:0,y:0,w:0,h:0}};occupied.push(chosen.box);const t=$('label-'+i);t.setAttribute('x',chosen.x);t.setAttribute('y',chosen.y);t.setAttribute('text-anchor',chosen.horizontal?'middle':'start');
    });}
    function select(id,open=false){const n=byId.get(id);if(!n)return;state.selected=id;
      for(const item of nodes){const el=$('node-'+item.id);el.classList.toggle('selected',item.id===id);el.setAttribute('aria-pressed',String(item.id===id));}
      edges.forEach((e,i)=>{const related=e.a===id||e.b===id;$('edge-'+i).classList.toggle('related',related);$('label-'+i).classList.toggle('related',related);});
      $('detail-tag').textContent=n.kicker+' · '+statuses[n.state];
      for(const field of ['title','plain','role','input','output','note'])$('detail-'+field).textContent=n[field]||'';
      $('detail-sources').replaceChildren(...n.sources.map(path=>link(path,path)));
      const links=[];if(n.page)links.push(link('打开板块架构',n.page,'btn primary'));if(n.doc)links.push(link('阅读设计',n.doc,'btn outline'));$('detail-links').replaceChildren(...links);
      if(open){$('directory').hidden=true;$('directory-toggle').setAttribute('aria-expanded','false');$('detail').hidden=false;$('detail').scrollTop=0;}
    }
    function camera(){const c=state.camera;world.style.transform=`translate(${c.x}px,${c.y}px) scale(${c.k})`;$('zoom-value').textContent=Math.round(c.k*100)+'%';$('zoom-out').disabled=c.k<=.1501;$('zoom-in').disabled=c.k>=2.499;viewport.style.backgroundSize=18*c.k+'px '+18*c.k+'px';viewport.style.backgroundPosition=c.x+'px '+c.y+'px';}
    function fit(){const w=viewport.clientWidth,h=viewport.clientHeight;const k=clamp(Math.min((w-35)/canvasWidth,(h-87)/canvasHeight,1),.15,2.5);state.camera={k,x:(w-canvasWidth*k)/2,y:(h-70-canvasHeight*k)/2};camera();}
    function zoom(factor,x=viewport.clientWidth/2,y=viewport.clientHeight/2){const c=state.camera,k=clamp(c.k*factor,.15,2.5),r=k/c.k;c.x=x-(x-c.x)*r;c.y=y-(y-c.y)*r;c.k=k;camera();}
    function focusNode(id,walking=false){const n=byId.get(id),w=viewport.clientWidth,h=viewport.clientHeight,k=w<760?Math.min(1,(w-50)/nodeWidth(n)):1;const cx=w<760?w/2:walking?(w+350)/2:(w-370)/2;state.camera={k,x:cx-(n.x+nodeWidth(n)/2)*k,y:(walking&&w<760?Math.max(130,(h-280)/2):h/2)-(n.y+nodeHeight(n)/2)*k};camera();}
    const point=e=>{const r=viewport.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};};
    viewport.addEventListener('pointerdown',e=>{if(e.target.closest('.node')||e.button!==0||drag)return;e.preventDefault();viewport.focus({preventScroll:true});pointers.set(e.pointerId,point(e));viewport.setPointerCapture(e.pointerId);viewport.classList.add('panning');if(pointers.size===1)pan=point(e);else if(pointers.size===2){const[a,b]=[...pointers.values()];pinch={d:Math.hypot(a.x-b.x,a.y-b.y),x:(a.x+b.x)/2,y:(a.y+b.y)/2};}});
    viewport.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return;const p=point(e);pointers.set(e.pointerId,p);if(pointers.size===2){const[a,b]=[...pointers.values()],next={d:Math.hypot(a.x-b.x,a.y-b.y),x:(a.x+b.x)/2,y:(a.y+b.y)/2};if(pinch?.d){zoom(next.d/pinch.d,pinch.x,pinch.y);state.camera.x+=next.x-pinch.x;state.camera.y+=next.y-pinch.y;camera();}pinch=next;}else if(pan){state.camera.x+=p.x-pan.x;state.camera.y+=p.y-pan.y;pan=p;camera();}});
    const endPan=e=>{pointers.delete(e.pointerId);pinch=null;pan=pointers.size?[...pointers.values()][0]:null;if(!pointers.size)viewport.classList.remove('panning');};
    viewport.addEventListener('pointerup',endPan);viewport.addEventListener('pointercancel',endPan);viewport.addEventListener('lostpointercapture',endPan);
    viewport.addEventListener('wheel',e=>{e.preventDefault();const p=point(e);zoom(Math.exp(-clamp(e.deltaY,-120,120)*.0025),p.x,p.y);},{passive:false});
    viewport.addEventListener('keydown',e=>{if(e.target!==viewport)return;let done=true;const c=state.camera;if(e.key==='+'||e.key==='=')zoom(1.2);else if(e.key==='-')zoom(1/1.2);else if(e.key==='0')fit();else if(e.key==='ArrowLeft')c.x+=45;else if(e.key==='ArrowRight')c.x-=45;else if(e.key==='ArrowUp')c.y+=45;else if(e.key==='ArrowDown')c.y-=45;else done=false;if(done){e.preventDefault();camera();}});
    $('zoom-in').onclick=()=>zoom(1.2);$('zoom-out').onclick=()=>zoom(1/1.2);$('fit').onclick=fit;$('actual').onclick=()=>zoom(1/state.camera.k);
    $('reset').onclick=()=>{endWalk();for(const p of original){const n=byId.get(p.id);Object.assign(n,p);$('node-'+n.id).style.left=n.x+'px';$('node-'+n.id).style.top=n.y+'px';}save();drawEdges();fit();};
    $('detail-close').onclick=()=>{$('detail').hidden=true;const selected=$('node-'+state.selected);selected?.focus({preventScroll:true});};
    const search=()=>{const q=$('search').value.trim().toLowerCase(),list=$('directory-list');list.replaceChildren();nodes.forEach((n,i)=>{if(![n.title,n.sub,n.symbol,n.kicker].join(' ').toLowerCase().includes(q))return;const b=make('button');b.type='button';b.append(make('small','',String(i+1).padStart(2,'0')),make('span','',n.title));b.onclick=()=>{endWalk();select(n.id,true);focusNode(n.id);};list.append(b);});$('search-empty').hidden=!!list.children.length;};
    $('search').addEventListener('input',search);$('clear-search').onclick=()=>{$('search').value='';search();$('search').focus();};search();
    $('directory-toggle').onclick=()=>{const open=$('directory').hidden;$('directory').hidden=!open;$('directory-toggle').setAttribute('aria-expanded',String(open));if(open){$('detail').hidden=true;$('search').focus();}};
    $('directory-close').onclick=()=>{$('directory').hidden=true;$('directory-toggle').setAttribute('aria-expanded','false');$('directory-toggle').focus();};
    for(const doc of data.docs||[])$('design-links').append(link(doc.label,doc.path));
    function showStep(index){const steps=data.steps||[];if(!steps.length)return;state.step=clamp(index,0,steps.length-1);const s=steps[state.step];document.body.classList.add('walk-active');$('walkthrough').hidden=false;$('walk-start').classList.add('active');$('walk-start').setAttribute('aria-pressed','true');$('detail').hidden=true;$('directory').hidden=true;$('directory-toggle').setAttribute('aria-expanded','false');$('step-label').textContent=`流程走读 · ${String(state.step+1).padStart(2,'0')} / ${steps.length}`;$('step-title').textContent=s.title;$('step-text').textContent=s.text;$('walk-prev').disabled=state.step===0;$('walk-next').textContent=state.step===steps.length-1?'完成走读 ✓':'下一步 →';$('step-progress').style.width=(state.step+1)/steps.length*100+'%';select(s.node);for(const n of nodes)$('node-'+n.id).classList.toggle('traced',n.id===s.node);edges.forEach((e,i)=>$('edge-'+i).classList.toggle('traced',i===s.edge));focusNode(s.node,true);}
    function endWalk(){state.step=-1;document.body.classList.remove('walk-active');$('walkthrough').hidden=true;$('walk-start').classList.remove('active');$('walk-start').setAttribute('aria-pressed','false');for(const n of nodes)$('node-'+n.id).classList.remove('traced');edges.forEach((e,i)=>$('edge-'+i).classList.remove('traced'));}
    $('walk-start').onclick=()=>{if(state.step>=0){endWalk();fit();}else showStep(0);};$('walk-prev').onclick=()=>showStep(state.step-1);$('walk-next').onclick=()=>{if(state.step===data.steps.length-1){endWalk();fit();}else showStep(state.step+1);};$('walk-exit').onclick=()=>{endWalk();fit();};
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){$('detail').hidden=true;$('directory').hidden=true;$('directory-toggle').setAttribute('aria-expanded','false');if(state.step>=0){endWalk();fit();}viewport.focus({preventScroll:true});}});
    new ResizeObserver(()=>{clearTimeout(resized);resized=setTimeout(()=>state.step>=0?focusNode(data.steps[state.step].node,true):fit(),100);}).observe(viewport);
    $('load-state').hidden=true;drawEdges();fit();
    const hashSelect=()=>{const aliases={modules:'package',lifecycle:'official',permissions:'official',sessions:'workspace','models-memory':'models',sequence:'superagent',implementation:'package','worker-pool':'superagent'};const id=decodeURIComponent(location.hash.slice(1));const target=byId.has(id)?id:aliases[id];if(byId.has(target)){select(target,true);focusNode(target);}};
    window.addEventListener('hashchange',hashSelect);hashSelect();
    window.architecture={getState:()=>JSON.parse(JSON.stringify({...state,positions:nodes.map(({id,x,y})=>({id,x,y}))})),nodeCount:nodes.length,edgeCount:edges.length};
  } catch(error) {
    viewport.classList.add('fatal');$('load-state').hidden=false;$('load-title').textContent='架构图暂时无法显示';$('load-message').textContent=error.message;$('retry').hidden=false;
  }
})();
