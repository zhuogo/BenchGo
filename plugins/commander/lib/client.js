window.__ModuleLoader__.load({id: 'benchgo', factory: (require) => { const module = {exports:{}}; const exports = module.exports;
var yr=Object.create;var Un=Object.defineProperty;var xr=Object.getOwnPropertyDescriptor;var Ur=Object.getOwnPropertyNames;var vr=Object.getPrototypeOf,Dr=Object.prototype.hasOwnProperty;var Nr=(e,t)=>{for(var n in t)Un(e,n,{get:t[n],enumerable:!0})},qo=(e,t,n,i)=>{if(t&&typeof t=="object"||typeof t=="function")for(let o of Ur(t))!Dr.call(e,o)&&o!==n&&Un(e,o,{get:()=>t[o],enumerable:!(i=xr(t,o))||i.enumerable});return e};var Mo=(e,t,n)=>(n=e!=null?yr(vr(e)):{},qo(t||!e||!e.__esModule?Un(n,"default",{value:e,enumerable:!0}):n,e)),Ar=e=>qo(Un({},"__esModule",{value:!0}),e);var Qd={};Nr(Qd,{apply:()=>Rd,inject:()=>Od});module.exports=Ar(Qd);async function Xe(e,t){let n=new URL(t).pathname,i="HTTP "+e.status+" \xB7 "+n,o=await e.text(),a;try{a=JSON.parse(o)}catch(r){let s=new Error((e.ok?"\u63A5\u53E3\u8FD4\u56DE\u683C\u5F0F\u5F02\u5E38":"\u8BF7\u6C42\u5931\u8D25")+"\uFF08"+i+"\uFF09",{cause:r});throw s.code=e.ok?"INVALID_JSON_RESPONSE":"HTTP_ERROR",s.status=e.status,s.pathname=n,s}if(!e.ok){let r=typeof a?.error=="string"?a.error:a?.error?.message,s=typeof r=="string"?r.replace(/\s+/g," ").trim().slice(0,200):"",d=new Error("\u8BF7\u6C42\u5931\u8D25"+(s?"\uFF1A"+s:"")+"\uFF08"+i+"\uFF09");throw d.code="HTTP_ERROR",d.status=e.status,d.pathname=n,d}if(a===null||typeof a!="object"){let r=new Error("\u63A5\u53E3\u8FD4\u56DE\u683C\u5F0F\u5F02\u5E38\uFF08"+i+"\uFF09");throw r.code="INVALID_JSON_RESPONSE",r.status=e.status,r.pathname=n,r}return a}var Dn=require("react");var Ue=require("react");function vn(e,t,n){return Math.min(n,Math.max(t,Math.round(e)))}function wo(e,t,n,i=56){let o=t===0?i:vn(t,264,420),a=e-o-400,r=n===0||a<300?0:Math.min(a,vn(n,300,e*.7));return{sidebar:o,center:Math.max(0,e-o-r),rightbar:r}}var $o=require("react");function ea({useSessions:e,usePanelInfo:t,productTitle:n}){let i=t(a=>a.activePanelId===null),o=e(a=>{let r=Object.values(a.byId).find(s=>(s.retainedBy.mainView??0)>0)?.id;return!i||r===void 0?void 0:a.byId[r]?.title});return(0,$o.useEffect)(()=>(document.title=o===void 0?n:`${o} \u2014 ${n}`,()=>{document.title=n}),[n,o]),null}var ta="commander-shell-AppFrame.module.css";if(!document.getElementById(ta)){let e=document.createElement("style");e.id=ta,e.textContent=`/* deepseek-harness/packages/client/ui-layout/src/client/AppFrame.module.css */
.AppFrame_frame {
  position: relative;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  height: 100%;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
}
.AppFrame_frame[data-animating] {
  transition: grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out);
}
.AppFrame_frame[data-dragging] {
  transition: none;
}
[data-windows-titlebar] .AppFrame_frame {
  --dsh-windows-content-radius: 16px;
  box-sizing: border-box;
  padding-top: var(--dsh-windows-titlebar-height);
  background: var(--dsw-specific-sidebar-fill);
}
[data-windows-titlebar] .AppFrame_centerCol {
  background: var(--dsw-alias-bg-base);
  border-radius: var(--dsh-windows-content-radius) 0 0 0;
  corner-shape: round;
}
[data-windows-titlebar] .AppFrame_frame::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: var(--dsh-windows-titlebar-height);
  background: var(--dsw-specific-sidebar-fill);
  -webkit-app-region: drag;
}
[data-windows-titlebar] .AppFrame_sidebarCol {
  border-right: none;
}
@media (prefers-reduced-motion: reduce) {
  .AppFrame_frame[data-animating] {
    transition: none;
  }
}
.AppFrame_sidebarCol {
  min-width: 0;
  overflow: hidden;
  background: var(--dsw-specific-sidebar-fill);
  border-right: 0.5px solid var(--dsw-alias-border-l3);
}
.AppFrame_centerCol {
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
[data-platform=darwin] .AppFrame_frame {
  background: transparent;
}
html[data-platform=darwin] {
  --dsh-frame-top-clearance: 48px;
}
html[data-windows-titlebar] {
  --dsh-frame-top-clearance: var(--dsh-windows-titlebar-height);
  --dsh-frame-chrome-top: var(--dsh-windows-titlebar-height);
}
html[data-platform=darwin],
html[data-windows-titlebar] {
  --dsh-frame-overlay-top: calc(var(--dsh-frame-top-clearance) + 20px);
}
html[data-platform=darwin][data-fullscreen],
html[data-windows-titlebar][data-fullscreen] {
  --dsh-frame-overlay-top: 20px;
  --dsh-frame-chrome-top: 0px;
}
[data-platform=darwin] .AppFrame_sidebarCol {
  background:
    linear-gradient(
      to bottom,
      rgb(122 155 240 / 0.1),
      rgb(122 155 240 / 0) 35%,
      rgb(143 137 184 / 0) 68%,
      rgb(143 137 184 / 0.09)),
    color-mix(in srgb, color-mix(in srgb, var(--dsw-specific-sidebar-fill) 97%, rgb(122 155 240)) 40%, transparent);
  border-right: none;
}
[data-platform=darwin] [data-ds-dark-theme] .AppFrame_sidebarCol {
  background:
    linear-gradient(
      to bottom,
      rgb(122 155 240 / 0.08),
      rgb(122 155 240 / 0) 35%,
      rgb(143 137 184 / 0) 68%,
      rgb(143 137 184 / 0.07)),
    color-mix(in srgb, var(--dsw-specific-sidebar-fill) 50%, transparent);
}
@media (prefers-reduced-transparency: reduce) {
  [data-platform=darwin] .AppFrame_sidebarCol,
  [data-platform=darwin] [data-ds-dark-theme] .AppFrame_sidebarCol {
    background: color-mix(in srgb, var(--dsw-specific-sidebar-fill) 90%, transparent);
  }
}
[data-platform=darwin] .AppFrame_centerCol {
  background: var(--dsw-alias-bg-base);
  border-left: 0.5px solid var(--dsw-alias-border-l3);
}
[data-platform=darwin] .AppFrame_rightbarCol {
  background: var(--dsw-alias-bg-base);
}
[data-platform=darwin] [data-sidebar-collapsed] .AppFrame_centerCol {
  border-left: none;
}
[data-platform=darwin] .AppFrame_frame[data-sidebar-collapsed] {
  --dsh-frame-leading-clearance: 160px;
}
[data-platform=darwin][data-fullscreen] .AppFrame_frame[data-sidebar-collapsed] {
  --dsh-frame-leading-clearance: 84px;
}
[data-platform=darwin][data-fullscreen] .AppFrame_leadingSeat {
  left: 12px;
}
.AppFrame_leadingSeat {
  position: absolute;
  top: 11px;
  left: 88px;
  z-index: 15;
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
}
.AppFrame_handle {
  position: absolute;
  grid-area: 1 / 1 / 2 / -1;
  top: 0;
  bottom: 0;
  width: 8px;
  margin-left: -4px;
  cursor: col-resize;
  z-index: 11;
  touch-action: none;
}
.AppFrame_frame[data-animating] .AppFrame_handle {
  transition: left var(--ds-transition-duration-slow) var(--ds-ease-in-out);
}
.AppFrame_frame[data-dragging] .AppFrame_handle {
  transition: none;
}
.AppFrame_frame[data-rightbar-fullscreen],
.AppFrame_frame[data-rightbar-fullscreen] .AppFrame_handle,
.AppFrame_frame[data-rightbar-instant],
.AppFrame_frame[data-rightbar-instant] .AppFrame_handle {
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .AppFrame_frame[data-animating] .AppFrame_handle {
    transition: none;
  }
}
.AppFrame_rightbarCol {
  position: relative;
  min-width: 0;
  overflow: visible;
}
.AppFrame_bottomRow {
  grid-column: 1 / -1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background: var(--dsw-alias-bg-base);
}
.AppFrame_overlayLayer {
  position: absolute;
  inset: 0;
  z-index: 20;
  pointer-events: none;
}
.AppFrame_overlayLayer > * {
  pointer-events: auto;
}
`,document.head.append(e)}var Et={frame:"AppFrame_frame",centerCol:"AppFrame_centerCol",sidebarCol:"AppFrame_sidebarCol",rightbarCol:"AppFrame_rightbarCol",leadingSeat:"AppFrame_leadingSeat",handle:"AppFrame_handle",bottomRow:"AppFrame_bottomRow",overlayLayer:"AppFrame_overlayLayer"};var qe=require("react/jsx-runtime");function Tr(e){return(0,qe.jsx)("div",{className:Et.centerCol,children:e.children})}function zr({usePanelInfo:e,renderSlot:t}){let n=e(i=>i.activePanelId);return t("main",{},{entryKey:n??"conversation"})}function Fr(e){return(0,qe.jsx)("div",{className:Et.rightbarCol,"data-rightbar-col":!0,children:e.children})}function na(e){let[t,n]=(0,Ue.useState)(!1),i=(0,Ue.useRef)(0),o=(0,Ue.useRef)(0),a=(0,Ue.useRef)(null),r=(0,Ue.useRef)(null),s=(0,Ue.useRef)({onStart:e.onStart,onDrag:e.onDrag,onEnd:e.onEnd});s.current={onStart:e.onStart,onDrag:e.onDrag,onEnd:e.onEnd};let d=(0,Ue.useCallback)(()=>{let p=r.current;p!==null&&(r.current=null,a.current!==null&&(cancelAnimationFrame(a.current),a.current=null),p.element.hasPointerCapture(p.id)&&p.element.releasePointerCapture(p.id),n(!1),s.current.onEnd())},[]);(0,Ue.useEffect)(()=>d,[d]);let c=(0,Ue.useCallback)(p=>{p.button!==0||r.current!==null||(p.preventDefault(),p.currentTarget.setPointerCapture(p.pointerId),r.current={element:p.currentTarget,id:p.pointerId},i.current=p.clientX,o.current=p.clientX,s.current.onStart(),n(!0))},[]),f=(0,Ue.useCallback)(p=>{r.current?.id===p.pointerId&&(o.current=p.clientX,a.current??=requestAnimationFrame(()=>{a.current=null,s.current.onDrag(o.current-i.current)}))},[]),u=(0,Ue.useCallback)(p=>{r.current?.id===p.pointerId&&(s.current.onDrag(p.clientX-i.current),d())},[d]),l=(0,Ue.useCallback)(p=>{r.current?.id===p.pointerId&&d()},[d]);return(0,qe.jsx)("div",{className:Et.handle,style:{left:e.left},"data-side":e.side,"data-dragging":t||void 0,onPointerDown:c,onPointerMove:f,onPointerUp:u,onPointerCancel:l,onLostPointerCapture:l})}function oa({useStore:e,useSessions:t,usePanelInfo:n,actions:i,renderSlot:o,t:a}){let r=e(re=>re.layoutInfo),s=(0,Ue.useRef)(null),d=r.viewportWidth;(0,Ue.useLayoutEffect)(()=>{let re=s.current;if(re===null)return;let ee=null,X=!1,B=()=>{let H=re.getBoundingClientRect().width;H>0&&i.setViewportWidth(H)};B();let S=new ResizeObserver(()=>{X||(ee??=requestAnimationFrame(()=>{ee=null,B()}))});return S.observe(re),()=>{X=!0,S.disconnect(),ee!==null&&cancelAnimationFrame(ee)}},[i]);let c=d<1024,f=c?!r.narrowExpanded:r.sidebar===0,u=f?0:r.sidebar===0?280:r.sidebar,l=r.rightbar??d*.45,p=document.documentElement.dataset.platform==="darwin",M=p||document.documentElement.hasAttribute("data-windows-titlebar")?0:56,D=wo(d,!r.rightbarShown&&c?0:u,l,M),g=wo(d,u,r.rightbarTrack?l:0,M),y=(0,Ue.useRef)(g);y.current=g;let I=(0,Ue.useRef)(D.rightbar);I.current=D.rightbar;let L=(0,Ue.useRef)(0),b=(0,Ue.useRef)(0),[x,F]=(0,Ue.useState)(!1),[_,Z]=(0,Ue.useState)(0),Q=`${f}:${r.rightbarTrack}`,v=(0,Ue.useRef)(Q),E=(0,Ue.useRef)(d);(0,Ue.useLayoutEffect)(()=>{let re=E.current!==d;E.current=d,v.current!==Q&&(v.current=Q,!re&&Z(ee=>ee+1))},[Q,d]),(0,Ue.useEffect)(()=>{if(_===0)return;let re=s.current;if(re===null)return;let ee=()=>{Z(0)},X=S=>{S.target===re&&S.propertyName==="grid-template-columns"&&ee()};re.addEventListener("transitionend",X);let B=setTimeout(ee,600);return()=>{re.removeEventListener("transitionend",X),clearTimeout(B)}},[_]);let O=(0,Ue.useCallback)(()=>{F(!1)},[]),P=(0,Ue.useCallback)(()=>{L.current=y.current.sidebar,F(!0)},[]),G=(0,Ue.useCallback)(re=>{i.setSidebar(L.current+re)},[i]),j=(0,Ue.useCallback)(()=>{b.current=I.current,F(!0)},[]),J=(0,Ue.useCallback)(re=>{i.setRightbar(b.current-re)},[i]),oe="BenchGo",R=g.rightbar===0?0:vn(l,300,d*.7),T=(0,Ue.useMemo)(()=>o("sidebar",{collapsed:f,width:g.sidebar}),[o,f,g.sidebar]),V=(0,Ue.useMemo)(()=>(0,qe.jsx)(zr,{usePanelInfo:n,renderSlot:o}),[n,o]),de=(0,Ue.useMemo)(()=>o("shell.overlay",{}),[o]),$=(0,Ue.useMemo)(()=>o("shell.leading",{}),[o]),se=p&&f;return(0,qe.jsxs)("div",{ref:s,className:Et.frame+" cmd-shell-frame",style:{...document.documentElement.hasAttribute("data-windows-titlebar")?{"--dsh-windows-sidebar-width":`${g.sidebar}px`}:{},gridTemplateColumns:`${g.sidebar}px minmax(${g.rightbar===0?0:400}px, 1fr) minmax(0px, ${R}px)`},"data-sidebar-collapsed":f||void 0,"data-rightbar-collapsed":g.rightbar===0||void 0,"data-rightbar-fullscreen":r.rightbarFullscreen||void 0,"data-rightbar-instant":r.rightbarInstant||void 0,"data-dragging":x||void 0,"data-animating":_>0||void 0,"data-plus-shell":!0,children:[(0,qe.jsx)(ea,{productTitle:oe,useSessions:t,usePanelInfo:n}),(0,qe.jsx)("div",{className:Et.sidebarCol,children:T}),(0,qe.jsxs)(qe.Fragment,{children:[(0,qe.jsx)(Tr,{children:V}),(0,qe.jsx)(Fr,{children:o("rightbar",{width:D.rightbar,viewportWidth:d,canShow:D.rightbar>0})})]}),(0,qe.jsx)("div",{className:Et.bottomRow,"data-shell-bottom":!0,children:o("shell.bottom",{})}),(0,qe.jsx)("div",{className:Et.overlayLayer,"data-shell-overlay":!0,children:de}),se&&(0,qe.jsx)("div",{className:Et.leadingSeat,"data-shell-leading":!0,children:$}),!f&&(0,qe.jsx)(na,{side:"sidebar",left:g.sidebar,onStart:P,onDrag:G,onEnd:O}),r.rightbarShown&&!r.rightbarFullscreen&&D.rightbar>0&&(0,qe.jsx)(na,{side:"rightbar",left:d-D.rightbar,onStart:j,onDrag:J,onEnd:O})]})}function aa(e,t=setTimeout,n=clearTimeout){let i,o=0,a,r=s=>{o=0,i=s,e.setViewportWidth(s)};return{...e,setViewportWidth(s){let d=Math.round(s);if(!(!Number.isFinite(d)||d<=0||d===o||d===i)){if(i===void 0||i<1024!=d<1024){a&&n(a),a=void 0,r(d);return}d<1024||(o=d,a&&n(a),a=t(()=>{a=void 0,o&&r(o)},90))}},dispose(){a&&n(a),a=void 0,o&&r(o)}}}var vt=require("react");function ia(e){var t,n,i="";if(typeof e=="string"||typeof e=="number")i+=e;else if(typeof e=="object")if(Array.isArray(e)){var o=e.length;for(t=0;t<o;t++)e[t]&&(n=ia(e[t]))&&(i&&(i+=" "),i+=n)}else for(n in e)e[n]&&(i&&(i+=" "),i+=n);return i}function Br(){for(var e,t,n=0,i="",o=arguments.length;n<o;n++)(e=arguments[n])&&(t=ia(e))&&(i&&(i+=" "),i+=t);return i}var yt=Br;var tt=require("@deepseek-ai/dsh-client-ui-primitives");var ra="commander-shell-SidebarRoot.module.css";if(!document.getElementById(ra)){let e=document.createElement("style");e.id=ra,e.textContent=`/* deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.module.css */
.SidebarRoot_root {
  --dsh-sidebar-inline-padding: 12px;
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 6px var(--dsh-sidebar-inline-padding);
  box-sizing: border-box;
  background: var(--dsw-specific-sidebar-fill);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
[data-platform=darwin] .SidebarRoot_root {
  background: transparent;
}
.SidebarRoot_root.SidebarRoot_collapsed {
  padding: 18px 10px 6px;
}
[data-windows-titlebar] .SidebarRoot_root .SidebarRoot_logoRow {
  height: 40px;
  margin: 0;
  padding: 0;
}
[data-windows-titlebar] .SidebarRoot_toggle {
  position: fixed;
  top: calc((var(--dsh-windows-titlebar-height) - 28px) / 2);
  left: 12px;
  z-index: 30;
  -webkit-app-region: no-drag;
}
[data-windows-titlebar] .SidebarRoot_root.SidebarRoot_collapsed .SidebarRoot_logoRow {
  height: 0;
}
[data-windows-titlebar] .SidebarRoot_root:not(.SidebarRoot_collapsed) .SidebarRoot_brand {
  padding-left: 4px;
}
[data-windows-titlebar] .SidebarRoot_brandIdentity {
  transform: translateY(1px);
}
[data-windows-titlebar] .SidebarRoot_brandMark {
  transform: translateX(1px);
}
[data-windows-titlebar] .SidebarRoot_brandName {
  font-weight: 400;
}
[data-windows-titlebar] .SidebarRoot_root.SidebarRoot_collapsed {
  padding: 0;
}
[data-windows-titlebar] .SidebarRoot_root:not(.SidebarRoot_collapsed) .SidebarRoot_newSession {
  margin-top: 8px;
  margin-left: 0;
}
[data-windows-titlebar] .SidebarRoot_collapsed .SidebarRoot_panelList,
[data-windows-titlebar] .SidebarRoot_collapsed .SidebarRoot_regionArea,
[data-windows-titlebar] .SidebarRoot_collapsed .SidebarRoot_footArea {
  display: none;
}
html[data-windows-titlebar]:has([data-sidebar-collapsed=true]) {
  --dsh-windows-menu-start: 84px;
}
[data-windows-titlebar] .SidebarRoot_collapsed .SidebarRoot_newSession {
  position: fixed;
  top: calc((var(--dsh-windows-titlebar-height) - 28px) / 2);
  left: 48px;
  margin: 0;
  padding: 0;
  border: none;
  z-index: 30;
  -webkit-app-region: no-drag;
}
[data-windows-titlebar] .SidebarRoot_railIn .SidebarRoot_iconButton,
[data-windows-titlebar] .SidebarRoot_railIn .SidebarRoot_newSession {
  animation: none;
}
[data-windows-titlebar] .SidebarRoot_collapsed .SidebarRoot_toggle,
[data-windows-titlebar] .SidebarRoot_collapsed .SidebarRoot_newSession {
  width: 28px;
  height: 28px;
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-secondary);
}
[data-windows-titlebar] .SidebarRoot_collapsed .SidebarRoot_toggle .SidebarRoot_panelIcon {
  display: inline;
}
.SidebarRoot_root.SidebarRoot_quietBars {
  --dsh-scrollbar-thumb: transparent;
  --dsh-scrollbar-thumb-hover: transparent;
}
.SidebarRoot_fading > * {
  opacity: 0;
  transition: opacity 150ms var(--ds-ease-in-out);
}
.SidebarRoot_wide {
  animation: SidebarRoot_wide-in 200ms var(--ds-ease-in-out);
}
@keyframes SidebarRoot_wide-in {
  from {
    opacity: 0;
  }
}
.SidebarRoot_railIn .SidebarRoot_iconButton,
.SidebarRoot_railIn .SidebarRoot_newSession,
.SidebarRoot_railIn .SidebarRoot_panelList,
.SidebarRoot_railIn .SidebarRoot_regionArea {
  animation: SidebarRoot_rail-in 150ms var(--ds-ease-in-out) backwards;
}
.SidebarRoot_railIn .SidebarRoot_footArea {
  animation: SidebarRoot_rail-fade-in 150ms var(--ds-ease-in-out) backwards;
}
@keyframes SidebarRoot_rail-in {
  from {
    opacity: 0;
    transform: translateX(49px);
  }
}
@keyframes SidebarRoot_rail-fade-in {
  from {
    opacity: 0;
  }
}
.SidebarRoot_topStrip {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  height: 52px;
  box-sizing: border-box;
  margin: -6px calc(-1 * var(--dsh-sidebar-inline-padding)) 0;
  padding: 0 12px 2px;
}
[data-fullscreen] .SidebarRoot_topStrip {
  justify-content: flex-start;
}
.SidebarRoot_topStrip + .SidebarRoot_logoRow {
  margin-top: -12px;
}
.SidebarRoot_logoRow {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  height: 60px;
  padding: 8px 0 8px 4px;
  margin-bottom: 4px;
  box-sizing: border-box;
  overflow: hidden;
}
.SidebarRoot_collapsed .SidebarRoot_logoRow {
  height: 36px;
  padding: 0;
  margin-bottom: 12px;
  justify-content: flex-start;
  overflow: visible;
}
.SidebarRoot_brand {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  overflow: hidden;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
[data-platform=darwin] .SidebarRoot_brand {
  cursor: default;
}
.SidebarRoot_brandIdentity {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  min-width: 0;
}
.SidebarRoot_brandMark {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.SidebarRoot_brandName {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 24px;
  font-size: 18px;
  font-weight: 600;
  line-height: 24px;
  letter-spacing: 0.04em;
}
.SidebarRoot_fallbackBrandName {
  font-size: 17px;
  letter-spacing: 0px;
  white-space: nowrap;
}
.SidebarRoot_localBuildBrand {
  flex: none;
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 1px;
  height: 24px;
  white-space: nowrap;
}
.SidebarRoot_localBuildTitle {
  font-size: 12px;
  line-height: 13px;
  letter-spacing: 0;
}
.SidebarRoot_iconButton {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  padding: 0;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
}
.SidebarRoot_iconButton:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.SidebarRoot_iconButton.SidebarRoot_toggle:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.SidebarRoot_collapsed .SidebarRoot_iconButton {
  width: 36px;
  height: 36px;
  border-radius: var(--dsw-radius-md);
}
.SidebarRoot_collapsed .SidebarRoot_toggle .SidebarRoot_panelIcon {
  display: none;
}
.SidebarRoot_collapsed .SidebarRoot_toggle:hover .SidebarRoot_panelIcon {
  display: inline;
}
.SidebarRoot_collapsed .SidebarRoot_toggle:hover .SidebarRoot_railMark {
  display: none;
}
.SidebarRoot_railMark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.SidebarRoot_collapsed .SidebarRoot_iconButton {
  color: var(--dsw-alias-label-primary);
}
.SidebarRoot_buildVersion {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 10px;
  padding: 0 3px;
  border-radius: 2px;
  color: var(--dsw-alias-label-primary-inverted);
  background: var(--dsw-alias-label-primary);
  font-family: var(--ds-font-family-code);
  font-size: 6px;
  font-weight: 500;
  line-height: 10px;
  white-space: nowrap;
}
.SidebarRoot_newSession {
  container-type: inline-size;
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  height: 38px;
  padding: 8px 12px;
  margin: 0 2px 12px;
  box-sizing: border-box;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-button-elevated-fill);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  cursor: pointer;
  overflow: hidden;
}
.SidebarRoot_newSession:hover {
  background: var(--dsw-alias-button-floating-hover);
}
[data-platform=darwin] .SidebarRoot_newSession {
  background: rgb(255 255 255 / 0.55);
}
[data-platform=darwin] .SidebarRoot_newSession:hover {
  background: rgb(255 255 255 / 0.3);
}
[data-platform=darwin] [data-ds-dark-theme] .SidebarRoot_newSession {
  background: rgb(255 255 255 / 0.15);
}
[data-platform=darwin] [data-ds-dark-theme] .SidebarRoot_newSession:hover {
  background: rgb(255 255 255 / 0.2);
}
.SidebarRoot_collapsed .SidebarRoot_newSession {
  align-self: flex-start;
  width: 36px;
  height: 36px;
  padding: 0;
  margin: 0 0 12px;
  gap: 0;
  border-color: transparent;
  background: transparent;
}
.SidebarRoot_collapsed .SidebarRoot_newSession:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.SidebarRoot_newSessionLabel {
  max-width: 200px;
  overflow: hidden;
  white-space: nowrap;
}
.SidebarRoot_collapsed .SidebarRoot_newSessionLabel {
  max-width: 0;
}
.SidebarRoot_newSessionLabelMask {
  flex: 1;
  min-width: 0;
}
.SidebarRoot_newSession:is(:hover, :focus-visible) .SidebarRoot_newSessionLabelMask:has(+ .SidebarRoot_newSessionShortcut) {
  overflow: hidden;
  mask-image:
    linear-gradient(
      to right,
      black calc(100% - 16px),
      transparent);
}
.SidebarRoot_newSessionContent {
  display: flex;
  width: 100cqw;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.SidebarRoot_newSessionContent > svg {
  flex: none;
}
.SidebarRoot_newSessionShortcut {
  opacity: 0;
  display: inline-flex;
  flex: none;
  pointer-events: none;
  font-weight: 400;
}
.SidebarRoot_newSession:is(:hover, :focus-visible) .SidebarRoot_newSessionShortcut {
  opacity: 1;
}
.SidebarRoot_panelList {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}
.SidebarRoot_panelRow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 2px;
  min-height: 36px;
  padding: 7px 8px;
  box-sizing: border-box;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  line-height: 22px;
  text-align: left;
  cursor: pointer;
}
.SidebarRoot_panelRow:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.SidebarRoot_panelRow.SidebarRoot_panelActive {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.SidebarRoot_panelRow:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.SidebarRoot_panelGlyph {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.SidebarRoot_panelTitle {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.SidebarRoot_collapsed .SidebarRoot_panelList {
  gap: 12px;
  margin-bottom: 12px;
}
.SidebarRoot_collapsed .SidebarRoot_panelRow {
  width: 36px;
  height: 36px;
  justify-content: center;
  margin: 0;
  padding: 0;
  color: var(--dsw-alias-label-primary);
}
.SidebarRoot_regionArea {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin-left: -4px;
  margin-right: calc(-1 * var(--dsh-sidebar-inline-padding));
  padding-left: 4px;
  overflow: hidden;
}
.SidebarRoot_collapsed .SidebarRoot_regionArea {
  margin-left: 0;
  margin-right: 0;
  padding-left: 0;
}
.SidebarRoot_footArea {
  flex: none;
  display: flex;
  flex-direction: column;
}
.SidebarRoot_settingsArea,
.SidebarRoot_footerActions {
  flex: none;
  min-width: 0;
  width: 100%;
}
.SidebarRoot_footerActions {
  display: flex;
}
.SidebarRoot_collapsed .SidebarRoot_footArea {
  align-items: center;
}
.SidebarRoot_collapsed .SidebarRoot_settingsArea,
.SidebarRoot_collapsed .SidebarRoot_footerActions {
  display: flex;
  justify-content: center;
  width: auto;
}
@media (prefers-reduced-motion: reduce) {
  .SidebarRoot_wide,
  .SidebarRoot_fading > *,
  .SidebarRoot_railIn .SidebarRoot_iconButton,
  .SidebarRoot_railIn .SidebarRoot_newSession,
  .SidebarRoot_railIn .SidebarRoot_panelList,
  .SidebarRoot_railIn .SidebarRoot_footArea,
  .SidebarRoot_railIn .SidebarRoot_regionArea {
    transition: none;
    animation: none;
  }
}
`,document.head.append(e)}var Ae={root:"SidebarRoot_root",collapsed:"SidebarRoot_collapsed",logoRow:"SidebarRoot_logoRow",toggle:"SidebarRoot_toggle",brand:"SidebarRoot_brand",brandIdentity:"SidebarRoot_brandIdentity",brandMark:"SidebarRoot_brandMark",brandName:"SidebarRoot_brandName",newSession:"SidebarRoot_newSession",panelList:"SidebarRoot_panelList",regionArea:"SidebarRoot_regionArea",footArea:"SidebarRoot_footArea",railIn:"SidebarRoot_railIn",iconButton:"SidebarRoot_iconButton",panelIcon:"SidebarRoot_panelIcon",quietBars:"SidebarRoot_quietBars",fading:"SidebarRoot_fading",wide:"SidebarRoot_wide","wide-in":"SidebarRoot_wide-in","rail-in":"SidebarRoot_rail-in","rail-fade-in":"SidebarRoot_rail-fade-in",topStrip:"SidebarRoot_topStrip",fallbackBrandName:"SidebarRoot_fallbackBrandName",localBuildBrand:"SidebarRoot_localBuildBrand",localBuildTitle:"SidebarRoot_localBuildTitle",railMark:"SidebarRoot_railMark",buildVersion:"SidebarRoot_buildVersion",newSessionLabel:"SidebarRoot_newSessionLabel",newSessionLabelMask:"SidebarRoot_newSessionLabelMask",newSessionShortcut:"SidebarRoot_newSessionShortcut",newSessionContent:"SidebarRoot_newSessionContent",panelRow:"SidebarRoot_panelRow",panelActive:"SidebarRoot_panelActive",panelGlyph:"SidebarRoot_panelGlyph",panelTitle:"SidebarRoot_panelTitle",settingsArea:"SidebarRoot_settingsArea",footerActions:"SidebarRoot_footerActions"};var ve=require("react/jsx-runtime"),Or=150,Rr=2e3;function Yr(){let e="0.2.1-alpha.3";if(e===void 0)return;let t="5719020";return e+(t===void 0?"":`-${t}`)}function Pr({id:e,label:t,wide:n,usePanelInfo:i,selectPanel:o,renderSlot:a}){let r=i(s=>s.activePanelId===e);return(0,ve.jsx)(tt.Tooltip,{label:t,delayMs:500,disabled:n,children:(0,ve.jsxs)("button",{type:"button",className:yt(Ae.panelRow,r&&Ae.panelActive),"aria-label":t,"aria-current":r?"page":void 0,onClick:()=>{o(e)},children:[(0,ve.jsx)("span",{className:Ae.panelGlyph,"aria-hidden":"true",children:a("sidebar.panellist",{size:n?16:18,active:r},{only:e})}),n&&(0,ve.jsx)("span",{className:yt(Ae.panelTitle,Ae.wide),children:t})]})})}function sa({collapsed:e,width:t,startSession:n,toggleSidebar:i,selectPanel:o,usePanels:a,useShortcuts:r,usePanelInfo:s,t:d,renderSlot:c}){let f=a(G=>G),u=r(G=>G.find(j=>j.id==="sidebar.left.toggle")),l=r(G=>G.find(j=>j.id==="session.new")),p=d(e?"toggle.open":"toggle.collapse"),[M,D]=(0,vt.useState)(e);(0,vt.useEffect)(()=>{if(!e){D(!1);return}let G=window.setTimeout(()=>{D(!0)},Or);return()=>{window.clearTimeout(G)}},[e]);let g=document.documentElement.hasAttribute("data-windows-titlebar"),y=!e,I=g?"bottom":"right",L=(0,vt.useRef)(t);e||(L.current=t);let b=(0,vt.useRef)(!e);e||(b.current=!0);let x=(0,vt.useRef)(null),[F,_]=(0,vt.useState)(!1),Z=(0,vt.useRef)(void 0),Q=()=>{Z.current===void 0&&(Z.current=window.setTimeout(()=>{Z.current=void 0,_(!1)},Rr))},v=()=>{window.clearTimeout(Z.current),Z.current=void 0};(0,vt.useEffect)(()=>{if(!F)return;let G=j=>{let J=x.current?.getBoundingClientRect();if(J===void 0)return;j.clientX>=J.left&&j.clientX<J.right&&j.clientY>=J.top&&j.clientY<J.bottom?v():Q()};return document.addEventListener("pointermove",G),()=>{document.removeEventListener("pointermove",G),v()}},[F]);let E=Yr(),O=(0,tt.isDarwinDesktop)(),P=(0,ve.jsx)(tt.Tooltip,{label:p,shortcutKeys:u?.keys,delayMs:500,side:I,children:(0,ve.jsxs)("button",{type:"button",className:yt(Ae.iconButton,Ae.toggle),"aria-label":p,"aria-keyshortcuts":u?.aria,onClick:()=>{i()},children:[!y&&!g&&(0,ve.jsx)("span",{className:Ae.railMark,"aria-hidden":"true",children:c("sidebar.brand.mark",{size:24},{fallback:(0,ve.jsx)(tt.FishLogo,{size:24})})}),(0,ve.jsx)(tt.IconPanelLeftOutlineRegular,{className:Ae.panelIcon,size:y||g?16:18}),!y&&c("sidebar.toggle.badge",{})]})});return(0,ve.jsxs)("div",{ref:x,className:yt(Ae.root,"cmd-shell-sidebar",!y&&Ae.collapsed,e&&y&&Ae.fading,!F&&Ae.quietBars),style:{width:"100%",minWidth:0},onPointerEnter:()=>{v(),_(!0)},onPointerLeave:()=>{Q()},children:[O&&(0,ve.jsx)("div",{className:Ae.topStrip,"data-window-drag":!0,children:P}),(0,ve.jsxs)("div",{className:Ae.logoRow,style:g?{transform:"none"}:void 0,"data-window-drag":!0,children:[y&&(()=>{let G=(0,ve.jsxs)("span",{className:Ae.brandIdentity,"aria-hidden":"true",children:[(0,ve.jsx)("span",{className:Ae.brandMark,children:c("sidebar.brand.mark",{size:24},{fallback:(0,ve.jsx)(tt.FishLogo,{size:24})})}),(0,ve.jsx)("span",{className:Ae.brandName,children:c("sidebar.brand.name",{},{fallback:E===void 0?(0,ve.jsx)("span",{className:Ae.fallbackBrandName,children:d("brand.localBuild")}):(0,ve.jsxs)("span",{className:Ae.localBuildBrand,children:[(0,ve.jsx)("span",{className:Ae.localBuildTitle,children:d("brand.localBuild")}),(0,ve.jsx)("span",{className:Ae.buildVersion,children:E})]})})})]});return O?(0,ve.jsx)("span",{className:yt(Ae.brand,Ae.wide),children:G}):(0,ve.jsx)("button",{type:"button",className:yt(Ae.brand,Ae.wide),"aria-label":d("session.new.label"),"aria-keyshortcuts":l?.aria,onClick:()=>{n()},children:G})})(),!O&&P]}),(0,ve.jsx)(tt.Tooltip,{label:d("session.new.label"),shortcutKeys:l?.keys,delayMs:500,side:I,disabled:y,children:(0,ve.jsxs)("button",{type:"button",className:Ae.newSession,"aria-label":d("session.new.label"),"aria-keyshortcuts":l?.aria,onClick:()=>{n()},children:[(0,ve.jsx)("span",{className:Ae.newSessionLabelMask,children:(0,ve.jsxs)("span",{className:Ae.newSessionContent,children:[y?(0,ve.jsx)(tt.IconNewChatOutlineMedium,{size:14}):(0,ve.jsx)(tt.IconNewChatOutlineRegular,{size:g?16:18}),y&&(0,ve.jsx)("span",{className:yt(Ae.newSessionLabel,Ae.wide),children:d("session.new")})]})}),y&&l!==void 0&&l.keys.length>0&&(0,ve.jsx)("span",{className:Ae.newSessionShortcut,"aria-hidden":"true",children:(0,ve.jsx)(tt.ShortcutKeys,{keys:l.keys})})]})}),f.length>0&&(0,ve.jsx)("nav",{className:Ae.panelList,"aria-label":d("panels.label"),children:f.map(({id:G,label:j})=>(0,ve.jsx)(Pr,{id:G,label:j,wide:y,usePanelInfo:s,selectPanel:o,renderSlot:c},G))}),(0,ve.jsx)("div",{className:Ae.regionArea,children:c("sidebar.workspaces",{wide:y,expandSidebar:()=>{e&&i()}})}),(0,ve.jsxs)("div",{className:Ae.footArea,children:[(0,ve.jsx)("div",{className:Ae.footerActions,children:c("sidebar.footer.action",{wide:y})}),(0,ve.jsx)("div",{className:Ae.settingsArea,children:c("sidebar.settings",{wide:y})})]})]})}var Ge=require("react"),ua=require("react-dom");var We=require("@deepseek-ai/dsh-client-ui-primitives");var da="commander-shell-SettingsRoot.module.css";if(!document.getElementById(da)){let e=document.createElement("style");e.id=da,e.textContent=`/* deepseek-harness/packages/client/ui-settings-general/src/client/SettingsRoot.module.css */
.SettingsRoot_triggerRow {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% + 4px);
  margin: 4px -2px;
}
.SettingsRoot_triggerRow.SettingsRoot_railRow {
  width: 36px;
  margin: 8px 0 10px;
}
.SettingsRoot_trigger {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  width: auto;
  height: 42px;
  margin: 0;
  padding: 0 10px 0 8px;
  box-sizing: border-box;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  cursor: pointer;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
}
.SettingsRoot_trigger:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.SettingsRoot_trigger.SettingsRoot_rail {
  flex: none;
  width: 36px;
  height: 36px;
  margin: 0;
  justify-content: center;
  gap: 0;
  padding: 0;
}
.SettingsRoot_triggerLabel {
  overflow: hidden;
  white-space: nowrap;
}
.SettingsRoot_overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.SettingsRoot_mask {
  position: absolute;
  inset: var(--dsh-frame-chrome-top, 0px) 0 0;
  background: var(--dsw-alias-bg-mask-1);
  backdrop-filter: var(--dsw-mask-blur);
}
.SettingsRoot_panel {
  position: relative;
  z-index: 1;
  display: flex;
  width: 800px;
  height: min(800px, calc(100vh - 2 * max(24px, var(--dsh-frame-overlay-top, 24px))));
  max-width: calc(100vw - 48px);
  border-radius: var(--dsw-radius-panel);
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.SettingsRoot_panel:focus {
  outline: none;
}
.SettingsRoot_nav {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: 188px;
  padding: 22px 12px 0;
  box-sizing: border-box;
}
.SettingsRoot_navTitle {
  padding: 0 12px;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.SettingsRoot_navList {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}
.SettingsRoot_navCell {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 9px 16px 9px 12px;
  box-sizing: border-box;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
  font-weight: 400;
  color: var(--dsw-alias-label-primary);
  text-align: left;
}
.SettingsRoot_navCell:hover {
  background: var(--dsw-specific-sidebar-nav-item-hover);
}
.SettingsRoot_navCell.SettingsRoot_active {
  background: var(--dsw-specific-sidebar-nav-item-active);
}
.SettingsRoot_navIcon {
  flex: none;
}
.SettingsRoot_navLabel {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.SettingsRoot_content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.SettingsRoot_header {
  flex: none;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  height: 54px;
  padding: 20px 14px 8px 10px;
  box-sizing: border-box;
}
.SettingsRoot_actions {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-left: auto;
}
.SettingsRoot_close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-primary);
}
.SettingsRoot_close:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.SettingsRoot_options {
  flex: 1;
  min-height: 0;
  padding: 0 24px 24px;
  overflow-y: auto;
}
.SettingsRoot_hiddenLabel {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
`,document.head.append(e)}var Te={triggerRow:"SettingsRoot_triggerRow",railRow:"SettingsRoot_railRow",trigger:"SettingsRoot_trigger",rail:"SettingsRoot_rail",triggerLabel:"SettingsRoot_triggerLabel",overlay:"SettingsRoot_overlay",mask:"SettingsRoot_mask",panel:"SettingsRoot_panel",nav:"SettingsRoot_nav",navTitle:"SettingsRoot_navTitle",navList:"SettingsRoot_navList",navCell:"SettingsRoot_navCell",active:"SettingsRoot_active",navIcon:"SettingsRoot_navIcon",navLabel:"SettingsRoot_navLabel",content:"SettingsRoot_content",header:"SettingsRoot_header",actions:"SettingsRoot_actions",close:"SettingsRoot_close",options:"SettingsRoot_options",hiddenLabel:"SettingsRoot_hiddenLabel"};var Vt=require("@deepseek-ai/dsh-client-ui-primitives");var la="commander-shell-DesktopUpdateIndicator.module.css";if(!document.getElementById(la)){let e=document.createElement("style");e.id=la,e.textContent=`/* deepseek-harness/packages/client/ui-settings-general/src/client/DesktopUpdateIndicator.module.css */
.DesktopUpdateIndicator_indicator {
  display: inline-grid;
  grid-template-columns: 14px max-content;
  align-items: center;
  column-gap: 4px;
  flex: none;
  height: 28px;
  padding: 0 8px;
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color) 20%, transparent);
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-brand-primary-new-colorprimary-new-color);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color) 8%, transparent);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.DesktopUpdateIndicator_icon {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
}
.DesktopUpdateIndicator_badge {
  position: absolute;
  inset-inline-end: 2px;
  top: 2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-brand-primary-new-colorprimary-new-color);
}
.DesktopUpdateIndicator_errorDot {
  background: currentColor;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  corner-shape: round;
}
.DesktopUpdateIndicator_spinner {
  animation: DesktopUpdateIndicator_spin 1s linear infinite;
}
@keyframes DesktopUpdateIndicator_spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .DesktopUpdateIndicator_spinner {
    animation: none;
  }
}
.DesktopUpdateIndicator_indicator[aria-disabled=true] {
  cursor: default;
}
`,document.head.append(e)}var ln={indicator:"DesktopUpdateIndicator_indicator",icon:"DesktopUpdateIndicator_icon",badge:"DesktopUpdateIndicator_badge",errorDot:"DesktopUpdateIndicator_errorDot",spinner:"DesktopUpdateIndicator_spinner",spin:"DesktopUpdateIndicator_spin"};var kt=require("react/jsx-runtime"),Qr=new Set(["checking","downloading","verifying","installing"]);function _r(e,t){let i={idle:"",checking:t("desktop.update.checking"),available:t("desktop.update.available"),downloading:t("desktop.update.progress",{percent:e.percent??0}),verifying:t("desktop.update.verifying"),installing:t("desktop.update.installing"),ready:t("desktop.update.ready"),error:t("desktop.update.retry")}[e.phase];if(e.phase==="checking"||e.phase==="verifying"||e.phase==="installing")return{label:i,detail:e.version??i};if(e.phase==="error"){let o={check:t("desktop.update.checkFailed"),"check-network":t("desktop.update.checkNetworkFailed"),download:t("desktop.update.downloadFailed"),"download-network":t("desktop.update.downloadNetworkFailed"),install:t("desktop.update.installFailed"),"install-network":t("desktop.update.installNetworkFailed"),"stop-failed":t("desktop.update.stopFailed"),"tasks-changed":t("desktop.update.tasksChanged"),"tasks-unavailable":t("desktop.update.tasksUnavailable")};return{label:i,detail:o[e.failure??"install"]}}return e.phase==="downloading"&&e.version!==void 0?{label:i,detail:t("desktop.update.downloadDetail",{percent:e.percent??0,version:e.version})}:{label:i,detail:e.version===void 0?i:t("desktop.update.versionDetail",{label:i,version:e.version})}}function ca({wide:e,hidden:t,t:n,view:i,onOpen:o}){let{presentation:a,failed:r,opening:s}=i;if(!e||t||!r&&(a===void 0||a.phase==="idle"))return null;let d=n("desktop.update.retry"),c=a===void 0?{label:d,detail:d}:_r(a,n),f=r?d:c.label,u=r||a?.phase==="error",l=s||a!==void 0&&Qr.has(a.phase);return(0,kt.jsx)(Vt.Tooltip,{label:r?d:c.detail,side:"top",children:(0,kt.jsxs)("button",{type:"button",className:ln.indicator,"aria-label":f,"aria-disabled":l,onClick:()=>{l||o()},children:[(0,kt.jsx)("span",{className:ln.icon,"aria-hidden":"true",children:u?(0,kt.jsx)("span",{className:ln.errorDot}):l?(0,kt.jsx)(Vt.IconLoadingOutlineRegular,{className:ln.spinner,size:14}):(0,kt.jsx)(Vt.IconDownloadOutlineRegular,{size:14})}),(0,kt.jsx)("span",{children:f})]})})}var De=require("react/jsx-runtime"),Zr=2e3,Hr=800;function Gr(e){return e==="link"?(0,De.jsx)("span",{className:Te.navIcon,style:{display:"inline-flex",width:16,height:16},"aria-hidden":"true",dangerouslySetInnerHTML:{__html:'<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M13.06 10.94a5.74 5.74 0 0 1 0 8.13c-2.25 2.24-5.89 2.25-8.13 0-2.24-2.25-2.25-5.89 0-8.13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M10.59 13.41c-2.34-2.34-2.34-6.14 0-8.49 2.34-2.35 6.14-2.34 8.49 0 2.35 2.34 2.34 6.14 0 8.49" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>'}}):e==="harness-tools"?(0,De.jsxs)("svg",{className:Te.navIcon,width:"16",height:"16",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.6",strokeLinecap:"round",strokeLinejoin:"round","aria-hidden":"true",children:[(0,De.jsx)("rect",{x:"3",y:"4",width:"18",height:"16",rx:"2"}),(0,De.jsx)("path",{d:"m7 9 3 3-3 3M13 15h4"})]}):e==="voice"?(0,De.jsx)("svg",{className:Te.navIcon,width:"16",height:"16",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.6",strokeLinecap:"round","aria-hidden":"true",children:(0,De.jsx)("path",{d:"M3 10v4m4-7v10m5-14v18m5-14v10m4-7v4"})}):e==="account"?(0,De.jsx)(We.IconUserOutlineMedium,{className:Te.navIcon,size:16}):e==="models"?(0,De.jsx)(We.IconDataOutlineMedium,{className:Te.navIcon,size:16}):e==="agent-presets"?(0,De.jsx)(We.IconAgentPresetOutlineMedium,{className:Te.navIcon,size:16}):e==="plugins"?(0,De.jsx)(We.IconPersonalizationOutlineMedium,{className:Te.navIcon,size:16}):e==="archived-sessions"?(0,De.jsx)(We.IconArchiveOutlineMedium,{className:Te.navIcon,size:16}):(0,De.jsx)(We.IconSettingsOutlineMedium,{className:Te.navIcon,size:16})}function Wr({rows:e,renderSlot:t,activeId:n,onSelect:i,onClose:o}){let a=e.find(d=>d.id===n)?.id??e[0]?.id,r=(0,Ge.useId)(),s=(0,Ge.useRef)(null);return(0,We.useModalLayer)(s,!0,o),(0,ua.createPortal)((0,De.jsxs)("div",{className:Te.overlay+" cmd-settings-overlay",role:"presentation",children:[(0,De.jsx)("div",{className:Te.mask,"aria-hidden":"true",onClick:o}),(0,De.jsxs)("div",{ref:s,tabIndex:-1,"data-shortcut-modal":"settings",className:Te.panel,role:"dialog","aria-modal":"true","aria-labelledby":r,children:[(0,De.jsxs)("nav",{className:Te.nav,children:[(0,De.jsx)("div",{className:Te.navTitle,id:r,tabIndex:-1,"data-modal-autofocus":a===void 0?"":void 0,children:t("settings.header",{})}),(0,De.jsx)("div",{className:Te.navList,children:e.map(d=>(0,De.jsxs)("button",{type:"button",className:yt(Te.navCell,d.id===a&&Te.active),"aria-current":d.id===a?"true":void 0,"data-modal-autofocus":d.id===a?"":void 0,onClick:()=>{i(d.id)},children:[Gr(d.id),(0,De.jsx)("span",{className:Te.navLabel,children:d.label})]},d.id))})]}),(0,De.jsxs)("div",{className:Te.content,children:[(0,De.jsxs)("div",{className:Te.header,children:[(0,De.jsx)("div",{className:Te.actions,children:t("settings.action",{})}),(0,De.jsxs)("button",{type:"button",className:Te.close,onClick:o,children:[(0,De.jsx)(We.IconCloseOutlineRegular,{size:14}),(0,De.jsx)("span",{className:Te.hiddenLabel,children:t("settings.close",{})})]})]}),(0,De.jsx)("div",{className:Te.options,children:a!==void 0&&t("settings.section",{close:o},{only:a})})]})]})]}),document.body)}function pa(e){let{wide:t,reconnect:n,useConnectionState:i,useSections:o,useOnboardingSteps:a,useSessions:r,renderSlot:s,t:d,useDesktopUpdate:c,openDesktopUpdate:f,useStore:u,actions:l,useShortcuts:p}=e,{open:M,activeId:D}=u($=>$),g=p($=>$.find(se=>se.id==="settings.open")),{close:y,openSection:I}=l,[L,b]=(0,Ge.useState)(),[x,F]=(0,Ge.useState)(()=>new Set),[_,Z]=(0,Ge.useState)(!1),[Q,v]=(0,Ge.useState)(!1),E=(0,Ge.useRef)(void 0),O=o($=>$),P=c($=>$),G=i($=>$),j=(0,Ge.useRef)(G),J=a($=>$),oe=r($=>{let se=Object.values($.byId).find(re=>(re.retainedBy.mainView??0)>0);return $.phase==="ready"&&(se===void 0||se.blank)}),R=L!==void 0?J.find($=>$.id===L):oe?J.find($=>!x.has($.id)):void 0;(0,Ge.useEffect)(()=>{oe||F(new Set)},[oe]);let T=(0,Ge.useRef)(R);(0,Ge.useEffect)(()=>{let $=T.current===void 0&&R!==void 0;T.current=R,$&&M&&y()},[R,M,y]),(0,Ge.useLayoutEffect)(()=>{let $=j.current;if(j.current=G,G!=="connected"){Z(!1);return}$!=="disconnected"&&$!=="connecting"||Z(!0)},[G]),(0,Ge.useLayoutEffect)(()=>{if(!_||Q)return;let $=window.setTimeout(()=>{Z(!1)},Zr);return()=>{window.clearTimeout($)}},[_,Q]),(0,Ge.useLayoutEffect)(()=>{if(G==="connecting"){E.current=Date.now();return}let $=E.current;if($===void 0)return;E.current=void 0;let se=Hr-(Date.now()-$);if(se<=0)return;v(!0);let re=window.setTimeout(()=>{v(!1)},se);return()=>{window.clearTimeout(re),v(!1)}},[G]);let V=(0,Ge.useCallback)($=>{b(void 0),F(se=>se.has($)?se:new Set([...se,$]))},[]),de;return G==="connecting"||Q?de="connecting":G==="disconnected"?de="disconnected":_&&(de="recovered"),(0,De.jsxs)(De.Fragment,{children:[(0,De.jsxs)("div",{className:yt(Te.triggerRow,!t&&Te.railRow,"cmd-sidebar-footer"),children:[(0,De.jsxs)("div",{className:"cmd-sidebar-status",children:[(0,De.jsx)(We.ConnectionIndicator,{state:t&&P.presentation?.phase!=="installing"?de:void 0,disconnectedLabel:d("connection.error"),connectingLabel:d("connection.connecting"),recoveredLabel:d("connection.connected"),reconnectActionLabel:d("connection.reconnect"),restartActionLabel:d("connection.restart"),onReconnect:n}),(0,De.jsx)(ca,{wide:t,hidden:de!==void 0&&P.presentation?.phase!=="installing",t:d,view:P,onOpen:f})]}),s("settings.launcher",{wide:t,settingsOpen:M,openSettings:l.open,...g?.keys.length?{settingsShortcut:{keys:g.keys,aria:g.aria}}:{},openOnboarding:$=>{y(),b($)}},{fallback:(0,De.jsx)(We.Tooltip,{disabled:M,label:d("trigger"),shortcutKeys:g?.keys,children:(0,De.jsx)("button",{type:"button",className:yt(Te.trigger,!t&&Te.rail),"aria-label":d("trigger"),"aria-keyshortcuts":g?.aria,"aria-haspopup":"dialog","aria-expanded":M,onClick:()=>{l.open()},children:s("settings.trigger",{wide:t})})})})]}),M&&(0,De.jsx)(Wr,{rows:O,renderSlot:s,activeId:D,onSelect:l.select,onClose:y}),R!==void 0&&s("settings.onboarding",{stepId:R.id,explicit:L!==void 0,complete:()=>{V(R.id)},openSection:I},{only:R.id})]})}var ga=require("react/jsx-runtime");function Vr(e,t){return function(n,i,o){return i==="workspace.defaultName"?e.getLocale().active==="zh"?"\u6700\u8FD1":"Recent":t.call(this,n,i,o)}}function Jr(e){let t=(0,Dn.useMemo)(()=>aa(e.actions),[e.actions]);return(0,Dn.useEffect)(()=>()=>t.dispose(),[t]),(0,ga.jsx)(oa,{...e,actions:t})}function ma(e){for(let[t,n,i]of[["root","sidebar",Jr],["sidebar","sidebar.workspaces",sa],["sidebar.settings","settings.section",pa]])e.effect(()=>{let o=e.slots.entries(t).find(r=>r.children?.[n]);if(!o)throw Error("Official shell entry is unavailable: "+t);let a=o.component;return o.component=i,()=>{o.component===i&&(o.component=a)}});e.effect(()=>{let t=e.locale,n=t.translate;if(typeof n!="function")throw Error("Official locale translation adapter is unavailable");let i=Vr(t,n);return t.translate=i,()=>{t.translate===i&&(t.translate=n)}})}function Nn(e){return e?.isDefault===!0}var Kr=e=>e.find(Nn),fa=e=>e.filter(t=>!Nn(t));function ha(e,t){let n=new Set(t.filter(Nn).map(i=>i.id??i.workspaceId));return e.filter(i=>n.has(i.projectId)||t.some(o=>Nn(o)&&typeof o.path=="string"&&o.path.length>0&&o.path===i.cwd))}function yo(e,t,n){if(t?.pendingInteraction||n?.status==="waiting")return"waiting";if((t?.running??e?.running)||n?.status==="running")return"running";if(n?.status==="connecting"||n?.status==="failed")return n.status;if(t?.completionUnread===!0)return"completed";if(n)return n.status==="completed"?"idle":n.status}function xo(e,t){if(!e)return null;let n=e.id??e.workspaceId,i=e.path,o=new Set(e.sessionIds??[]),a={connecting:1,running:2,waiting:3},r=null;for(let s of t){if(s.archived||!a[s.status])continue;(n&&s.projectId===n||i&&s.cwd===i||s.id&&o.has(s.id)||s.ownerSessionId&&o.has(s.ownerSessionId))&&a[s.status]>(a[r]??0)&&(r=s.status)}return r}function Uo(e,t=[],n){let i=e?.items,o=e?.phase==="ready"||i?.length>0?i??[]:t,a=new Map(t.map(r=>[r.id??r.workspaceId,r]));return o.map(r=>{let s=r.workspaceId??r.id;return{...r,id:s,sessionIds:r.sessionIds??[],isDefault:n!=null?s===n:(a.get(s)?.isDefault??r.isDefault)===!0}})}function vo(e,t){return typeof t=="string"&&t.length>0&&(e.id===t||e.native===!0&&e.ownerSessionId===t&&(!e.parentId||e.harnessAdopted===!0))}async function ba(e,t){let n;try{n=await e.workspaces.initializeDefault()}catch{}return t({workspaceId:n?.workspaceId})}async function Ma(e,t,n,i,o){let a=Uo(e.workspaces.list?.getSnapshot(),t,i),r=n??Kr(a)?.id;if(n==null&&o&&(r=(await o())?.workspaceId),r||(r=(await e.workspaces.initializeDefault())?.workspaceId),!r)throw Error("\u6700\u8FD1\u5DE5\u4F5C\u533A\u521B\u5EFA\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5");return e.uiWorkspace.startSession(r),r}function wa(e){return[["delegation","\u539F\u751F\u59D4\u6D3E"],["fonts","\u754C\u9762\u5B57\u4F53"]].flatMap(([t,n])=>{let i=e?.[t];if(i?.available!==!1||!i.error)return[];let o=String(i.error).replace(/\s+/g," ").trim().slice(0,200);return[n+"\u6682\u4E0D\u53EF\u7528\uFF1A"+o]}).join(`
`)}var we=require("react"),Nt=require("@deepseek-ai/dsh-client-ui-primitives");async function xa(e,t,n){if(!e.ok){let c=await e.json();throw Error(c.error||"\u8BED\u97F3\u8BC6\u522B\u8BF7\u6C42\u5931\u8D25")}if(!e.body)throw Error("\u8BED\u97F3\u8BC6\u522B\u672A\u8FD4\u56DE\u4E8B\u4EF6\u6D41");let i=e.body.getReader(),o=new TextDecoder,a="",r=0,s=()=>{i.cancel().catch(()=>{})};t.addEventListener("abort",s,{once:!0});let d=c=>{if(!c.trim())return;let f;try{f=JSON.parse(c)}catch{throw Error("\u8BED\u97F3\u8BC6\u522B\u4E8B\u4EF6\u683C\u5F0F\u9519\u8BEF")}if(f.type==="error")throw Error(f.error||"\u8BED\u97F3\u8BC6\u522B\u8FDE\u63A5\u5931\u8D25");typeof f.text=="string"&&f.text.length<=2e4&&n(f)};try{for(;;){t.throwIfAborted();let{value:c,done:f}=await i.read();if(t.throwIfAborted(),f)break;if(r+=c.length,r>16*1024*1024)throw Error("\u8BED\u97F3\u4E8B\u4EF6\u6D41\u8D85\u9650");if(a+=o.decode(c,{stream:!0}),a.length>65536)throw Error("\u8BED\u97F3\u4E8B\u4EF6\u8FC7\u5927");let u;for(;(u=a.indexOf(`
`))>=0;)d(a.slice(0,u)),a=a.slice(u+1)}a+=o.decode(),a.trim()&&d(a)}finally{t.removeEventListener("abort",s),await i.cancel().catch(()=>{}),i.releaseLock()}}var Do=()=>{let e,t,n=new Promise((i,o)=>{e=i,t=o});return n.catch(()=>{}),{promise:n,resolve:e,reject:t}},An=()=>new DOMException("Voice input cleared","AbortError"),ya=480,Xr=30,qr=600,$r=12,jn=class{constructor({request:t,endpoint:n,headers:i,openSocket:o,onError:a=()=>{},onWarning:r=()=>{},now:s=Date.now}){Object.assign(this,{request:t,endpoint:n,headers:i,openSocket:o,onError:a,onWarning:r,now:s}),this.abort=new AbortController,this.utterances=new Map,this.queue=[],this.inflight=new Map,this.epoch=0,this.sequence=0,this.closed=!1,this.ready=!1,this.committing=0,this.dropped=0}async action(t,n={},i=this.abort.signal){let o=await this.request(this.endpoint("api/voice"),{method:"POST",credentials:"same-origin",signal:AbortSignal.any([i,AbortSignal.timeout(12e3)]),headers:{"content-type":"application/json",...this.headers()},body:JSON.stringify({action:t,id:this.id,...n})}),a=await o.json();if(!o.ok)throw Error(a.error||"\u5B9E\u65F6\u8BC6\u522B\u8FDE\u63A5\u5931\u8D25");return a}async start(){try{if(typeof this.openSocket!="function")throw Error("\u5F53\u524D\u8F7D\u4F53\u4E0D\u652F\u6301\u5B9E\u65F6\u8BED\u97F3\u8FDE\u63A5");let{id:t,ticket:n}=await this.action("asr.start");this.id=t,this.closed&&(await this.action("asr.end",{},AbortSignal.timeout(3e3)).catch(()=>{}),this.abort.signal.throwIfAborted()),this.abort.signal.throwIfAborted();let i=this.openSocket("/api/voice/realtime");this.ws=i,this.handshake=Do(),i.addEventListener("open",()=>{this.closed||i.send(JSON.stringify({type:"attach",id:t,ticket:n,callId:this.headers()["x-voice-call-id"]||""}))}),i.addEventListener("message",a=>this.receive(a.data)),i.addEventListener("error",()=>this.fail(Error("\u5B9E\u65F6\u8BED\u97F3\u8FDE\u63A5\u5931\u8D25"))),i.addEventListener("close",()=>{this.closed||this.fail(Error("\u5B9E\u65F6\u8BED\u97F3\u8FDE\u63A5\u5DF2\u65AD\u5F00"))});let o=setTimeout(()=>this.fail(Error("\u5B9E\u65F6\u8BED\u97F3\u8FDE\u63A5\u8D85\u65F6")),1e4);try{await this.handshake.promise}finally{clearTimeout(o)}this.pulse=setInterval(()=>this.pump(),20),this.pulse.unref?.()}catch(t){throw await this.close(),t}}receive(t){if(!this.closed)try{if(typeof t!="string"||t.length>65536)throw Error("\u5B9E\u65F6\u8BED\u97F3\u4E8B\u4EF6\u65E0\u6548");let n=JSON.parse(t);if(n.type==="error")throw Error(n.error||"\u5B9E\u65F6\u8BC6\u522B\u5931\u8D25");if(n.type==="closed")throw Error("\u5B9E\u65F6\u8BED\u97F3\u4F1A\u8BDD\u5DF2\u7ED3\u675F");if(n.epoch!==this.epoch)return;if(n.type==="ready"){this.ready=!0,this.handshake?.resolve(),this.clearing?.resolve(),this.clearing=null,this.pump();return}if(n.type==="ack"){if(!this.inflight.delete(n.sequence))return;n.accepted||this.drop(1),this.pump();return}let i=this.utterances.get(n.utteranceId);if(!i)return;if(typeof n.text!="string"||n.text.length>2e4)throw Error("\u5B9E\u65F6\u8BC6\u522B\u6587\u672C\u65E0\u6548");n.type==="partial"&&n.text!==i.lastPartial&&(i.lastPartial=n.text,i.partial(n.text)),n.type==="final"&&(clearTimeout(i.timer),this.utterances.delete(n.utteranceId),this.committing===n.utteranceId&&(this.committing=0),i.resolve(n.text),this.pump())}catch(n){this.fail(n)}}fail(t){if(this.closed)return;this.handshake?.reject(t),this.clearing?.reject(t);for(let i of this.utterances.values())clearTimeout(i.timer),i.reject(t);let n=!!this.pulse;this.close(),n&&this.onError(t)}drop(t){this.dropped+=t,(!this.warnedAt||this.now()-this.warnedAt>=2e3)&&(this.warnedAt=this.now(),this.onWarning({droppedFrames:this.dropped,message:"\u7F51\u7EDC\u62E5\u5835\uFF0C\u5DF2\u8DF3\u8FC7\u8FC7\u671F\u8BED\u97F3\uFF1B\u8BF7\u91CD\u8BF4\u672A\u8BC6\u522B\u5185\u5BB9"}))}prune(){let t=this.now(),n=0,i=this.queue.reduce((o,a)=>o+(a.type==="audio"),0);this.queue=this.queue.filter(o=>o.type!=="audio"?!0:t-o.at>qr||i>Xr?(i--,n++,!1):!0),n&&this.drop(n)}append(t,n,i){if(this.abort.signal.throwIfAborted(),!Number.isSafeInteger(n)||n<1||n>4294967295)throw Error("\u8BED\u97F3\u6BB5\u6807\u8BC6\u65E0\u6548");let o=this.utterances.get(n);if(!o){if(this.utterances.size>=8)throw Error("\u8BC6\u522B\u54CD\u5E94\u8FC7\u6162\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");o={...Do(),partial:i,lastPartial:"",committed:!1},this.utterances.set(n,o)}if(o.committed)throw Error("\u8BED\u97F3\u6BB5\u5DF2\u7ECF\u63D0\u4EA4");let a=t.reduce((d,c)=>d+c.length,0),r=new Int16Array(a),s=0;for(let d of t)r.set(d,s),s+=d.length;for(let d=0;d<r.length;d+=ya)this.queue.push({type:"audio",id:n,pcm:r.slice(d,d+ya),at:this.now()});this.prune(),this.pump()}pump(){if(!this.closed){if(this.prune(),this.inflight.size&&this.now()-this.inflight.values().next().value>12e3){this.fail(Error("\u5B9E\u65F6\u8BED\u97F3\u7F51\u7EDC\u54CD\u5E94\u8D85\u65F6"));return}if(!(!this.ready||this.committing||this.ws?.readyState!==1))try{for(;this.queue.length;){let t=this.queue[0];if(this.ws.bufferedAmount>1920||this.inflight.size>=$r)return;if(this.queue.shift(),t.type==="commit"){this.committing=t.id,this.ws.send(JSON.stringify({type:"commit",epoch:this.epoch,utteranceId:t.id}));return}let n=++this.sequence,i=new Uint8Array(12+t.pcm.length*2),o=new DataView(i.buffer);o.setUint32(0,this.epoch,!0),o.setUint32(4,t.id,!0),o.setUint32(8,n,!0);for(let a=0;a<t.pcm.length;a++)o.setInt16(12+a*2,t.pcm[a],!0);this.inflight.set(n,this.now()),this.ws.send(i)}}catch(t){this.fail(t)}}}commit(t){let n=this.utterances.get(t);return n?(n.committed||(n.committed=!0,n.timer=setTimeout(()=>this.fail(Error("\u5B9E\u65F6\u8BC6\u522B\u7B49\u5F85\u6700\u7EC8\u7ED3\u679C\u8D85\u65F6")),25e3),this.queue.push({type:"commit",id:t}),this.pump()),n.promise):Promise.resolve("")}clear(){if(this.closed||!this.ws)return Promise.resolve();let t=this.clearing;t||this.epoch++,this.ready=!1,this.committing=0,this.queue=[],this.inflight.clear();for(let i of this.utterances.values())clearTimeout(i.timer),i.reject(An());if(this.utterances.clear(),t)return t.promise;this.clearing=Do();let n=this.clearing.promise;this.resetTimer=setTimeout(()=>this.fail(Error("\u5B9E\u65F6\u8BC6\u522B\u91CD\u7F6E\u8D85\u65F6")),12e3),n.finally(()=>clearTimeout(this.resetTimer)).catch(()=>{});try{this.ws.send(JSON.stringify({type:"clear",epoch:this.epoch}))}catch(i){this.fail(i)}return n}async close(){if(!this.closed){this.closed=!0,this.ready=!1,clearInterval(this.pulse),clearTimeout(this.resetTimer),this.abort.abort(),this.handshake?.reject(An()),this.clearing?.reject(An());for(let t of this.utterances.values())clearTimeout(t.timer),t.reject(An());this.utterances.clear(),this.queue=[],this.inflight.clear(),this.ws?.close(),this.id&&await this.action("asr.end",{},AbortSignal.timeout(3e3)).catch(()=>{})}}};var cn=null,es=()=>new DOMException("Voice operation cancelled","AbortError");function ts(e){let t=e.reduce((r,s)=>r+s.length,0),n=new ArrayBuffer(44+t*2),i=new DataView(n),o=(r,s)=>{for(let d=0;d<s.length;d++)i.setUint8(r+d,s.charCodeAt(d))};o(0,"RIFF"),i.setUint32(4,36+t*2,!0),o(8,"WAVE"),o(12,"fmt "),i.setUint32(16,16,!0),i.setUint16(20,1,!0),i.setUint16(22,1,!0),i.setUint32(24,24e3,!0),i.setUint32(28,24e3*2,!0),i.setUint16(32,2,!0),i.setUint16(34,16,!0),o(36,"data"),i.setUint32(40,t*2,!0);let a=44;for(let r of e)for(let s of r)i.setInt16(a,s,!0),a+=2;return new Blob([n],{type:"audio/wav"})}var ns=(e,t)=>e?t?e+(/[\p{Script=Han}]$/u.test(e)||/^[\p{Script=Han}，。！？、]/u.test(t)?"":" ")+t:e:t,Cn=class{constructor({transcribe:t,realtime:n,parallel:i=!1,onPartial:o=()=>{},onFinal:a=()=>{},onSpeechStart:r=()=>{},onSpeechEnd:s=()=>{},onLevel:d=()=>{},onError:c=()=>{},silenceMs:f=320,workletURL:u="api/voice/worklet"}={}){Object.assign(this,{transcribe:t,realtime:n,parallel:i,onPartial:o,onFinal:a,onSpeechStart:r,onSpeechEnd:s,onLevel:d,onError:c,silenceMs:f,workletURL:u}),this.levelAt=0,this.generation=0,this.active=!1,this.pending=Promise.resolve(),this.controllers=new Set,this.pre=[],this.noise=.001,this.muted=!1,this.playbackActive=!1,this.echoUntil=0,this.attack=0,this.backlog=0,this.segment=null,this.stopping=null,this.utteranceId=0,this.finals=new Set,this.tasks=new Set,this.finalChain=Promise.resolve(),this.asrActive=0,this.asrWaiters=[]}async start(){if(this.active)return;if(this.stopping&&await this.stopping,cn&&cn!==this)throw Error("\u9EA6\u514B\u98CE\u5DF2\u88AB\u53E6\u4E00\u4E2A\u8BED\u97F3\u5165\u53E3\u4F7F\u7528");if(!globalThis.navigator?.mediaDevices?.getUserMedia)throw Error("\u9EA6\u514B\u98CE\u9700\u8981 HTTPS \u6216 localhost \u5B89\u5168\u73AF\u5883");cn=this,this.active=!0,this.lastFinal="";let t=++this.generation;try{let n=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:!0,noiseSuppression:!0,autoGainControl:!0}});if(!this.active||t!==this.generation){n.getTracks().forEach(a=>a.stop());return}this.stream=n;let i=globalThis.AudioContext||globalThis.webkitAudioContext;this.context=new i;let o=this.context;if(await o.audioWorklet.addModule(String(this.workletURL)),!this.active||t!==this.generation){this.context===o&&await this.release();return}this.node=new AudioWorkletNode(this.context,"voice-capture",{numberOfOutputs:1,outputChannelCount:[1]}),this.node.port.onmessage=({data:a})=>{this.active&&!this.muted&&a.epoch===this.generation&&a.type==="pcm"&&this.accept(new Int16Array(a.data))},this.node.port.postMessage({type:"mute",value:this.muted,epoch:this.generation});for(let a of n.getAudioTracks?.()||[])a.enabled=!this.muted;this.source=this.context.createMediaStreamSource(n),this.source.connect(this.node),this.node.connect(this.context.destination),await this.context.resume()}catch(n){throw t===this.generation&&(this.active=!1,await this.release()),n}}setPlaybackActive(t){this.playbackActive=!!t,t||(this.echoUntil=Date.now()+220)}setMuted(t){if(this.muted!==!!t){this.muted=!!t,this.muted&&this.generation++;for(let n of this.stream?.getAudioTracks?.()||[])n.enabled=!this.muted;if(this.node?.port.postMessage({type:"mute",value:this.muted,epoch:this.generation}),this.muted){let n=this.segment?.id;this.segment=null,this.pre=[],this.attack=0;for(let i of this.controllers)i.abort();this.realtime?.clear?.().catch(i=>this.onError(i)),this.onLevel(0),n&&this.onSpeechEnd(n,{cancelled:!0})}}}accept(t){if(this.muted)return;let n=0;for(let c of t)n+=(c/32768)**2;let i=Math.sqrt(n/t.length),o=t.length/24e3*1e3,a=Date.now();a-this.levelAt>=66&&(this.levelAt=a,this.onLevel(Math.min(1,i*8)));let r=this.playbackActive||a<this.echoUntil,s=i>Math.max(r?.009:.004,this.noise*(r?3.5:2.2));if(this.segment)this.segment.frames.push(t),this.segment.samples+=t.length;else{for(this.pre.push(t);this.pre.reduce((c,f)=>c+f.length,0)>24e3*.22;)this.pre.shift();if(this.attack=s?this.attack+o:0,!s&&!r&&(this.noise=this.noise*(i<this.noise?.9:.995)+i*(i<this.noise?.1:.005)),this.attack<(r?200:100))return;this.segment={frames:this.pre.splice(0),samples:0,total:0,silence:0,text:"",generation:this.generation,id:++this.utteranceId},this.segment.samples=this.segment.frames.reduce((c,f)=>c+f.length,0),this.attack=0,this.onSpeechStart(this.segment.id)}let d=this.segment;d.total+=o,d.silence=s?0:d.silence+o,d.silence>=this.silenceMs||d.total>=15e3?this.commit():(this.realtime||d.samples>=24e3*1.5)&&this.submit(d)}submit(t){if(!t.frames.length)return;if(this.realtime){let r=t.frames;t.frames=[],t.samples=0;try{Promise.resolve(this.realtime.append(r,t.id,s=>{t.generation===this.generation&&t.id===this.utteranceId&&(t.text=s,this.onPartial(s,{utteranceId:t.id}))})).catch(s=>{s.name!=="AbortError"&&t.generation===this.generation&&this.onError(s)})}catch(s){s.name!=="AbortError"&&t.generation===this.generation&&this.onError(s)}return}if(this.backlog>=6){t.frames=[],t.samples=0,this.onError(Error("\u8BED\u97F3\u8BC6\u522B\u5904\u7406\u8FC7\u6162\uFF0C\u5DF2\u4E22\u5F03\u8D85\u9650\u97F3\u9891"));return}let n=ts(t.frames);t.frames=[],t.samples=0,this.backlog++,t.parts??=[];let i={text:"",done:!1};t.parts.push(i);let o=async()=>{if(t.generation!==this.generation)return;let r=new AbortController;this.controllers.add(r);let s;try{if(this.parallel){for(;this.asrActive>=2;)await new Promise(d=>this.asrWaiters.push(d));if(t.generation!==this.generation){this.asrWaiters.shift()?.();return}this.asrActive++}try{let d=await Promise.race([Promise.resolve().then(()=>this.transcribe(n,r.signal,c=>{t.generation===this.generation&&(i.text=c,this.publishPartials(t,i))})),new Promise((c,f)=>{s=setTimeout(()=>{f(Error("\u8BED\u97F3\u8BC6\u522B\u8D85\u65F6")),r.abort()},25e3),r.signal.addEventListener("abort",()=>f(es()),{once:!0})})]);if(t.generation!==this.generation)return;i.text=(typeof d=="string"?d:d?.text||"").trim()}finally{i.done=!0,this.publishPartials(t,i),this.parallel&&(this.asrActive--,this.asrWaiters.shift()?.())}}catch(d){d.name!=="AbortError"&&t.generation===this.generation&&this.onError(d)}finally{clearTimeout(s),this.controllers.delete(r)}},a=(this.parallel?Promise.resolve().then(o):this.pending.then(o)).finally(()=>{this.backlog--});this.track(t,a),this.pending=this.parallel?Promise.all([...this.tasks]):a}track(t,n){this.tasks.add(n),n.then(()=>this.tasks.delete(n),()=>this.tasks.delete(n)),t.tasks??=[],t.tasks.push(n)}publishPartials(t,n){if(t.generation!==this.generation)return;let i="",o=!0;for(let a of t.parts){if(!o)break;a.text&&(i=ns(i,a.text)),o=a.done}i&&i!==t.text&&(t.text=i,this.onPartial(i,{utteranceId:t.id}))}commit(){let t=this.segment;if(!t)return Promise.resolve("");this.segment=null,this.pre=[],this.onSpeechEnd(t.id,{cancelled:!1}),this.submit(t);let n;try{n=this.realtime&&t.generation===this.generation?Promise.resolve(this.realtime.commit(t.id)):null}catch(a){n=Promise.reject(a)}n?.catch(()=>{});let i=this.finalChain.then(async()=>(await Promise.all(t.tasks||[]),n&&(t.text=await n),t.generation===this.generation?(t.text&&(this.lastFinal=t.text),this.onFinal(t.text,{utteranceId:t.id,final:!0}),t.text):""));this.finalChain=i.catch(()=>{});let o=i.then(()=>{},a=>{t.generation===this.generation&&a.name!=="AbortError"&&this.onError(a)}).finally(()=>this.finals.delete(o));return this.finals.add(o),this.pending=Promise.all([...this.tasks,this.finalChain]),i}async release(){this.node?.disconnect(),this.source?.disconnect(),this.node&&(this.node.port.onmessage=null),this.stream?.getTracks().forEach(n=>n.stop());let t=this.context;this.node=null,this.source=null,this.stream=null,this.context=null,t&&t.state!=="closed"&&await t.close().catch(()=>{}),cn===this&&(cn=null)}stop({flush:t=!0}={}){if(this.stopping)return this.stopping;this.active=!1;let n=t?this.commit():Promise.resolve("");if(!t){this.generation++,this.segment=null;for(let i of this.controllers)i.abort();this.realtime?.close()}return this.pre=[],this.attack=0,this.stopping=(async()=>{await this.release();let i=await n;return await this.pending,await Promise.allSettled([...this.finals]),await this.realtime?.close(),t&&(i||this.lastFinal)||""})().finally(()=>{this.stopping=null}),this.stopping}dispose(){return this.stop({flush:!1})}},In=class{constructor({onPlayed:t=()=>{},onPlaybackStart:n=()=>{},onPlaybackIdle:i=()=>{},onMetrics:o=()=>{},onError:a=()=>{},workletURL:r="api/voice/worklet",maxBufferedSeconds:s=2}={}){Object.assign(this,{onPlayed:t,onPlaybackStart:n,onPlaybackIdle:i,onMetrics:o,onError:a,workletURL:r}),this.maxSamples=Math.max(24e3,s*24e3),this.epoch=0,this.queued=0,this.waiters=[],this.odd=null,this.starting=null}async start(){if(this.starting)return this.starting;if(!(this.context?.state==="running"&&this.node))return this.starting=(async()=>{let t=globalThis.AudioContext||globalThis.webkitAudioContext;if(!t)throw Error("\u6B64\u6D4F\u89C8\u5668\u4E0D\u652F\u6301 Web Audio");if(!this.context){this.context=new t;try{await this.context.audioWorklet.addModule(String(this.workletURL)),this.node=new AudioWorkletNode(this.context,"voice-playback",{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[1]}),this.node.port.onmessage=({data:n})=>{n.epoch===this.epoch&&(n.type==="consumed"?(this.queued=Math.max(0,this.queued-n.count),this.wake()):n.type==="played"?this.onPlayed(n.id):n.type==="playing"?this.onPlaybackStart({id:n.id,epoch:this.epoch}):n.type==="idle"?this.onPlaybackIdle():n.type==="error"&&this.onError(Error(n.error)),n.type==="level"&&this.onMetrics({bufferedSeconds:this.queued/24e3,level:n.level}))},this.node.connect(this.context.destination),this.node.port.postMessage({type:"clear",epoch:this.epoch})}catch(n){throw await this.context.close().catch(()=>{}),this.context=null,n}}await this.context.resume()})().finally(()=>this.starting=null),this.starting}wake(){for(let t of this.waiters.splice(0))t()}async enqueue(t,n){let i=this.epoch;if(await this.start(),i===this.epoch){if(t instanceof Uint8Array||(t=new Uint8Array(t)),this.odd!==null){let o=new Uint8Array(t.length+1);o[0]=this.odd,o.set(t,1),t=o,this.odd=null}t.length%2&&(this.odd=t[t.length-1],t=t.subarray(0,-1));for(let o=0;o<t.length;o+=24e3){let a=t.subarray(o,Math.min(t.length,o+24e3));for(;i===this.epoch&&this.queued+a.length/2>this.maxSamples;)await new Promise(d=>this.waiters.push(d));if(i!==this.epoch)return;let r=new Int16Array(a.length/2),s=new DataView(a.buffer,a.byteOffset,a.byteLength);for(let d=0;d<r.length;d++)r[d]=s.getInt16(d*2,!0);this.queued+=r.length,this.node.port.postMessage({type:"pcm",id:n,epoch:i,data:r.buffer},[r.buffer])}}}segmentEnd(t){this.odd!==null&&(this.odd=null,this.onError(Error("TTS PCM \u6570\u636E\u5B58\u5728\u4E0D\u5B8C\u6574\u91C7\u6837"))),this.node?.port.postMessage({type:"end",id:t,epoch:this.epoch})}clear(){this.onPlaybackIdle(),this.epoch++,this.queued=0,this.odd=null,this.node?.port.postMessage({type:"clear",epoch:this.epoch}),this.wake()}async dispose(){this.clear(),await this.starting?.catch(()=>{}),this.node?.disconnect(),this.node&&(this.node.port.onmessage=null);let t=this.context;this.node=null,this.context=null,t&&t.state!=="closed"&&await t.close()}};function Ua(e){return e.replace(/https?:\/\/\S+/gi,"").replace(/\b(?:sk|dg|ghp|github_pat|AKIA|Bearer)[-_ ]?[A-Za-z0-9_+\/-]{10,}={0,2}/gi,"[\u654F\u611F\u4FE1\u606F\u5DF2\u7565\u8FC7]").replace(/\b(?:api[_ -]?key|secret|token|password|密码|密钥)\s*[:=]\s*[^\s，。；;]+/gi,"[\u654F\u611F\u4FE1\u606F\u5DF2\u7565\u8FC7]").replace(/\b[A-Za-z0-9_+\/=-]{36,}\b/g,"[\u957F\u6807\u8BC6\u5DF2\u7565\u8FC7]").replace(/^[ \t]*#{1,6}\s+/gm,"").replace(/[*_~]+/g,"").replace(/\s+/g," ").trim()}var os=/^(?:微笑|笑着(?:说)?|轻笑|大笑|苦笑|叹气|轻叹|清嗓|咳嗽|点头|摇头|挠头|耸肩|沉默|停顿|深呼吸|吸气|呼气|开心|兴奋|低声|耳语|温柔|严肃|思考中|laughs?|chuckles?|sighs?|whispers?|smiles?|nods?|clears throat)(?:中|地|了一下)?$/iu,as={code:"\u4EE3\u7801\u6211\u53D1\u5728\u804A\u5929\u91CC\u4E86\u3002",table:"\u8868\u683C\u6211\u653E\u5728\u804A\u5929\u91CC\u4E86\u3002",url:"\u94FE\u63A5\u5DF2\u53D1\u5728\u804A\u5929\u91CC\u3002"},En=class{constructor({maxChars:t=120,now:n=()=>Date.now()}={}){this.now=n,this.startedAt=0,this.updatedAt=0,this.emitted=0,this.maxChars=Math.max(40,Math.min(t,500)),this.raw="",this.text="",this.fenced=null,this.inline=!1,this.hidden=null,this.discardToken=!1,this.url=!1,this.table=!1,this.lineStart=!0,this.hints=new Set,this.discardLink=!1}push(t){return this.startedAt||(this.startedAt=this.now()),this.updatedAt=this.now(),this.raw+=String(t||""),this.consume(!1)}consume(t,n=!1){let i=[],o=()=>{let s=Ua(this.text);this.text="",s&&(i.push(s),this.emitted++,this.startedAt=this.now())},a=s=>{for(let d of s)if(this.text+=d,/[。！？；!?\n]/u.test(d)||d==="."&&(!this.raw[0]||/\s/.test(this.raw[0])))o();else if(!this.emitted&&!this.inline&&/[，,]/u.test(d)&&!/[0-9]/.test(this.text.at(-2)||"")&&this.text.trim().length>=(/[\p{Script=Han}]/u.test(this.text)?10:32))o();else if(this.text.length>=this.maxChars){let c=Math.max(this.text.lastIndexOf(" "),this.text.lastIndexOf("\uFF0C"),this.text.lastIndexOf(","));if(c>=this.maxChars*.4){let f=this.text.slice(c+1);this.text=this.text.slice(0,c+1),o(),this.text=f}else/[\p{Script=Han}]/u.test(d)?o():this.text.length>this.maxChars+100&&(this.text="[\u8FC7\u957F\u6807\u8BC6\u5DF2\u7565\u8FC7]",o(),this.discardToken=!0)}},r=s=>{this.hints.has(s)||(this.hints.add(s),this.text.trim()&&a(" "),a(as[s]))};for(;this.raw.length&&(t||n||this.raw.length>8||/[。！？；!?\n]/u.test(this.raw)||!this.emitted&&/[，,]/u.test(this.raw));){if(this.hidden){let u="</"+this.hidden+">",l=this.raw.toLowerCase().indexOf(u);if(l<0){this.raw=this.raw.slice(-u.length);break}this.raw=this.raw.slice(l+u.length),this.hidden=null;continue}if(this.fenced){let u=this.raw.indexOf(this.fenced);if(u<0){this.raw=this.raw.slice(-2),t&&(this.raw="");break}this.raw=this.raw.slice(u+3),this.fenced=null,this.lineStart=!0;continue}if(this.discardLink){let u=this.raw.indexOf(")"),l=this.raw.indexOf(`
`);if(u>=0&&(l<0||u<l)){this.raw=this.raw.slice(u+1),this.discardLink=!1;continue}if(l>=0){this.raw=this.raw.slice(l),this.discardLink=!1;continue}this.raw="";break}if(this.url){let u=0;for(;u<this.raw.length&&!/[\s<>，。！？；）]/u.test(this.raw[u]);)u++;if(this.raw=this.raw.slice(u),this.raw.length)this.url=!1;else break;continue}if(this.table){let u=this.raw.indexOf(`
`);if(u<0){this.raw="";break}this.raw=this.raw.slice(u+1),this.table=!1,this.lineStart=!0;continue}if(this.raw.startsWith("~~~")||this.raw.startsWith("`".repeat(3))){this.fenced=this.raw.slice(0,3),this.inline=!1,this.raw=this.raw.slice(3),r("code");continue}let s=this.raw.toLowerCase(),d=["https://","http://","www."];if(d.some(u=>s.startsWith(u))){this.url=!0,r("url");continue}if(!t&&d.some(u=>u.startsWith(s)))break;if(this.raw[0]==="<"){let u=this.raw.indexOf(">");if(u<0){if(this.raw.length<256&&!t)break;this.raw=this.raw.slice(-8),t&&(this.raw="");break}let l=this.raw.slice(1,u).trim().toLowerCase();["think","thinking","analysis","reasoning","secret"].includes(l)&&(this.hidden=l),this.raw=this.raw.slice(u+1);continue}if(this.lineStart){let u=this.raw.split(`
`,1)[0];if(/^\s*\|/u.test(u)||u.includes("|")&&(/\|.*\|/u.test(u)||/^[^。！？!?]{0,160}\|/u.test(u))){this.table=!0,this.text="",r("table");continue}if(/^\s*(?:#{1,6}|>|[-+*]|\d+[.)])\s+/u.test(u)){let l=/^\s*(?:#{1,6}|>|[-+*]|\d+[.)])\s+/u.exec(this.raw);if(this.raw=this.raw.slice(l[0].length),!this.raw)break}}if(this.raw.charCodeAt(0)===96){this.inline=!this.inline,this.raw=this.raw.slice(1);continue}if(this.raw[0]==="["){let u=this.raw.indexOf("]");if(u<0||this.raw.length===u+1){if(this.raw.length<2048&&!t)break;if(!t){this.raw="",this.discardLink=!0;break}}if(u>=0&&this.raw[u+1]==="("){let l=this.raw.indexOf(")",u+2);if(l<0){if(this.raw.length<2048&&!t)break;let M=this.raw.slice(1,u);this.raw="",a(M),this.discardLink=!t;break}let p=this.raw.slice(1,u);this.raw=this.raw.slice(l+1),a(p),this.lineStart=!1;continue}}let c={"(":")","\uFF08":"\uFF09","[":"]","*":"*"}[this.raw[0]];if(c){let u=this.raw.indexOf(c,1);if(u>0&&u<=80&&os.test(this.raw.slice(1,u).trim())){this.raw=this.raw.slice(u+1);continue}if(u<0&&this.raw.length<82&&!t)break}let f=String.fromCodePoint(this.raw.codePointAt(0));if(this.raw=this.raw.slice(f.length),this.discardToken)if(/\s|[，。！？；]/u.test(f))this.discardToken=!1;else continue;if(!/[\p{Extended_Pictographic}️‍]/u.test(f)){if(f==="|"&&!this.inline){this.table=!0,this.text="",r("table");continue}this.lineStart=f===`
`||this.lineStart&&/[ 	]/u.test(f),a(f)}}return t&&(this.raw="",o()),i}flushIdle(t=this.now()){if(this.hidden||this.fenced||this.inline||this.url||this.table||this.discardLink)return[];let n=t-this.updatedAt,i=t-this.startedAt,o=this.emitted===0;if(n<(o?300:650)&&i<(o?700:1200))return[];let a=this.consume(!1,n>=(o?300:650));if(a.length)return a;let r=this.text;if(r.length<(o?10:18))return[];let s=-1;for(let c=0;c<r.length;c++)/[，,；; ]/u.test(r[c])&&!(/[0-9]/.test(r[c-1]||"")&&/[0-9]/.test(r[c+1]||""))&&(s=c+1);if(s<4&&i>=1200&&/[\p{Script=Han}]/u.test(r.at(-1))&&(s=r.length),s<4)return[];let d=Ua(r.slice(0,s));return this.text=r.slice(s),this.startedAt=t,d?(this.emitted++,[d]):[]}finish(){return this.consume(!0)}},kn=class{constructor({synthesize:t,player:n,onError:i=()=>{},concurrency:o=3,maxQueued:a=32,maxPrefetchBytes:r=96e3}={}){Object.assign(this,{synthesize:t,player:n,onError:i}),this.concurrency=Math.max(1,Math.min(3,o)),this.maxQueued=a,this.maxPrefetchBytes=Math.max(1920,r),this.items=[],this.epoch=0,this.sequence=0,this.controllers=new Set,this.readers=new Set,this.running=null,this.closed=!1}push(t){return this.closed||!t?.trim()?!1:this.items.length>=this.maxQueued?(this.onError(Error("\u6717\u8BFB\u961F\u5217\u5DF2\u6EE1\uFF0C\u5DF2\u8DF3\u8FC7\u591A\u4F59\u6587\u672C")),!1):(this.items.push({id:++this.sequence,text:t.slice(0,1500),chunks:[],buffered:0,waiters:[]}),this.prefetch(),this.pump(),!0)}wake(t){for(let n of t.waiters.splice(0))n()}wait(t){return new Promise(n=>t.waiters.push(n))}async bounded(t,n){let i,o,a=new Promise((r,s)=>{o=()=>s(new DOMException("Speech cancelled","AbortError")),n.aborted?o():n.addEventListener("abort",o,{once:!0})});try{return await Promise.race([t,a,new Promise((r,s)=>i=setTimeout(()=>s(Error("\u8BED\u97F3\u5408\u6210\u6D41\u8BFB\u53D6\u8D85\u65F6")),3e4))])}finally{clearTimeout(i),n.removeEventListener("abort",o)}}prefetch(){let t=this.items.filter(n=>n.promise).length;for(let n of this.items){if(t>=this.concurrency)break;if(n.promise)continue;t++;let i=new AbortController;n.controller=i,this.controllers.add(i);let o=this.epoch;n.promise=(async()=>{let a;try{let r=await this.bounded(Promise.resolve().then(()=>this.synthesize(n.text,i.signal)).then(s=>(i.signal.aborted&&s.body?.cancel().catch(()=>{}),s)),i.signal);if(o!==this.epoch||i.signal.aborted){r.body?.cancel().catch(()=>{});return}if(r.ok===!1)throw Error("\u8BED\u97F3\u5408\u6210\u5931\u8D25\uFF1A"+r.status);if(!r.body?.getReader)throw Error("TTS \u672A\u8FD4\u56DE\u6D41\u5F0F PCM");for(a=r.body.getReader(),this.readers.add(a);o===this.epoch&&!i.signal.aborted;){for(;n.buffered>=this.maxPrefetchBytes&&o===this.epoch&&!i.signal.aborted;)await this.wait(n);if(o!==this.epoch||i.signal.aborted)break;let{done:s,value:d}=await this.bounded(a.read(),i.signal);if(s)break;if(d.byteLength>1024*1024)throw Error("TTS \u97F3\u9891\u5305\u8D85\u51FA\u9650\u5236");for(let c=0;c<d.length;){for(;n.buffered>=this.maxPrefetchBytes&&o===this.epoch&&!i.signal.aborted;)await this.wait(n);if(o!==this.epoch||i.signal.aborted)break;let f=Math.min(d.length-c,this.maxPrefetchBytes-n.buffered),u=d.slice(c,c+f);c+=f,n.chunks.push(u),n.buffered+=f,this.wake(n)}}}catch(r){n.error=r}finally{n.done=!0,this.wake(n),i.abort(),this.controllers.delete(i),a&&(this.readers.delete(a),a.cancel().catch(()=>{}),a.releaseLock())}})()}}pump(){if(this.running)return this.running;let t=this.epoch,n=(async()=>{for(;this.items.length&&t===this.epoch;){this.prefetch();let o=this.items[0];try{for(;t===this.epoch;)if(o.chunks.length){let a=Math.min(o.buffered,1920),r=new Uint8Array(a),s=0;for(;s<a;){let d=o.chunks[0],c=Math.min(d.length,a-s);r.set(d.subarray(0,c),s),s+=c,c===d.length?o.chunks.shift():o.chunks[0]=d.subarray(c)}o.buffered-=a,this.wake(o),await this.player.enqueue(r,o.id)}else if(o.done){if(o.error)throw o.error;this.player.segmentEnd(o.id);break}else await this.wait(o)}catch(a){t===this.epoch&&a.name!=="AbortError"&&this.onError(a)}finally{o.controller.abort(),this.wake(o)}t===this.epoch&&(this.items.shift(),this.prefetch())}})(),i;return this.running=i=n.finally(()=>{this.running===i&&(this.running=null),this.items.length&&!this.closed&&this.pump()}),i}async finish(){for(;this.items.length||this.running;)await(this.running||this.pump())}cancel(){this.epoch++;for(let t of this.items)t.controller?.abort(),this.wake(t);this.items=[];for(let t of this.controllers)t.abort();this.controllers.clear();for(let t of this.readers)t.cancel().catch(()=>{});this.player.clear()}async dispose(){this.closed=!0;let t=this.items.map(n=>n.promise).filter(Boolean);this.cancel(),await Promise.allSettled([this.running,...t])}};var Ln=class{constructor({onText:t,onStart:n,onEnd:i,onReset:o}={}){Object.assign(this,{onText:t,onStart:n,onEnd:i,onReset:o}),this.attempts=new Map,this.steps=new Map,this.seen=new Set,this.revision=null,this.restart=!1}key(t){return t.data?.attemptId??String(t.data?.turn??"")+":"+String(t.data?.step??"")}step(t){let{turn:n,step:i}=t.data||{};return n!==void 0&&i!==void 0?n+":"+i:void 0}track(t){let n=this.key(t),i=this.step(t);return i!==void 0&&this.steps.set(i,n),n}forget(t){this.attempts.delete(t);for(let[n,i]of this.steps)i===t&&this.steps.delete(n)}clear(){this.attempts.clear(),this.steps.clear()}remember(t){let n=t.type+":"+t.seq+":"+this.key(t);return this.seen.has(n)?!1:(this.seen.add(n),this.seen.size>4096&&this.seen.delete(this.seen.values().next().value),!0)}baseline(t){this.revision=t.revision,this.clear(),this.seen.clear(),this.restart=!1;for(let{event:n}of t.entries||[])if(this.remember(n),n.type==="assistant/live-chunk"&&n.data?.chunk?.type==="text-delta"){let i=this.track(n);this.attempts.set(i,(this.attempts.get(i)||"")+n.data.chunk.text)}}accept(t){if(t.revision!==void 0&&t.revision===this.revision)return;this.revision=t.revision;let n=t.change;if(n.kind==="replace"){this.onReset?.(),this.baseline(t);return}if(n.kind==="prepend"){for(let{event:o}of n.entries||[])this.remember(o);return}if(n.kind==="settle-assistant"&&!n.entry){this.forget(n.attemptId);return}let i=n.kind==="settle-assistant"?[n.entry].filter(Boolean):n.entries||[];for(let{event:o}of i)if(this.remember(o)){if(o.type==="assistant/live-chunk"){let{chunk:a}=o.data,r=this.track(o);a.type==="text-delta"&&(this.restart&&(this.restart=!1,this.onStart?.(o)),this.attempts.set(r,(this.attempts.get(r)||"")+a.text),this.onText?.(a.text));continue}if(o.type==="turn/start"&&(this.restart=!1,this.clear(),this.onStart?.()),(o.type==="llm/retry"||o.type==="assistant/attempt")&&(this.onReset?.(),this.clear(),this.restart=!0),o.type==="assistant/message"){let a=(o.data.message?.content||[]).filter(d=>d.type==="text").map(d=>d.text).join(""),r=n.kind==="settle-assistant"?n.attemptId??this.key(o):this.steps.get(this.step(o))??this.key(o),s=this.attempts.get(r)||"";!o.data.interrupted&&a.startsWith(s)&&(this.restart&&(this.restart=!1,this.onStart?.(o)),a.length>s.length&&this.onText?.(a.slice(s.length))),this.forget(r)}o.type==="turn/end"&&this.onEnd?.(o)}}};var Jt=e=>new URL(e,document.baseURI);async function is(e,t={}){let n=await fetch(Jt("api/voice"),{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({action:e,...t})}),i=await n.json();if(!n.ok)throw Error(i.error||"\u8BED\u97F3\u670D\u52A1\u4E0D\u53EF\u7528");return i}function rs(e){let t=e,n=new Set;return{getSnapshot:()=>t,subscribe:i=>(n.add(i),()=>n.delete(i)),patch:i=>{t={...t,...i};for(let o of n)o()}}}function va(e,t={}){let n=t.fetch||globalThis.fetch.bind(globalThis),i=t.json||is,o=t.window||globalThis.window,a=t.createCapture||(Y=>new Cn(Y)),r=t.createPlayer||(Y=>new In(Y)),s=t.createQueue||(Y=>new kn(Y)),d=t.createChunker||(()=>new En),c=t.wait||(Y=>new Promise(le=>setTimeout(le,Y))),f=t.setInterval||globalThis.setInterval,u=t.clearInterval||globalThis.clearInterval,l=rs({config:null,mode:"idle",phase:"idle",sessionId:null,error:"",transcript:"",level:0,playbackLevel:0,muted:!1,readEnabled:!1}),p=crypto.randomUUID(),M=new Set,D=new Map,g=new Set,y=null,I,L,b,x,F,_,Z,Q,v=0,E=0,O=0,P=!1,G=!1,j=!1,J=!1,oe=!1,R=!1,T=null,V=Y=>{J||l.patch(Y)},de=Y=>V({error:Y?.message||String(Y)}),$=()=>_?{"x-voice-call-id":_.callId}:{},se=(Y=l.getSnapshot().sessionId)=>e.uiSession.sessionStatus.getSnapshot().get(Y),re=()=>V({phase:l.getSnapshot().phase==="starting"&&R?"starting":se()?.pendingInteraction?"waiting":G?"speaking":se()?.running?"thinking":g.size&&!P?"transcribing":l.getSnapshot().mode!=="idle"?"listening":"idle"}),ee=e.uiSession.sessionStatus.subscribe(re);function X(){j=!0,G=!1,I?.setPlaybackActive?.(!1),V({playbackLevel:0}),x=d(),b?.cancel(),M.clear(),re()}function B(){if(!L){let Y=r({workletURL:Jt("api/voice/worklet"),onError:le=>{L===Y&&de(le)},onPlaybackStart:()=>{L===Y&&(G=!0,I?.setPlaybackActive?.(!0),re())},onPlaybackIdle:()=>{L===Y&&(G=!1,I?.setPlaybackActive?.(!1),V({playbackLevel:0}),re())},onMetrics:le=>{L===Y&&le.level!==void 0&&V({playbackLevel:le.level})},onPlayed:le=>{L===Y&&(M.delete(le),!M.size&&!b?.items.length&&(G=!1,I?.setPlaybackActive?.(!1),re()))}});L=Y}return L.start()}function S(){b||(b=s({player:L,synthesize:async(Y,le)=>{let be=await n(Jt("api/voice/speech"),{method:"POST",credentials:"same-origin",signal:le,headers:{"content-type":"application/json",...$()},body:JSON.stringify({text:Y})});if(!be.ok){let h=await be.json();throw Error(h.error||"\u6717\u8BFB\u5931\u8D25")}return be},onError:Y=>{X(),de(Y)}}))}function H(Y){if(M.size>=128){de(Error("\u64AD\u653E\u786E\u8BA4\u961F\u5217\u5DF2\u6EE1\uFF0C\u8BF7\u505C\u6B62\u540E\u91CD\u65B0\u6717\u8BFB"));return}b.push(Y)&&(M.add(b.sequence),re())}function ae(Y){if(!(j||!(l.getSnapshot().readEnabled||l.getSnapshot().mode==="call")||!Y)){S(),x||=d();for(let le of x.push(Y))H(le)}}function he(Y){if(Q?.sessionId===Y)return;let le=e.sessions.binding(Y);if(!le)throw Error("\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u53EF\u7528\u5BF9\u8BDD");Q&&X(),F?.(),Q=le;let be=Q.eventSource,h=new Ln({onText:ae,onStart:()=>{!P&&!g.size&&(j=!1),x=d(),re()},onReset:()=>X(),onEnd:()=>{if(!j&&(l.getSnapshot().readEnabled||l.getSnapshot().mode==="call")){S();for(let ne of(x||=d()).finish())H(ne)}re()}});h.baseline(be.getSnapshot()),F=be.subscribe(()=>h.accept(be.getSnapshot())),V({sessionId:Y})}async function ge(Y=l.getSnapshot().sessionId){if(se(Y)?.pendingInteraction)return!1;let le=e.sessions.scope(Y);return le&&se(Y)?.running&&await le.get("conversation").cancel(),!0}async function Re(Y,le){let be=Y+":"+le;if(y!==be){y=be;try{let h=()=>Y===v&&le===E&&l.getSnapshot().mode==="call"&&!P&&!g.size;if(!h())return;let ne=[...D.entries()].sort((_e,Pe)=>_e[0]-Pe[0]),C=ne.map(_e=>_e[1]).filter(Boolean).join(`
`);if(!C.trim())return;let m=()=>se()?.pendingInteraction?(V({error:"\u8BF7\u5148\u5728\u5BF9\u8BDD\u4E2D\u5B8C\u6210\u6388\u6743\u6216\u4EA4\u4E92\uFF1B\u672C\u6BB5\u8BED\u97F3\u5C1A\u672A\u53D1\u9001",transcript:C,phase:"waiting"}),!0):!1;if(m())return;let q=e.sessions.scope(l.getSnapshot().sessionId);if(!q)throw Error("\u5BF9\u8BDD\u5DF2\u7ECF\u5173\u95ED");if(await ge(),!h()||m())return;let fe=Date.now()+1e4;for(;se()?.running;){if(!h()||m())return;if(Date.now()>fe)throw Error("\u539F\u5DE5\u5177\u5C1A\u672A\u505C\u6B62\uFF0C\u672C\u6BB5\u8BED\u97F3\u672A\u53D1\u9001\uFF0C\u8BF7\u624B\u52A8\u91CD\u8BD5");await c(50)}if(!h()||m())return;j=!1,x=d(),V({transcript:C,phase:"thinking"});for(let[_e,Pe]of ne)D.get(_e)===Pe&&D.delete(_e);try{await q.get("conversation").send(C)}catch(_e){if(Y===v)for(let[Pe,st]of ne)D.has(Pe)||D.set(Pe,st);throw _e}}finally{y===be&&(y=null)}}}async function Ye({sessionId:Y,inputActions:le},be){if(J)throw Error("\u8BED\u97F3\u63D2\u4EF6\u5DF2\u505C\u7528");if(R)throw Error("\u8BED\u97F3\u6B63\u5728\u542F\u52A8");if(oe)throw Error("\u6B63\u5728\u91CA\u653E\u4E0A\u4E00\u6BB5\u8BED\u97F3\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");R=!0;let h,ne;try{T&&await T,I&&await je.hangup(),h=++v;let C=l.getSnapshot().config||await je.load();if(h!==v||J)return;if(!C[be==="call"?"call":"dictation"]||!C.asr.configured||be==="call"&&!C.tts.configured)throw Error("\u8BF7\u5148\u5728\u300C\u8BBE\u7F6E \u2192 \u8BED\u97F3\u300D\u542F\u7528\u529F\u80FD\u5E76\u914D\u7F6E\u6A21\u578B");if(he(Y),V({mode:be,sessionId:Y,phase:"starting",error:"",transcript:"",muted:!1,playbackLevel:0}),D.clear(),g.clear(),O=0,P=!1,E++,be==="call"){if(await B(),h!==v||J)return;let Me=await i("call.start",{sessionId:Y,deviceId:p});if(h!==v||J){await i("call.end",{sessionId:Y,deviceId:p,callId:Me.call.callId});return}_={...Me.call,sessionId:Y};let He=_;Z=f(()=>{i("call.heartbeat",{sessionId:Y,deviceId:p,callId:He.callId}).catch(wt=>{_===He&&(de(wt),je.hangup())})},15e3)}V({mode:be,sessionId:Y,phase:"listening",error:"",transcript:""}),j=!1;let m=be==="dictation"?le.captureInsertion():null,q="",fe="",_e=!1,Pe=Me=>{if(h!==v||Me===q||_e)return;if(!le.insertText(Me,m)){_e=!0,V({error:"\u8349\u7A3F\u5DF2\u88AB\u4FEE\u6539\uFF0C\u8BF7\u590D\u5236\u8BED\u97F3\u680F\u8F6C\u5F55\u6587\u5B57\u540E\u63D2\u5165",transcript:Me});return}q=Me;let He=le.captureInsertion();m={start:m.start,end:m.start+Me.length,draftRev:He.draftRev},le.persistDraft()},st=["step-websocket","openai-websocket"].includes(C.asr.protocol)?new jn({request:n,endpoint:Jt,headers:$,openSocket:Me=>e.connection.openWebSocket(Me),onWarning:Me=>{h===v&&V({error:Me.message})},onError:Me=>{h===v&&(de(Me),je.hangup())}}):null;if(st&&(ne={dispose:()=>st.close()},I=ne,await st.start(),h!==v)){await st.close();return}if(ne=a({realtime:st,parallel:["transcriptions-sse","mimo-sse","step-sse"].includes(C.asr.protocol),workletURL:Jt("api/voice/worklet"),transcribe:async(Me,He,wt)=>{let Dt=await n(Jt("api/voice/transcribe"),{method:"POST",credentials:"same-origin",signal:He,headers:{"content-type":"audio/wav",...$()},body:Me});if(Dt.headers.get("content-type")?.includes("application/x-ndjson")){let dt="",ce=!1;if(await xa(Dt,He,It=>{It.type==="partial"&&(dt=It.text,wt?.(dt)),It.type==="final"&&(dt=It.text,ce=!0)}),!ce)throw Error("\u8BC6\u522B\u8FDE\u63A5\u5728\u6700\u7EC8\u7ED3\u679C\u524D\u5173\u95ED");return{text:dt}}let Ht=await Dt.json();if(!Dt.ok)throw Error(Ht.error||"\u8F6C\u5F55\u5931\u8D25");return Ht},onLevel:Me=>{h===v&&V({level:Me})},onSpeechStart:Me=>{h===v&&(O=Me??O+1,g.add(O),P=!0,E++,be==="call"&&(X(),ge(Y).catch(He=>{h===v&&de(He)})),V({phase:se(Y)?.pendingInteraction?"waiting":"listening"}))},onSpeechEnd:(Me,He={})=>{h===v&&(Me===O&&(P=!1),He.cancelled&&(g.delete(Me),D.delete(Me)),re())},onPartial:(Me,He={})=>{h===v&&(be==="dictation"?(V({transcript:Me}),Pe(fe+Me)):(He.utteranceId??O)===O&&V({transcript:[...D.values(),Me].filter(Boolean).join(`
`)}))},onFinal:(Me,He={})=>{if(h!==v)return;let wt=He.utteranceId??O;g.delete(wt),wt===O&&(P=!1),be==="dictation"?(fe+=Me,Pe(fe)):(D.set(wt,Me),V({transcript:[...D.values()].join(`
`)}),!P&&!g.size&&Re(h,E).catch(Dt=>{h===v&&de(Dt)}))},onError:Me=>{h===v&&(de(Me),je.hangup())}}),I=ne,await ne.start(),h!==v||J){await ne.dispose();return}V({phase:"listening"}),j=!1}catch(C){throw h===v?await je.hangup():await ne?.dispose(),C}finally{R=!1}}let je={state:l,async load(){try{let{config:Y}=await i("config");return V({config:Y,error:""}),Y}catch(Y){throw de(Y),Y}},async configure(Y){await je.hangup();let le=await i("configure",{config:Y});return V({config:le.config,error:""}),le.config},setMuted(Y){if(l.getSnapshot().mode!=="call")return;let le=!!Y;le!==l.getSnapshot().muted&&(I?.setMuted?.(le),E++,P=!1,g.clear(),D.clear(),V({muted:le,level:0,transcript:""}),re())},toggleMute(){je.setMuted(!l.getSnapshot().muted)},async toggleRead(Y){if(l.getSnapshot().mode==="call")return;if(l.getSnapshot().readEnabled){X(),V({readEnabled:!1});return}let le=l.getSnapshot().config||await je.load();if(!le.readAloud||!le.tts.configured)throw Error("\u8BF7\u5148\u5728\u300C\u8BBE\u7F6E \u2192 \u8BED\u97F3\u300D\u914D\u7F6E\u5E76\u5F00\u542F\u6717\u8BFB");let be=v;he(Y);try{if(await B(),be!==v||J)return;S(),x=d(),j=!1,V({readEnabled:!0,sessionId:Y,error:""})}catch(h){throw await je.hangup(),h}},startDictation:Y=>Ye(Y,"dictation"),async stopDictation(){if(!I||l.getSnapshot().mode!=="dictation")return;let Y=I;oe=!0;try{await Y.stop({flush:!0})}finally{I===Y&&(I=null,V({mode:"idle",phase:"idle"})),oe=!1}},startCall:Y=>Ye(Y,"call"),hangup(){if(T)return T;++v,E++,P=!1,u(Z);let Y=l.getSnapshot(),le=I,be=_,h=b,ne=L;return I=null,_=null,X(),b=null,L=null,M.clear(),D.clear(),g.clear(),F?.(),F=null,Q=null,V({mode:"idle",phase:"idle",level:0,playbackLevel:0,muted:!1,readEnabled:!1}),T=(async()=>{let m=[le?.dispose(),h?.dispose(),ne?.dispose()];Y.mode==="call"&&m.push(ge(Y.sessionId)),be&&m.push(i("call.end",{sessionId:be.sessionId,deviceId:p,callId:be.callId})),await Promise.allSettled(m)})().finally(()=>{T=null}),T},async dispose(){u(Ze),await je.hangup(),ee(),o?.removeEventListener("pagehide",pe),o?.removeEventListener("offline",pe),J=!0}},Ze=f(()=>{if(!j&&x?.flushIdle&&(l.getSnapshot().readEnabled||l.getSnapshot().mode==="call"))for(let Y of x.flushIdle(Date.now()))H(Y)},25);Ze?.unref?.();let pe=()=>{je.hangup()};return o?.addEventListener("pagehide",pe),o?.addEventListener("offline",pe),je}var Da=`.voice-activity,.voice-settings{--voice-blue:var(--dsw-alias-state-business-primary,#4d6bfe);--voice-text:var(--dsw-alias-label-primary,#242424);--voice-muted:var(--dsw-alias-label-secondary,#818181);--voice-hover:var(--dsw-alias-interactive-bg-hover,#88888812);--voice-border:color-mix(in srgb,currentColor 12%,transparent);color:var(--voice-text);font:inherit;box-sizing:border-box}
.voice-activity *,.voice-settings *{box-sizing:border-box}
.voice-activity{display:flex;align-items:center;gap:4px;min-width:0;position:relative}
.voice-icon-button{appearance:none;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none;transition:background 160ms,color 160ms,transform 160ms}
.voice-icon-button{width:30px;height:30px;border-radius:8px;padding:7px}
.voice-icon-button svg{width:16px;height:16px;flex:none;overflow:visible}
.voice-icon-button:hover{background:var(--voice-hover)}
.voice-icon-button:active{transform:scale(.94)}
.voice-icon-button[aria-pressed=true]{background:var(--voice-hover);color:var(--voice-blue)}
.voice-activity button:disabled{opacity:.4;cursor:not-allowed}
.voice-activity button:focus-visible,.voice-settings :focus-visible{outline:2px solid var(--dsw-focus-ring-color,#8a8a8a);outline-offset:2px}
.voice-status{display:flex;align-items:center;gap:7px;min-width:0;max-width:310px;padding:0 4px;font-size:12px;color:var(--voice-muted)}
.voice-status-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.voice-status-dot{width:6px;height:6px;border-radius:50%;background:var(--voice-blue);flex:none;animation:voice-breathe 1.6s ease-in-out infinite}
.voice-phase-waiting .voice-status-dot{animation-duration:2.4s}
.voice-phase-thinking .voice-status-dot{animation-duration:.9s}
.voice-inline-error{font-size:11px;line-height:1.5;color:var(--dsw-alias-state-error-label,#c34d4d);max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.voice-inline-note{font-size:11px;color:var(--voice-muted)}
.voice-expanded{flex:1;min-width:0}
.voice-expanded .voice-status{flex:1}
.voice-settings{max-width:640px;padding:6px 2px 22px;font-size:13px;line-height:1.6}
.voice-settings header{margin-bottom:20px}
.voice-settings h2{margin:0;font-size:18px;line-height:1.5;font-weight:600}
.voice-settings header p{margin:3px 0 0;font-size:12px;color:var(--voice-muted)}
.voice-privacy-note{font-size:12px;line-height:1.75;color:var(--voice-muted);margin-bottom:24px;padding-left:12px;border-left:2px solid var(--voice-border)}
.voice-settings fieldset{border:0;margin:0 0 24px;padding:0;min-width:0}
.voice-settings legend{font-weight:600;font-size:13px;padding:0;margin-bottom:10px}
.voice-setting-toggle{display:flex;gap:24px;align-items:center;justify-content:space-between;padding:10px 0;cursor:pointer}
.voice-setting-toggle strong{display:block;font-weight:500;font-size:13px}
.voice-setting-toggle small{display:block;color:var(--voice-muted);font-size:12px;margin-top:2px}
.voice-setting-toggle input{appearance:none;width:30px;height:18px;background:color-mix(in srgb,currentColor 22%,transparent);border:0;border-radius:12px;position:relative;cursor:pointer;flex:none;transition:background 160ms}
.voice-setting-toggle input::before{content:'';position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 1px 2px #0002;transition:transform 160ms}
.voice-setting-toggle input:checked{background:var(--voice-blue)}
.voice-setting-toggle input:checked::before{transform:translateX(12px)}
.voice-provider-settings>label{display:grid;gap:6px;font-size:12px;margin:12px 0}
.voice-provider-settings input{min-width:0;width:100%;border:1px solid var(--voice-border);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;padding:9px 11px;line-height:1.4;outline-offset:2px}
.voice-provider-settings input::placeholder{color:var(--voice-muted);opacity:.8}
.voice-key-field{display:flex;align-items:center;gap:8px}
.voice-key-field input{flex:1;width:0}
.voice-key-field button{flex:none;border:0;background:transparent;color:var(--voice-muted);font:inherit;font-size:12px;cursor:pointer;padding:8px 4px;border-radius:5px;white-space:nowrap}
.voice-key-field button:hover{color:var(--voice-text)}
.voice-provider-hint{margin:0;color:var(--voice-muted);font-size:11px}
.voice-settings footer{display:flex;align-items:center;gap:12px}
.voice-settings footer span{font-size:12px;color:var(--voice-muted)}
.voice-save{border:0;border-radius:8px;padding:8px 16px;font:inherit;font-size:13px;line-height:1.5;font-weight:500;cursor:pointer;background:var(--voice-blue);color:#fff;transition:opacity 160ms,transform 160ms}
.voice-save:active{transform:scale(.98)}
.voice-save:disabled{opacity:.4;cursor:default}
.voice-settings-error{font-size:12px;color:var(--dsw-alias-state-error-label,#c34d4d);margin-top:14px;overflow-wrap:anywhere}
@keyframes voice-breathe{0%,100%{opacity:.45;box-shadow:0 0 0 0 color-mix(in srgb,currentColor 0%,transparent)}50%{opacity:1;box-shadow:0 0 0 4px color-mix(in srgb,currentColor 8%,transparent)}}
@media(prefers-reduced-motion:reduce){.voice-activity *,.voice-settings *{animation:none!important;transition:none!important}}
.voice-tabs{position:relative;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;padding:4px;border-radius:9px;background:var(--voice-hover);margin:0 0 20px;isolation:isolate}
.voice-tab-indicator{position:absolute;top:4px;bottom:4px;left:4px;width:calc((100% - 8px)/3);background:var(--dsw-alias-bg-layer-2,#fff);border-radius:6px;box-shadow:0 1px 4px #00000010;transform:translateX(calc(var(--voice-tab-index)*100%));transition:transform 420ms cubic-bezier(.22,1.35,.36,1)}
.voice-tabs [role=tab]{position:relative;z-index:1;border:0;border-radius:6px;background:transparent;color:var(--voice-muted);font:inherit;font-size:12px;line-height:1.5;padding:9px 6px;cursor:pointer;transition:color 160ms,transform 220ms cubic-bezier(.22,1.4,.36,1)}
.voice-tabs [role=tab][aria-selected=true]{color:var(--voice-text);font-weight:500}
.voice-tabs [role=tab]:active{transform:scale(.95)}
.voice-tab-panel{animation:voice-panel-enter 220ms ease both}
.voice-mode-settings{margin-bottom:12px!important}
.voice-tab-panel .voice-privacy-note{margin-bottom:23px}
.voice-select{position:relative;display:grid;gap:6px;margin:12px 0}
.voice-field-label{font-size:12px;color:var(--voice-text)}
.voice-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:38px;padding:9px 11px;background:transparent;border:1px solid var(--voice-border);border-radius:7px;color:inherit;font:inherit;font-size:13px;cursor:pointer;text-align:left}
.voice-select-trigger>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.voice-select-trigger svg{flex:none;transform:rotate(180deg);transition:transform 180ms}
.voice-select-trigger[aria-expanded=true] svg{transform:rotate(0deg)}
.voice-select-trigger:disabled{opacity:.5;cursor:default}
.voice-select-popover{position:absolute;z-index:80;top:calc(100% + 5px);left:0;right:0;padding:5px;border-radius:8px;border:1px solid var(--voice-border);background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-elevation-prominent,0 8px 24px #00000018);animation:voice-panel-enter 130ms ease both}
.voice-select-popover .voice-select-search{border:0!important;background:transparent;border-radius:4px;padding:8px 9px;font-size:12px;outline:none!important}
.voice-select-options{max-height:220px;overflow:auto;scrollbar-width:none;overscroll-behavior:contain}
.voice-select-options::-webkit-scrollbar{display:none}
.voice-select-options>button{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;width:100%;padding:9px;border:0;border-radius:5px;color:inherit;background:transparent;font:inherit;font-size:12px;text-align:left;cursor:pointer}
.voice-select-options>button>span{overflow-wrap:anywhere;min-width:0}
.voice-select-options>button small{font-size:10px;color:var(--voice-muted);text-align:right;max-width:48%;overflow-wrap:anywhere}
.voice-select-options>button[data-active=true]{background:var(--voice-hover)}
.voice-select-options>button[aria-selected=true]{font-weight:500}
.voice-select-options>button[aria-disabled=true]{opacity:.4;cursor:default}
.voice-select-options>p{padding:9px}
.voice-model-actions{display:flex;gap:10px;align-items:center;margin-top:14px}
.voice-model-actions>span{margin-right:auto}
.voice-text-button{border:0;background:transparent;padding:4px 0;color:var(--voice-muted);font:inherit;font-size:11px;cursor:pointer}
.voice-text-button:hover{color:var(--voice-text)}
.voice-text-button:disabled{opacity:.5;cursor:default}
.voice-provider-settings input[readonly]{color:var(--voice-muted);background:var(--voice-hover)}
@keyframes voice-panel-enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:600px){.voice-tabs [role=tab]{padding-inline:2px;font-size:11px}.voice-select-options>button{gap:6px}}
@media(prefers-reduced-motion:reduce){.voice-tabs *,.voice-tab-panel,.voice-select-popover{animation:none!important;transition:none!important}}

/* Iconsax 0.0.8 VolumeHigh/VolumeSlash Linear; MIT, ERFAN KHADIVAR.
   Existing third-party notice: client/assets/iconsax/LICENSE. */
.voice-speaker-icon,.voice-speaker-icon svg{display:block;width:16px;height:16px;flex:none}
.voice-recording-strip{display:flex;align-items:center;gap:12px;flex:1;min-width:100px;padding:3px 2px 3px 10px}
.voice-recording-caption{flex:1;min-width:0;max-width:460px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--voice-muted)}
.voice-recording-pulse{height:24px;display:flex;gap:2px;align-items:center;flex:0 1 190px;min-width:90px;padding:0 10px;color:var(--voice-blue);overflow:hidden}
.voice-recording-pulse i{display:block;width:2px;height:20px;border-radius:2px;background:currentColor;transform-origin:center;transform:scaleY(calc(.12 + var(--voice-level,0)*var(--voice-band,1)));transition:transform 80ms linear;flex:none;opacity:.85}
.voice-stop-recording{margin-left:auto;color:var(--voice-text);background:var(--voice-hover)}
@media(max-width:600px){.voice-settings{padding-inline:0}.voice-setting-toggle{gap:12px}.voice-status{max-width:120px}.voice-inline-error{max-width:130px}.voice-key-field{gap:5px}}
/* The official activity contract retains submit; hide it only in this recording toolbar. */
[class*="_trailing"]:has(.voice-dictating)>button[class*="_primary"]{display:none}
@media(prefers-reduced-motion:reduce){.voice-recording-pulse i{animation:none;transform:none}}
.voice-call-button{width:30px;height:30px;padding:7px}
.voice-microphone-icon{position:relative;display:flex;align-items:center;justify-content:center;width:18px;height:18px}
.voice-microphone-icon svg{width:18px;height:18px}
.voice-microphone-muted::after{content:'';position:absolute;left:1px;top:8px;width:17px;height:1.5px;border-radius:1px;background:currentColor;transform:rotate(-45deg);box-shadow:0 -1px 0 var(--dsw-specific-input-major,#fff)}
/* Scoped takeover keeps the draft mounted and restores controls on teardown. */
[data-composer-card].voice-call-composer{padding-top:0;gap:0;overflow:hidden}
[data-composer-card].voice-call-composer>:not(:has(.voice-call-panel)){display:none!important}
.voice-call-composer>[class*="_row"]{padding:0;display:block;container-type:normal}
.voice-call-composer [class*="_trailing"]{display:block;width:100%;margin:0}
.voice-call-composer [class*="_trailing"]>:not(:has(.voice-call-panel)){display:none!important}
.voice-calling{width:100%;gap:0}
.voice-call-panel{position:relative;display:flex;flex-direction:column;align-items:stretch;width:100%;min-height:208px;padding:18px 12px 10px;isolation:isolate;animation:voice-panel-enter 260ms ease both}
.voice-call-visual{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:142px;pointer-events:none}
.voice-call-caption{color:var(--voice-muted);font-size:12px;line-height:18px;letter-spacing:.02em}
.voice-call-controls{display:flex;align-items:center;gap:14px;min-height:38px;width:100%;margin-top:10px}
.voice-call-mic,.voice-call-stop{width:34px;height:34px;border-radius:50%;padding:8px}
.voice-call-mic{color:var(--voice-blue);background:color-mix(in srgb,var(--voice-blue) 9%,transparent)}
.voice-call-mic[aria-pressed=true]{background:var(--voice-hover);color:var(--voice-muted)}
.voice-call-stop{margin-left:auto;background:var(--voice-blue);color:#fff}
.voice-call-stop:hover{background:color-mix(in srgb,var(--voice-blue) 88%,#000)}
.voice-call-transcript{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;font-size:12px;line-height:18px;color:var(--voice-muted)}
.voice-call-error{color:var(--dsw-alias-state-error-label,#c34d4d)}
/* Blue sphere movement follows controller phase and real audio levels. */
.voice-call-orb{--voice-orb-speed:7s;position:relative;display:block;width:96px;height:96px;flex:none;transform:scale(calc(1 + var(--voice-level,0)*.075));transition:transform 100ms linear,filter 300ms}
.voice-orb-aura{position:absolute;inset:4px;border-radius:50%;background:color-mix(in srgb,var(--voice-blue) 16%,transparent);filter:blur(11px);opacity:.55;transform:scale(calc(1.07 + var(--voice-level,0)*.12));transition:transform 100ms linear,opacity 400ms}
.voice-orb-body{position:absolute;inset:7px;border-radius:50%;overflow:hidden;isolation:isolate;background:radial-gradient(ellipse at 32% 22%,#effaff 0%,#d4eeff 20%,#8abaff 43%,#4d6bfe 71%,#314bbd 100%);box-shadow:inset 0 0 12px #ffffff5e,inset -5px -8px 14px #2440a52e;animation:voice-orb-breathe 4s ease-in-out infinite}
.voice-orb-cloud{position:absolute;inset:-35%;background:conic-gradient(from 35deg at 50% 50%,transparent 0deg,#f3fcffbf 65deg,transparent 130deg,#164bd544 220deg,#9cd6ff96 280deg,transparent 360deg);filter:blur(6px);animation:voice-orb-flow var(--voice-orb-speed) linear infinite}
.voice-orb-shine{position:absolute;inset:0;border-radius:50%;background:radial-gradient(ellipse at 28% 20%,#fff9 0%,#fff0 54%);box-shadow:inset 1px 1px 3px #fff9;opacity:.7}
.voice-orb-thinking,.voice-orb-transcribing{--voice-orb-speed:2.6s}
.voice-orb-thinking .voice-orb-body,.voice-orb-transcribing .voice-orb-body{animation:voice-orb-think 2.4s ease-in-out infinite}
.voice-orb-speaking{--voice-orb-speed:3.3s}
.voice-orb-speaking .voice-orb-body{animation:voice-orb-speak 1.1s ease-in-out infinite}
.voice-orb-speaking .voice-orb-aura{opacity:.8}
.voice-orb-starting{opacity:.65;--voice-orb-speed:3s}
.voice-orb-waiting{--voice-orb-speed:12s}
.voice-orb-waiting .voice-orb-body{animation-duration:5s}
.voice-orb-muted{filter:saturate(.35);opacity:.65;--voice-orb-speed:16s}
.voice-orb-muted .voice-orb-body{animation:none}
@keyframes voice-orb-flow{to{transform:rotate(360deg)}}
@keyframes voice-orb-breathe{0%,100%{transform:scale(.96)}50%{transform:scale(1)}}
@keyframes voice-orb-think{0%,100%{transform:scale(.93) rotate(-4deg)}50%{transform:scale(1) rotate(5deg)}}
@keyframes voice-orb-speak{0%,100%{transform:scale(.96,.98)}35%{transform:scale(1.025,1)}70%{transform:scale(.99,1.025)}}
@media(max-width:600px){.voice-call-panel{min-height:194px;padding-top:12px}.voice-call-visual{min-height:134px}.voice-call-controls{gap:10px}.voice-call-transcript{font-size:11px}}
@media(prefers-reduced-motion:reduce){.voice-call-orb,.voice-call-orb *{animation:none!important;transition:none!important}.voice-call-orb,.voice-orb-body,.voice-orb-aura{transform:none!important}.voice-recording-pulse i{transition:none;transform:scaleY(calc(.12 + var(--voice-level,0)*var(--voice-band,1)))}}
`;var k=require("react/jsx-runtime");function Aa(e){let t=va(e),n=document.createElement("style");n.textContent=Da,document.head.append(n),e.effect(()=>async()=>{n.remove(),await t.dispose()}),e.slots.inject("settings.section",()=>e.slots.register({name:"settings.section",id:"voice",order:35,label:()=>"\u8BED\u97F3",inject:()=>({controller:t})},ws)),e.slots.inject("conversation.input.activity",()=>e.slots.register({name:"conversation.input.activity",priority:-10,inject:()=>({controller:t})},fs)),t.load().catch(()=>{})}function ja(e){return(0,we.useSyncExternalStore)(t=>e.state.subscribe(t),()=>e.state.getSnapshot())}function Kt({label:e,children:t}){return(0,k.jsx)(Nt.Tooltip,{label:e,delayMs:450,portal:!0,children:t})}var ds={on:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M2 10v4c0 2 1 3 3 3h1.43c.37 0 .74.11 1.06.3l2.92 1.83c2.52 1.58 4.59.43 4.59-2.54V7.41c0-2.98-2.07-4.12-4.59-2.54L7.49 6.7c-.32.19-.69.3-1.06.3H5c-2 0-3 1-3 3Z" stroke-width="1.5" stroke="currentColor"/><path d="M18 8a6.66 6.66 0 0 1 0 8M19.83 5.5a10.83 10.83 0 0 1 0 13" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"/></svg>',off:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M15 8.37v-.96c0-2.98-2.07-4.12-4.59-2.54L7.49 6.7c-.32.19-.69.3-1.06.3H5c-2 0-3 1-3 3v4c0 2 1 3 3 3h2M10.41 19.13c2.52 1.58 4.59.43 4.59-2.54v-3.64M18.81 9.42c.9 2.15.63 4.66-.81 6.58M21.15 7.8a10.82 10.82 0 0 1-1.32 10.7M22 2 2 22" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"/></svg>'};function ls({active:e}){return(0,k.jsx)("span",{className:"voice-speaker-icon","aria-hidden":"true",dangerouslySetInnerHTML:{__html:ds[e?"on":"off"]}})}var cs='<svg viewBox="0 0 24 24" fill="none"><path d="M3 8.25v7.5M7.5 5.75v12.5M12 3.25v17.5M16.5 5.75v12.5M21 8.25v7.5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"/></svg>';function us(){return(0,k.jsx)("span",{className:"voice-speaker-icon","aria-hidden":"true",dangerouslySetInnerHTML:{__html:cs}})}var ps=1.2,Ca=.25,Ia=4;function zn(e){let t=Number(e);return Number.isFinite(t)&&t>=Ca&&t<=Ia?Math.round(t*100)/100:ps}var Na={idle:"\u51C6\u5907\u4E2D",starting:"\u6B63\u5728\u8FDE\u63A5",listening:"\u6B63\u5728\u8046\u542C",transcribing:"\u6B63\u5728\u8BC6\u522B",thinking:"\u6B63\u5728\u601D\u8003",speaking:"\u6B63\u5728\u56DE\u5E94",waiting:"\u7B49\u5F85\u6388\u6743\u6216\u4EA4\u4E92"};function ms({muted:e=!1}){return(0,k.jsx)("span",{className:"voice-microphone-icon"+(e?" voice-microphone-muted":""),"aria-hidden":"true",children:(0,k.jsx)(Nt.IconMicrophoneOutlineMedium,{size:18})})}function gs({state:e}){let t=e.muted&&e.phase==="listening"?"muted":e.phase,n=Math.max(0,Math.min(1,Number(e.phase==="speaking"?e.playbackLevel||0:e.muted?0:e.level||0)));return(0,k.jsxs)("span",{className:"voice-call-orb voice-orb-"+t,"aria-hidden":"true",style:{"--voice-level":n},children:[(0,k.jsx)("span",{className:"voice-orb-aura"}),(0,k.jsxs)("span",{className:"voice-orb-body",children:[(0,k.jsx)("span",{className:"voice-orb-cloud"}),(0,k.jsx)("span",{className:"voice-orb-shine"})]})]})}function fs({controller:e,sessionId:t,inputActions:n,locked:i,onActiveChange:o}){let a=ja(e),[r,s]=(0,we.useState)(!1),[d,c]=(0,we.useState)(""),f=(0,we.useRef)(0),u=(0,we.useRef)(null),l=a.sessionId===t,p=l&&a.mode!=="idle",M=p&&a.mode==="dictation",D=p&&a.mode==="call",g=l&&a.readEnabled&&a.phase==="speaking";(0,we.useEffect)(()=>{if(!D)return;let _=u.current,Z=_?.closest("[data-composer-card]");if(!Z)return;Z.classList.add("voice-call-composer");let Q=[...Z.children].filter(v=>!v.contains(_)).map(v=>[v,v.inert]);for(let[v]of Q)v.inert=!0;return()=>{Z.classList.remove("voice-call-composer");for(let[v,E]of Q)v.inert=E}},[D,t]),(0,we.useEffect)(()=>(o?.(p),()=>o?.(!1)),[p,o]),(0,we.useEffect)(()=>(f.current++,c(""),s(!1),()=>{f.current++,e.state.getSnapshot().sessionId===t&&e.hangup()}),[e,t]);let y=async _=>{let Z=f.current;s(!0),c("");try{await _()}catch(Q){Z===f.current&&c(Q.message||"\u8BED\u97F3\u64CD\u4F5C\u5931\u8D25")}finally{Z===f.current&&s(!1)}},I=a.config;if(!I)return a.error?(0,k.jsx)("span",{className:"voice-inline-error",role:"status",children:"\u8BED\u97F3\u914D\u7F6E\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u91CD\u8BD5"}):null;let L=!!(I.asr?.configured&&I.asr?.model),b=!!(I.tts?.configured&&I.tts?.model),x=!i&&!r&&a.mode==="idle",F=d||(l||a.mode==="idle"?a.error:"");return D?(0,k.jsx)("div",{ref:u,className:"voice-activity voice-expanded voice-calling voice-call-phase-"+a.phase,children:(0,k.jsxs)("div",{className:"voice-call-panel",role:"group","aria-label":"\u5B9E\u65F6\u8BED\u97F3\u901A\u8BDD",children:[(0,k.jsxs)("div",{className:"voice-call-visual",children:[(0,k.jsx)(gs,{state:a}),(0,k.jsx)("span",{className:"voice-call-caption",role:"status",children:a.muted&&a.phase==="listening"?"\u9EA6\u514B\u98CE\u5DF2\u5173\u95ED":Na[a.phase]||"\u8BED\u97F3\u5904\u7406\u4E2D"})]}),(0,k.jsxs)("div",{className:"voice-call-controls",children:[(0,k.jsx)(Kt,{label:a.muted?"\u5F00\u542F\u9EA6\u514B\u98CE":"\u5173\u95ED\u9EA6\u514B\u98CE",children:(0,k.jsx)("button",{type:"button",className:"voice-icon-button voice-call-mic","aria-label":a.muted?"\u5F00\u542F\u9EA6\u514B\u98CE":"\u5173\u95ED\u9EA6\u514B\u98CE","aria-pressed":!!a.muted,disabled:r,onClick:()=>y(()=>e.setMuted(!a.muted)),children:(0,k.jsx)(ms,{muted:a.muted})})}),(0,k.jsx)("span",{className:"voice-call-transcript"+(F?" voice-call-error":""),role:F?"alert":void 0,children:F||a.transcript||(a.muted?"\u9EA6\u514B\u98CE\u5DF2\u5173\u95ED\uFF0C\u4ECD\u53EF\u6536\u542C\u56DE\u590D":"\u76F4\u63A5\u8BF4\u8BDD\uFF0C\u968F\u65F6\u53EF\u4EE5\u6253\u65AD")}),(0,k.jsx)(Kt,{label:"\u7ED3\u675F\u901A\u8BDD",children:(0,k.jsx)("button",{type:"button",className:"voice-icon-button voice-call-stop","aria-label":"\u7ED3\u675F\u8BED\u97F3\u901A\u8BDD",onClick:()=>y(()=>e.hangup()),children:(0,k.jsx)(Nt.IconStopFillRegular,{size:16})})})]})]})}):(0,k.jsxs)("div",{ref:u,className:"voice-activity "+(p?"voice-expanded ":"")+(M?"voice-dictating":""),children:[M?(0,k.jsxs)("div",{className:"voice-recording-strip",children:[(0,k.jsx)("span",{className:"voice-recording-pulse",role:"img","aria-label":"\u9EA6\u514B\u98CE\u5B9E\u65F6\u97F3\u91CF",style:{"--voice-level":a.level||0},children:Array.from({length:31},(_,Z)=>(0,k.jsx)("i",{style:{"--voice-band":.22+.78*Math.abs(Math.sin(Z*1.7))}},Z))}),(0,k.jsx)("span",{className:"voice-recording-caption",role:"status",children:a.transcript||"\u6B63\u5728\u8046\u542C"}),(0,k.jsx)(Kt,{label:"\u505C\u6B62\u8F6C\u5F55",children:(0,k.jsx)("button",{type:"button",className:"voice-icon-button voice-stop-recording","aria-label":"\u505C\u6B62\u8BED\u97F3\u8F6C\u5F55",onClick:()=>y(()=>e.stopDictation()),children:(0,k.jsx)(Nt.IconStopFillRegular,{size:16})})})]}):I.dictation&&!D&&(0,k.jsx)(Kt,{label:L?"\u8BED\u97F3\u8F6C\u6587\u672C":"\u8BF7\u5148\u5728\u8BBE\u7F6E \u2192 \u8BED\u97F3\u4E2D\u914D\u7F6E ASR \u6A21\u578B",children:(0,k.jsx)("button",{type:"button",className:"voice-icon-button","aria-label":"\u8BED\u97F3\u8F6C\u6587\u672C",disabled:!x||!L,onClick:()=>y(()=>e.startDictation({sessionId:t,inputActions:n})),children:(0,k.jsx)(Nt.IconMicrophoneOutlineMedium,{size:18})})}),I.readAloud&&(0,k.jsx)(Kt,{label:a.readEnabled?"\u81EA\u52A8\u6717\u8BFB\u5F00\u542F":"\u81EA\u52A8\u6717\u8BFB\u5173\u95ED",children:(0,k.jsx)("button",{type:"button",className:"voice-icon-button voice-read-button","aria-label":a.readEnabled?"\u81EA\u52A8\u6717\u8BFB\u5F00\u542F":"\u81EA\u52A8\u6717\u8BFB\u5173\u95ED","aria-pressed":!!a.readEnabled,disabled:!b&&!a.readEnabled,onClick:()=>y(()=>e.toggleRead(t)),children:(0,k.jsx)(ls,{active:!!a.readEnabled})})}),I.call&&!M&&(0,k.jsx)(Kt,{label:"\u5F00\u59CB\u901A\u8BDD",children:(0,k.jsx)("button",{type:"button",className:"voice-icon-button voice-call-button","aria-label":"\u5F00\u59CB\u8BED\u97F3\u901A\u8BDD",disabled:!x||!L||!b,onClick:()=>y(()=>e.startCall({sessionId:t,inputActions:n})),children:(0,k.jsx)(us,{})})}),!M&&(p||g)&&(0,k.jsxs)("div",{className:"voice-status voice-phase-"+a.phase,role:"status",children:[(0,k.jsx)("span",{className:"voice-status-dot"}),(0,k.jsx)("span",{className:"voice-status-text",children:a.transcript||Na[a.phase]||"\u8BED\u97F3\u5904\u7406\u4E2D"})]}),!p&&r&&(0,k.jsx)("span",{className:"voice-inline-note",role:"status",children:"\u8FDE\u63A5\u4E2D\u2026"}),F&&(0,k.jsx)("span",{className:"voice-inline-error",role:"alert",children:F})]})}function hs(e){let t=n=>({providerId:e[n]?.providerId||"",baseURL:e[n]?.baseURL||"",model:e[n]?.model||"",apiKey:"",...n==="tts"?{voice:e.tts?.voice||"",speed:zn(e.tts?.speed),protocol:e.tts?.protocol||(/^(?:stepaudio-(?:2\.5|3)-tts|stepfun-2\.5-tts|step-tts-(?:2|mini))$/iu.test(e.tts?.model||"")?"step-speech":"speech")}:{protocol:e.asr?.protocol||"transcriptions-sse",realtime:e.asr?.realtime||{url:"",query:{}}}});return{dictation:!!e.dictation,readAloud:!!e.readAloud,call:!!e.call,asr:t("asr"),tts:t("tts")}}async function Ea(e,t={},n){let i=await fetch(new URL("api/voice",document.baseURI),{method:"POST",credentials:"same-origin",signal:n,headers:{"content-type":"application/json"},body:JSON.stringify({action:e,...t})}),o=await i.json();if(!i.ok)throw Error(o.error||"\u65E0\u6CD5\u8BFB\u53D6\u6A21\u578B\u670D\u52A1");return o}function bs({label:e,detail:t,checked:n,onChange:i}){return(0,k.jsxs)("label",{className:"voice-setting-toggle",children:[(0,k.jsxs)("span",{children:[(0,k.jsx)("strong",{children:e}),(0,k.jsx)("small",{children:t})]}),(0,k.jsx)("input",{type:"checkbox",role:"switch",checked:!!n,onChange:o=>i(o.target.checked)})]})}function Sn({label:e,value:t,options:n,onChange:i,placeholder:o="\u8BF7\u9009\u62E9",disabled:a}){let r=(0,we.useId)(),s=(0,we.useRef)(null),d=(0,we.useRef)(null),c=(0,we.useRef)(null),[f,u]=(0,we.useState)(!1),[l,p]=(0,we.useState)(""),[M,D]=(0,we.useState)(0),g=n.filter(b=>(b.label+" "+(b.hint||"")).toLowerCase().includes(l.toLowerCase())),y=n.find(b=>b.value===t),I=b=>{!b||b.disabled||(i(b.value),u(!1),c.current?.focus())};(0,we.useEffect)(()=>{f?d.current?.focus():p("")},[f]),(0,we.useEffect)(()=>{if(!f)return;let b=x=>{s.current?.contains(x.target)||u(!1)};return document.addEventListener("pointerdown",b),()=>document.removeEventListener("pointerdown",b)},[f]),(0,we.useEffect)(()=>{s.current?.querySelector('[data-active="true"]')?.scrollIntoView({block:"nearest"})},[M,f]);let L=b=>{if(b.key==="Escape"&&(b.preventDefault(),b.stopPropagation(),u(!1),c.current?.focus()),b.key==="Tab"&&u(!1),["ArrowDown","ArrowUp","Home","End"].includes(b.key)){b.preventDefault();let x=b.key==="Home"?0:b.key==="End"?g.length-1:Math.max(0,Math.min(g.length-1,M+(b.key==="ArrowDown"?1:-1)));D(x)}b.key==="Enter"&&(b.preventDefault(),I(g[M]))};return(0,k.jsxs)("div",{className:"voice-select",ref:s,children:[(0,k.jsx)("span",{id:r+"-label",className:"voice-field-label",children:e}),(0,k.jsxs)("button",{ref:c,type:"button",className:"voice-select-trigger","aria-labelledby":r+"-label "+r+"-value","aria-haspopup":"listbox","aria-expanded":f,"aria-controls":f?r:void 0,disabled:a,onClick:()=>{D(Math.max(0,g.findIndex(b=>b.value===t))),u(!f)},onKeyDown:b=>{(b.key==="ArrowDown"||b.key==="ArrowUp")&&(b.preventDefault(),u(!0))},children:[(0,k.jsx)("span",{id:r+"-value",children:y?.label||t||o}),(0,k.jsx)(Nt.IconChevronUpOutlineRegular,{size:12})]}),f&&(0,k.jsxs)("div",{className:"voice-select-popover",children:[(0,k.jsx)("input",{ref:d,role:"combobox","aria-label":"\u641C\u7D22"+e,"aria-autocomplete":"list","aria-expanded":"true","aria-controls":r,"aria-activedescendant":g[M]?r+"-"+M:void 0,className:"voice-select-search",placeholder:"\u641C\u7D22"+e,value:l,onChange:b=>{p(b.target.value),D(0)},onKeyDown:L}),(0,k.jsxs)("div",{id:r,role:"listbox","aria-labelledby":r+"-label",className:"voice-select-options",children:[g.map((b,x)=>(0,k.jsxs)("button",{id:r+"-"+x,role:"option","aria-selected":b.value===t,"aria-disabled":!!b.disabled,"data-active":x===M,type:"button",tabIndex:-1,onPointerMove:()=>D(x),onClick:()=>I(b),children:[(0,k.jsx)("span",{children:b.label}),b.hint&&(0,k.jsx)("small",{children:b.hint})]},b.value)),!g.length&&(0,k.jsx)("p",{className:"voice-provider-hint",children:"\u6CA1\u6709\u5339\u914D\u7ED3\u679C\uFF0C\u53EF\u8FD4\u56DE\u624B\u52A8\u586B\u5199"})]})]})]})}function Ms({name:e,draft:t,config:n,providers:i,update:o,clearKey:a,toggleClear:r,disabled:s}){let[d,c]=(0,we.useState)([]),[f,u]=(0,we.useState)(!1),[l,p]=(0,we.useState)(""),[M,D]=(0,we.useState)(!1),[g,y]=(0,we.useState)(0),I=t.providerId,L=i.find(x=>x.id===I);(0,we.useEffect)(()=>{if(c([]),p(""),u(!1),D(!1),!I)return;let x=new AbortController;return u(!0),Ea("models",{providerId:I},x.signal).then(F=>{c((F.models||[]).filter(_=>_.kinds?.includes(e)))}).catch(F=>{x.signal.aborted||p(F.message)}).finally(()=>{x.signal.aborted||u(!1)}),()=>x.abort()},[I,e,g]);let b=[{value:"",label:"\u72EC\u7ACB\u914D\u7F6E",hint:"\u624B\u52A8\u586B\u5199\u670D\u52A1\u4E0E\u5BC6\u94A5"},...i.map(x=>({value:x.id,label:x.name||x.id,hint:x.configured?"\u590D\u7528\u5DF2\u6709\u4F9B\u5E94\u5546":"\u4F9B\u5E94\u5546\u5C1A\u672A\u914D\u7F6E",disabled:!x.configured}))];return I&&!L&&b.push({value:I,label:I,hint:"\u5F53\u524D\u4F9B\u5E94\u5546\u6682\u4E0D\u53EF\u7528"}),(0,k.jsxs)("fieldset",{disabled:s,className:"voice-provider-settings",children:[(0,k.jsx)("legend",{children:e==="asr"?"ASR \xB7 \u8BED\u97F3\u8BC6\u522B":"TTS \xB7 \u8BED\u97F3\u5408\u6210"}),(0,k.jsx)("p",{className:"voice-provider-hint",children:e==="asr"?"\u9ED8\u8BA4\u4F7F\u7528 OpenAI \u517C\u5BB9\u63A5\u53E3\uFF1BWebSocket \u6301\u7EED\u53D1\u9001\u97F3\u9891\uFF0CHTTP / SSE \u5206\u6BB5\u4E0A\u4F20":"\u517C\u5BB9\u8BED\u97F3\u5408\u6210 API\uFF0C\u6D41\u5F0F PCM 24 kHz \u5355\u58F0\u9053"}),(0,k.jsx)(Sn,{label:"\u6A21\u578B\u4F9B\u5E94\u5546",value:I,options:b,disabled:s,onChange:x=>{x!==I&&o({providerId:x,baseURL:i.find(F=>F.id===x)?.baseURL||"",model:"",apiKey:"",protocol:e==="asr"?"transcriptions-sse":"speech",...e==="asr"?{realtime:{url:"",query:{}}}:{voice:""}})}}),e==="asr"&&(0,k.jsx)(Sn,{label:"\u8BC6\u522B\u534F\u8BAE",value:t.protocol,options:[{value:"transcriptions-sse",label:"OpenAI \u517C\u5BB9\u8F6C\u5F55 SSE",hint:"\u5206\u6BB5\u4E0A\u4F20\u540E\u589E\u91CF\u8FD4\u56DE\u6587\u5B57\uFF0C\u9700\u6A21\u578B\u652F\u6301"},{value:"transcriptions",label:"OpenAI \u517C\u5BB9\u8F6C\u5F55 HTTP",hint:"\u5B8C\u6574\u8BED\u6BB5\u4E0A\u4F20\u540E\u8FD4\u56DE\u6587\u5B57"},{value:"openai-websocket",label:"OpenAI \u517C\u5BB9\u5B9E\u65F6\u8F6C\u5F55 WSS",hint:"\u6301\u7EED PCM \u8F93\u5165\uFF0C\u9ED8\u8BA4 /realtime?intent=transcription"},{value:"mimo-sse",label:"MiMo SSE \u6269\u5C55",hint:"\u4EC5\u4F9B\u5E94\u5546\u660E\u786E\u652F\u6301\u65F6\u4F7F\u7528"},{value:"step-sse",label:"Step SSE \u6269\u5C55",hint:"\u4EC5\u4F9B\u5E94\u5546\u652F\u6301 /audio/asr/sse \u65F6\u4F7F\u7528"},{value:"step-websocket",label:"Step \u5B9E\u65F6\u8F6C\u5F55\u534F\u8BAE\u6269\u5C55",hint:"\u6301\u7EED PCM \u8F93\u5165\uFF1B\u4E0E OpenAI \u4F1A\u8BDD\u3001\u6587\u672C\u4E8B\u4EF6\u683C\u5F0F\u4E0D\u540C"}],disabled:s,onChange:x=>o({protocol:x})}),e==="asr"&&["step-websocket","openai-websocket"].includes(t.protocol)&&(0,k.jsxs)("label",{children:["WebSocket \u5730\u5740\uFF08\u53EF\u9009\uFF09",(0,k.jsx)("input",{type:"url",autoComplete:"off",placeholder:"\u7559\u7A7A\u4F7F\u7528\u534F\u8BAE\u9ED8\u8BA4\u5730\u5740\uFF1B\u53EF\u586B\u5199\u5B8C\u6574 wss:// \u5730\u5740",value:t.realtime?.url||"",onChange:x=>o({realtime:{...t.realtime,url:x.target.value}})}),(0,k.jsx)("small",{children:"\u7F51\u5173\u8DEF\u7531\u53C2\u6570\u53EF\u5199\u5165\u5730\u5740\uFF1BAPI Key \u4EC5\u901A\u8FC7\u670D\u52A1\u7AEF\u8BF7\u6C42\u5934\u53D1\u9001\u3002"})]}),e==="tts"&&(0,k.jsx)(Sn,{label:"\u5408\u6210\u534F\u8BAE",value:t.protocol,options:[{value:"speech",label:"OpenAI \u517C\u5BB9\u8BED\u97F3\u5408\u6210",hint:"\u6807\u51C6 /audio/speech\uFF0C\u6D41\u5F0F PCM"},{value:"step-speech",label:"Step \u8BED\u97F3\u5408\u6210\u6269\u5C55",hint:"\u4EC5\u5BF9\u652F\u6301\u7684\u670D\u52A1\u53D1\u9001\u91C7\u6837\u7387\u548C\u6D41\u5F0F\u6269\u5C55\u5B57\u6BB5"}],disabled:s,onChange:x=>o({protocol:x})}),(0,k.jsxs)("label",{children:["API \u5730\u5740",(0,k.jsx)("input",{type:"url",inputMode:"url",autoComplete:"off",readOnly:!!I,placeholder:"https://api.example.com/v1",value:L?.baseURL||t.baseURL,onChange:x=>o({baseURL:x.target.value})})]}),I&&(0,k.jsx)("p",{className:"voice-provider-hint",children:"\u4F7F\u7528\u8BE5\u4F9B\u5E94\u5546\u5DF2\u6709\u7684\u8FDE\u63A5\u914D\u7F6E\uFF0C\u5BC6\u94A5\u4E0D\u4F1A\u8FD4\u56DE\u6D4F\u89C8\u5668\u3002"}),I&&(0,k.jsxs)("div",{className:"voice-model-actions",children:[(0,k.jsx)("span",{className:"voice-field-label",children:"\u6A21\u578B\u5217\u8868"}),(0,k.jsx)("button",{type:"button",className:"voice-text-button",disabled:f||s,onClick:()=>y(x=>x+1),children:f?"\u83B7\u53D6\u4E2D\u2026":"\u91CD\u65B0\u83B7\u53D6"}),(0,k.jsx)("button",{type:"button",className:"voice-text-button",onClick:()=>D(x=>!x),children:M?"\u4ECE\u5217\u8868\u9009\u62E9":"\u624B\u52A8\u586B\u5199"})]}),I&&!M?(0,k.jsxs)(k.Fragment,{children:[(0,k.jsx)(Sn,{label:"\u6A21\u578B",value:t.model,options:d.map(x=>({value:x.id,label:x.name||x.id,hint:x.inferred?"\u6309\u6A21\u578B\u540D\u79F0\u63A8\u65AD\u80FD\u529B":x.id})),placeholder:f?"\u6B63\u5728\u83B7\u53D6\u6A21\u578B\u2026":"\u9009\u62E9\u6A21\u578B",disabled:s||f,onChange:x=>o({model:x})}),!f&&!d.length&&(0,k.jsx)("p",{className:"voice-provider-hint",children:"\u672A\u627E\u5230\u5BF9\u5E94\u8BED\u97F3\u6A21\u578B\uFF0C\u53EF\u624B\u52A8\u586B\u5199\u6A21\u578B ID\u3002"})]}):(0,k.jsxs)("label",{children:["\u6A21\u578B",(0,k.jsx)("input",{type:"text",autoComplete:"off",placeholder:e==="asr"?"\u586B\u5199\u8F6C\u5F55\u6A21\u578B ID":"\u586B\u5199\u8BED\u97F3\u5408\u6210\u6A21\u578B ID",value:t.model,onChange:x=>o({model:x.target.value})})]}),l&&(0,k.jsxs)("p",{role:"status",className:"voice-settings-error",children:[l,"\uFF1B\u53EF\u624B\u52A8\u586B\u5199\u6A21\u578B ID\u3002"]}),e==="tts"&&(0,k.jsxs)("label",{children:["\u97F3\u8272",(0,k.jsx)("input",{type:"text",autoComplete:"off",placeholder:t.protocol==="step-speech"?"\u9ED8\u8BA4 cixingnansheng":"\u9ED8\u8BA4 alloy\uFF1B\u53EF\u586B\u5199\u6A21\u578B\u652F\u6301\u7684 voice",value:t.voice,onChange:x=>o({voice:x.target.value})})]}),e==="tts"&&(0,k.jsxs)("label",{className:"voice-speed-field",children:[(0,k.jsxs)("span",{className:"voice-field-label",children:["\u8BED\u901F ",(0,k.jsxs)("output",{children:[zn(t.speed).toFixed(2),"\xD7"]})]}),(0,k.jsx)("input",{type:"range",min:Ca,max:Ia,step:"0.05",value:zn(t.speed),"aria-label":"\u8BED\u901F",onChange:x=>o({speed:zn(x.target.value)})})]}),!I&&(0,k.jsxs)("label",{children:["API Key",(0,k.jsxs)("div",{className:"voice-key-field",children:[(0,k.jsx)("input",{type:"password",autoComplete:"new-password",spellCheck:!1,placeholder:a?"\u4FDD\u5B58\u540E\u6E05\u9664\u5BC6\u94A5":n?.apiKeyConfigured?"\u5DF2\u914D\u7F6E\uFF0C\u7559\u7A7A\u4FDD\u7559\u73B0\u6709\u5BC6\u94A5":"\u586B\u5199 API Key",value:t.apiKey,onChange:x=>o({apiKey:x.target.value})}),(n?.apiKeyConfigured||a)&&(0,k.jsx)("button",{type:"button",onClick:r,children:a?"\u64A4\u9500\u6E05\u9664":"\u6E05\u9664\u5BC6\u94A5"})]})]})]})}var Tn=[{id:"dictation",label:"\u8BED\u97F3\u8F6C\u6587\u672C",detail:"\u5728\u8F93\u5165\u6846\u5B9E\u65F6\u8F6C\u5F55\uFF0C\u786E\u8BA4\u540E\u53D1\u9001",kinds:["asr"]},{id:"readAloud",label:"\u6717\u8BFB\u56DE\u590D",detail:"\u6309\u7247\u6BB5\u64AD\u653E\u56DE\u590D\uFF0C\u53EF\u968F\u65F6\u505C\u6B62",kinds:["tts"]},{id:"call",label:"\u5B9E\u65F6\u901A\u8BDD",detail:"\u8FDE\u7EED\u8046\u542C\u3001\u81EA\u52A8\u53D1\u9001\uFF0C\u652F\u6301\u6253\u65AD\u56DE\u590D",kinds:["asr","tts"]}];function ws({controller:e}){let t=ja(e),[n,i]=(0,we.useState)(null),[o,a]=(0,we.useState)(!1),[r,s]=(0,we.useState)(!1),[d,c]=(0,we.useState)(""),[f,u]=(0,we.useState)(!1),[l,p]=(0,we.useState)({}),[M,D]=(0,we.useState)("dictation"),[g,y]=(0,we.useState)([]),[I,L]=(0,we.useState)(""),b=(0,we.useId)();(0,we.useEffect)(()=>{t.config&&!o&&i(hs(t.config))},[t.config,o]),(0,we.useEffect)(()=>{let v=new AbortController;return Ea("providers",{},v.signal).then(E=>y(E.providers||[])).catch(E=>{v.signal.aborted||L(E.message)}),()=>v.abort()},[]);let x=(v,E)=>{i(O=>({...O,[v]:E})),a(!0),u(!1)},F=(v,E)=>{i(O=>({...O,[v]:{...O[v],...E}})),a(!0),u(!1),(E.apiKey||E.providerId)&&p(O=>({...O,[v]:!1}))},_=async v=>{v.preventDefault(),s(!0),c(""),u(!1);let E={...n,asr:{...n.asr},tts:{...n.tts}};for(let O of["asr","tts"])E[O].baseURL=E[O].baseURL.trim(),E[O].model=E[O].model.trim(),E[O].providerId?delete E[O].apiKey:l[O]?E[O].apiKey="":E[O].apiKey.trim()||delete E[O].apiKey;try{await e.configure(E),a(!1),p({}),u(!0)}catch(O){c(O.message||"\u4FDD\u5B58\u5931\u8D25")}finally{s(!1)}};if(!n)return(0,k.jsxs)("section",{className:"voice-settings",children:[(0,k.jsx)("h2",{children:"\u8BED\u97F3"}),(0,k.jsx)("p",{role:"status",children:t.error||"\u6B63\u5728\u52A0\u8F7D\u8BED\u97F3\u8BBE\u7F6E\u2026"}),t.error&&(0,k.jsx)("button",{type:"button",className:"voice-save",onClick:()=>e.load().catch(v=>c(v.message)),children:"\u91CD\u65B0\u52A0\u8F7D"}),d&&(0,k.jsx)("p",{role:"alert",className:"voice-settings-error",children:d})]});let Z=Tn.find(v=>v.id===M),Q=Tn.indexOf(Z);return(0,k.jsxs)("form",{className:"voice-settings",onSubmit:_,children:[(0,k.jsxs)("header",{children:[(0,k.jsx)("h2",{children:"\u8BED\u97F3"}),(0,k.jsx)("p",{children:"\u5728\u5BF9\u8BDD\u91CC\u81EA\u7136\u5730\u8BF4\u3001\u542C\u4E0E\u4EA4\u6D41\u3002"})]}),(0,k.jsxs)("div",{className:"voice-tabs",role:"tablist","aria-label":"\u8BED\u97F3\u4EA4\u4E92\u65B9\u5F0F",style:{"--voice-tab-index":Q},children:[(0,k.jsx)("span",{className:"voice-tab-indicator","aria-hidden":"true"}),Tn.map((v,E)=>(0,k.jsx)("button",{id:b+"-"+v.id,type:"button",role:"tab","aria-selected":M===v.id,"aria-controls":b+"-panel",tabIndex:M===v.id?0:-1,onClick:()=>D(v.id),onKeyDown:O=>{if(!["ArrowLeft","ArrowRight","Home","End"].includes(O.key))return;O.preventDefault();let P=O.key==="Home"?0:O.key==="End"?2:(E+(O.key==="ArrowRight"?1:2))%3;D(Tn[P].id),O.currentTarget.parentElement.querySelectorAll("[role=tab]")[P]?.focus()},children:v.label},v.id))]}),(0,k.jsxs)("div",{className:"voice-tab-panel",id:b+"-panel",role:"tabpanel","aria-labelledby":b+"-"+M,children:[(0,k.jsx)("fieldset",{disabled:r,className:"voice-mode-settings",children:(0,k.jsx)(bs,{label:Z.label,detail:Z.detail,checked:n[M],onChange:v=>x(M,v)})}),(0,k.jsx)("div",{className:"voice-privacy-note",children:M==="dictation"?"\u97F3\u9891\u53D1\u9001\u81F3\u6240\u9009 ASR \u670D\u52A1\u3002\u8F6C\u5F55\u5199\u5165\u8349\u7A3F\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u53D1\u9001\u3002":M==="readAloud"?"\u56DE\u590D\u6587\u672C\u53D1\u9001\u81F3\u6240\u9009 TTS \u670D\u52A1\u3002\u5F00\u542F\u540E\u4ECD\u53EF\u5728\u8F93\u5165\u6846\u5207\u6362\u672C\u8BBE\u5907\u7684\u81EA\u52A8\u6717\u8BFB\u3002":"\u97F3\u9891\u53D1\u9001\u81F3 ASR\uFF0C\u8F6C\u5F55\u53D1\u9001\u7ED9\u5F53\u524D\u5BF9\u8BDD\u6A21\u578B\uFF0C\u56DE\u590D\u6587\u672C\u53D1\u9001\u81F3 TTS\u3002\u901A\u8BDD\u4E0E\u5176\u4ED6\u4E24\u79CD\u65B9\u5F0F\u72EC\u7ACB\u5F00\u542F\u3002"}),M==="call"&&!["step-websocket","openai-websocket"].includes(n.asr.protocol)&&(0,k.jsx)("p",{role:"status",className:"voice-provider-hint",children:"\u5F53\u524D\u4E3A\u5206\u6BB5\u8BC6\u522B\u3002\u8FFD\u6C42\u4F4E\u5EF6\u8FDF\uFF0C\u8BF7\u9009\u62E9\u670D\u52A1\u5B9E\u9645\u652F\u6301\u7684\u5B9E\u65F6\u8F6C\u5F55 WSS \u534F\u8BAE\u53CA\u5BF9\u5E94\u6A21\u578B\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u6539\u5199\u73B0\u6709\u9009\u62E9\u3002"}),Z.kinds.map(v=>(0,k.jsx)(Ms,{name:v,draft:n[v],config:t.config?.[v],providers:g,update:E=>F(v,E),clearKey:l[v],toggleClear:()=>{p(E=>({...E,[v]:!E[v]})),F(v,{apiKey:""})},disabled:r},v))]},M),I&&(0,k.jsxs)("p",{role:"status",className:"voice-provider-hint",children:["\u6682\u65F6\u65E0\u6CD5\u8BFB\u53D6\u5DF2\u6709\u4F9B\u5E94\u5546\uFF1A",I,"\u3002\u4ECD\u53EF\u72EC\u7ACB\u914D\u7F6E\u3002"]}),(0,k.jsxs)("footer",{children:[(0,k.jsx)("button",{className:"voice-save",type:"submit",disabled:r||!o,children:r?"\u4FDD\u5B58\u4E2D\u2026":"\u4FDD\u5B58\u8BBE\u7F6E"}),(0,k.jsx)("span",{role:"status",children:f?"\u5DF2\u4FDD\u5B58":o?"\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539":""})]}),(d||t.error)&&(0,k.jsx)("p",{role:"alert",className:"voice-settings-error",children:d||t.error})]})}var lt=require("react"),Co=require("react-dom");var Ve=require("react"),Ba=require("react-dom");var Tl=require("react");var No={edit:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M11 2H9C4 2 2 4 2 9v6c0 5 2 7 7 7h6c5 0 7-2 7-7v-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M16.04 3.02 8.16 10.9c-.3.3-.6.89-.66 1.32l-.43 3.01c-.16 1.09.61 1.85 1.7 1.7l3.01-.43c.42-.06 1.01-.36 1.32-.66l7.88-7.88c1.36-1.36 2-2.94 0-4.94-2-2-3.58-1.36-4.94 0Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"></path><path d="M14.91 4.15a7.144 7.144 0 0 0 4.94 4.94" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M16.19 2H7.81C4.17 2 2 4.17 2 7.81v8.37C2 19.83 4.17 22 7.81 22h8.37c3.64 0 5.81-2.17 5.81-5.81V7.81C22 4.17 19.83 2 16.19 2Zm-5.24 15.51c-.29.29-.84.57-1.24.63l-2.46.35c-.09.01-.18.02-.27.02-.41 0-.79-.14-1.06-.41-.33-.33-.47-.81-.39-1.34l.35-2.46c.06-.41.33-.95.63-1.24l4.46-4.46a7.546 7.546 0 0 0 .6 1.29c.1.17.21.33.3.45.11.17.24.33.32.42.05.07.09.12.11.14.25.3.54.58.79.79.07.07.11.11.13.12.15.12.3.24.43.33.16.12.32.23.49.32.2.12.42.23.64.34.23.1.44.19.65.26l-4.48 4.45Zm6.42-6.42-.92.93a.31.31 0 0 1-.22.09c-.03 0-.07 0-.09-.01a6.202 6.202 0 0 1-4.23-4.23c-.03-.11 0-.23.08-.3l.93-.93c1.52-1.52 2.97-1.49 4.46 0 .76.76 1.13 1.49 1.13 2.25-.01.72-.38 1.44-1.14 2.2Z" fill="currentColor"></path></svg>'},search:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M11.5 21a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19ZM22 22l-2-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M11.5 21a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19ZM21.3 21.999c-.18 0-.36-.07-.49-.2l-1.86-1.86a.706.706 0 0 1 0-.99c.27-.27.71-.27.99 0l1.86 1.86c.27.27.27.71 0 .99-.14.13-.32.2-.5.2Z" fill="currentColor"></path></svg>'},folder:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M22 11v6c0 4-1 5-5 5H7c-4 0-5-1-5-5V7c0-4 1-5 5-5h1.5c1.5 0 1.83.44 2.4 1.2l1.5 2c.38.5.6.8 1.6.8h3c4 0 5 1 5 5Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10"></path><path d="M8 2h9c2 0 3 1 3 3v1.38" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M19.434 4.034c.133.208-.094.45-.334.396-.47-.14-.99-.21-1.52-.21h-3.3a.5.5 0 0 1-.4-.2l-1.15-1.53c-.141-.2-.008-.49.236-.49h2.754c1.56 0 2.936.81 3.714 2.034Z" fill="currentColor"></path><path d="M20.14 6.54a4.18 4.18 0 0 0-1.45-.67c-.36-.1-.73-.15-1.11-.15h-3.72c-.58 0-.62-.05-.93-.46l-1.4-1.86C10.88 2.53 10.37 2 8.74 2H6.42C3.98 2 2 3.98 2 6.42v11.16C2 20.02 3.98 22 6.42 22h11.16c2.44 0 4.42-1.98 4.42-4.42v-7.44c0-1.49-.73-2.8-1.86-3.6Zm-5.75 9.8H9.6c-.39 0-.69-.31-.69-.7 0-.38.3-.7.69-.7h4.79c.39 0 .7.32.7.7 0 .39-.31.7-.7.7Z" fill="currentColor"></path></svg>'},folderOpen:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="m21.67 14.3-.4 5c-.15 1.53-.27 2.7-2.98 2.7H5.71C3 22 2.88 20.83 2.73 19.3l-.4-5c-.08-.83.18-1.6.65-2.19l.02-.02C3.55 11.42 4.38 11 5.31 11h13.38c.93 0 1.75.42 2.29 1.07.01.01.02.02.02.03.49.59.76 1.36.67 2.2Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10"></path><path d="M3.5 11.43V6.28c0-3.4.85-4.25 4.25-4.25h1.27c1.27 0 1.56.38 2.04 1.02l1.27 1.7c.32.42.51.68 1.36.68h2.55c3.4 0 4.25.85 4.25 4.25v1.79M9.43 17h5.14" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="m21.058 11.822-.16-.22c-.28-.34-.61-.61-.99-.81-.51-.29-1.09-.44-1.69-.44H5.768c-.6 0-1.17.15-1.69.44-.39.21-.74.5-1.03.86-.57.73-.84 1.63-.75 2.53l.37 4.67c.13 1.41.3 3.15 3.47 3.15h11.72c3.17 0 3.33-1.74 3.47-3.16l.37-4.65c.09-.84-.13-1.68-.64-2.37Zm-6.67 5.52h-4.79c-.39 0-.7-.32-.7-.7 0-.38.31-.7.7-.7h4.79c.39 0 .7.32.7.7 0 .39-.31.7-.7.7ZM20.56 8.596c.038.383-.378.64-.742.517a4.979 4.979 0 0 0-1.59-.253H5.769c-.556 0-1.104.09-1.616.262-.36.121-.773-.127-.773-.507V6.66c0-3.57 1.09-4.66 4.66-4.66h1.18c1.43 0 1.88.46 2.46 1.21l1.2 1.6c.25.34.26.36.7.36h2.38c3.126 0 4.347.837 4.601 3.426Z" fill="currentColor"></path></svg>'},plus:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M6 12h12M12 18V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M16.19 2H7.81C4.17 2 2 4.17 2 7.81v8.37C2 19.83 4.17 22 7.81 22h8.37c3.64 0 5.81-2.17 5.81-5.81V7.81C22 4.17 19.83 2 16.19 2ZM18 12.75h-5.25V18c0 .41-.34.75-.75.75s-.75-.34-.75-.75v-5.25H6c-.41 0-.75-.34-.75-.75s.34-.75.75-.75h5.25V6c0-.41.34-.75.75-.75s.75.34.75.75v5.25H18c.41 0 .75.34.75.75s-.34.75-.75.75Z" fill="currentColor"></path></svg>'},chevronDown:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="10" stroke-width="1.5" d="M19.92 8.95l-6.52 6.52c-.77.77-2.03.77-2.8 0L4.08 8.95"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path fill="currentColor" d="M17.919 8.18H6.079c-.96 0-1.44 1.16-.76 1.84l5.18 5.18c.83.83 2.18.83 3.01 0l1.97-1.97 3.21-3.21c.67-.68.19-1.84-.77-1.84z"></path></svg>'},chevronLeft:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="10" stroke-width="1.5" d="M15 19.92L8.48 13.4c-.77-.77-.77-2.03 0-2.8L15 4.08"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path fill="currentColor" d="M13.978 5.319l-3.21 3.21-1.97 1.96a2.13 2.13 0 000 3.01l5.18 5.18c.68.68 1.84.19 1.84-.76V6.079c0-.96-1.16-1.44-1.84-.76z"></path></svg>'},archive:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M19.5 10.22V19c0 2-.5 3-3 3h-9c-2.5 0-3-1-3-3v-8.78M5 2h14c2 0 3 1 3 3v2c0 2-1 3-3 3H5c-2 0-3-1-3-3V5c0-2 1-3 3-3ZM10.18 14h3.64" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M22 5v2c0 1.83-.83 2.82-2.5 2.97-.16.02-.33.03-.5.03H5c-.17 0-.34-.01-.5-.03C2.83 9.82 2 8.83 2 7V5c0-2 1-3 3-3h14c2 0 3 1 3 3ZM5.5 11.25c-.55 0-1 .45-1 1V19c0 2 .5 3 3 3h9c2.5 0 3-1 3-3v-6.75c0-.55-.45-1-1-1h-13Zm8.32 4.5h-3.64c-.41 0-.75-.34-.75-.75s.34-.75.75-.75h3.64c.41 0 .75.34.75.75s-.34.75-.75.75Z" fill="currentColor"></path></svg>'},settings:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"></path><path d="M2 12.88v-1.76c0-1.04.85-1.9 1.9-1.9 1.81 0 2.55-1.28 1.64-2.85-.52-.9-.21-2.07.7-2.59l1.73-.99c.79-.47 1.81-.19 2.28.6l.11.19c.9 1.57 2.38 1.57 3.29 0l.11-.19c.47-.79 1.49-1.07 2.28-.6l1.73.99c.91.52 1.22 1.69.7 2.59-.91 1.57-.17 2.85 1.64 2.85 1.04 0 1.9.85 1.9 1.9v1.76c0 1.04-.85 1.9-1.9 1.9-1.81 0-2.55 1.28-1.64 2.85.52.91.21 2.07-.7 2.59l-1.73.99c-.79.47-1.81.19-2.28-.6l-.11-.19c-.9-1.57-2.38-1.57-3.29 0l-.11.19c-.47.79-1.49 1.07-2.28.6l-1.73-.99a1.899 1.899 0 0 1-.7-2.59c.91-1.57.17-2.85-1.64-2.85-1.05 0-1.9-.86-1.9-1.9Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M20.1 9.221c-1.81 0-2.55-1.28-1.65-2.85.52-.91.21-2.07-.7-2.59l-1.73-.99c-.79-.47-1.81-.19-2.28.6l-.11.19c-.9 1.57-2.38 1.57-3.29 0l-.11-.19a1.641 1.641 0 0 0-2.26-.6l-1.73.99c-.91.52-1.22 1.69-.7 2.6.91 1.56.17 2.84-1.64 2.84-1.04 0-1.9.85-1.9 1.9v1.76c0 1.04.85 1.9 1.9 1.9 1.81 0 2.55 1.28 1.64 2.85-.52.91-.21 2.07.7 2.59l1.73.99c.79.47 1.81.19 2.28-.6l.11-.19c.9-1.57 2.38-1.57 3.29 0l.11.19c.47.79 1.49 1.07 2.28.6l1.73-.99c.91-.52 1.22-1.69.7-2.59-.91-1.57-.17-2.85 1.64-2.85 1.04 0 1.9-.85 1.9-1.9v-1.76a1.92 1.92 0 0 0-1.91-1.9Zm-8.1 6.03c-1.79 0-3.25-1.46-3.25-3.25s1.46-3.25 3.25-3.25 3.25 1.46 3.25 3.25-1.46 3.25-3.25 3.25Z" fill="currentColor"></path></svg>'},more:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2ZM19 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2ZM12 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2Z" stroke="currentColor" stroke-width="1.5"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M16.19 2H7.81C4.17 2 2 4.17 2 7.81v8.37C2 19.83 4.17 22 7.81 22h8.37c3.64 0 5.81-2.17 5.81-5.81V7.81C22 4.17 19.83 2 16.19 2ZM7 13.31c-.72 0-1.31-.59-1.31-1.31 0-.72.59-1.31 1.31-1.31.72 0 1.31.59 1.31 1.31 0 .72-.59 1.31-1.31 1.31Zm5 0c-.72 0-1.31-.59-1.31-1.31 0-.72.59-1.31 1.31-1.31.72 0 1.31.59 1.31 1.31 0 .72-.59 1.31-1.31 1.31Zm5 0c-.72 0-1.31-.59-1.31-1.31 0-.72.59-1.31 1.31-1.31.72 0 1.31.59 1.31 1.31 0 .72-.59 1.31-1.31 1.31Z" fill="currentColor"></path></svg>'},trash:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M21 5.98c-3.33-.33-6.68-.5-10.02-.5-1.98 0-3.96.1-5.94.3L3 5.98M8.5 4.97l.22-1.31C8.88 2.71 9 2 10.69 2h2.62c1.69 0 1.82.75 1.97 1.67l.22 1.3M18.85 9.14l-.65 10.07C18.09 20.78 18 22 15.21 22H8.79C6 22 5.91 20.78 5.8 19.21L5.15 9.14M10.33 16.5h3.33M9.5 12.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M21.07 5.23c-1.61-.16-3.22-.28-4.84-.37v-.01l-.22-1.3c-.15-.92-.37-2.3-2.71-2.3h-2.62c-2.33 0-2.55 1.32-2.71 2.29l-.21 1.28c-.93.06-1.86.12-2.79.21l-2.04.2c-.42.04-.72.41-.68.82.04.41.4.71.82.67l2.04-.2c5.24-.52 10.52-.32 15.82.21h.08c.38 0 .71-.29.75-.68a.766.766 0 0 0-.69-.82ZM19.23 8.14c-.24-.25-.57-.39-.91-.39H5.68c-.34 0-.68.14-.91.39-.23.25-.36.59-.34.94l.62 10.26c.11 1.52.25 3.42 3.74 3.42h6.42c3.49 0 3.63-1.89 3.74-3.42l.62-10.25c.02-.36-.11-.7-.34-.95Zm-5.57 9.61h-3.33c-.41 0-.75-.34-.75-.75s.34-.75.75-.75h3.33c.41 0 .75.34.75.75s-.34.75-.75.75Zm.84-4h-5c-.41 0-.75-.34-.75-.75s.34-.75.75-.75h5c.41 0 .75.34.75.75s-.34.75-.75.75Z" fill="currentColor"></path></svg>'},plugins:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M22 8.52V3.98C22 2.57 21.36 2 19.77 2h-4.04c-1.59 0-2.23.57-2.23 1.98v4.53c0 1.42.64 1.98 2.23 1.98h4.04c1.59.01 2.23-.56 2.23-1.97ZM22 19.77v-4.04c0-1.59-.64-2.23-2.23-2.23h-4.04c-1.59 0-2.23.64-2.23 2.23v4.04c0 1.59.64 2.23 2.23 2.23h4.04c1.59 0 2.23-.64 2.23-2.23ZM10.5 8.52V3.98C10.5 2.57 9.86 2 8.27 2H4.23C2.64 2 2 2.57 2 3.98v4.53c0 1.42.64 1.98 2.23 1.98h4.04c1.59.01 2.23-.56 2.23-1.97ZM10.5 19.77v-4.04c0-1.59-.64-2.23-2.23-2.23H4.23c-1.59 0-2.23.64-2.23 2.23v4.04C2 21.36 2.64 22 4.23 22h4.04c1.59 0 2.23-.64 2.23-2.23Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M22 8.52V3.98C22 2.57 21.36 2 19.77 2h-4.04c-1.59 0-2.23.57-2.23 1.98v4.53c0 1.42.64 1.98 2.23 1.98h4.04c1.59.01 2.23-.56 2.23-1.97ZM22 19.77v-4.04c0-1.59-.64-2.23-2.23-2.23h-4.04c-1.59 0-2.23.64-2.23 2.23v4.04c0 1.59.64 2.23 2.23 2.23h4.04c1.59 0 2.23-.64 2.23-2.23ZM10.5 8.52V3.98C10.5 2.57 9.86 2 8.27 2H4.23C2.64 2 2 2.57 2 3.98v4.53c0 1.42.64 1.98 2.23 1.98h4.04c1.59.01 2.23-.56 2.23-1.97ZM10.5 19.77v-4.04c0-1.59-.64-2.23-2.23-2.23H4.23c-1.59 0-2.23.64-2.23 2.23v4.04C2 21.36 2.64 22 4.23 22h4.04c1.59 0 2.23-.64 2.23-2.23Z" fill="currentColor"></path></svg>'},schedules:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M8 2v3M16 2v3M3.5 9.09h17M21 8.5V17c0 3-1.5 5-5 5H8c-3.5 0-5-2-5-5V8.5c0-3 1.5-5 5-5h8c3.5 0 5 2 5 5Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"></path><path d="M15.695 13.7h.009M15.695 16.7h.009M11.995 13.7h.01M11.995 16.7h.01M8.294 13.7h.01M8.294 16.7h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M16.75 3.56V2c0-.41-.34-.75-.75-.75s-.75.34-.75.75v1.5h-6.5V2c0-.41-.34-.75-.75-.75s-.75.34-.75.75v1.56c-2.7.25-4.01 1.86-4.21 4.25-.02.29.22.53.5.53h16.92c.29 0 .53-.25.5-.53-.2-2.39-1.51-4-4.21-4.25ZM20 9.84H4c-.55 0-1 .45-1 1V17c0 3 1.5 5 5 5h8c3.5 0 5-2 5-5v-6.16c0-.55-.45-1-1-1ZM9.21 18.21c-.05.04-.1.09-.15.12-.06.04-.12.07-.18.09-.06.03-.12.05-.18.06-.07.01-.13.02-.2.02-.13 0-.26-.03-.38-.08-.13-.05-.23-.12-.33-.21-.18-.19-.29-.45-.29-.71 0-.26.11-.52.29-.71.1-.09.2-.16.33-.21.18-.08.38-.1.58-.06.06.01.12.03.18.06.06.02.12.05.18.09l.15.12c.18.19.29.45.29.71 0 .26-.11.52-.29.71Zm0-3.5c-.19.18-.45.29-.71.29-.26 0-.52-.11-.71-.29-.18-.19-.29-.45-.29-.71 0-.26.11-.52.29-.71.28-.28.72-.37 1.09-.21.13.05.24.12.33.21.18.19.29.45.29.71 0 .26-.11.52-.29.71Zm3.5 3.5c-.19.18-.45.29-.71.29-.26 0-.52-.11-.71-.29-.18-.19-.29-.45-.29-.71 0-.26.11-.52.29-.71.37-.37 1.05-.37 1.42 0 .18.19.29.45.29.71 0 .26-.11.52-.29.71Zm0-3.5-.15.12c-.06.04-.12.07-.18.09-.06.03-.12.05-.18.06-.07.01-.13.02-.2.02-.26 0-.52-.11-.71-.29-.18-.19-.29-.45-.29-.71 0-.26.11-.52.29-.71.09-.09.2-.16.33-.21.37-.16.81-.07 1.09.21.18.19.29.45.29.71 0 .26-.11.52-.29.71Zm3.5 3.5c-.19.18-.45.29-.71.29-.26 0-.52-.11-.71-.29-.18-.19-.29-.45-.29-.71 0-.26.11-.52.29-.71.37-.37 1.05-.37 1.42 0 .18.19.29.45.29.71 0 .26-.11.52-.29.71Zm0-3.5-.15.12c-.06.04-.12.07-.18.09-.06.03-.12.05-.18.06-.07.01-.14.02-.2.02-.26 0-.52-.11-.71-.29-.18-.19-.29-.45-.29-.71 0-.26.11-.52.29-.71.1-.09.2-.16.33-.21.18-.08.38-.1.58-.06.06.01.12.03.18.06.06.02.12.05.18.09l.15.12c.18.19.29.45.29.71 0 .26-.11.52-.29.71Z" fill="currentColor"></path></svg>'},check:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 22c5.5 0 10-4.5 10-10S17.5 2 12 2 2 6.5 2 12s4.5 10 10 10Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="m7.75 12 2.83 2.83 5.67-5.66" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10 10-4.49 10-10S17.51 2 12 2Zm4.78 7.7-5.67 5.67a.75.75 0 0 1-1.06 0l-2.83-2.83a.754.754 0 0 1 0-1.06c.29-.29.77-.29 1.06 0l2.3 2.3 5.14-5.14c.29-.29.77-.29 1.06 0 .29.29.29.76 0 1.06Z" fill="currentColor"></path></svg>'},collapse:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M21.97 15V9c0-5-2-7-7-7h-6c-5 0-7 2-7 7v6c0 5 2 7 7 7h6c5 0 7-2 7-7ZM7.97 2v20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M14.97 9.44 12.41 12l2.56 2.56" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M2 7.811v8.38c0 1.49.36 2.73 1.05 3.68.29.42.66.79 1.08 1.08.82.6 1.86.95 3.09 1.03V2.031C3.94 2.241 2 4.371 2 7.811ZM20.95 4.13c-.29-.42-.66-.79-1.08-1.08C18.92 2.36 17.68 2 16.19 2H8.72v20h7.47c3.64 0 5.81-2.17 5.81-5.81V7.81c0-1.49-.36-2.73-1.05-3.68Zm-5.45 9.9c.29.29.29.77 0 1.06-.15.15-.34.22-.53.22s-.38-.07-.53-.22l-2.56-2.56a.754.754 0 0 1 0-1.06l2.56-2.56c.29-.29.77-.29 1.06 0 .29.29.29.77 0 1.06L13.48 12l2.02 2.03Z" fill="currentColor"></path></svg>'},link:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M13.06 10.94a5.74 5.74 0 0 1 0 8.13c-2.25 2.24-5.89 2.25-8.13 0-2.24-2.25-2.25-5.89 0-8.13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M10.59 13.41c-2.34-2.34-2.34-6.14 0-8.49 2.34-2.35 6.14-2.34 8.49 0 2.35 2.34 2.34 6.14 0 8.49" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M19.071 14.242c-.29.29-.75.29-1.03 0a.718.718 0 0 1 0-1.03c2-2 2-5.25 0-7.24-2-1.99-5.25-2-7.24 0-1.99 2-2 5.25 0 7.24.29.29.29.75 0 1.03-.29.29-.75.29-1.03 0-2.57-2.57-2.57-6.75 0-9.31 2.57-2.56 6.75-2.57 9.31 0a6.594 6.594 0 0 1-.01 9.31Z" fill="currentColor"></path><path d="M4.929 9.76c.29-.29.75-.29 1.03 0 .29.29.29.75 0 1.03-2 2-2 5.25 0 7.24 2 1.99 5.25 2 7.24 0 1.99-2 2-5.25 0-7.24a.718.718 0 0 1 0-1.03c.29-.29.75-.29 1.03 0 2.57 2.57 2.57 6.75 0 9.31-2.57 2.56-6.75 2.57-9.31 0a6.594 6.594 0 0 1 .01-9.31Z" fill="currentColor"></path></svg>'},external:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 11l8.2-8.2M22 6.8V2h-4.8M11 2H9C4 2 2 4 2 9v6c0 5 2 7 7 7h6c5 0 7-2 7-7v-2"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path fill="currentColor" d="M16.19 2H7.81C4.17 2 2 4.17 2 7.81v8.37C2 19.83 4.17 22 7.81 22h8.37c3.64 0 5.81-2.17 5.81-5.81V7.81C22 4.17 19.83 2 16.19 2zm1.06 10.33c0 .41-.34.75-.75.75s-.75-.34-.75-.75V9.31l-7.72 7.72c-.15.15-.34.22-.53.22s-.38-.07-.53-.22a.754.754 0 010-1.06l7.72-7.72h-3.02c-.41 0-.75-.34-.75-.75s.34-.75.75-.75h4.83c.41 0 .75.34.75.75v4.83z"></path></svg>'},scan:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M2 9V6.5C2 4.01 4.01 2 6.5 2H9M15 2h2.5C19.99 2 22 4.01 22 6.5V9M22 16v1.5c0 2.49-2.01 4.5-4.5 4.5H16M9 22H6.5C4.01 22 2 19.99 2 17.5V15M17 9.5v5c0 2-1 3-3 3h-4c-2 0-3-1-3-3v-5c0-2 1-3 3-3h4c2 0 3 1 3 3ZM19 12H5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M2.77 10C2.34 10 2 9.66 2 9.23V6.92A4.93 4.93 0 0 1 6.92 2h2.31c.43 0 .77.34.77.77s-.34.77-.77.77H6.92c-1.87 0-3.38 1.52-3.38 3.38v2.31c0 .43-.35.77-.77.77ZM21.23 10a.77.77 0 0 1-.77-.77V6.92c0-1.87-1.52-3.38-3.38-3.38h-2.31a.77.77 0 0 1 0-1.54h2.31A4.93 4.93 0 0 1 22 6.92v2.31c0 .43-.34.77-.77.77ZM17.082 22h-1.39a.77.77 0 0 1 0-1.54h1.39c1.87 0 3.38-1.52 3.38-3.38V15.7a.77.77 0 0 1 1.54 0v1.38a4.93 4.93 0 0 1-4.92 4.92ZM9.23 22H6.92A4.93 4.93 0 0 1 2 17.08v-2.31c0-.43.34-.77.77-.77s.77.34.77.77v2.31c0 1.87 1.52 3.38 3.38 3.38h2.31a.77.77 0 0 1 0 1.54ZM18.46 11.23H5.54a.77.77 0 0 0 0 1.54H18.46a.77.77 0 0 0 0-1.54ZM6.898 13.94v.33c0 1.66 1.34 3 3 3h4.2c1.66 0 3-1.34 3-3v-.33c0-.12-.09-.21-.21-.21h-9.78c-.12 0-.21.09-.21.21ZM6.898 10.06v-.33c0-1.66 1.34-3 3-3h4.2c1.66 0 3 1.34 3 3v.33c0 .12-.09.21-.21.21h-9.78c-.12 0-.21-.09-.21-.21Z" fill="currentColor"></path></svg>'},refresh:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M22 12c0 5.52-4.48 10-10 10s-8.89-5.56-8.89-5.56m0 0h4.52m-4.52 0v5M2 12C2 6.48 6.44 2 12 2c6.67 0 10 5.56 10 5.56m0 0v-5m0 5h-4.44"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path fill="currentColor" d="M16.19 2H7.81C4.17 2 2 4.17 2 7.81v8.37C2 19.83 4.17 22 7.81 22h8.37c3.64 0 5.81-2.17 5.81-5.81V7.81C22 4.17 19.83 2 16.19 2zM12 18.25c-1.79 0-3.19-.89-4.14-1.77v.71c0 .41-.34.75-.75.75s-.75-.34-.75-.75v-2.75c0-.41.34-.75.75-.75h2.48c.41 0 .75.34.75.75s-.34.75-.75.75h-.9c.74.74 1.89 1.56 3.31 1.56 2.62 0 4.75-2.13 4.75-4.75 0-.41.34-.75.75-.75s.75.34.75.75c0 3.45-2.8 6.25-6.25 6.25zm6.25-8.71v.08a.75.75 0 01-.3.54c-.07.05-.15.09-.24.12-.07.02-.14.03-.21.03h-2.43c-.41 0-.75-.34-.75-.75s.34-.75.75-.75h.83c-.8-.74-2.09-1.56-3.88-1.56-2.62 0-4.75 2.13-4.75 4.75 0 .41-.34.75-.75.75s-.77-.34-.77-.75c0-3.45 2.8-6.25 6.25-6.25 2.15 0 3.73.93 4.75 1.82v-.76c0-.41.34-.75.75-.75s.75.34.75.75v2.73z"></path></svg>'},copy:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16 12.9v4.2c0 3.5-1.4 4.9-4.9 4.9H6.9C3.4 22 2 20.6 2 17.1v-4.2C2 9.4 3.4 8 6.9 8h4.2c3.5 0 4.9 1.4 4.9 4.9z"></path><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M22 6.9v4.2c0 3.5-1.4 4.9-4.9 4.9H16v-3.1C16 9.4 14.6 8 11.1 8H8V6.9C8 3.4 9.4 2 12.9 2h4.2C20.6 2 22 3.4 22 6.9z"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M16 12.9v4.2c0 3.5-1.4 4.9-4.9 4.9H6.9C3.4 22 2 20.6 2 17.1v-4.2C2 9.4 3.4 8 6.9 8h4.2c3.5 0 4.9 1.4 4.9 4.9Z" fill="currentColor"></path><path d="M17.1 2h-4.2C9.817 2 8.37 3.094 8.07 5.739c-.064.553.395 1.011.952 1.011H11.1c4.2 0 6.15 1.95 6.15 6.15v2.078c0 .557.457 1.015 1.01.952C20.907 15.63 22 14.183 22 11.1V6.9C22 3.4 20.6 2 17.1 2Z" fill="currentColor"></path></svg>'},close:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 22c5.5 0 10-4.5 10-10S17.5 2 12 2 2 6.5 2 12s4.5 10 10 10ZM9.17 14.83l5.66-5.66M14.83 14.83 9.17 9.17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10 10-4.49 10-10S17.51 2 12 2Zm3.36 12.3c.29.29.29.77 0 1.06-.15.15-.34.22-.53.22s-.38-.07-.53-.22l-2.3-2.3-2.3 2.3c-.15.15-.34.22-.53.22s-.38-.07-.53-.22a.754.754 0 0 1 0-1.06l2.3-2.3-2.3-2.3a.754.754 0 0 1 0-1.06c.29-.29.77-.29 1.06 0l2.3 2.3 2.3-2.3c.29-.29.77-.29 1.06 0 .29.29.29.77 0 1.06l-2.3 2.3 2.3 2.3Z" fill="currentColor"></path></svg>'},computer:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M6.44 2h11.11C21.11 2 22 2.89 22 6.44v6.33c0 3.56-.89 4.44-4.44 4.44H6.44C2.89 17.22 2 16.33 2 12.78V6.44C2 2.89 2.89 2 6.44 2ZM12 17.22V22M2 13h20M7.5 22h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M17.56 2H6.41C3.98 2 2 3.98 2 6.41v6.7a4.41 4.41 0 0 0 4.41 4.41h3.84c.55 0 1 .45 1 1v.97c0 .55-.45 1-1 1H7.83a.755.755 0 0 0 0 1.51h8.35c.41 0 .75-.34.75-.75s-.34-.75-.75-.75h-2.42c-.55 0-1-.45-1-1v-.97c0-.55.45-1 1-1h3.81a4.41 4.41 0 0 0 4.41-4.41v-6.7C21.97 3.98 19.99 2 17.56 2Z" fill="currentColor"></path></svg>'},mobile:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M17 6v10c0 4-1 5-5 5H6c-4 0-5-1-5-5V6c0-4 1-5 5-5h6c4 0 5 1 5 5ZM11 4.5H7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M9 18.1A1.55 1.55 0 1 0 9 15a1.55 1.55 0 0 0 0 3.1Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M16.24 2H7.76C5 2 4 3 4 5.81v12.38C4 21 5 22 7.76 22h8.47C19 22 20 21 20 18.19V5.81C20 3 19 2 16.24 2ZM12 19.3c-.96 0-1.75-.79-1.75-1.75s.79-1.75 1.75-1.75 1.75.79 1.75 1.75-.79 1.75-1.75 1.75Zm2-13.05h-4c-.41 0-.75-.34-.75-.75s.34-.75.75-.75h4c.41 0 .75.34.75.75s-.34.75-.75.75Z" fill="currentColor"></path></svg>'},server:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M19.32 10H4.69c-1.48 0-2.68-1.21-2.68-2.68V4.69c0-1.48 1.21-2.68 2.68-2.68h14.63C20.8 2.01 22 3.22 22 4.69v2.63C22 8.79 20.79 10 19.32 10ZM19.32 22H4.69c-1.48 0-2.68-1.21-2.68-2.68v-2.63c0-1.48 1.21-2.68 2.68-2.68h14.63c1.48 0 2.68 1.21 2.68 2.68v2.63c0 1.47-1.21 2.68-2.68 2.68ZM6 5v2M10 5v2M6 17v2M10 17v2M14 6h4M14 18h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M19.32 2H4.68C3.21 2 2 3.21 2 4.68v2.63C2 8.79 3.21 10 4.68 10h14.63C20.79 10 22 8.79 22 7.32V4.68C22 3.21 20.79 2 19.32 2ZM6.75 7c0 .41-.34.75-.75.75s-.75-.34-.75-.75V5c0-.41.34-.75.75-.75s.75.34.75.75v2Zm4 0c0 .41-.34.75-.75.75s-.75-.34-.75-.75V5c0-.41.34-.75.75-.75s.75.34.75.75v2ZM18 6.75h-4c-.41 0-.75-.34-.75-.75s.34-.75.75-.75h4c.41 0 .75.34.75.75s-.34.75-.75.75ZM19.32 14H4.68C3.21 14 2 15.21 2 16.68v2.63C2 20.79 3.21 22 4.68 22h14.63c1.48 0 2.68-1.21 2.68-2.68v-2.63A2.68 2.68 0 0 0 19.32 14ZM6.75 19c0 .41-.34.75-.75.75s-.75-.34-.75-.75v-2c0-.41.34-.75.75-.75s.75.34.75.75v2Zm4 0c0 .41-.34.75-.75.75s-.75-.34-.75-.75v-2c0-.41.34-.75.75-.75s.75.34.75.75v2Zm7.25-.25h-4c-.41 0-.75-.34-.75-.75s.34-.75.75-.75h4c.41 0 .75.34.75.75s-.34.75-.75.75Z" fill="currentColor"></path></svg>'},devices:{linear:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M17.01 12.73a1.07 1.07 0 1 0 0-2.14 1.07 1.07 0 0 0 0 2.14Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M20 6v1.79c-.25-.03-.54-.05-.85-.05h-4.28c-2.14 0-2.85.71-2.85 2.85v5.11H6c-3.2 0-4-.8-4-4V6c0-3.2.8-4 4-4h10c3.2 0 4 .8 4 4ZM9 15.7V20M2 11.9h10M5.95 20H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M17.01 12.73a1.07 1.07 0 1 0 0-2.14 1.07 1.07 0 0 0 0 2.14Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"></path><path d="M20 7.79c-.25-.03-.54-.05-.85-.05h-4.28c-2.14 0-2.85.71-2.85 2.85v8.56c0 2.14.71 2.85 2.85 2.85h4.28c2.14 0 2.85-.71 2.85-2.85v-8.56c0-1.83-.52-2.61-2-2.8Zm-2.99 2.8a1.071 1.071 0 0 1 0 2.14 1.071 1.071 0 0 1 0-2.14Zm0 8.56c-1.18 0-2.14-.96-2.14-2.14a2.142 2.142 0 0 1 3.54-1.62c.45.4.74.98.74 1.62 0 1.18-.96 2.14-2.14 2.14Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"></path><path d="M19.15 17.01c0 1.18-.96 2.14-2.14 2.14-1.18 0-2.14-.96-2.14-2.14a2.142 2.142 0 0 1 3.54-1.62c.45.4.74.98.74 1.62ZM17.01 12.73a1.07 1.07 0 1 0 0-2.14 1.07 1.07 0 0 0 0 2.14Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"></path></svg>',bold:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M20 6v.24h-5.13c-2.97 0-4.35 1.38-4.35 4.35v5.11h-.77v3.55h.77v1.5H4.95c-.41 0-.75-.34-.75-.75s.34-.75.75-.75h3.3V15.7H6c-3.13 0-3.97-.77-4-3.8V6c0-3.2.8-4 4-4h10c3.2 0 4 .8 4 4Z" fill="currentColor"></path><path d="M20 7.788c-.25-.03-.54-.05-.85-.05h-4.28c-2.14 0-2.85.71-2.85 2.85v8.66c.01.62.08 1.11.23 1.5.35.91 1.14 1.25 2.62 1.25h4.28c2.14 0 2.85-.71 2.85-2.85v-8.56c0-1.83-.52-2.61-2-2.8Zm-2.99 2.3c.87 0 1.57.7 1.57 1.57 0 .87-.7 1.57-1.57 1.57-.87 0-1.57-.7-1.57-1.57 0-.87.7-1.57 1.57-1.57Zm0 9.06c-1.18 0-2.14-.96-2.14-2.14a2.142 2.142 0 0 1 3.54-1.62c.45.4.74.98.74 1.62 0 1.18-.96 2.14-2.14 2.14Z" fill="currentColor"></path><path d="M20 7.788c-.25-.03-.54-.05-.85-.05h-4.28c-2.14 0-2.85.71-2.85 2.85v8.66c.01.62.08 1.11.23 1.5.35.91 1.14 1.25 2.62 1.25h4.28c2.14 0 2.85-.71 2.85-2.85v-8.56c0-1.83-.52-2.61-2-2.8Zm-2.99 2.3c.87 0 1.57.7 1.57 1.57 0 .87-.7 1.57-1.57 1.57-.87 0-1.57-.7-1.57-1.57 0-.87.7-1.57 1.57-1.57Zm0 9.06c-1.18 0-2.14-.96-2.14-2.14a2.142 2.142 0 0 1 3.54-1.62c.45.4.74.98.74 1.62 0 1.18-.96 2.14-2.14 2.14Z" fill="currentColor"></path></svg>'}};var un=require("react/jsx-runtime");function te({name:e,size:t=20,selected:n=!1,className:i=""}){let o=No[e]??No.plugins;return(0,un.jsxs)("span",{className:`cmd-ui-icon ${n?"is-selected":""} ${i}`,style:{width:t,height:t},"aria-hidden":"true",children:[(0,un.jsx)("span",{className:"cmd-ui-linear",dangerouslySetInnerHTML:{__html:o.linear}}),(0,un.jsx)("span",{className:"cmd-ui-bold",dangerouslySetInnerHTML:{__html:o.bold}})]})}function La(e=globalThis){if(e.__DSH_LINK_WORKBENCH__||e.__DSH_TRANSPORT__&&e.__DSH_TRANSPORT__.ownsHost!==!0)return"remote";if(e.__DSH_TRANSPORT__?.ownsHost===!0)return"owner";let t=e.location;return t?.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(t.hostname)?"owner":"cloud"}var xs=e=>{try{let t=new URL(e);return["http:","https:","dsh-app:"].includes(t.protocol)&&(t.origin===e||t.protocol==="dsh-app:"&&"dsh-app://"+t.host===e)}catch{return!1}},ka=e=>typeof e=="string"?e.trim().slice(0,100):"";function Sa({host:e=globalThis,onChange:t=()=>{},ready:n=!1}={}){let i="",o=!1,a=null,r=e.BenchGoDevices&&typeof e.BenchGoDevices.postMessage=="function",s=e.parent&&e.parent!==e,d=l=>{a=l?{name:l}:null,t(a)},c=l=>{r?e.BenchGoDevices.postMessage(JSON.stringify({type:l})):s&&e.parent.postMessage({type:l},i||"*")},f=l=>{if(r||!s||l.source!==e.parent||!xs(l.origin)||i&&l.origin!==i)return;if(l.data?.type==="dsh-devices:probe"){n&&e.parent.postMessage({type:"dsh-devices:ready"},l.origin);return}if(l.data?.type!=="dsh-devices:init")return;let p=ka(l.data.name);p&&(i=l.origin,d(p))},u=()=>{r&&(d(ka(e.__DSH_DEVICE_NAVIGATION__?.name)),n&&a&&c("dsh-devices:ready"))};return e.addEventListener("message",f),e.addEventListener("dsh-devices:navigation",u),u(),n&&!r&&s&&c("dsh-devices:ready"),{showDevices(){return!a||o?!1:(c("dsh-devices:show"),!0)},dispose(){o||(o=!0,e.removeEventListener("message",f),e.removeEventListener("dsh-devices:navigation",u),n&&(r||s)&&c("dsh-devices:unready"))}}}var Ta=e=>e==="light"||e==="dark"?e:"",Us=e=>e.matchMedia?.("(prefers-color-scheme: dark)").matches?"dark":"light";function Ao(e=globalThis){let t=e.document?.documentElement,n=e.document?.body;return Ta(t?.style?.colorScheme)||Ta(t?.getAttribute?.("data-ds-theme-source"))||(n?.hasAttribute?.("data-ds-dark-theme")?"dark":Us(e))}function za(e,t=globalThis){let n,i=()=>{let r=Ao(t);r!==n&&(n=r,e(r))},o=t.matchMedia?.("(prefers-color-scheme: dark)"),a=t.MutationObserver&&new t.MutationObserver(i);for(let r of[t.document?.documentElement,t.document?.body])r&&a?.observe(r,{attributes:!0,attributeFilter:["style","data-ds-theme-source","data-ds-dark-theme"]});return o?.addEventListener?o.addEventListener("change",i):o?.addListener?.(i),i(),()=>{a?.disconnect(),o?.removeEventListener?o.removeEventListener("change",i):o?.removeListener?.(i)}}var Pl=require("react");var Fa=`.dc-loading-state{display:grid;justify-items:center;align-content:center;gap:20px;min-height:240px;padding:28px;color:inherit;box-sizing:border-box}
.dc-loading-state strong{font-family:inherit;font-size:13px;font-weight:500;line-height:1.5;opacity:.65}
.dc-loading-mark{display:flex;align-items:center;gap:7px;height:32px;color:var(--dc-accent,var(--link-accent,#2c6ee8))}
.dc-loading-mark i{width:6px;height:22px;border-radius:3px;background:currentColor;animation:dc-loading-wave 1.1s ease-in-out infinite}
.dc-loading-mark i:nth-child(2){animation-delay:.15s}.dc-loading-mark i:nth-child(3){animation-delay:.3s}
.dc-loading-preview{display:grid;gap:12px;width:min(360px,100%)}
.dc-loading-preview span{height:12px;border-radius:4px;background:currentColor;opacity:.06;animation:dc-loading-fade 1.6s ease-in-out infinite}
.dc-loading-preview span:nth-child(2){width:80%;animation-delay:.15s}.dc-loading-preview span:nth-child(3){width:58%;animation-delay:.3s}
@keyframes dc-loading-wave{0%,100%{transform:scaleY(.45);opacity:.45}50%{transform:scaleY(1);opacity:1}}
@keyframes dc-loading-fade{50%{opacity:.12}}
@media(prefers-reduced-motion:reduce){.dc-loading-mark i,.dc-loading-preview span{animation:none}}
`;var ft=require("react/jsx-runtime");function jo({label:e="\u6B63\u5728\u52A0\u8F7D\u2026",skeleton:t=!1}){return(0,ft.jsxs)("div",{className:"dc-loading-state",role:"status","aria-live":"polite","aria-busy":"true",children:[(0,ft.jsx)("style",{children:Fa}),(0,ft.jsxs)("span",{className:"dc-loading-mark","aria-hidden":"true",children:[(0,ft.jsx)("i",{}),(0,ft.jsx)("i",{}),(0,ft.jsx)("i",{})]}),(0,ft.jsx)("strong",{children:e}),t&&(0,ft.jsxs)("div",{className:"dc-loading-preview","aria-hidden":"true",children:[(0,ft.jsx)("span",{}),(0,ft.jsx)("span",{}),(0,ft.jsx)("span",{})]})]})}var Qe=require("react/jsx-runtime");function Fn({compact:e=!1,label:t=""}){let[n,i]=(0,Ve.useState)(""),[o,a]=(0,Ve.useState)(!1),[r,s]=(0,Ve.useState)(!1),[d,c]=(0,Ve.useState)(""),f=(0,Ve.useRef)(null),u=(0,Ve.useRef)(null),l=(0,Ve.useRef)(!1),[p,M]=(0,Ve.useState)(null),[D,g]=(0,Ve.useState)(!1),y=(0,Ve.useRef)(null),I=La(),[L,b]=(0,Ve.useState)(!1),[x,F]=(0,Ve.useState)(()=>Ao());(0,Ve.useEffect)(()=>za(F),[]);let _=()=>{n&&u.current?.contentWindow?.postMessage({type:"dsh-devices:theme",theme:x,background:globalThis.getComputedStyle?.(f.current)?.backgroundColor},new URL(n).origin)};(0,Ve.useEffect)(_,[n,x]),(0,Ve.useEffect)(()=>{let Q=Sa({onChange:M,ready:e});return y.current=Q,()=>{Q.dispose(),y.current=null}},[e]),(0,Ve.useEffect)(()=>{f.current&&(o&&!f.current.open?f.current.showModal():!o&&f.current.open&&f.current.close())},[o]),(0,Ve.useEffect)(()=>{if(!n)return;let Q=v=>{v.source!==u.current?.contentWindow||v.origin!==new URL(n).origin||(v.data?.type==="dsh-devices:theme-ready"&&_(),v.data?.type==="dsh-devices:return-local"&&a(!1),v.data?.type==="dsh-devices:workbench-navigation"&&g(v.data.ready===!0))};return window.addEventListener("message",Q),()=>window.removeEventListener("message",Q)},[n,x]);let Z=async()=>{if(!l.current){if(p){y.current?.showDevices();return}if(a(!0),c(""),!n){l.current=!0,s(!0);try{let Q=new URL("/api/commander-devices",location.origin),v=await fetch(Q,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({action:"launch",parentOrigin:location.origin})}),E=await Xe(v,Q);if(E.error)throw new Error(typeof E.error=="string"?E.error:E.error.message||"\u8BBE\u5907\u4E2D\u5FC3\u6682\u65F6\u65E0\u6CD5\u6253\u5F00");let O=new URL(E.url,location.origin),P=O.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(O.hostname),G=O.origin===location.origin&&O.protocol==="https:"&&O.pathname.startsWith("/devices/");if(!(I==="cloud"?G:P||G))throw new Error("\u8BBE\u5907\u4E2D\u5FC3\u5730\u5740\u65E0\u6548");O.searchParams.set("parentOrigin",location.origin),O.searchParams.set("theme",x),i(O.href)}catch(Q){c(Q.message)}finally{l.current=!1,s(!1)}}}};return I==="remote"&&!p?null:(0,Qe.jsxs)(Qe.Fragment,{children:[(0,Qe.jsxs)("button",{type:"button",className:`cmd-search-toggle dsh-device-launcher${e?" dsh-device-launcher-compact":""}`,"aria-label":p?`\u5207\u6362\u8BBE\u5907\uFF1A${p.name}`:"\u8BBE\u5907\u4E2D\u5FC3",title:p?.name||"\u8BBE\u5907\u4E2D\u5FC3","aria-haspopup":p?void 0:"dialog",onClick:Z,children:[(0,Qe.jsx)(te,{name:"link",size:16}),t,e&&(0,Qe.jsx)(te,{name:"chevronDown",size:10})]}),(0,Ba.createPortal)((0,Qe.jsxs)("dialog",{ref:f,className:"dsh-device-dialog","data-theme":x,onCancel:()=>a(!1),onClose:()=>a(!1),children:[(0,Qe.jsx)("style",{children:".dsh-device-dialog{position:fixed;inset:0;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#202020);color-scheme:light}html[data-windows-titlebar] .dsh-device-dialog{top:var(--dsh-windows-titlebar-height,40px);height:calc(100dvh - var(--dsh-windows-titlebar-height,40px))}.dsh-device-dialog::backdrop{background:#10182088}.dsh-device-dialog[open]{display:flex;flex-direction:column}.dsh-device-dialog-header{display:flex;align-items:center;justify-content:flex-start;gap:2px;flex:none;min-height:38px;padding:5px max(14px,env(safe-area-inset-right)) 5px max(14px,env(safe-area-inset-left));border-bottom:1px solid #8883;background:inherit;font-size:12px;line-height:1.5;font-family:inherit}.dsh-device-dialog-header button,.dsh-device-dialog-error button{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;cursor:pointer}.dsh-device-dialog-header button:hover{background:#8882}.dsh-device-dialog-header>button{padding:6px}.dsh-device-dialog iframe{display:block;flex:1;width:100%;min-height:0;border:0}.dsh-device-dialog-error{display:grid;justify-items:center;align-content:center;flex:1;padding:24px;gap:12px;font-size:13px}.dsh-device-dialog-error p{max-width:420px;overflow-wrap:anywhere}.dsh-device-dialog-error button{border:1px solid #8884}.dsh-device-dialog :focus-visible{outline:2px solid #2c6ee8;outline-offset:2px}.dsh-device-dialog-header.dsh-device-dialog-ready{display:none}@media(max-width:767px){.dsh-device-dialog-header.dsh-device-dialog-integrated{display:none}}.dsh-device-dialog[data-theme=dark]{background:var(--dsw-alias-bg-base,#151517);color:var(--dsw-alias-label-primary,#ededed);color-scheme:dark}"}),(0,Qe.jsxs)("header",{className:`dsh-device-dialog-header${L?" dsh-device-dialog-ready":""}${D?" dsh-device-dialog-integrated":""}`,children:[(0,Qe.jsx)("button",{type:"button","aria-label":"\u8FD4\u56DE\u5DE5\u4F5C\u53F0",onClick:()=>a(!1),children:(0,Qe.jsx)(te,{name:"chevronLeft",size:16})}),(0,Qe.jsx)("span",{children:"\u8BBE\u5907\u4E2D\u5FC3"})]}),n?(0,Qe.jsxs)(Qe.Fragment,{children:[(0,Qe.jsx)("div",{hidden:L,children:(0,Qe.jsx)(jo,{label:"\u6B63\u5728\u6253\u5F00\u8BBE\u5907\u4E2D\u5FC3\u2026"})}),(0,Qe.jsx)("iframe",{ref:u,style:L?void 0:{position:"absolute",visibility:"hidden"},src:n,title:"BenchGo\u8BBE\u5907\u4E2D\u5FC3",allow:"clipboard-read; clipboard-write; microphone",referrerPolicy:"no-referrer",onLoad:()=>{b(!0),g(!1),_()}})]}):(0,Qe.jsxs)("div",{className:"dsh-device-dialog-error",children:[!d&&(0,Qe.jsx)(jo,{label:"\u6B63\u5728\u6253\u5F00\u8BBE\u5907\u4E2D\u5FC3\u2026"}),(0,Qe.jsx)("p",{hidden:!d,role:d?"alert":"status",children:d||(r?"\u6B63\u5728\u6253\u5F00\u8BBE\u5907\u4E2D\u5FC3\u2026":"\u51C6\u5907\u6253\u5F00\u8BBE\u5907\u4E2D\u5FC3")}),d&&I!=="remote"&&(0,Qe.jsx)("button",{type:"button",onClick:Z,disabled:r,children:"\u91CD\u8BD5"})]})]}),document.body)]})}var Oa=`.cmd-mobile-workbench { display: none; }
.cmd-shell-frame[data-plus-resizing],
.cmd-shell-frame[data-plus-resizing] * { animation: none !important; transition: none !important; }

/* The same workbench, settings slots and composer on a smaller canvas. */
@media (any-pointer: coarse) {
  /* Includes body portals used by menus and settings in the shared workbench. */
  html { -webkit-tap-highlight-color: transparent; }
  :is(button, a, summary, [role="button"], [tabindex]):not(input, textarea, select, [contenteditable]):focus:not(:focus-visible) {
    outline: none;
  }
}
@media (max-width: 767px) {
  html, body, #root { width: 100%; min-width: 0; overscroll-behavior: none; }
  #root { height: var(--cmd-mobile-viewport-height, 100dvh); }
  .cmd-shell-frame[data-plus-shell] {
    box-sizing: border-box; height: var(--cmd-mobile-viewport-height, 100dvh);
    grid-template-columns: 0 minmax(0, 1fr) 0 !important;
    padding-top: env(safe-area-inset-top, 0px);
    --dsh-frame-top-clearance: 0px; --dsh-frame-leading-clearance: 0px;
    --dsh-frame-chrome-top: 0px; --dsh-frame-overlay-top: 12px;
  }
  .cmd-shell-frame[data-plus-shell] > :first-child {
    position: absolute; inset: calc(44px + env(safe-area-inset-top, 0px)) auto 0 0; z-index: 40;
    width: min(304px, 86vw); max-width: 100%;
    /* The resident title row already includes the top safe area. */
    padding-top: 0; box-sizing: border-box;
    background: var(--dsw-specific-sidebar-fill);
    visibility: visible; transform: translateX(0);
    transition: transform 180ms ease, visibility 180ms;
  }
  .cmd-shell-frame[data-plus-shell][data-sidebar-collapsed] > :first-child {
    visibility: hidden; pointer-events: none; transform: translateX(-100%);
  }
  .cmd-shell-frame[data-plus-shell] > [data-side],
  .cmd-shell-frame[data-plus-shell] > [data-shell-leading] { display: none; }
  .cmd-shell-sidebar { height: 100%; padding-bottom: env(safe-area-inset-bottom, 0px); }
  .cmd-shell-sidebar [class*="logoRow"] { display: none; }
  .cmd-shell-sidebar [class*="topStrip"] { display: none !important; }
  .cmd-shell-sidebar [class*="railMark"] { display: none !important; }
  .cmd-shell-sidebar .cmd-session, .cmd-shell-sidebar [class*="panelRow"],
  .cmd-shell-sidebar .cmd-settings { min-height: 44px; }
  .cmd-shell-sidebar .cmd-settings-row > button { min-height: 44px; }
  .cmd-shell-frame:has(.cmd-projects),
  .cmd-shell-sidebar:has(.cmd-projects),
  .cmd-shell-sidebar:has(.cmd-projects) * { animation: none !important; transition: none !important; }
  .cmd-mobile-workbench:not([hidden]) { display: contents; }
  .cmd-mobile-navigation {
    display: flex; align-items: center; gap: 2px; flex: none;
    min-height: 44px; padding-inline-end: 4px; color: var(--dsw-alias-label-primary);
  }
  .cmd-shell-frame[data-plus-shell]:has(.cmd-mobile-navigation-fallback) {
    padding-top: calc(44px + env(safe-area-inset-top, 0px));
  }
  .cmd-mobile-navigation-fallback {
    position: absolute; z-index: 50; inset: env(safe-area-inset-top, 0px) 0 auto;
    padding-inline: max(6px, env(safe-area-inset-left, 0px));
    background: var(--dsw-alias-bg-base); pointer-events: auto;
  }
  .cmd-mobile-navigation > button,
  .cmd-mobile-device > button {
    display: inline-flex; align-items: center; justify-content: center; flex: none;
    width: 40px; height: 44px; min-width: 0; border: 0; border-radius: 10px; padding: 0;
    background: transparent; color: inherit; cursor: pointer; touch-action: manipulation;
  }
  .cmd-mobile-device { display: flex; align-items: center; min-width: 0; }
  .cmd-mobile-device > button { max-width: 94px; width: auto; padding-inline: 6px; gap: 4px; }
  .cmd-mobile-navigation > button:active,
  .cmd-mobile-device > button:active { background: var(--dsw-alias-interactive-bg-hover); }
  .cmd-mobile-sidebar-icon-open { transform: rotate(180deg); }
  .cmd-mobile-drawer-mask {
    position: absolute; inset: 0; z-index: 1; pointer-events: auto;
    appearance: none; border: 0; padding: 0; background: var(--dsw-alias-bg-mask-1, #0006);
  }
  .cmd-shell-frame > :nth-child(2) { min-width: 0; grid-column: 2; grid-row: 1; }
  .cmd-shell-frame > [data-rightbar-col] { grid-column: 3; grid-row: 1; }
  .cmd-shell-frame [data-conversation-header-leading] { display: flex; min-width: 0; }
  .cmd-shell-frame header:has([data-conversation-header-leading]) {
    position: relative; z-index: 30; padding-block-start: 0;
    padding-inline-start: max(6px, env(safe-area-inset-left, 0px));
    padding-inline-end: max(8px, env(safe-area-inset-right, 0px));
  }
  .cmd-shell-frame header:has([data-conversation-header-leading]) > [class*="titleRow"] {
    min-height: 44px; min-width: 0; padding-inline-start: 0;
  }
  .cmd-shell-frame header [class*="crumbCurrent"] { max-width: 100%; }
  .cmd-shell-frame header [class*="titleCluster"] { min-width: 0; }
  .cmd-shell-frame header [class*="headerUtilities"] { margin-inline-start: 4px; gap: 4px; }
  .cmd-shell-frame [data-conversation-header-corner] { margin-inline-end: 0; }
  .cmd-shell-frame [data-conversation-tabs] { overflow-x: auto; scrollbar-width: none; }
  .cmd-shell-frame [data-conversation-region="composer"] {
    padding-bottom: env(safe-area-inset-bottom, 0px);
    --dsh-composer-side-clearance: 10px;
    --dsh-composer-text-max-height: min(240px, 35dvh);
  }
  /* Only normal input controls: voice calls retain their expanded panel.
     Shrink the text seats, never clip the whole operation group. */
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) > [class*="_row"] {
    flex-wrap: nowrap; gap: 4px; padding-inline: 6px;
    --dsh-composer-model-text-display: block;
  }
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) [class*="_tools"],
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) [class*="_modes"] {
    gap: 2px; min-width: 0; flex: 0 1 auto;
  }
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) [class*="_tools"] { max-width: 36%; }
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) [class*="_modes"] > * { min-width: 0; }
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) [class*="_modes"] button {
    min-width: 0; max-width: 100%; gap: 2px; padding-inline: 2px;
  }
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) [class*="_trailing"] {
    flex: 1 1 0; min-width: 0; gap: 4px;
  }
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) [class*="_standardControls"] {
    flex: 1 1 0; min-width: 0; gap: 2px;
  }
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) [class*="_standardControls"][hidden] { display: none; }
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) .cmd-model-trigger {
    width: 100%; max-width: 100%; flex: 1 1 0; min-width: 0; padding-inline: 2px; gap: 3px;
  }
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) .cmd-model-caption { flex: 1 1 auto; }
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) [class*="_activity"]:has(.voice-activity:not(.voice-expanded)) {
    flex: 0 1 auto; min-width: 90px; max-width: calc(100% - 44px);
  }
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) .voice-activity:not(.voice-expanded) {
    gap: 0; flex: 0 1 auto; min-width: 0;
  }
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) .voice-inline-error,
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) .voice-inline-note {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) .voice-recording-strip { gap: 4px; min-width: 0; padding-inline: 2px; }
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) .voice-recording-pulse { flex-basis: 90px; min-width: 44px; padding-inline: 2px; }
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) [class*="_primary"],
  .cmd-shell-frame [data-composer-card]:not(.voice-call-composer) .voice-icon-button { flex: none; }
  .cmd-shell-frame [contenteditable="true"],
  :is(.cmd-shell-frame, [role="dialog"]) :is(input:not([type="checkbox"]):not([type="radio"]), textarea, select) {
    font-size: max(16px, 1em); min-width: 0; max-width: 100%;
    scroll-margin-block: 60px;
  }
  .cmd-shell-frame [contenteditable="true"] { min-height: 44px; -webkit-user-select: text; user-select: text; }
  .cmd-shell-frame [data-conversation-scroll] { overscroll-behavior-y: contain; }
  /* Portals live outside the frame, so they need their own safe viewport.
     Native Android already consumes insets; browsers publish them through env(). */
  .cmd-settings-overlay {
    inset: 0 0 auto; height: var(--cmd-mobile-viewport-height, 100dvh);
    box-sizing: border-box;
    padding: calc(12px + env(safe-area-inset-top, 0px))
      calc(8px + env(safe-area-inset-right, 0px))
      calc(12px + env(safe-area-inset-bottom, 0px))
      calc(8px + env(safe-area-inset-left, 0px));
  }
  /* The official settings portal becomes a single-column sheet with scrollable tabs. */
  [data-shortcut-modal="settings"][role="dialog"] {
    width: 100%; max-width: 100%; height: 100%; max-height: 100%; min-height: 0;
    flex-direction: column; border-radius: 16px;
  }
  [data-shortcut-modal="settings"] > nav { width: 100%; padding: 16px 12px 8px; gap: 10px; }
  [data-shortcut-modal="settings"] > nav > :first-child { padding-inline: 8px; padding-right: 44px; }
  [data-shortcut-modal="settings"] > nav > :last-child {
    flex-direction: row; flex-wrap: nowrap; overflow: auto; gap: 4px; scrollbar-width: none;
  }
  [data-shortcut-modal="settings"] > nav button { flex: none; height: 44px; padding-inline: 12px; }
  [data-shortcut-modal="settings"] > :last-child { flex: 1; min-height: 0; }
  [data-shortcut-modal="settings"] > :last-child > :first-child {
    height: auto; min-height: 0; padding: 0 12px;
  }
  [data-shortcut-modal="settings"] > :last-child > :first-child > button:last-child {
    position: absolute; top: 6px; right: 6px; width: 44px; height: 44px;
  }
  [data-shortcut-modal="settings"] > :last-child > :last-child { padding: 12px 16px 20px; overscroll-behavior: contain; }
  [data-shortcut-modal="settings"] :is(fieldset, section, form) { min-width: 0; max-width: 100%; }
  [data-shortcut-modal="settings"] :is(h2, h3, p, label) { overflow-wrap: anywhere; }
  [data-shortcut-modal="settings"] .voice-setting-toggle { gap: 12px; }
  [data-shortcut-modal="settings"] .voice-model-actions,
  [data-shortcut-modal="settings"] .voice-settings footer { flex-wrap: wrap; }
  [role="dialog"]:not([aria-label="\u5DE5\u4F5C\u53F0\u5BFC\u822A"]):not([data-shortcut-modal="settings"]) { max-width: calc(100vw - 16px); box-sizing: border-box; }
  [role="menu"], [role="listbox"] { max-width: calc(100vw - 16px); max-height: min(420px, 65dvh); overflow-y: auto; }
}
@media (max-width: 767px) and (prefers-reduced-motion: reduce) {
  .cmd-shell-frame[data-plus-shell] > :first-child { transition: none; }
}
`;function Ra(e,t,n=setTimeout,i=clearTimeout){if(!e||!t)return()=>{};let o=Math.round(e.getBoundingClientRect().width),a,r=new t(s=>{let d=Math.round(s[0]?.contentRect.width??e.getBoundingClientRect().width);d!==o&&(o=d,e.setAttribute("data-plus-resizing",""),a&&i(a),a=n(()=>{a=void 0,e.removeAttribute("data-plus-resizing")},260))});return r.observe(e),()=>{r.disconnect(),a&&i(a),e.removeAttribute("data-plus-resizing")}}var At=require("react/jsx-runtime"),Ya="(max-width: 767px)",Ns='button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';function As({ctx:e}){let t=(0,lt.useRef)(null),n=(0,lt.useRef)(null),[i,o]=(0,lt.useState)(()=>window.matchMedia(Ya).matches),[a,r]=(0,lt.useState)(!1),[s,d]=(0,lt.useState)(null),[c,f]=(0,lt.useState)(null);(0,lt.useEffect)(()=>{let l=window.matchMedia(Ya),p=()=>o(l.matches);return l.addEventListener("change",p),()=>l.removeEventListener("change",p)},[]),(0,lt.useEffect)(()=>{let l=t.current?.closest(".cmd-shell-frame");if(!l)return;let p=()=>f(l.querySelector("[data-cmd-mobile-leading]")),M=new MutationObserver(D=>{D.some(g=>[...g.addedNodes,...g.removedNodes].some(y=>y.nodeType===1&&(y.matches("[data-cmd-mobile-leading]")||y.querySelector("[data-cmd-mobile-leading]"))))&&p()});return M.observe(l,{subtree:!0,childList:!0}),p(),()=>M.disconnect()},[]),(0,lt.useEffect)(()=>{let l=t.current?.closest(".cmd-shell-frame");if(!l)return;d(l.querySelector("[data-shell-overlay]"));let p=()=>r(!l.hasAttribute("data-sidebar-collapsed")),M=new MutationObserver(p);return M.observe(l,{attributes:!0,attributeFilter:["data-sidebar-collapsed"]}),p(),()=>M.disconnect()},[]),(0,lt.useEffect)(()=>{let l=t.current?.closest(".cmd-shell-frame");return Ra(l,window.ResizeObserver)},[]),(0,lt.useEffect)(()=>{if(!i)return;let l=window.visualViewport,p=document.documentElement,M=p.style.getPropertyValue("--cmd-mobile-viewport-height"),D,g=()=>{if(!l||l.scale===1){let y=Math.round(l?.height??window.innerHeight);y!==D&&(D=y,p.style.setProperty("--cmd-mobile-viewport-height",y+"px"))}};return g(),l?.addEventListener("resize",g),window.addEventListener("resize",g),()=>{l?.removeEventListener("resize",g),window.removeEventListener("resize",g),M?p.style.setProperty("--cmd-mobile-viewport-height",M):p.style.removeProperty("--cmd-mobile-viewport-height")}},[i]),(0,lt.useEffect)(()=>{if(!i||!a)return;let l=t.current?.closest(".cmd-shell-frame"),p=l?.querySelector(".cmd-shell-sidebar")?.parentElement;if(!l||!p)return;let M=l.querySelector('[class*="centerCol"]'),g=[l.querySelector("[data-rightbar-col]")].filter(Boolean),y=n.current?.closest(".cmd-mobile-navigation");for(M&&!M.contains(y)&&g.push(M);y&&y!==M&&M?.contains(y);){let v=y.parentElement;g.push(...[...v.children].filter(E=>E!==y)),y=v}let I=g.map(v=>[v,v.inert]);for(let[v]of I)v.inert=!0;let L=["role","aria-modal","aria-label"].map(v=>[v,p.getAttribute(v)]);p.setAttribute("role","dialog"),p.setAttribute("aria-modal","true"),p.setAttribute("aria-label","\u5DE5\u4F5C\u53F0\u5BFC\u822A");let b=()=>{l.hasAttribute("data-sidebar-collapsed")||e.layout.toggleSidebar()},x=()=>[n.current,...p.querySelectorAll(Ns)].filter(v=>v&&!v.closest("[inert]")&&v.getClientRects().length);(x()[1]??x()[0])?.focus({preventScroll:!0});let F=v=>{if([...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some(G=>G!==p&&G.getClientRects().length)||(v.key==="Escape"&&(v.preventDefault(),v.stopPropagation(),b()),v.key!=="Tab"))return;let E=x(),O=E[0],P=E.at(-1);if(!O){v.preventDefault();return}v.shiftKey&&(document.activeElement===O||!E.includes(document.activeElement))?(v.preventDefault(),P.focus()):!v.shiftKey&&(document.activeElement===P||!E.includes(document.activeElement))&&(v.preventDefault(),O.focus())},_,Z=()=>{_!==void 0&&cancelAnimationFrame(_),_=requestAnimationFrame(()=>{_=void 0,b()})},Q=v=>{let E=v.target.closest?.("button, a");E&&(E.matches('.cmd-settings, .cmd-session, .cmd-new-chat, .cmd-project-new, [class*="newSession"]')||E.closest('[class*="panelList"]'))&&Z()};return document.addEventListener("keydown",F,!0),p.addEventListener("click",Q),()=>{_!==void 0&&cancelAnimationFrame(_);let v=p.contains(document.activeElement)||document.activeElement===document.body;document.removeEventListener("keydown",F,!0),p.removeEventListener("click",Q);for(let[E,O]of I)E.inert=O;for(let[E,O]of L)O===null?p.removeAttribute(E):p.setAttribute(E,O);v&&n.current?.focus({preventScroll:!0})}},[e,i,a,c]);let u=i&&(0,At.jsxs)("div",{className:"cmd-mobile-navigation"+(c?"":" cmd-mobile-navigation-fallback"),children:[(0,At.jsx)("button",{ref:n,type:"button","aria-label":a?"\u6536\u8D77\u4FA7\u8FB9\u680F":"\u6253\u5F00\u4FA7\u8FB9\u680F","aria-expanded":a,"aria-haspopup":"dialog",onClick:()=>e.layout.toggleSidebar(),children:(0,At.jsx)(te,{name:"collapse",className:a?"":"cmd-mobile-sidebar-icon-open",size:21})}),(0,At.jsx)("div",{className:"cmd-mobile-device",inert:a?"":void 0,children:(0,At.jsx)(Fn,{compact:!0})})]});return(0,At.jsxs)("div",{ref:t,className:"cmd-mobile-workbench",hidden:!i,children:[c?(0,Co.createPortal)(u,c):u,i&&a&&s&&(0,Co.createPortal)((0,At.jsx)("button",{type:"button",className:"cmd-mobile-drawer-mask","aria-label":"\u5173\u95ED\u4FA7\u8FB9\u680F",tabIndex:-1,onClick:()=>e.layout.toggleSidebar()}),s)]})}function Pa(e){let t=document.createElement("style");t.dataset.commanderMobileWorkbench="",t.textContent=Oa,document.head.append(t),e.effect(()=>()=>t.remove()),e.slots.inject("conversation.header.leading",()=>e.slots.register({name:"conversation.header.leading",id:"commander-mobile-navigation",priority:-10},()=>(0,At.jsx)("div",{"data-cmd-mobile-leading":""}))),e.slots.inject("shell.overlay",()=>e.slots.register({name:"shell.overlay",id:"commander-mobile-workbench",order:-100,inject:()=>({ctx:e})},As))}var ot=Mo(require("react"),1),Rt=require("@deepseek-ai/dsh-client-ui-primitives");var Qa=`.cmd-usage-modal{width:min(824px,calc(100vw - 32px))!important;max-width:calc(100vw - 32px)}.cmd-usage{width:min(760px,calc(100vw - 64px));max-height:75vh;overflow:auto;scrollbar-width:none;color:var(--ds-fg-primary,#242424)}.cmd-usage::-webkit-scrollbar,.cmd-usage-history::-webkit-scrollbar{display:none}.cmd-usage-toolbar{display:flex;align-items:center;gap:12px;justify-content:space-between;margin-bottom:18px}.cmd-usage-presets{display:flex;gap:3px;background:#8881;padding:3px;border-radius:7px;flex-wrap:wrap}.cmd-usage button{font:inherit;cursor:pointer}.cmd-usage-presets button,.cmd-usage-refresh{border:0;background:transparent;padding:6px 10px;border-radius:5px;font-size:12px;color:inherit}.cmd-usage-presets button[data-selected=true]{background:var(--ds-bg-elevated,#fff);box-shadow:0 1px 3px #0001}.cmd-usage-refresh{color:#888}.cmd-usage-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.cmd-usage-metric{padding:14px;border:1px solid #8882;border-radius:8px;display:flex;flex-direction:column;gap:10px}.cmd-usage-metric small{font-size:11px;color:#888}.cmd-usage-metric strong{font-size:17px;font-weight:550;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.cmd-usage-note{font-size:11px;color:#888;line-height:1.8;margin:12px 0 22px}.cmd-usage h3{font-size:12px;font-weight:550;margin:20px 0 12px}.cmd-usage h3 span{color:#999;font-weight:400;margin-left:6px}.cmd-usage-table-wrap{overflow-x:auto;scrollbar-width:none}.cmd-usage table{width:100%;border-collapse:collapse;font-size:11px;text-align:right;white-space:nowrap}.cmd-usage th{color:#888;font-weight:400;padding:8px 10px;border-bottom:1px solid #8882}.cmd-usage td{padding:12px 10px;border-bottom:1px solid #8881;font-variant-numeric:tabular-nums}.cmd-usage th:first-child,.cmd-usage td:first-child{text-align:left;padding-left:0}.cmd-usage td strong{font-weight:500}.cmd-usage td small{display:block;color:#999;font-size:10px;max-width:190px;overflow:hidden;text-overflow:ellipsis;margin-top:4px}.cmd-usage-empty{text-align:center;padding:30px;color:#999;font-size:12px}.cmd-usage-dates{display:flex;align-items:flex-end;gap:12px;margin-bottom:16px;font-size:11px;color:#888}.cmd-usage-dates label{display:flex;flex-direction:column;gap:6px}.cmd-usage-dates input{background:transparent;color:inherit;border:1px solid #8883;border-radius:5px;padding:7px;font:inherit}.cmd-usage-dates>span{padding-bottom:8px}@media(max-width:640px){.cmd-usage-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.cmd-usage-toolbar{align-items:flex-start}.cmd-usage-presets button{padding:6px 7px}.cmd-usage-record>div:first-child span{max-width:180px;overflow:hidden;text-overflow:ellipsis}}

.cmd-usage-bars{display:flex;align-items:flex-end;justify-content:center;gap:3px;width:16px;height:16px;padding:1px;box-sizing:border-box}.cmd-usage-bars i{width:3px;border-radius:1px;background:currentColor}.cmd-usage-bars i:nth-child(1){height:5px}.cmd-usage-bars i:nth-child(2){height:9px}.cmd-usage-bars i:nth-child(3){height:14px}
.cmd-usage-toolbar-right{display:flex;align-items:center;gap:8px;margin-left:auto;flex-shrink:0}.cmd-usage-segment{position:relative;isolation:isolate;display:grid;grid-template-columns:1fr 1fr;width:200px;padding:3px;background:var(--dsw-alias-interactive-bg-hover,#8881);border-radius:10px}.cmd-usage-segment-thumb{position:absolute;z-index:-1;inset:3px auto 3px 3px;width:calc(50% - 3px);background:var(--dsw-alias-background-l1,#fff);box-shadow:0 1px 4px #00000012;border-radius:7px;transition:transform 430ms cubic-bezier(.34,1.56,.5,1)}.cmd-usage-segment[data-view=history] .cmd-usage-segment-thumb{transform:translateX(100%)}.cmd-usage-segment button{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#888);font-size:11px;white-space:nowrap;padding:7px 4px;border-radius:7px;transition:color 180ms}.cmd-usage-segment button[aria-selected=true]{color:var(--dsw-alias-label-primary,inherit)}.cmd-usage-refresh{display:grid;place-items:center;width:30px;height:30px;padding:0!important;border-radius:8px}.cmd-usage-refresh:hover{background:#8881}.cmd-usage-refresh[aria-busy=true] svg{animation:cmd-usage-spin 1s linear infinite}.cmd-usage-panel:not([hidden]){animation:cmd-usage-enter 260ms ease both}.cmd-usage-panel[hidden]{display:none}@keyframes cmd-usage-spin{to{transform:rotate(360deg)}}@keyframes cmd-usage-enter{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}@media(max-width:720px){.cmd-usage-toolbar{flex-wrap:wrap}.cmd-usage-toolbar-right{margin-left:0;justify-content:flex-end;width:100%}}@media(prefers-reduced-motion:reduce){.cmd-usage-segment-thumb{transition:none}.cmd-usage-panel:not([hidden]),.cmd-usage-refresh[aria-busy=true] svg{animation:none}}

.cmd-usage-modal{width:min(1100px,calc(100vw - 32px))!important}.cmd-usage{width:100%}.cmd-usage-history-table{max-height:49vh;overflow:auto}.cmd-usage-history-table table{font-size:13px;line-height:1.5}.cmd-usage-history-table th{position:sticky;top:0;z-index:1;padding:12px 14px;background:var(--dsw-alias-bg-base,#fff);font-size:12px}.cmd-usage-history-table td{padding:15px 14px}.cmd-usage-history-table tr:hover td{background:var(--dsw-alias-interactive-bg-hover,#8881)}.cmd-usage-history-table th:first-child,.cmd-usage-history-table td:first-child{padding-left:10px}.cmd-usage-history-table th:nth-child(-n+3),.cmd-usage-history-table td:nth-child(-n+3){text-align:left}.cmd-usage-model-cell{min-width:140px;max-width:240px;white-space:normal;overflow-wrap:anywhere}.cmd-usage-total-cell{font-weight:600}.cmd-usage-pagination{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0 4px;color:var(--dsw-alias-label-secondary,#888);font-size:12px}.cmd-usage-pagination>div{display:flex;align-items:center;gap:12px;font-variant-numeric:tabular-nums}.cmd-usage-pagination button{display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,#8881);color:inherit}.cmd-usage-pagination button:disabled{opacity:.35;cursor:default}.cmd-page-next{transform:rotate(180deg)}
.cmd-usage-charts{--cmd-chart-accent:var(--dsw-alias-state-business-primary,#4d6bfe);border-block:1px solid #8882;padding:16px 0}.cmd-usage-chart-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.cmd-usage .cmd-usage-chart-heading h3{margin:0}.cmd-usage-chart-heading>span,.cmd-usage-chart-note{font-size:11px;color:var(--dsw-alias-label-secondary,#888)}.cmd-usage-chart{margin:20px 0 0;min-width:0}.cmd-usage-chart figcaption{font-size:11px;font-weight:500;margin-bottom:10px}.cmd-usage-chart-scroll{overflow-x:auto;scrollbar-width:thin;border-radius:4px}.cmd-usage-chart svg{display:block;width:100%;height:240px;overflow:visible}.cmd-usage-chart-axis{fill:var(--dsw-alias-label-secondary,#888);font-size:10px;font-variant-numeric:tabular-nums}.cmd-usage-chart-axis line{stroke:currentColor;stroke-opacity:.12;stroke-dasharray:3 4}.cmd-usage-chart-bar{fill:var(--cmd-chart-accent)}.cmd-usage-chart-line{fill:none;stroke:currentColor;stroke-width:2;pointer-events:none;vector-effect:non-scaling-stroke}.cmd-usage-chart-point{fill:var(--dsw-alias-background-l1,#fff);stroke:currentColor;stroke-width:2;pointer-events:none}.cmd-usage-chart-legend{display:flex;align-items:center;gap:20px;flex-wrap:wrap}.cmd-usage-chart-legend>span{display:inline-flex;align-items:center;gap:6px}.cmd-usage-chart-legend i{display:inline-block;flex:none;width:12px}.cmd-usage-chart-token-key{height:8px;border-radius:2px;background:var(--cmd-chart-accent)}.cmd-usage-chart-call-key{height:0;border-top:2px solid currentColor}.cmd-usage-chart-hit{fill:transparent}.cmd-usage-chart-column:hover .cmd-usage-chart-hit,.cmd-usage-chart-column:focus .cmd-usage-chart-hit{fill:currentColor;fill-opacity:.06}.cmd-usage-chart-column:focus{outline:none}.cmd-usage-chart-column:focus .cmd-usage-chart-hit{stroke:var(--cmd-chart-accent);stroke-width:1}.cmd-usage-chart-missing{stroke:currentColor;stroke-width:2;fill:none}.cmd-usage-chart-tick{fill:var(--dsw-alias-label-secondary,#888);font-size:10px;font-variant-numeric:tabular-nums}.cmd-usage-chart-note{line-height:1.8;margin:12px 0 0}.cmd-usage-chart-scroll:focus-visible{outline:2px solid var(--cmd-chart-accent);outline-offset:3px}
.cmd-usage-groups{display:grid;grid-template-columns:minmax(180px,.72fr) minmax(0,1.8fr);gap:18px;align-items:center;padding:14px;border:1px solid #8882;border-radius:10px}.cmd-usage-pie-panel{display:flex;flex-direction:column;align-items:center;gap:12px}.cmd-usage-pie{display:grid;place-items:center;width:148px;height:148px;border-radius:50%;position:relative}.cmd-usage-pie::after{content:'';position:absolute;inset:25px;border-radius:50%;background:var(--ds-bg-elevated,#fff)}.cmd-usage-pie>span{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;font-size:17px;font-weight:600}.cmd-usage-pie small{font-size:10px;font-weight:400;opacity:.55}.cmd-usage-pie-legend{display:grid;gap:5px;width:100%;font-size:11px}.cmd-usage-pie-legend span{display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cmd-usage-pie-legend i{width:8px;height:8px;border-radius:50%;flex:none}.cmd-usage-groups .cmd-usage-table-wrap{min-width:0}@media(max-width:640px){.cmd-usage-groups{grid-template-columns:1fr}.cmd-usage-pie-panel{max-width:220px;margin:auto}}
`;var _a=`.cmd-usage { color: var(--dsw-alias-label-primary, #242424); }
.cmd-usage :is(.cmd-usage-refresh, .cmd-usage-metric small, .cmd-usage-note, .cmd-usage h3 span, .cmd-usage th, .cmd-usage td small, .cmd-usage-empty, .cmd-usage-dates, .cmd-usage-pagination) {
  color: var(--dsw-alias-label-secondary, #818181);
}
.cmd-usage-presets,
.cmd-usage-segment { background: var(--dsw-alias-interactive-bg-hover, #8881); }
.cmd-usage-presets button[data-selected="true"],
.cmd-usage-segment-thumb { background: var(--dsw-alias-bg-layer-1, #fff); }
.cmd-usage-chart-point { fill: var(--dsw-alias-bg-layer-1, #fff); }
.cmd-usage-metric { border-color: var(--dsw-alias-border-l2, #8882); }
.cmd-usage th,
.cmd-usage td,
.cmd-usage-charts { border-color: var(--dsw-alias-border-l2, #8882); }
.cmd-usage-history-table th { background: var(--dsw-alias-bg-base, #fff); }
.cmd-usage-refresh:hover,
.cmd-usage-history-table tr:hover td { background: var(--dsw-alias-interactive-bg-hover, #8881); }
`;function ct(e){if(e==null||!Number.isFinite(Number(e)))return"\u672A\u63D0\u4F9B";let t=Number(e),n=Math.abs(t);return n>=1e9?(t/1e9).toFixed(2)+"B":n>=1e6?(t/1e6).toFixed(2)+"M":new Intl.NumberFormat("zh-CN",{maximumFractionDigits:0}).format(t)}var lc=require("react");var Ee=require("react/jsx-runtime"),Ha={hour:"\u5C0F\u65F6",day:"\u5929",month:"\u6708",year:"\u5E74"},pn=e=>new Intl.NumberFormat("zh-CN").format(e);function Za(e,t,n=!1){return t.interval==="hour"?new Date(e.time).toLocaleTimeString("zh-CN",{timeZone:t.timeZone,hour:"2-digit",minute:"2-digit",...n?{timeZoneName:"short"}:{}}):n||t.interval!=="day"?e.time:e.time.slice(5)}function Ga({timeline:e}){let t=e?.buckets||[],n=t.reduce((i,o)=>i+o.calls,0);return(0,Ee.jsxs)("section",{className:"cmd-usage-charts","aria-label":"\u6570\u636E\u56FE\u8868",children:[(0,Ee.jsxs)("div",{className:"cmd-usage-chart-heading",children:[(0,Ee.jsx)("h3",{children:"\u6570\u636E\u56FE\u8868"}),e&&(0,Ee.jsxs)("span",{children:["\u6309",Ha[e.interval],"\u6C47\u603B \xB7 \u5171 ",pn(n)," \u6761\u8BB0\u5F55"]})]}),e?n?(0,Ee.jsx)(Ee.Fragment,{children:(0,Ee.jsx)(Is,{timeline:e})}):(0,Ee.jsx)("div",{className:"cmd-usage-empty",children:"\u8FD9\u4E2A\u65F6\u95F4\u6BB5\u8FD8\u6CA1\u6709\u7528\u91CF\u8BB0\u5F55"}):(0,Ee.jsx)("div",{className:"cmd-usage-empty",children:"\u56FE\u8868\u6570\u636E\u6682\u672A\u63D0\u4F9B\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5"})]})}function Is({timeline:e}){let{buckets:t}=e,n=Math.max(1,...t.map(g=>g.totalTokens??0)),i=Math.ceil(Math.max(1,...t.map(g=>g.calls))/2)*2,o=Math.max(680,t.length*12+120),a=240,r=64,s=56,d=24,c=174,u=(o-r-s)/t.length,l=Math.max(2,Math.min(24,u*.6)),p=Math.max(1,Math.ceil((t.length-1)/6)),M=t.map((g,y)=>({x:r+u*(y+.5),y:d+c*(1-g.calls/i)})),D=M.map(({x:g,y},I)=>(I?"L":"M")+g+","+y).join(" ");return(0,Ee.jsxs)("figure",{className:"cmd-usage-chart",children:[(0,Ee.jsxs)("figcaption",{className:"cmd-usage-chart-legend",children:[(0,Ee.jsxs)("span",{children:[(0,Ee.jsx)("i",{className:"cmd-usage-chart-token-key","aria-hidden":"true"}),"Token \u7528\u91CF \xB7 \u5DE6\u8F74"]}),(0,Ee.jsxs)("span",{children:[(0,Ee.jsx)("i",{className:"cmd-usage-chart-call-key","aria-hidden":"true"}),"\u8BB0\u5F55\u6570\u91CF \xB7 \u53F3\u8F74"]})]}),(0,Ee.jsx)("div",{className:"cmd-usage-chart-scroll",tabIndex:0,role:"region","aria-label":"Token \u7528\u91CF\u4E0E\u8BB0\u5F55\u6570\u91CF\u65F6\u95F4\u56FE\u8868\uFF0C\u53EF\u6A2A\u5411\u6EDA\u52A8",children:(0,Ee.jsxs)("svg",{viewBox:"0 0 "+o+" "+a,style:{minWidth:o},role:"group","aria-label":"Token \u7528\u91CF\u67F1\u5F62\u4E0E\u8BB0\u5F55\u6570\u91CF\u6298\u7EBF\uFF0C\u6309"+Ha[e.interval]+"\u6C47\u603B",children:[[0,.5,1].map(g=>{let y=d+c*(1-g);return(0,Ee.jsxs)("g",{className:"cmd-usage-chart-axis",children:[(0,Ee.jsx)("line",{x1:r,x2:o-s,y1:y,y2:y}),(0,Ee.jsx)("text",{x:r-8,y:y+4,textAnchor:"end","aria-label":"Token \u7528\u91CF "+ct(n*g),children:ct(n*g)}),(0,Ee.jsx)("text",{x:o-s+8,y:y+4,textAnchor:"start","aria-label":"\u8BB0\u5F55\u6570\u91CF "+pn(i*g),children:pn(i*g)})]},g)}),t.map((g,y)=>{let I=g.measuredCalls<g.calls,L=Za(g,e,!0)+"\uFF1A"+pn(g.calls)+" \u6761\u8BB0\u5F55\uFF0C"+(I?"\u5DF2\u77E5 Token ":"Token ")+ct(g.totalTokens)+(I?"\uFF0C"+pn(g.calls-g.measuredCalls)+" \u6761\u672A\u63D0\u4F9B":""),{x:b,y:x}=M[y],F=(g.totalTokens??0)/n*c;return(0,Ee.jsxs)("g",{className:"cmd-usage-chart-column",tabIndex:0,role:"img","aria-label":L,children:[(0,Ee.jsx)("title",{children:L}),(0,Ee.jsx)("rect",{className:"cmd-usage-chart-hit",x:b-u/2,y:d,width:u,height:c}),(0,Ee.jsx)("rect",{className:"cmd-usage-chart-bar",x:b-l/2,y:d+c-F,width:l,height:F,rx:2}),I&&(0,Ee.jsx)("path",{className:"cmd-usage-chart-missing",d:"M"+(b-3)+","+(d+c-Math.max(F,4)-5)+"l6,-6"}),(0,Ee.jsx)("circle",{className:"cmd-usage-chart-point",cx:b,cy:x,r:3}),(y%p===0||y===t.length-1)&&(0,Ee.jsx)("text",{className:"cmd-usage-chart-tick",x:b,y:a-12,textAnchor:"middle",children:Za(g,e)})]},g.time)}),(0,Ee.jsx)("path",{className:"cmd-usage-chart-line",d:D,"aria-hidden":"true"})]})})]})}var z=require("react/jsx-runtime"),Io={codex:"Codex",claude:"Claude Code",pi:"Pi",opencode:"OpenCode",gemini:"Gemini CLI",hermes:"Hermes",grok:"Grok Build",mcode:"MiniMax Code",harness:"Harness"},Es={harness:"Harness \u4F1A\u8BDD","official-harness":"Harness \u4F1A\u8BDD",commander:"BenchGo","commander-native":"BenchGo","native-history":"\u672C\u673A\u5DE5\u5177\u65E5\u5FD7",machine:"\u672C\u673A\u5DE5\u5177\u65E5\u5FD7"},Ja=e=>e==null?"\u672A\u63D0\u4F9B":new Intl.NumberFormat("zh-CN",{maximumFractionDigits:1}).format(e),Wa=e=>{let t=new Date(e);return[t.getFullYear(),String(t.getMonth()+1).padStart(2,"0"),String(t.getDate()).padStart(2,"0")].join("-")};function Va(e){let t=new Date;t.setHours(0,0,0,0);let n=new Date(t);return n.setDate(n.getDate()-e+1),{start:Wa(n),end:Wa(t)}}var Bn=["#4d6bfe","#10b981","#f59e0b","#ec4899","#8b5cf6","#06b6d4"];function ks({groups:e}){let t=e.reduce((o,a)=>o+(a.totalTokens||0),0),n=0,i=e.map((o,a)=>{let r=n;return n+=t?(o.totalTokens||0)/t*360:0,`${Bn[a%Bn.length]} ${r}deg ${n}deg`}).join(", ");return(0,z.jsxs)("div",{className:"cmd-usage-groups",children:[(0,z.jsxs)("div",{className:"cmd-usage-pie-panel",children:[(0,z.jsx)("div",{className:"cmd-usage-pie",style:{background:t?`conic-gradient(${i})`:"color-mix(in srgb,currentColor 10%,transparent)"},role:"img","aria-label":"\u5DE5\u5177\u4E0E\u6A21\u578B Token \u5360\u6BD4",children:(0,z.jsxs)("span",{children:[ct(t),(0,z.jsx)("small",{children:"Token"})]})}),(0,z.jsx)("div",{className:"cmd-usage-pie-legend",children:e.slice(0,6).map((o,a)=>(0,z.jsxs)("span",{children:[(0,z.jsx)("i",{style:{background:Bn[a%Bn.length]}}),Io[o.tool]||o.tool]},JSON.stringify([o.tool,o.model])))})]}),(0,z.jsxs)("div",{className:"cmd-usage-table-wrap",children:[(0,z.jsxs)("table",{children:[(0,z.jsx)("thead",{children:(0,z.jsxs)("tr",{children:[(0,z.jsx)("th",{children:"\u5DE5\u5177 / \u6A21\u578B"}),(0,z.jsx)("th",{children:"\u8BB0\u5F55"}),(0,z.jsx)("th",{children:"Token"}),(0,z.jsx)("th",{children:"\u7F13\u5B58\u8BFB\u53D6"}),(0,z.jsx)("th",{children:"\u547D\u4E2D\u7387"}),(0,z.jsx)("th",{children:"Tokens/s"})]})}),(0,z.jsx)("tbody",{children:e.map(o=>(0,z.jsxs)("tr",{children:[(0,z.jsxs)("td",{children:[(0,z.jsx)("strong",{children:Io[o.tool]||o.tool}),(0,z.jsx)("small",{children:o.model||"\u6A21\u578B\u672A\u63D0\u4F9B"})]}),(0,z.jsx)("td",{children:o.calls}),(0,z.jsx)("td",{children:ct(o.totalTokens)}),(0,z.jsx)("td",{children:ct(o.cacheReadTokens)}),(0,z.jsx)("td",{children:o.cacheHitRate===null?"\u672A\u63D0\u4F9B":(o.cacheHitRate*100).toFixed(1)+"%"}),(0,z.jsx)("td",{children:Ja(o.tokensPerSecond)})]},JSON.stringify([o.tool,o.model])))})]}),!e.length&&(0,z.jsx)("div",{className:"cmd-usage-empty",children:"\u8FD9\u4E2A\u65F6\u95F4\u6BB5\u8FD8\u6CA1\u6709\u7528\u91CF\u8BB0\u5F55"})]})]})}function Ka(){return(0,z.jsx)(Rt.Tooltip,{label:"\u7528\u91CF\u7EDF\u8BA1",side:"top",gap:10,delayMs:450,portal:!0,children:(0,z.jsx)("button",{type:"button",className:"cmd-archive-launcher","aria-label":"\u7528\u91CF\u7EDF\u8BA1","aria-haspopup":"dialog",onClick:()=>document.dispatchEvent(new Event("commander:usage")),children:(0,z.jsxs)("span",{className:"cmd-usage-bars","aria-hidden":"true",children:[(0,z.jsx)("i",{}),(0,z.jsx)("i",{}),(0,z.jsx)("i",{})]})})})}function Xa(e){let t=document.createElement("style");t.textContent=Qa+_a,document.head.append(t),e.effect(()=>()=>t.remove())}function qa(){let[e,t]=(0,ot.useState)("overview"),[n,i]=(0,ot.useState)(1),o=50,[a,r]=(0,ot.useState)(!1),[s,d]=(0,ot.useState)(1),[c,f]=(0,ot.useState)(()=>Va(1)),[u,l]=(0,ot.useState)(null),[p,M]=(0,ot.useState)(""),[D,g]=(0,ot.useState)(!1),[y,I]=(0,ot.useState)(0),L=ot.default.useRef(!1);return(0,ot.useEffect)(()=>{i(1)},[c.start,c.end]),(0,ot.useEffect)(()=>{let b=()=>r(!0);return document.addEventListener("commander:usage",b),()=>document.removeEventListener("commander:usage",b)},[]),(0,ot.useEffect)(()=>{if(!a)return;let b=new AbortController,x=new Date(c.start+"T00:00:00"),F=new Date(c.end+"T00:00:00");if(F.setDate(F.getDate()+1),!Number.isFinite(+x)||!Number.isFinite(+F)||F<=x){M("\u8BF7\u9009\u62E9\u6709\u6548\u8D77\u6B62\u65E5\u671F"),l(null);return}g(!0),M("");let _=L.current;return L.current=!1,fetch(new URL("api/commander/usage",document.baseURI),{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({start:x.toISOString(),end:F.toISOString(),page:n,pageSize:o,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,..._?{refresh:!0}:{}}),signal:b.signal}).then(async Z=>{let Q=await Xe(Z,new URL("api/commander/usage",document.baseURI));b.signal.aborted||(l(Q),Q.error&&M(Q.error))}).catch(Z=>{b.signal.aborted||(M(Z.message),l(null))}).finally(()=>{b.signal.aborted||g(!1)}),()=>b.abort()},[a,c.start,c.end,y,n]),(0,z.jsx)(Rt.Modal,{className:"cmd-usage-modal",open:a,onClose:()=>r(!1),title:"\u7528\u91CF\u7EDF\u8BA1",closeLabel:"\u5173\u95ED",description:"\u6309\u5DE5\u5177\u548C\u6A21\u578B\u67E5\u770B\u771F\u5B9E\u7528\u91CF",children:(0,z.jsxs)("div",{className:"cmd-usage",children:[(0,z.jsxs)("div",{className:"cmd-usage-toolbar",children:[(0,z.jsxs)("div",{className:"cmd-usage-presets",children:[[1,3,7,15,30].map(b=>(0,z.jsx)("button",{type:"button","data-selected":s===b,onClick:()=>{d(b),f(Va(b))},children:b===1?"\u4ECA\u5929":b+" \u5929"},b)),(0,z.jsx)("button",{type:"button","data-selected":s===null,onClick:()=>d(null),children:"\u81EA\u5B9A\u4E49"})]}),(0,z.jsxs)("div",{className:"cmd-usage-toolbar-right",children:[(0,z.jsxs)("div",{className:"cmd-usage-segment",role:"tablist","aria-label":"\u7528\u91CF\u89C6\u56FE","data-view":e,children:[(0,z.jsx)("span",{className:"cmd-usage-segment-thumb","aria-hidden":"true"}),[["overview","\u6982\u89C8"],["history","\u8BE6\u7EC6\u4F7F\u7528\u8BB0\u5F55"]].map(([b,x])=>(0,z.jsx)("button",{id:"usage-tab-"+b,type:"button",role:"tab","aria-selected":e===b,"aria-controls":"usage-panel-"+b,onClick:()=>t(b),children:x},b))]}),(0,z.jsx)(Rt.Tooltip,{label:"\u5237\u65B0",portal:!0,children:(0,z.jsx)("button",{type:"button",className:"cmd-usage-refresh","aria-label":"\u5237\u65B0\u7528\u91CF\u7EDF\u8BA1","aria-busy":D,disabled:D,onClick:()=>{L.current=!0,I(b=>b+1)},children:(0,z.jsx)(Rt.IconRefreshOutlineRegular,{size:16})})})]})]}),s===null&&(0,z.jsxs)("div",{className:"cmd-usage-dates",children:[(0,z.jsxs)("label",{children:["\u8D77\u59CB\u65E5\u671F",(0,z.jsx)("input",{type:"date",value:c.start,max:c.end,onChange:b=>f(x=>({...x,start:b.target.value}))})]}),(0,z.jsx)("span",{children:"\u81F3"}),(0,z.jsxs)("label",{children:["\u7ED3\u675F\u65E5\u671F",(0,z.jsx)("input",{type:"date",value:c.end,min:c.start,onChange:b=>f(x=>({...x,end:b.target.value}))})]})]}),p&&(0,z.jsx)("div",{role:"alert",className:"cmd-error",children:p}),u&&(0,z.jsxs)(z.Fragment,{children:[(0,z.jsxs)("div",{role:"tabpanel",id:"usage-panel-overview","aria-labelledby":"usage-tab-overview",hidden:e!=="overview",className:"cmd-usage-panel",children:[(0,z.jsxs)("div",{className:"cmd-usage-cards",children:[(0,z.jsx)(On,{label:"Token \u603B\u8BA1",value:ct(u.summary.totalTokens)}),(0,z.jsx)(On,{label:"\u8F93\u5165 / \u8F93\u51FA",value:ct(u.summary.inputTokens)+" / "+ct(u.summary.outputTokens)}),(0,z.jsx)(On,{label:"\u7F13\u5B58\u547D\u4E2D",value:u.summary.cacheHitRate===null?"\u672A\u63D0\u4F9B":(u.summary.cacheHitRate*100).toFixed(1)+"%"}),(0,z.jsx)(On,{label:"Tokens / \u79D2",value:Ja(u.summary.tokensPerSecond)})]}),(0,z.jsx)(Ga,{timeline:u.timeline}),(0,z.jsx)("h3",{children:"\u5DE5\u5177\u4E0E\u6A21\u578B"}),(0,z.jsx)(ks,{groups:u.groups})]}),(0,z.jsxs)("div",{role:"tabpanel",id:"usage-panel-history","aria-labelledby":"usage-tab-history",hidden:e!=="history",className:"cmd-usage-panel",children:[(0,z.jsx)("h3",{children:"\u4F7F\u7528\u8BB0\u5F55"}),(0,z.jsxs)("div",{className:"cmd-usage-table-wrap cmd-usage-history-table",children:[(0,z.jsxs)("table",{"aria-label":"\u8BE6\u7EC6\u4F7F\u7528\u8BB0\u5F55",children:[(0,z.jsx)("thead",{children:(0,z.jsxs)("tr",{children:[(0,z.jsx)("th",{children:"\u65F6\u95F4"}),(0,z.jsx)("th",{children:"\u5DE5\u5177"}),(0,z.jsx)("th",{children:"\u6A21\u578B"}),(0,z.jsx)("th",{children:"\u8F93\u5165"}),(0,z.jsx)("th",{children:"\u8F93\u51FA"}),(0,z.jsx)("th",{children:"\u603B Token"}),(0,z.jsx)("th",{children:"\u7F13\u5B58\u8BFB\u53D6"}),(0,z.jsx)("th",{children:"\u72B6\u6001"}),(0,z.jsx)("th",{children:"\u6765\u6E90"})]})}),(0,z.jsx)("tbody",{children:u.records.map(b=>(0,z.jsxs)("tr",{children:[(0,z.jsx)("td",{children:new Date(b.time).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"})}),(0,z.jsx)("td",{children:Io[b.tool]||b.tool}),(0,z.jsx)("td",{className:"cmd-usage-model-cell",children:b.model||"\u672A\u63D0\u4F9B"}),(0,z.jsx)("td",{children:ct(b.inputTokens)}),(0,z.jsx)("td",{children:ct(b.outputTokens)}),(0,z.jsx)("td",{className:"cmd-usage-total-cell",children:ct(b.totalTokens)}),(0,z.jsx)("td",{children:ct(b.cacheReadTokens)}),(0,z.jsx)("td",{children:{completed:"\u5B8C\u6210",idle:"\u5C31\u7EEA",running:"\u8FD0\u884C\u4E2D",failed:"\u5931\u8D25",cancelled:"\u5DF2\u505C\u6B62",error:"\u5931\u8D25"}[b.status]||b.status||"\u672A\u63D0\u4F9B"}),(0,z.jsx)("td",{children:Es[b.source]||b.source||"\u672A\u6807\u6CE8"})]},b.id))})]}),!u.records.length&&(0,z.jsx)("div",{className:"cmd-usage-empty",children:"\u8FD9\u4E2A\u65F6\u95F4\u6BB5\u8FD8\u6CA1\u6709\u4F7F\u7528\u8BB0\u5F55"})]}),(0,z.jsxs)("nav",{className:"cmd-usage-pagination","aria-label":"\u4F7F\u7528\u8BB0\u5F55\u5206\u9875",children:[(0,z.jsx)("span",{}),(0,z.jsxs)("div",{children:[(0,z.jsx)("button",{type:"button",disabled:D||u.page<=1,"aria-label":"\u4E0A\u4E00\u9875",onClick:()=>i(Math.max(1,u.page-1)),children:(0,z.jsx)(te,{name:"chevronLeft",size:14})}),(0,z.jsxs)("span",{"aria-live":"polite",children:[u.page||1," / ",u.pageCount||1]}),(0,z.jsx)("button",{type:"button",disabled:D||u.page>=u.pageCount,"aria-label":"\u4E0B\u4E00\u9875",onClick:()=>i(u.page+1),children:(0,z.jsx)(te,{name:"chevronLeft",size:14,className:"cmd-page-next"})})]})]})]})]})]})})}function On({label:e,value:t}){return(0,z.jsxs)("div",{className:"cmd-usage-metric",children:[(0,z.jsx)("small",{children:e}),(0,z.jsx)("strong",{children:t})]})}var $a=require("react"),Xt=require("@deepseek-ai/dsh-client-ui-primitives"),Rn=require("react/jsx-runtime");function ei(e){return{getSnapshot:()=>e.theme.getTheme(),subscribe:t=>e.on("theme/change",t),setTheme:t=>e.theme.setTheme(t)}}function ti({theme:e}){let n=(0,$a.useSyncExternalStore)(e.subscribe,e.getSnapshot).active.colorScheme==="dark",i=n?"\u5207\u6362\u5230\u6D45\u8272\u6A21\u5F0F":"\u5207\u6362\u5230\u6DF1\u8272\u6A21\u5F0F";return(0,Rn.jsx)(Xt.Tooltip,{label:i,side:"top",gap:10,delayMs:450,portal:!0,children:(0,Rn.jsx)("button",{type:"button",className:"cmd-archive-launcher cmd-theme-launcher","aria-label":i,onClick:()=>e.setTheme(e.getSnapshot().active.colorScheme==="dark"?"light":"dark"),children:(0,Rn.jsx)(n?Xt.IconLightOutlineMedium:Xt.IconDarkOutlineMedium,{size:16})})})}var Ie=require("react");var qt={codex:'<svg fill="#000" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>OpenAI</title><path d="M21.55 10.004a5.416 5.416 0 00-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0010.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 001.76 7.496a5.487 5.487 0 00.691 6.5 5.416 5.416 0 00.477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0013.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 003.715-2.66 5.488 5.488 0 00-.693-6.497v.001zm-8.381 11.558a4.199 4.199 0 01-2.675-.954c.034-.018.093-.05.132-.074l4.44-2.53a.71.71 0 00.364-.623v-6.176l1.877 1.069c.02.01.033.029.036.05v5.115c-.003 2.274-1.87 4.118-4.174 4.123zM4.192 17.78a4.059 4.059 0 01-.498-2.763c.032.02.09.055.131.078l4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138a.068.068 0 01-.027.057L9.9 19.288c-1.999 1.136-4.552.46-5.707-1.51h-.001zM3.023 8.216A4.15 4.15 0 015.198 6.41l-.002.151v5.06a.711.711 0 00.364.624l5.42 3.087-1.876 1.07a.067.067 0 01-.063.005l-4.489-2.559c-1.995-1.14-2.679-3.658-1.53-5.63h.001zm15.417 3.54l-5.42-3.088L14.896 7.6a.067.067 0 01.063-.006l4.489 2.557c1.998 1.14 2.683 3.662 1.529 5.633a4.163 4.163 0 01-2.174 1.807V12.38a.71.71 0 00-.363-.623zm1.867-2.773a6.04 6.04 0 00-.132-.078l-4.44-2.53a.731.731 0 00-.729 0l-5.42 3.088V7.325a.068.068 0 01.027-.057L14.1 4.713c2-1.137 4.555-.46 5.707 1.513.487.833.664 1.809.499 2.757h.001zm-11.741 3.81l-1.877-1.068a.065.065 0 01-.036-.051V6.559c.001-2.277 1.873-4.122 4.181-4.12.976 0 1.92.338 2.671.954-.034.018-.092.05-.131.073l-4.44 2.53a.71.71 0 00-.365.623l-.003 6.173v.002zm1.02-2.168L12 9.25l2.414 1.375v2.75L12 14.75l-2.415-1.375v-2.75z"></path></svg>',claude:'<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Claude</title><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="#D97757" fill-rule="nonzero"></path></svg>',opencode:'<svg height="1em" width="1em" style="flex:none;line-height:1" viewBox="0 0 240 300" xmlns="http://www.w3.org/2000/svg"><title>OpenCode</title><g clip-path="url(#clip0_1401_86274)"><mask id="mask0_1401_86274" style="mask-type:luminance" maskUnits="userSpaceOnUse" x="0" y="0" width="240" height="300"><path d="M240 0H0V300H240V0Z" fill="white"/></mask><g mask="url(#mask0_1401_86274)"><path d="M180 240H60V120H180V240Z" fill="#CFCECD"/><path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="#211E1E"/></g></g><defs><clipPath id="clip0_1401_86274"><rect width="240" height="300" fill="white"/></clipPath></defs></svg>',deepseek:`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="50.000000" height="50.000000" viewBox="0 0 50 50" fill="none">
	<path id="path" d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z" fill="#000" fill-opacity="1.000000" fill-rule="nonzero"/>
</svg>
`};var Oe=require("@deepseek-ai/dsh-client-ui-primitives");var ni=`/* The hidden New Session caption control no longer reserves a menu gap. */
html[data-windows-titlebar]:has(.cmd-shell-sidebar .cmd-projects) {
  --dsh-windows-menu-start: 48px;
}
/* The official sidebar and settings shell stay mounted. Only their geometry changes. */
[class*="_root"]:has(> [class*="_regionArea"] .cmd-projects) {
  --dsh-sidebar-inline-padding: 6px;
  position: relative;
  padding: 8px 6px 6px;
}
[class*="_root"]:has(.cmd-projects) > [class*="_logoRow"] {
  position: absolute;
  top: 10px;
  right: 8px;
  width: 30px;
  height: 30px;
  margin: 0;
  padding: 0;
  z-index: 1;
  overflow: visible;
}
[class*="_root"]:has(.cmd-projects) > [class*="_logoRow"] > [class*="_brand"],
[class*="_root"]:has(.cmd-projects) button[class*="_newSession"],
[class*="_root"]:has(.cmd-projects) [class*="_railMark"] { display: none; }
[class*="_root"]:has(.cmd-projects) [class*="_toggle"] [class*="_panelIcon"] { display: inline; }
[class*="_root"]:has(.cmd-projects) > [class*="_regionArea"] { display: contents; }
/* Keep the collapsed rail's empty workspace seat flexible so footer controls stay at the bottom. */
[class*="_root"]:has(.cmd-projects.cmd-narrow) > [class*="_regionArea"] {
  display: flex;
  flex: none;
  min-height: 0;
  flex-direction: column;
  order: 1;
}
[class*="_root"]:has(.cmd-projects) > [class*="_panelList"] {
  display: flex;
  flex-direction: row;
  gap: 4px;
  margin: 2px 2px 14px;
  padding: 0;
  order: 0;
}
[class*="_root"]:has(.cmd-projects) [class*="_panelRow"] {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 6px 9px;
  gap: 8px;
  font-size: 12px;
  border-radius: 8px;
  transition: background 160ms ease, transform 160ms ease;
}
[class*="_root"]:has(.cmd-projects) [class*="_panelRow"]:active { transform: scale(.97); }
[class*="_root"]:has(.cmd-projects) [class*="_panelRow"][aria-current="page"]::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 0;
  height: 2px;
  border-radius: 2px;
  background: currentColor;
  opacity: .45;
  animation: cmd-reveal 180ms ease both;
}
[class*="_root"]:has(.cmd-projects) > [class*="_footArea"] { order: 2; padding-top: 6px; }
[class*="_root"]:has(.cmd-narrow) > [class*="_panelList"] { order: 2; }
[class*="_root"]:has(.cmd-narrow) > [class*="_footArea"] { order: 3; margin-top: auto; }

.cmd-projects {
  --cmd-text: var(--dsw-alias-label-primary, #242424);
  --cmd-muted: var(--dsw-alias-label-secondary, #818181);
  --cmd-hover: var(--dsw-alias-interactive-bg-hover, #88888812);
  --cmd-line: color-mix(in srgb, currentColor 10%, transparent);
  display: contents;
  color: var(--cmd-text);
  font: inherit;
  font-size: 13px;
}
.cmd-projects * { box-sizing: border-box; }
.cmd-projects button, .cmd-settings {
  font: inherit;
  cursor: pointer;
  color: inherit;
  border: 0;
  background: transparent;
  border-radius: 8px;
  padding: 8px 10px;
  text-align: left;
  transition: background 160ms ease, color 160ms ease, transform 160ms ease;
}
.cmd-projects button:hover, .cmd-settings:hover { background: var(--dsw-alias-interactive-bg-hover, #88888812); }
.cmd-projects button:active, .cmd-settings:active { transform: scale(.98); }
.cmd-projects button:disabled { opacity: .4; cursor: default; }
.cmd-projects input { font: inherit; color: inherit; border: 1px solid var(--cmd-line); border-radius: 8px; background: transparent; padding: 10px; width: 100%; outline-offset: 2px; }
.cmd-projects label { display: grid; gap: 6px; }
.cmd-projects :focus-visible, .cmd-settings:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #8a8a8a); outline-offset: -2px; }
.cmd-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; vertical-align: middle; font-size: 16px; font-weight: 500; }
.cmd-icon img { max-width: 100%; object-fit: contain; }
.cmd-pi { color: #b37b55; }

/* Compact toolbar remains fixed while the project/session list scrolls. */
.cmd-sidebar-nav { order: -1; display: flex; align-items: center; gap: 3px; min-height: 36px; margin: 0 2px 8px; padding-right: 34px; flex: none; }
.cmd-sidebar-nav button { display: flex; align-items: center; justify-content: center; gap: 8px; min-width: 32px; min-height: 34px; padding: 7px 8px; }
.cmd-sidebar-nav .cmd-new-chat { justify-content: flex-start; white-space: nowrap; padding-right: 10px; font-size: 13px; }
.cmd-search-toggle[aria-pressed="true"] { background: var(--cmd-hover); color: var(--cmd-text); box-shadow: inset 0 0 0 1px var(--cmd-line); }
.cmd-sidebar-content { order: 1; flex: 1; min-height: 0; overflow: auto; padding: 0 2px 12px; scrollbar-width: none; -ms-overflow-style: none; }
.cmd-sidebar-content::-webkit-scrollbar { display: none; width: 0; height: 0; }
.cmd-section-title { display: flex; align-items: center; justify-content: space-between; min-height: 32px; padding: 0 4px; margin: 0 0 5px; color: var(--cmd-muted); font-size: 12px; font-weight: 500; }
.cmd-section-title button { display: flex; padding: 5px; color: var(--cmd-muted); opacity: 1; transition: background 140ms ease; }
.cmd-search-panel { order: -1; flex: none; margin: 0 2px 10px; animation: cmd-reveal 180ms ease both; }
.cmd-search-field { display: flex !important; align-items: center; gap: 8px !important; min-height: 36px; padding: 0 8px; border: 1px solid var(--cmd-line); border-radius: 9px; background: var(--cmd-hover); }
.cmd-search-field:focus-within { border-color: color-mix(in srgb, currentColor 28%, transparent); }
.cmd-search-field > .cmd-ui-icon { color: var(--cmd-muted); }
.cmd-projects .cmd-search-field .cmd-search { flex: 1; min-width: 0; width: 0; margin: 0; padding: 8px 0; border: 0; background: transparent; animation: none; font-size: 12px; outline: none; }
.cmd-search-field button { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 4px; color: var(--cmd-muted); }
.cmd-search-close { transform: rotate(45deg); }
.cmd-search-field button:hover > .cmd-search-close { transform: rotate(45deg); }
.cmd-section-title .cmd-section-toggle { flex: 1; min-width: 0; min-height: 32px; align-items: center; justify-content: space-between; gap: 6px; padding: 6px 5px; font-size: 12px; opacity: 1; }
.cmd-section-toggle > .cmd-ui-icon { opacity: .6; transition: transform 220ms cubic-bezier(.2,.8,.2,1), opacity 160ms ease; }
.cmd-section-toggle[aria-expanded="false"] > .cmd-ui-icon { transform: rotate(-90deg); }
.cmd-section-toggle:hover > .cmd-ui-icon { opacity: 1; }
.cmd-section-body { display: grid; grid-template-rows: 1fr; opacity: 1; transition: grid-template-rows 220ms cubic-bezier(.2,.8,.2,1), opacity 180ms ease; }
.cmd-section-body[data-open="false"] { grid-template-rows: 0fr; opacity: 0; pointer-events: none; }
.cmd-section-inner { min-height: 0; overflow: hidden; }
.cmd-recents { opacity: 1; transform: translateY(0); transition: opacity 110ms ease, transform 110ms ease; }
.cmd-recents[data-transition="out"] { opacity: 0; transform: translateY(-4px); pointer-events: none; }
.cmd-recents[data-transition="in"] { animation: cmd-reveal 180ms ease both; }
.cmd-project { margin: 1px 0; }
.cmd-project-name { display: flex; align-items: center; position: relative; border-radius: 8px; min-height: 34px; transition: background 160ms ease; }
.cmd-project-name:hover { background: var(--cmd-hover); }
.cmd-project-name > button:first-child { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; padding: 8px 9px; }
.cmd-project-name > button:first-child:hover { background: transparent; }
.cmd-project-name > button:first-child > span:not(.cmd-activity):not(.cmd-ui-icon) { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1; font-size: 12px; }
.cmd-project-name svg { flex: none; color: var(--cmd-muted); transition: transform 220ms ease; }
.cmd-project-name .cmd-project-new { display: flex; margin-right: 3px; opacity: 0; padding: 5px; }
.cmd-project-name:hover .cmd-project-new, .cmd-project-name:focus-within .cmd-project-new { opacity: 1; }
.cmd-project-name .cmd-project-chevron { transform: rotate(-90deg); transition: transform 220ms cubic-bezier(.2,.8,.2,1); }
.cmd-project-name .cmd-project-chevron.cmd-rotated { transform: rotate(0deg); }
.cmd-project-children { margin: 2px 0 5px 16px; padding-left: 6px; border-left: 1px solid var(--cmd-line); animation: cmd-reveal 200ms ease both; }
.cmd-project-children .cmd-session { font-size: 12px; min-height: 32px; }
.cmd-recent-title { margin-top: 0; }
.cmd-projects .cmd-session { position: relative; width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 9px; margin: 1px 0; min-height: 35px; font-size: 12px; line-height: 19px; isolation: isolate; }
.cmd-session > span:not(.cmd-icon):not(.cmd-activity) { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; }
.cmd-session .cmd-icon { opacity: .65; transition: opacity 160ms ease; }
.cmd-session:hover .cmd-icon, .cmd-session.cmd-selected .cmd-icon, .cmd-is-active .cmd-icon { opacity: 1; }
.cmd-session.cmd-selected { background: var(--cmd-hover); }
/* A quiet sphere with two outward waves; movement indicates work, color indicates attention. */
.cmd-activity { display: inline-flex; position: relative; flex: 0 0 16px; align-items: center; justify-content: center; width: 16px; height: 16px; color: var(--cmd-text, var(--dsw-alias-label-primary, #242424)); }
.cmd-activity::before, .cmd-activity::after { content: ''; position: absolute; inset: 2px; border: 1px solid currentColor; border-radius: 50%; opacity: 0; transform: scale(.5); }
.cmd-activity > i { display: block; width: 7px; height: 7px; border-radius: 50%; background: radial-gradient(circle at 30% 25%, color-mix(in srgb, currentColor 35%, transparent), currentColor 75%); box-shadow: inset -.5px -.5px 1px color-mix(in srgb, currentColor 30%, transparent); }
.cmd-status-running::before, .cmd-status-running::after, .cmd-status-connecting::before, .cmd-status-connecting::after { animation: cmd-orb-ripple 3s cubic-bezier(.2,.55,.35,1) infinite; }
.cmd-status-running::after, .cmd-status-connecting::after { animation-delay: -1.5s; }
.cmd-status-running > i { animation: cmd-orb-breathe 3s ease-in-out infinite; }
.cmd-status-running, .cmd-status-connecting { color: #438bea; }
.cmd-status-completed { color: #36a36b; }
.cmd-status-connecting { opacity: .6; }
.cmd-status-waiting { color: #b98824; }
.cmd-status-failed { color: #d05c5c; }
.cmd-status-waiting::before, .cmd-status-failed::before { opacity: .35; transform: scale(.9); }
@keyframes cmd-orb-ripple { 0% { transform: scale(.45); opacity: 0; } 15% { opacity: .3; } 80%, 100% { transform: scale(1.3); opacity: 0; } }
@keyframes cmd-orb-breathe { 0%, 100% { transform: scale(.9); opacity: .8; } 50% { transform: scale(1); opacity: 1; } }
.cmd-section-label { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
.cmd-sidebar-empty { font-size: 12px; color: var(--cmd-muted); padding: 4px 9px; margin: 4px 0 12px; line-height: 1.7; }
.cmd-add-project { padding: 9px; margin-bottom: 10px; background: var(--cmd-hover); border-radius: 8px; animation: cmd-reveal 180ms ease both; }
.cmd-add-project label { font-size: 12px; }
.cmd-add-project input { font-size: 12px; margin: 6px 0; }
.cmd-add-project button { width: 100%; text-align: center; background: var(--cmd-line); }
.cmd-error { color: #bd625b; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; background: #ae4d410a; border: 1px solid #ae4d4125; border-radius: 8px; margin: 8px 0; }
.cmd-settings { display: flex; flex: none; align-items: center; justify-content: center; width: 36px; height: 36px; min-height: 36px; padding: 0; color: var(--dsw-alias-label-secondary); }
.cmd-settings svg { transition: transform 300ms ease; }
.cmd-settings:hover svg { transform: rotate(30deg); }

/* Collapsed rail keeps every action reachable, including the expand control. */
[class*="_root"]:has(.cmd-narrow) > [class*="_panelList"] { flex-direction: column; align-items: center; margin: 4px 0 12px; gap: 4px; }
[class*="_root"]:has(.cmd-narrow) [class*="_panelRow"] { flex: none; width: 36px; height: 36px; padding: 8px; }
[class*="_root"]:has(.cmd-narrow) > [class*="_logoRow"] { left: 50%; right: auto; width: 36px; transform: translateX(-50%); }
.cmd-narrow .cmd-sidebar-nav { flex-direction: column; padding: 36px 0 0; margin: 0 0 4px; }
.cmd-narrow .cmd-sidebar-nav > button { width: 36px; height: 36px; min-height: 36px; }
.cmd-narrow.cmd-sidebar-content { padding: 0; }
.cmd-narrow .cmd-project-new { display: none; }
.cmd-narrow .cmd-session, .cmd-narrow .cmd-project-name > button:first-child { justify-content: center; padding: 8px 4px; }
.cmd-narrow .cmd-project-name > button:first-child { position: relative; }
.cmd-narrow .cmd-project-activity { position: absolute; right: 1px; bottom: 1px; width: 12px; height: 12px; border-radius: 50%; background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #fff)); }
.cmd-narrow .cmd-project-activity > i { width: 5px; height: 5px; }
.cmd-narrow .cmd-section-title { justify-content: center; padding: 0; }

@keyframes cmd-reveal { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
@media (hover: none) { .cmd-section-title button, .cmd-project-name .cmd-project-new { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .cmd-projects *, .cmd-projects *::before, .cmd-settings, .cmd-settings svg,
  [class*="_root"]:has(.cmd-projects) [class*="_panelRow"] { animation: none !important; transition: none !important; }
}

/* Iconsax: consistent optical boxes; selection crossfades from Linear to Bold. */
.cmd-ui-icon { position: relative; display: inline-flex; flex: none; vertical-align: middle; color: inherit; }
.cmd-ui-icon > span { position: absolute; inset: 0; display: flex; transition: opacity 180ms ease, transform 220ms cubic-bezier(.2,.8,.2,1); }
.cmd-ui-icon svg { width: 100%; height: 100%; display: block; }
.cmd-ui-icon .cmd-ui-linear { opacity: 1; transform: scale(1); }
.cmd-ui-icon .cmd-ui-bold { opacity: 0; transform: scale(.88); }
.cmd-ui-icon.is-selected .cmd-ui-linear { opacity: 0; transform: scale(1.08); }
.cmd-ui-icon.is-selected .cmd-ui-bold { opacity: 1; transform: scale(1); }
.cmd-sidebar-nav button:hover > .cmd-ui-icon { transform: translateY(-1px); }
.cmd-sidebar-nav .cmd-new-chat { width: 36px; height: 36px; padding: 8px; justify-content: center; }
.cmd-icon { width: 16px; height: 16px; flex: 0 0 16px; line-height: 1; }
.cmd-icon img { display: block; width: 100%; height: 100%; }
.cmd-project-name .cmd-ui-icon { flex: none; }
.cmd-project-name span:not(.cmd-activity):not(.cmd-ui-icon):not(.cmd-ui-linear):not(.cmd-ui-bold) { min-width: 0; }
.cmd-session-row { position: relative; border-radius: 8px; }
.cmd-session-row .cmd-session { padding-left: 9px; padding-right: 34px; }
.cmd-session-row .cmd-session > .cmd-icon { margin-left: 0; }
.cmd-session-more { position: absolute; z-index: 2; right: 3px; top: 4px; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 5px !important; opacity: 0; background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #fff)) !important; box-shadow: -5px 0 8px var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #fff)); transition: opacity 140ms ease, background 140ms ease !important; }
.cmd-session-row .cmd-session-more:hover, .cmd-session-more[aria-expanded="true"] { background: color-mix(in srgb, var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #fff)) 90%, var(--cmd-text)) !important; }
.cmd-session-row:hover .cmd-session-more, .cmd-session-row:focus-within .cmd-session-more, .cmd-session-more[aria-expanded="true"] { opacity: 1; }
.cmd-danger { color: #c05c59 !important; }
.cmd-dialog-button { font: inherit; cursor: pointer; padding: 9px 15px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l3, #88888825); color: inherit; background: var(--dsw-alias-interactive-bg-hover, #88888812); }
.cmd-dialog-button:disabled { opacity: .45; cursor: default; }
.cmd-narrow .cmd-session-row .cmd-session { width: 36px; height: 36px; min-height: 36px; margin: 1px auto; padding: 9px; justify-content: center; }
.cmd-narrow .cmd-section-title { margin: 3px 0; }
.cmd-narrow .cmd-section-title button { opacity: 1; }
/* Remove only the initial hero headline, leaving the official input and project controls intact. */
[class*="_headline"]:has([class*="_fishHitbox"]) { display: none; }
/* Compact project picker; keep the official modal's focus trap and dismissal. */
.cmd-project-dialog { width: min(360px, 100%); max-height: 100%; padding: 0; gap: 0; border-radius: 16px; font-size: 13px; line-height: 1.45; color: var(--dsw-alias-label-primary, #242424); }
.cmd-project-header { display: flex; flex: none; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px 10px; }
.cmd-project-header h2 { margin: 0; font-size: 15px; font-weight: 600; line-height: 24px; }
.cmd-project-dialog button, .cmd-project-dialog input { font: inherit; }
.cmd-project-dialog button:disabled { opacity: .45; cursor: default; }
.cmd-project-dialog :focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: -2px; }
.cmd-project-icon-button { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #777); cursor: pointer; }
.cmd-project-icon-button:hover:not(:disabled), .cmd-folder-home:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #88888812); color: var(--dsw-alias-label-primary, #242424); }
.cmd-project-content { display: flex; flex-direction: column; min-height: 0; padding: 0 16px 14px; overflow: auto; scrollbar-width: thin; }
.cmd-project-tabs { display: grid; grid-template-columns: 1fr 1fr; flex: none; gap: 3px; padding: 3px; margin-bottom: 12px; border-radius: 9px; background: var(--dsw-alias-interactive-bg-hover, #88888812); }
.cmd-project-tabs button { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 30px; padding: 5px 10px; border: 0; color: var(--dsw-alias-label-secondary, #777); background: transparent; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.cmd-project-tabs button[aria-selected="true"] { color: var(--dsw-alias-label-primary, #242424); background: var(--dsw-alias-bg-layer-2, #fff); box-shadow: 0 1px 3px #00000012; font-weight: 500; }
.cmd-project-tabs svg { flex: none; }
.cmd-folder-browser { display: flex; flex-direction: column; min-height: 0; }
.cmd-folder-location { display: flex; flex: none; gap: 4px; align-items: center; min-width: 0; margin-bottom: 8px; }
.cmd-folder-location > span { min-width: 0; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--dsw-alias-label-secondary, #777); font-size: 12px; }
.cmd-folder-home { flex: none; padding: 5px 6px; border: 0; border-radius: 6px; color: inherit; background: transparent; cursor: pointer; white-space: nowrap; }
.cmd-folder-search { display: flex; flex: none; align-items: center; gap: 7px; min-height: 32px; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l3, #88888825); border-radius: 7px; padding: 5px 9px; color: var(--dsw-alias-label-secondary, #777); }
.cmd-folder-search:focus-within { border-color: var(--dsw-focus-ring-color, #4d6bfe); }
.cmd-folder-search input { min-width: 0; width: 100%; padding: 0; background: transparent; border: 0; color: var(--dsw-alias-label-primary, #242424); outline: none; }
.cmd-folder-search input:focus-visible { outline: none; }
.cmd-folder-search input::placeholder, .cmd-github-form input::placeholder { color: var(--dsw-alias-label-secondary, #777); opacity: .8; }
.cmd-folder-entries { flex: 0 1 200px; height: 200px; min-height: 64px; overflow: auto; overscroll-behavior: contain; margin: 6px -4px 10px; padding: 0 4px; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l2, #88888840) transparent; }
.cmd-folder-entries > button { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 33px; padding: 7px 6px; border: 0; border-radius: 6px; color: inherit; background: transparent; cursor: pointer; text-align: left; }
.cmd-folder-entries > button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #88888812); }
.cmd-folder-entries > button > span:not(.cmd-ui-icon) { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.cmd-folder-entries > button > .cmd-ui-icon { color: var(--dsw-alias-label-secondary, #777); }
.cmd-folder-next { transform: rotate(-90deg); opacity: .65; }
.cmd-folder-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 100%; box-sizing: border-box; padding: 12px; color: var(--dsw-alias-label-secondary, #777); text-align: center; font-size: 12px; }
.cmd-folder-error-detail { max-width: 100%; overflow-wrap: anywhere; }
.cmd-folder-retry { border: 0; border-radius: 5px; padding: 4px 10px; background: var(--dsw-alias-interactive-bg-hover, #88888812); color: var(--dsw-alias-label-primary, #242424); cursor: pointer; }
.cmd-project-submit { display: flex; flex: none; align-items: center; gap: 12px; justify-content: flex-end; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l3, #88888825); }
.cmd-project-selection { display: flex; flex: 1; flex-direction: column; min-width: 0; gap: 1px; }
.cmd-project-selection > span { color: var(--dsw-alias-label-secondary, #777); font-size: 11px; }
.cmd-project-selection strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; }
.cmd-project-submit .cmd-dialog-button { flex: none; min-height: 32px; padding: 6px 12px; border-radius: 7px; white-space: nowrap; }
.cmd-project-error { flex: none; margin-bottom: 10px; color: var(--dsw-alias-state-danger-primary, #c05c59); font-size: 12px; overflow-wrap: anywhere; }
.cmd-github-form { display: grid; gap: 8px; padding-top: 2px; }
.cmd-github-form label { font-weight: 500; font-size: 12px; }
.cmd-github-form input { min-width: 0; width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l3, #88888825); border-radius: 7px; color: inherit; background: transparent; }
.cmd-github-form p { margin: 0 0 6px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #777); }
@media (pointer: coarse) { .cmd-project-icon-button { width: 36px; height: 36px; } .cmd-project-tabs button, .cmd-folder-home, .cmd-folder-entries > button, .cmd-project-submit .cmd-dialog-button, .cmd-folder-retry { min-height: 40px; } .cmd-folder-search, .cmd-github-form input { min-height: 40px; } .cmd-project-dialog input { font-size: 16px; } }
@media(hover:none) { .cmd-session-more { opacity: 1; } }
@media(prefers-reduced-motion:reduce) { .cmd-ui-icon, .cmd-ui-icon > span { transition:none!important; animation:none!important; } }

[class*="_root"]:has(.cmd-projects) [class*="_toggle"] [class*="_panelIcon"] { display:none; }
[class*="_root"]:has(.cmd-projects) [class*="_toggle"]::before { content:''; width:16px; height:16px; background:currentColor; mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M21.97%2015V9c0-5-2-7-7-7h-6c-5%200-7%202-7%207v6c0%205%202%207%207%207h6c5%200%207-2%207-7ZM7.97%202v20%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3C%2Fpath%3E%3Cpath%20d%3D%22M14.97%209.44%2012.41%2012l2.56%202.56%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E") center/contain no-repeat; transition:transform 220ms ease; }
[class*="_root"]:has(.cmd-narrow) [class*="_toggle"]::before { transform:rotate(180deg); }
/* Workspace headings highlight only on hover; conversation selection stays separate. */
.cmd-projects .cmd-section-toggle:hover > .cmd-ui-icon { transform: none; }
.cmd-projects .cmd-section-toggle[aria-expanded="false"]:hover > .cmd-ui-icon { transform: rotate(-90deg); }
.cmd-projects .cmd-search-field button:hover > .cmd-search-close { transform: rotate(45deg); }
@media(prefers-reduced-motion:reduce) { [class*="_root"]:has(.cmd-projects) [class*="_toggle"]::before { transition:none; } }

/* Official anchored Menu handles placement, keyboard traversal and dismissal. */
.cmd-session-details { display: flex; align-items: center; gap: 8px; padding-bottom: 16px; color: var(--dsw-alias-label-secondary, #818181); font-size: 12px; overflow-wrap: anywhere; }
.cmd-session-actions { display: grid; gap: 4px; }
.cmd-session-actions button { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 42px; padding: 11px 12px; border: 0; border-radius: 9px; background: transparent; color: inherit; text-align: left; font: inherit; font-size: 13px; cursor: pointer; transition: background 160ms ease, transform 160ms ease; }
.cmd-session-actions button:hover { background: var(--dsw-alias-interactive-bg-hover, #88888812); }
.cmd-session-actions button:active { transform: scale(.99); }
.cmd-session-actions button:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #8a8a8a); outline-offset: -2px; }
.cmd-session-actions button:disabled { opacity: .45; cursor: default; }
.cmd-session-actions .cmd-session-action-divider { height: 1px; margin: 5px 8px; background: var(--dsw-alias-border-l2, #8882); }
.cmd-rename-form { display: grid; gap: 8px; min-width: min(320px, calc(100vw - 56px)); }
.cmd-rename-form label { color: var(--dsw-alias-label-secondary, #818181); font-size: 12px; }
.cmd-rename-form input { box-sizing: border-box; width: 100%; min-width: 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2, #8882); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary, inherit); font: inherit; }
.cmd-rename-form input:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #8a8a8a); outline-offset: 1px; }
.cmd-dialog-primary { background: var(--dsw-alias-state-business-primary, #4d6bfe); border-color: transparent; color: #fff; }
.cmd-copy-status { margin: 12px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #818181); }
.cmd-copy-fallback { width: 100%; min-height: 140px; margin-top: 10px; padding: 10px; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l3, #88888825); border-radius: 8px; resize: vertical; background: var(--dsw-alias-interactive-bg-hover, #88888812); color: inherit; font: 12px/1.6 var(--ds-font-family-code, monospace); }

/* Region uses display:contents: fade actual plugin boxes with the official rail. */
[class*="_frame"][data-animating]:has(.cmd-projects) { transition: grid-template-columns 300ms cubic-bezier(.22,.68,0,1); }
[class*="_frame"][data-animating]:has(.cmd-projects) > [class*="_handle"] { transition: left 300ms cubic-bezier(.22,.68,0,1); }
[class*="_frame"][data-dragging]:has(.cmd-projects),
[class*="_frame"][data-dragging]:has(.cmd-projects) > [class*="_handle"] { transition: none; }
[class*="_root"][class*="_fading"]:has(.cmd-projects) .cmd-sidebar-nav,
[class*="_root"][class*="_fading"]:has(.cmd-projects) .cmd-search-panel,
[class*="_root"][class*="_fading"]:has(.cmd-projects).cmd-sidebar-content { opacity: 0; transform: translateX(-6px); transition: opacity 130ms ease, transform 150ms ease; }
[class*="_root"][class*="_railIn"]:has(.cmd-projects) .cmd-sidebar-nav,
[class*="_root"][class*="_railIn"]:has(.cmd-projects).cmd-sidebar-content { animation: cmd-rail-in 150ms cubic-bezier(.2,.8,.2,1) backwards; }
[class*="_root"]:has(.cmd-projects:not(.cmd-narrow)):not([class*="_fading"]) .cmd-sidebar-nav,
[class*="_root"]:has(.cmd-projects:not(.cmd-narrow)):not([class*="_fading"]).cmd-sidebar-content { animation: cmd-reveal 200ms ease both; }
@keyframes cmd-rail-in { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: translateX(0); } }
@media (prefers-reduced-motion: reduce) {
  [class*="_frame"][data-animating]:has(.cmd-projects),
  [class*="_frame"][data-animating]:has(.cmd-projects) > [class*="_handle"],
  [class*="_root"]:has(.cmd-projects) .cmd-sidebar-nav,
  [class*="_root"]:has(.cmd-projects) .cmd-search-panel,
  [class*="_root"]:has(.cmd-projects) .cmd-sidebar-content,
  .cmd-section-body, .cmd-section-toggle > .cmd-ui-icon,
  .cmd-recents, .cmd-session-actions button { animation: none !important; transition: none !important; }
}

.cmd-sidebar-footer { flex-direction: column; align-items: stretch; gap: 6px; }
.cmd-sidebar-status { display: flex; flex-direction: column; align-items: flex-start; width: 100%; min-width: 0; }
.cmd-sidebar-status:empty { display: none; }
.cmd-sidebar-status > button { max-width: 100%; min-height: 28px; height: auto; grid-template-columns: 14px minmax(0, 1fr); padding-block: 5px; white-space: normal; overflow-wrap: anywhere; }
.cmd-settings-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-start; gap: 4px; width: 100%; min-width: 0; }
.cmd-archive-launcher { display: flex; flex: none; align-items: center; justify-content: center; width: 36px; height: 36px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.cmd-archive-launcher:hover, .cmd-archive-launcher[aria-pressed=true] { background: var(--dsw-alias-interactive-bg-hover, #88888812); }
.cmd-archive-launcher:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #888); outline-offset: -2px; }
.cmd-archive-launcher:disabled { opacity: .45; cursor: default; }
.cmd-settings-row-rail { flex-direction: column; }
.cmd-actions-popover { width: 270px; max-width: calc(100vw - 24px); color: var(--dsw-alias-label-primary); font-family: inherit; }
.cmd-actions-popover .cmd-session-details { padding: 10px 12px 8px; margin: 0; }
.cmd-actions-popover .cmd-session-actions { gap: 2px; }
.cmd-actions-popover .cmd-session-actions button { min-height: 42px; padding: 10px 12px; font-size: 13px; }
.cmd-actions-popover .cmd-copy-status { padding: 0 10px 8px; font-size: 11px; }
.cmd-actions-popover .cmd-error { margin: 6px; }
.cmd-actions-popover .cmd-copy-fallback { width: calc(100% - 12px); margin: 6px; }
@media(prefers-reduced-motion:reduce) {
  .cmd-activity::before, .cmd-activity::after, .cmd-activity > i { animation: none !important; }
  .cmd-status-running::before, .cmd-status-connecting::before { opacity: .2; transform: scale(.9); }
}
/* Geometry and content share a single timeline; no delayed rail mount/crossfade. */
.cmd-shell-frame:has(.cmd-projects) { transition: grid-template-columns 280ms cubic-bezier(.22,.68,0,1); }
.cmd-shell-frame[data-dragging]:has(.cmd-projects) { transition: none; }
.cmd-shell-sidebar:has(.cmd-projects) { overflow: hidden; transition: padding 280ms cubic-bezier(.22,.68,0,1); }
.cmd-shell-sidebar:has(.cmd-projects) .cmd-sidebar-nav,
.cmd-shell-sidebar:has(.cmd-projects) .cmd-sidebar-content,
.cmd-shell-sidebar:has(.cmd-projects) > [class*="_panelList"],
.cmd-shell-sidebar:has(.cmd-projects) > [class*="_footArea"] { animation: none !important; transform: none; opacity: 1; transition: padding 280ms cubic-bezier(.22,.68,0,1), margin 280ms cubic-bezier(.22,.68,0,1), gap 280ms cubic-bezier(.22,.68,0,1); }
.cmd-shell-sidebar .cmd-session > span:not(.cmd-icon):not(.cmd-activity),
.cmd-shell-sidebar .cmd-project-name button > span:not(.cmd-ui-icon):not(.cmd-activity) { animation: cmd-sidebar-label-in 200ms ease both; }
@keyframes cmd-sidebar-label-in { from { opacity: 0; transform: translateX(-5px); } to { opacity: 1; transform: translateX(0); } }
@media (prefers-reduced-motion: reduce) { .cmd-shell-frame:has(.cmd-projects),.cmd-shell-sidebar:has(.cmd-projects),.cmd-shell-sidebar:has(.cmd-projects) * { transition: none !important; animation: none !important; } }
.cmd-session-quick-actions{position:absolute;z-index:2;right:31px;top:4px;display:flex;align-items:center;gap:1px;opacity:0;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#fff));box-shadow:-5px 0 8px var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#fff));transition:opacity 140ms ease}.cmd-session-row:hover .cmd-session-quick-actions,.cmd-session-row:focus-within .cmd-session-quick-actions{opacity:1}.cmd-session-quick{display:flex!important;align-items:center;justify-content:center;width:26px;height:28px;padding:6px!important;color:var(--cmd-muted)}.cmd-session-quick:hover{color:var(--cmd-text)}.cmd-project-delete{display:flex;margin-right:3px;padding:5px!important;opacity:0;color:var(--cmd-muted)}.cmd-project-name:hover .cmd-project-delete,.cmd-project-name:focus-within .cmd-project-delete{opacity:1}.cmd-project-delete:hover{color:#c05c59!important}
`;var oi=`/* Generated by scripts/build-fonts.py; load only displayed characters. */
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-latin-238bc49130b1.woff2") format("woff2"); unicode-range: U+20-7E,U+A0,U+A5,U+B1,U+B7,U+D7,U+F7,U+2013-2014,U+2018-201A,U+201C-201D,U+2026,U+2190-2193,U+2212,U+221A,U+2248,U+2460-2469,U+25A0-25A1,U+25B2-25B3,U+25C6-25C7,U+25CB,U+25CE-25CF,U+2605-2606; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u30-0fe8d99641c3.woff2") format("woff2"); unicode-range: U+3001-3002,U+3007-300D,U+3010-3011,U+3014-3015; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u32-202a573131a1.woff2") format("woff2"); unicode-range: U+3220-3229; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u4e-cc2f8b20be49.woff2") format("woff2"); unicode-range: U+4E00-4E01,U+4E03,U+4E07-4E0E,U+4E10-4E11,U+4E13-4E16,U+4E18-4E1E,U+4E22,U+4E24-4E25,U+4E27-4E28,U+4E2A-4E2D,U+4E30,U+4E32,U+4E34,U+4E36,U+4E38-4E3B,U+4E3D-4E3F,U+4E43,U+4E45,U+4E47-4E49,U+4E4B-4E50,U+4E52-4E54,U+4E56,U+4E58-4E59,U+4E5C-4E61,U+4E66,U+4E69,U+4E70-4E71,U+4E73,U+4E7E,U+4E86,U+4E88-4E89,U+4E8B-4E8F,U+4E91-4E95,U+4E98,U+4E9A-4E9B,U+4E9F-4EA2,U+4EA4-4EA9,U+4EAB-4EAE,U+4EB2-4EB3,U+4EB5,U+4EBA-4EBB,U+4EBF-4EC7,U+4EC9-4ECB,U+4ECD-4ECE,U+4ED1,U+4ED3-4ED9,U+4EDD-4EDF,U+4EE1,U+4EE3-4EE5,U+4EE8,U+4EEA-4EEC,U+4EF0,U+4EF2-4EF3,U+4EF5-4EF7,U+4EFB,U+4EFD,U+4EFF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u4f-9189b5f2d321.woff2") format("woff2"); unicode-range: U+4F01,U+4F09-4F0A,U+4F0D-4F11,U+4F17-4F1B,U+4F1E-4F20,U+4F22,U+4F24-4F27,U+4F2A-4F2B,U+4F2F-4F30,U+4F32,U+4F34,U+4F36,U+4F38,U+4F3A,U+4F3C-4F3D,U+4F43,U+4F46,U+4F4D-4F51,U+4F53,U+4F55,U+4F57-4F60,U+4F63-4F65,U+4F67,U+4F69,U+4F6C,U+4F6F-4F70,U+4F73-4F74,U+4F76,U+4F7B-4F7C,U+4F7E-4F7F,U+4F83-4F84,U+4F88-4F89,U+4F8B,U+4F8D,U+4F8F,U+4F91,U+4F94,U+4F97,U+4F9B,U+4F9D,U+4FA0,U+4FA3,U+4FA5-4FAA,U+4FAC,U+4FAE-4FAF,U+4FB5,U+4FBF,U+4FC3-4FC5,U+4FCA,U+4FCE-4FD1,U+4FD7-4FD8,U+4FDA,U+4FDC-4FDF,U+4FE1,U+4FE3,U+4FE6,U+4FE8-4FEA,U+4FED-4FEF,U+4FF1,U+4FF3,U+4FF8,U+4FFA,U+4FFE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u50-e2560e003872.woff2") format("woff2"); unicode-range: U+500C-500D,U+500F,U+5012,U+5014,U+5018-501A,U+501C,U+501F,U+5021,U+5025-5026,U+5028-502A,U+502C-502E,U+503A,U+503C,U+503E,U+5043,U+5047-5048,U+504C,U+504E-504F,U+5055,U+505A,U+505C,U+5065,U+506C,U+5076-5077,U+507B,U+507E-5080,U+5085,U+5088,U+508D,U+50A3,U+50A5,U+50A7-50A9,U+50AC,U+50B2,U+50BA-50BB,U+50CF,U+50D6,U+50DA,U+50E6-50E7,U+50EC-50EE,U+50F3,U+50F5,U+50FB; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u51-a9c5e7a8c7c4.woff2") format("woff2"); unicode-range: U+5106-5107,U+510B,U+5112,U+5121,U+513F-5141,U+5143-5146,U+5148-5149,U+514B,U+514D,U+5151,U+5154-5156,U+515A,U+515C,U+5162,U+5165,U+5168,U+516B-516E,U+5170-5171,U+5173-5179,U+517B-517D,U+5180-5182,U+5185,U+5188-5189,U+518C-518D,U+5192,U+5195-5197,U+5199,U+519B-519C,U+51A0,U+51A2,U+51A4-51A5,U+51AB-51AC,U+51AF-51B3,U+51B5-51B7,U+51BB-51BD,U+51C0,U+51C4,U+51C6-51C7,U+51C9,U+51CB-51CC,U+51CF,U+51D1,U+51DB,U+51DD,U+51E0-51E1,U+51E4,U+51EB,U+51ED,U+51EF-51F0,U+51F3,U+51F5-51F6,U+51F8-51FD,U+51FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u52-0cfd00b473c8.woff2") format("woff2"); unicode-range: U+5200-5203,U+5206-5208,U+520A,U+520D-520E,U+5211-5212,U+5216-521B,U+521D,U+5220,U+5224,U+5228-5229,U+522B,U+522D-522E,U+5230,U+5233,U+5236-523B,U+523D,U+523F-5243,U+524A,U+524C-524D,U+5250-5251,U+5254,U+5256,U+525C,U+525E,U+5261,U+5265,U+5267,U+5269-526A,U+526F,U+5272,U+527D,U+527F,U+5281-5282,U+5288,U+5290,U+5293,U+529B,U+529D-52A3,U+52A8-52AD,U+52B1-52B3,U+52BE-52BF,U+52C3,U+52C7,U+52C9,U+52CB,U+52D0,U+52D2,U+52D6,U+52D8,U+52DF,U+52E4,U+52F0,U+52F9-52FA,U+52FE-52FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u53-18122a07f60a.woff2") format("woff2"); unicode-range: U+5300,U+5305-5306,U+5308,U+530D,U+530F-5310,U+5315-5317,U+5319-531A,U+531D,U+5320-5321,U+5323,U+5326,U+532A,U+532E,U+5339-533B,U+533E-533F,U+5341,U+5343,U+5345,U+5347-534A,U+534E-534F,U+5351-5353,U+5355-5357,U+535A,U+535C,U+535E-5364,U+5366-5367,U+5369,U+536B,U+536E-5371,U+5373-5375,U+5377-5378,U+537A,U+537F,U+5382,U+5384-5386,U+5389,U+538B-538D,U+5395,U+5398,U+539A,U+539D,U+539F,U+53A2-53A3,U+53A5-53A6,U+53A8-53A9,U+53AE,U+53B6,U+53BB,U+53BF,U+53C1-53C2,U+53C8-53CD,U+53D1,U+53D4,U+53D6-53D9,U+53DB,U+53DF-53E0,U+53E3-53E6,U+53E8-53F3,U+53F5-53F9,U+53FB-53FD; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u54-8ca41aa9cff2.woff2") format("woff2"); unicode-range: U+5401,U+5403-5404,U+5406,U+5408-540A,U+540C-5413,U+5415-5417,U+541B,U+541D-5421,U+5423,U+5426-5429,U+542B-542F,U+5431-5432,U+5434-5435,U+5438-5439,U+543B-543C,U+543E,U+5440,U+5443,U+5446,U+5448,U+544A-544B,U+5450,U+5452-5459,U+545B-545C,U+5462,U+5464,U+5466,U+5468,U+5471-5473,U+5475-5478,U+547B-547D,U+5480,U+5482,U+5484,U+5486,U+548B-548C,U+548E-5490,U+5492,U+5494-5496,U+5499-549B,U+549D,U+54A3-54A4,U+54A6-54AD,U+54AF,U+54B1,U+54B3-54B4,U+54B8,U+54BB,U+54BD,U+54BF-54C2,U+54C4,U+54C6-54C9,U+54CC-54D5,U+54D7,U+54D9-54DA,U+54DC-54DF,U+54E5-54EA,U+54ED-54EE,U+54F2-54F3,U+54FA,U+54FC-54FD,U+54FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u55-7bd55e14647e.woff2") format("woff2"); unicode-range: U+5501,U+5506-5507,U+5509,U+550F-5511,U+5514,U+551B,U+5520,U+5522-5524,U+5527,U+552A,U+552C,U+552E-5531,U+5533,U+5537,U+553C,U+553E-553F,U+5541,U+5543-5544,U+5546,U+5549-554A,U+5550,U+5555-5556,U+555C,U+5561,U+5564-5567,U+556A,U+556C-556E,U+5575-5578,U+557B-557C,U+557E,U+5580-5584,U+5587-558B,U+558F,U+5591,U+5594,U+5598-5599,U+559C-559D,U+559F,U+55A7,U+55B1,U+55B3,U+55B5,U+55B7,U+55B9,U+55BB,U+55BD-55BE,U+55C4-55C5,U+55C9,U+55CC-55CD,U+55D1-55D4,U+55D6,U+55DC-55DD,U+55DF,U+55E1,U+55E3-55E6,U+55E8,U+55EA-55EC,U+55EF,U+55F2-55F3,U+55F5,U+55F7,U+55FD-55FE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u56-26f093e8a810.woff2") format("woff2"); unicode-range: U+5600-5601,U+5608-5609,U+560C,U+560E-560F,U+5618,U+561B,U+561E-561F,U+5623-5624,U+5627,U+562C-562D,U+5631-5632,U+5634,U+5636,U+5639,U+563B,U+563F,U+564C-564E,U+5654,U+5657-5659,U+565C,U+5662,U+5664,U+5668-566C,U+5671,U+5676,U+567B-567C,U+5685-5686,U+568E-568F,U+5693,U+56A3,U+56AF,U+56B7,U+56BC,U+56CA,U+56D4,U+56D7,U+56DA-56DB,U+56DD-56E2,U+56E4,U+56EB,U+56ED,U+56F0-56F1,U+56F4-56F5,U+56F9-56FA,U+56FD-56FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u57-36bde83a8378.woff2") format("woff2"); unicode-range: U+5703-5704,U+5706,U+5708-570A,U+571C,U+571F,U+5723,U+5728-572A,U+572C-5730,U+5733,U+5739-573B,U+573E,U+5740,U+5742,U+5747,U+574A,U+574C-5751,U+5757,U+575A-5761,U+5764,U+5766,U+5768-576B,U+576D,U+576F,U+5773,U+5776-5777,U+577B-577C,U+5782-5786,U+578B-578C,U+5792-5793,U+579B,U+57A0-57A4,U+57A6-57A7,U+57A9,U+57AB,U+57AD-57AE,U+57B2,U+57B4,U+57B8,U+57C2-57C3,U+57CB,U+57CE-57CF,U+57D2,U+57D4-57D5,U+57D8-57DA,U+57DD,U+57DF-57E0,U+57E4,U+57ED,U+57EF,U+57F4,U+57F8-57FA,U+57FD; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u58-d1df14217098.woff2") format("woff2"); unicode-range: U+5800,U+5802,U+5806-5807,U+580B,U+580D,U+5811,U+5815,U+5819,U+581E,U+5820-5821,U+5824,U+582A,U+5830,U+5835,U+5844,U+584C-584D,U+5851,U+5854,U+5858,U+585E,U+5865,U+586B-586C,U+587E,U+5880-5881,U+5883,U+5885,U+5889,U+5892-5893,U+5899-589A,U+589E-589F,U+58A8-58A9,U+58BC,U+58C1,U+58C5,U+58D1,U+58D5,U+58E4,U+58EB-58EC,U+58EE,U+58F0,U+58F3,U+58F6,U+58F9; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u59-4e41ab22c51a.woff2") format("woff2"); unicode-range: U+5902,U+5904,U+5907,U+590D,U+590F,U+5914-5916,U+5919-591A,U+591C,U+591F,U+5924-5925,U+5927,U+5929-592B,U+592D-592F,U+5931,U+5934,U+5937-593A,U+593C,U+5941-5942,U+5944,U+5947-5949,U+594B,U+594E-594F,U+5951,U+5954-5958,U+595A,U+5960,U+5962,U+5965,U+5973-5974,U+5976,U+5978-5979,U+597D,U+5981-5984,U+5986-5988,U+598A,U+598D,U+5992-5993,U+5996-5997,U+5999,U+599E,U+59A3-59A5,U+59A8-59AB,U+59AE-59AF,U+59B2,U+59B9,U+59BB,U+59BE,U+59C6,U+59CA-59CB,U+59D0-59D4,U+59D7-59D8,U+59DA,U+59DC-59DD,U+59E3,U+59E5,U+59E8,U+59EC,U+59F9,U+59FB,U+59FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u5a-746a367174e6.woff2") format("woff2"); unicode-range: U+5A01,U+5A03-5A09,U+5A0C,U+5A11,U+5A13,U+5A18,U+5A1C,U+5A1F-5A20,U+5A23,U+5A25,U+5A29,U+5A31-5A32,U+5A34,U+5A36,U+5A3C,U+5A40,U+5A46,U+5A49-5A4A,U+5A55,U+5A5A,U+5A62,U+5A67,U+5A6A,U+5A74-5A77,U+5A7A,U+5A7F,U+5A92,U+5A9A-5A9B,U+5AAA,U+5AB2-5AB3,U+5AB5,U+5AB8,U+5ABE,U+5AC1-5AC2,U+5AC9,U+5ACC,U+5AD2,U+5AD4,U+5AD6,U+5AD8,U+5ADC,U+5AE0-5AE1,U+5AE3,U+5AE6,U+5AE9,U+5AEB,U+5AF1; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u5b-3d1dd404d70c.woff2") format("woff2"); unicode-range: U+5B09,U+5B16-5B17,U+5B32,U+5B34,U+5B37,U+5B40,U+5B50-5B51,U+5B53-5B55,U+5B57-5B5D,U+5B5F,U+5B62-5B66,U+5B69-5B6A,U+5B6C,U+5B70-5B71,U+5B73,U+5B75,U+5B7A,U+5B7D,U+5B80-5B81,U+5B83-5B85,U+5B87-5B89,U+5B8B-5B8C,U+5B8F,U+5B93,U+5B95,U+5B97-5B9E,U+5BA0-5BA6,U+5BAA-5BAB,U+5BB0,U+5BB3-5BB6,U+5BB8-5BB9,U+5BBD-5BBF,U+5BC2,U+5BC4-5BC7,U+5BCC,U+5BD0,U+5BD2-5BD3,U+5BDD-5BDF,U+5BE1,U+5BE4-5BE5,U+5BE8,U+5BEE,U+5BF0,U+5BF8-5BFC,U+5BFF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u5c-fe0a273f69e7.woff2") format("woff2"); unicode-range: U+5C01,U+5C04,U+5C06,U+5C09-5C0A,U+5C0F,U+5C11,U+5C14-5C16,U+5C18,U+5C1A,U+5C1C-5C1D,U+5C22,U+5C24-5C25,U+5C27,U+5C2C,U+5C31,U+5C34,U+5C38-5C42,U+5C45,U+5C48-5C4B,U+5C4E-5C51,U+5C55,U+5C59,U+5C5E,U+5C60-5C61,U+5C63,U+5C65-5C66,U+5C6E-5C6F,U+5C71,U+5C79-5C7A,U+5C7F,U+5C81-5C82,U+5C88,U+5C8C-5C8D,U+5C90-5C91,U+5C94,U+5C96-5C9C,U+5CA2-5CA3,U+5CA9,U+5CAB-5CAD,U+5CB1,U+5CB3,U+5CB5,U+5CB7-5CB8,U+5CBD,U+5CBF,U+5CC1,U+5CC4,U+5CCB,U+5CD2,U+5CD9,U+5CE1,U+5CE4-5CE6,U+5CE8,U+5CEA,U+5CED,U+5CF0,U+5CFB; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u5d-af1f0a1c8d2d.woff2") format("woff2"); unicode-range: U+5D02-5D03,U+5D06-5D07,U+5D0E,U+5D14,U+5D16,U+5D1B,U+5D1E,U+5D24,U+5D26-5D27,U+5D29,U+5D2D-5D2E,U+5D34,U+5D3D-5D3E,U+5D47,U+5D4A-5D4C,U+5D58,U+5D5B,U+5D5D,U+5D69,U+5D6B-5D6C,U+5D6F,U+5D74,U+5D82,U+5D99,U+5D9D,U+5DB7,U+5DC5,U+5DCD,U+5DDB,U+5DDD-5DDE,U+5DE1-5DE2,U+5DE5-5DE9,U+5DEB,U+5DEE-5DEF,U+5DF1-5DF4,U+5DF7,U+5DFD-5DFE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u5e-598c65420e17.woff2") format("woff2"); unicode-range: U+5E01-5E03,U+5E05-5E06,U+5E08,U+5E0C,U+5E0F-5E11,U+5E14-5E16,U+5E18-5E1D,U+5E26-5E27,U+5E2D-5E2E,U+5E31,U+5E37-5E38,U+5E3B-5E3D,U+5E42,U+5E44-5E45,U+5E4C,U+5E54-5E55,U+5E5B,U+5E5E,U+5E61-5E62,U+5E72-5E74,U+5E76,U+5E78,U+5E7A-5E7D,U+5E7F-5E80,U+5E84,U+5E86-5E87,U+5E8A-5E8B,U+5E8F-5E91,U+5E93-5E97,U+5E99-5E9A,U+5E9C,U+5E9E-5EA0,U+5EA5-5EA7,U+5EAD,U+5EB3,U+5EB5-5EB9,U+5EBE,U+5EC9-5ECA,U+5ED1-5ED3,U+5ED6,U+5EDB,U+5EE8,U+5EEA,U+5EF4,U+5EF6-5EF7,U+5EFA,U+5EFE-5EFF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u5f-a92eaaa5265a.woff2") format("woff2"); unicode-range: U+5F00-5F04,U+5F08,U+5F0A-5F0B,U+5F0F,U+5F11,U+5F13,U+5F15,U+5F17-5F18,U+5F1B,U+5F1F-5F20,U+5F25-5F27,U+5F29-5F2A,U+5F2D,U+5F2F,U+5F31,U+5F39-5F3A,U+5F3C,U+5F40,U+5F50,U+5F52-5F53,U+5F55-5F58,U+5F5D,U+5F61-5F62,U+5F64,U+5F66,U+5F69-5F6A,U+5F6C-5F6D,U+5F70-5F71,U+5F73,U+5F77,U+5F79,U+5F7B-5F7C,U+5F80-5F82,U+5F84-5F85,U+5F87-5F8C,U+5F90,U+5F92,U+5F95,U+5F97-5F99,U+5F9C,U+5FA1,U+5FA8,U+5FAA,U+5FAD-5FAE,U+5FB5,U+5FB7,U+5FBC-5FBD,U+5FC3-5FC6,U+5FC9,U+5FCC-5FCD,U+5FCF-5FD2,U+5FD6-5FD9,U+5FDD,U+5FE0-5FE1,U+5FE4,U+5FE7,U+5FEA-5FEB,U+5FED-5FEE,U+5FF1,U+5FF5,U+5FF8,U+5FFB,U+5FFD-5FFF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u60-48ee3d26462d.woff2") format("woff2"); unicode-range: U+6000-6006,U+600A,U+600D-600F,U+6012,U+6014-6016,U+6019,U+601B-601D,U+6020-6021,U+6025-602B,U+602F,U+6035,U+603B-603C,U+603F,U+6041-6043,U+604B,U+604D,U+6050,U+6052,U+6055,U+6059-605A,U+605D,U+6062-6064,U+6067-606D,U+606F-6070,U+6073,U+6076,U+6078-607D,U+607F,U+6083-6084,U+6089,U+608C-608D,U+6092,U+6094,U+6096,U+609A-609B,U+609D,U+609F-60A0,U+60A3,U+60A6,U+60A8,U+60AB-60AD,U+60AF,U+60B1-60B2,U+60B4,U+60B8,U+60BB-60BC,U+60C5-60C6,U+60CA-60CB,U+60D1,U+60D5,U+60D8,U+60DA,U+60DC-60DD,U+60DF-60E0,U+60E6-60E9,U+60EB-60F0,U+60F3-60F4,U+60F6,U+60F9-60FA; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u61-7a57f35bc077.woff2") format("woff2"); unicode-range: U+6100-6101,U+6106,U+6108-6109,U+610D-610F,U+6115,U+611A,U+611F-6120,U+6123-6124,U+6126-6127,U+612B,U+613F,U+6148,U+614A,U+614C,U+614E,U+6151,U+6155,U+615D,U+6162,U+6167-6168,U+6170,U+6175,U+6177,U+618B,U+618E,U+6194,U+619D,U+61A7-61A9,U+61AC,U+61B7,U+61BE,U+61C2,U+61C8,U+61CA-61CB,U+61D1-61D2,U+61D4,U+61E6,U+61F5,U+61FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u62-d2d0b7b36631.woff2") format("woff2"); unicode-range: U+6206,U+6208,U+620A-6212,U+6215-6218,U+621A-621B,U+621F,U+6221-6222,U+6224-6225,U+622A,U+622C,U+622E,U+6233-6234,U+6237,U+623D-6241,U+6243,U+6247-6249,U+624B-624E,U+6251-6254,U+6258,U+625B,U+6263,U+6266-6267,U+6269-6270,U+6273,U+6276,U+6279,U+627C,U+627E-6280,U+6284,U+6289-628A,U+6291-6293,U+6295-6298,U+629A-629B,U+629F-62A2,U+62A4-62A5,U+62A8,U+62AB-62AC,U+62B1,U+62B5,U+62B9,U+62BB-62BD,U+62BF,U+62C2,U+62C4-62CA,U+62CC-62CE,U+62D0,U+62D2-62D4,U+62D6-62DC,U+62DF,U+62E2-62E3,U+62E5-62E9,U+62EC-62EF,U+62F1,U+62F3-62F4,U+62F6-62F7,U+62FC-62FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u63-cade7c6635e6.woff2") format("woff2"); unicode-range: U+6301-6302,U+6307-6309,U+630E,U+6311,U+6316,U+631A-631B,U+631D-6325,U+6328,U+632A-632B,U+632F,U+6332,U+6339-633A,U+633D,U+6342-6343,U+6345-6346,U+6349,U+634B-6350,U+6355,U+635E-635F,U+6361-6363,U+6367,U+6369,U+636D-636E,U+6371,U+6376-6377,U+637A-637B,U+6380,U+6382,U+6387-638A,U+638C,U+638E-6390,U+6392,U+6396,U+6398,U+63A0,U+63A2-63A3,U+63A5,U+63A7-63AA,U+63AC-63AE,U+63B0,U+63B3-63B4,U+63B7-63B8,U+63BA,U+63BC,U+63BE,U+63C4,U+63C6,U+63C9,U+63CD-63D0,U+63D2,U+63D6,U+63DE,U+63E0-63E1,U+63E3,U+63E9-63EA,U+63ED,U+63F2,U+63F4,U+63F6,U+63F8,U+63FD,U+63FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u64-ed34e40d7f65.woff2") format("woff2"); unicode-range: U+6400-6402,U+6405,U+640B-640C,U+640F-6410,U+6413-6414,U+641B-641C,U+641E,U+6420-6421,U+6426,U+642A,U+642C-642D,U+6434,U+643A,U+643D,U+643F,U+6441,U+6444-6448,U+644A,U+6452,U+6454,U+6458,U+645E,U+6467,U+6469,U+646D,U+6478-647A,U+6482,U+6484-6485,U+6487,U+6491-6492,U+6495-6496,U+6499,U+649E,U+64A4,U+64A9,U+64AC-64AE,U+64B0,U+64B5,U+64B7-64B8,U+64BA,U+64BC,U+64C0,U+64C2,U+64C5,U+64CD-64CE,U+64D0,U+64D2,U+64D7-64D8,U+64DE,U+64E2,U+64E4,U+64E6; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u65-e13e83e69c38.woff2") format("woff2"); unicode-range: U+6500,U+6509,U+6512,U+6518,U+6525,U+652B,U+652E-652F,U+6534-6536,U+6538-6539,U+653B,U+653E-653F,U+6545,U+6548-6549,U+654C,U+654F,U+6551,U+6555-6556,U+6559,U+655B,U+655D-655E,U+6562-6563,U+6566,U+656B-656C,U+6570,U+6572,U+6574,U+6577,U+6587,U+658B-658C,U+6590-6591,U+6593,U+6597,U+6599,U+659B-659C,U+659F,U+65A1,U+65A4-65A5,U+65A7,U+65A9,U+65AB,U+65AD,U+65AF-65B0,U+65B9,U+65BC-65BD,U+65C1,U+65C3-65C6,U+65CB-65CC,U+65CE-65CF,U+65D2,U+65D6-65D7,U+65E0,U+65E2,U+65E5-65E9,U+65EC-65F1,U+65F6-65F7,U+65FA; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u66-1dbcfa5da147.woff2") format("woff2"); unicode-range: U+6600,U+6602-6603,U+6606,U+660A,U+660C,U+660E-660F,U+6613-6615,U+6619,U+661D,U+661F-6620,U+6625,U+6627-6628,U+662D,U+662F,U+6631,U+6634-6636,U+663C,U+663E,U+6641,U+6643,U+664B-664C,U+664F,U+6652-6657,U+665A,U+665F,U+6661,U+6664,U+6666,U+6668,U+666E-6670,U+6674,U+6676-6677,U+667A,U+667E,U+6682,U+6684,U+6687,U+668C,U+6691,U+6696-6697,U+669D,U+66A7-66A8,U+66AE,U+66B4,U+66B9,U+66BE,U+66D9,U+66DB-66DD,U+66E6,U+66E9,U+66F0,U+66F2-66F4,U+66F7,U+66F9,U+66FC,U+66FE-66FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u67-6b0a26b82da6.woff2") format("woff2"); unicode-range: U+6700,U+6708-670B,U+670D,U+6710,U+6714-6715,U+6717,U+671B,U+671D,U+671F,U+6726,U+6728,U+672A-672D,U+672F,U+6731,U+6734-6735,U+673A,U+673D,U+6740,U+6742-6743,U+6746,U+6748-6749,U+674C,U+674E-6751,U+6753,U+6756,U+675C,U+675E-6761,U+6765,U+6768-676A,U+676D,U+676F-6770,U+6772-6773,U+6775,U+6777,U+677C,U+677E-677F,U+6781,U+6784,U+6787,U+6789,U+678B,U+6790,U+6795,U+6797-6798,U+679A,U+679C-679E,U+67A2-67A3,U+67A5,U+67A7-67A8,U+67AA-67AB,U+67AD,U+67AF-67B0,U+67B3,U+67B5-67B8,U+67C1,U+67C3-67C4,U+67CF-67D4,U+67D8-67DA,U+67DC-67DE,U+67E0,U+67E2,U+67E5,U+67E9,U+67EC,U+67EF-67F1,U+67F3-67F4,U+67FD,U+67FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u68-1b8217cfceed.woff2") format("woff2"); unicode-range: U+6800,U+6805,U+6807-680C,U+680E-680F,U+6811,U+6813,U+6816-6817,U+681D,U+6821,U+6829-682A,U+6832-6833,U+6837-6839,U+683C-683E,U+6840-6846,U+6848-684A,U+684C,U+684E,U+6850-6851,U+6853-6855,U+6860-6869,U+686B,U+6874,U+6876-6877,U+6881,U+6883,U+6885-6886,U+688F,U+6893,U+6897,U+68A2,U+68A6-68A8,U+68AD,U+68AF-68B0,U+68B3,U+68B5,U+68C0,U+68C2,U+68C9,U+68CB,U+68CD,U+68D2,U+68D5,U+68D8,U+68DA,U+68E0,U+68E3,U+68EE,U+68F0-68F1,U+68F5,U+68F9-68FA,U+68FC; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u69-673e63627790.woff2") format("woff2"); unicode-range: U+6901,U+6905,U+690B,U+690D-690E,U+6910,U+6912,U+691F-6920,U+6924,U+692D,U+6930,U+6934,U+6939,U+693D,U+693F,U+6942,U+6954,U+6957,U+695A,U+695D-695E,U+6960,U+6963,U+6966,U+696B,U+696E,U+6971,U+6977-6979,U+697C,U+6980,U+6982,U+6984,U+6986-6989,U+698D,U+6994-6995,U+6998,U+699B-699C,U+69A7-69A8,U+69AB,U+69AD,U+69B1,U+69B4,U+69B7,U+69BB,U+69C1,U+69CA,U+69CC,U+69CE,U+69D0,U+69D4,U+69DB,U+69DF-69E0,U+69ED,U+69F2,U+69FD,U+69FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u6a-3c94008a4640.woff2") format("woff2"); unicode-range: U+6A0A,U+6A17-6A18,U+6A1F,U+6A21,U+6A28,U+6A2A,U+6A2F,U+6A31,U+6A35,U+6A3D-6A3E,U+6A44,U+6A47,U+6A50,U+6A58-6A59,U+6A5B,U+6A61,U+6A65,U+6A71,U+6A79,U+6A7C,U+6A80,U+6A84,U+6A8E,U+6A90-6A91,U+6A97,U+6AA0,U+6AA9,U+6AAB-6AAC; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u6b-44572c410fa0.woff2") format("woff2"); unicode-range: U+6B20-6B24,U+6B27,U+6B32,U+6B37,U+6B39-6B3A,U+6B3E,U+6B43,U+6B46-6B47,U+6B49,U+6B4C,U+6B59,U+6B62-6B67,U+6B6A,U+6B79,U+6B7B-6B7C,U+6B81-6B84,U+6B86-6B87,U+6B89-6B8B,U+6B8D,U+6B92-6B93,U+6B96,U+6B9A-6B9B,U+6BA1,U+6BAA,U+6BB3-6BB5,U+6BB7,U+6BBF,U+6BC1-6BC2,U+6BC5,U+6BCB,U+6BCD,U+6BCF,U+6BD2-6BD7,U+6BD9,U+6BDB,U+6BE1,U+6BEA-6BEB,U+6BEF,U+6BF3,U+6BF5,U+6BF9,U+6BFD; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u6c-1b323b366e88.woff2") format("woff2"); unicode-range: U+6C05-6C07,U+6C0D,U+6C0F-6C11,U+6C13-6C16,U+6C18-6C1B,U+6C1F,U+6C21-6C22,U+6C24,U+6C26-6C2A,U+6C2E-6C30,U+6C32,U+6C34-6C35,U+6C38,U+6C3D,U+6C40-6C42,U+6C46-6C47,U+6C49-6C4A,U+6C50,U+6C54-6C55,U+6C57,U+6C5B-6C61,U+6C64,U+6C68-6C6A,U+6C70,U+6C72,U+6C74,U+6C76,U+6C79,U+6C7D-6C7E,U+6C81-6C83,U+6C85-6C86,U+6C88-6C89,U+6C8C,U+6C8F-6C90,U+6C93-6C94,U+6C99,U+6C9B,U+6C9F,U+6CA1,U+6CA3-6CA7,U+6CA9-6CAB,U+6CAD-6CAE,U+6CB1-6CB3,U+6CB8-6CB9,U+6CBB-6CBF,U+6CC4-6CC5,U+6CC9-6CCA,U+6CCC,U+6CD0,U+6CD3-6CD7,U+6CDB,U+6CDE,U+6CE0-6CE3,U+6CE5,U+6CE8,U+6CEA-6CEB,U+6CEE-6CF1,U+6CF3,U+6CF5-6CF8,U+6CFA-6CFE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u6d-cbc376d6fe3f.woff2") format("woff2"); unicode-range: U+6D01,U+6D04,U+6D07,U+6D0B-6D0C,U+6D0E,U+6D12,U+6D17,U+6D19-6D1B,U+6D1E,U+6D25,U+6D27,U+6D2A-6D2B,U+6D2E,U+6D31-6D33,U+6D35,U+6D39,U+6D3B-6D3E,U+6D41,U+6D43,U+6D45-6D48,U+6D4A-6D4B,U+6D4D-6D4F,U+6D51-6D54,U+6D59-6D5A,U+6D5C,U+6D5E,U+6D60,U+6D63,U+6D66,U+6D69-6D6A,U+6D6E-6D6F,U+6D74,U+6D77-6D78,U+6D7C,U+6D82,U+6D85,U+6D88-6D89,U+6D8C,U+6D8E,U+6D91,U+6D93-6D95,U+6D9B,U+6D9D-6DA1,U+6DA3-6DA4,U+6DA6-6DAB,U+6DAE-6DAF,U+6DB2,U+6DB5,U+6DB8,U+6DBF-6DC0,U+6DC4-6DC7,U+6DCB-6DCC,U+6DD1,U+6DD6,U+6DD8-6DD9,U+6DDD-6DDE,U+6DE0-6DE1,U+6DE4,U+6DE6,U+6DEB-6DEC,U+6DEE,U+6DF1,U+6DF3,U+6DF7,U+6DF9,U+6DFB-6DFC; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u6e-7f7e211e2fee.woff2") format("woff2"); unicode-range: U+6E05,U+6E0A,U+6E0C-6E0E,U+6E10-6E11,U+6E14,U+6E16-6E17,U+6E1A,U+6E1D,U+6E20-6E21,U+6E23-6E25,U+6E29,U+6E2B,U+6E2D,U+6E2F,U+6E32,U+6E34,U+6E38,U+6E3A,U+6E43-6E44,U+6E4D-6E4E,U+6E53-6E54,U+6E56,U+6E58,U+6E5B,U+6E5F,U+6E6B,U+6E6E,U+6E7E-6E7F,U+6E83,U+6E85-6E86,U+6E89,U+6E8F-6E90,U+6E98,U+6E9C,U+6E9F,U+6EA2,U+6EA5,U+6EA7,U+6EAA,U+6EAF,U+6EB1-6EB2,U+6EB4,U+6EB6-6EB7,U+6EBA-6EBB,U+6EBD,U+6EC1-6EC2,U+6EC7,U+6ECB,U+6ECF,U+6ED1,U+6ED3-6ED5,U+6ED7,U+6EDA,U+6EDE-6EE2,U+6EE4-6EE6,U+6EE8-6EE9,U+6EF4,U+6EF9; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u6f-ff280ce052fa.woff2") format("woff2"); unicode-range: U+6F02,U+6F06,U+6F09,U+6F0F,U+6F13-6F15,U+6F20,U+6F24,U+6F29-6F2B,U+6F2D,U+6F2F,U+6F31,U+6F33,U+6F36,U+6F3E,U+6F46-6F47,U+6F4B,U+6F4D,U+6F58,U+6F5C,U+6F5E,U+6F62,U+6F66,U+6F6D-6F6E,U+6F72,U+6F74,U+6F78,U+6F7A,U+6F7C,U+6F84,U+6F88-6F89,U+6F8C-6F8E,U+6F9C,U+6FA1,U+6FA7,U+6FB3,U+6FB6,U+6FB9,U+6FC0,U+6FC2,U+6FC9,U+6FD1-6FD2,U+6FDE,U+6FE0-6FE1,U+6FEE-6FEF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u70-cb727eaf73b6.woff2") format("woff2"); unicode-range: U+7011,U+701A-701B,U+7023,U+7035,U+7039,U+704C,U+704F,U+705E,U+706B-706D,U+706F-7070,U+7075-7076,U+7078,U+707C,U+707E-7080,U+7085,U+7089-708A,U+708E,U+7092,U+7094-7096,U+7099,U+709C-709D,U+70AB-70AF,U+70B1,U+70B3,U+70B7-70B9,U+70BB-70BD,U+70C0-70C3,U+70C8,U+70CA,U+70D8-70D9,U+70DB,U+70DF,U+70E4,U+70E6-70E9,U+70EB-70ED,U+70EF,U+70F7,U+70F9,U+70FD; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u71-0bb1747439fe.woff2") format("woff2"); unicode-range: U+7109-710A,U+7110,U+7113,U+7115-7116,U+7118-711A,U+7126,U+712F-7131,U+7136,U+7145,U+714A,U+714C,U+714E,U+715C,U+715E,U+7164,U+7166-7168,U+716E,U+7172-7173,U+7178,U+717A,U+717D,U+7184,U+718A,U+718F,U+7194,U+7198-7199,U+719F-71A0,U+71A8,U+71AC,U+71B3,U+71B5,U+71B9,U+71C3,U+71CE,U+71D4-71D5,U+71E0,U+71E5,U+71E7,U+71EE,U+71F9; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u72-cccd39590d69.woff2") format("woff2"); unicode-range: U+7206,U+721D,U+7228,U+722A,U+722C,U+7230-7231,U+7235-7239,U+723B,U+723D,U+723F,U+7247-7248,U+724C-724D,U+7252,U+7256,U+7259,U+725B,U+725D,U+725F,U+7261-7262,U+7266-7267,U+7269,U+726E-726F,U+7272,U+7275,U+7279-727A,U+727E-7281,U+7284,U+728A-728B,U+728D,U+728F,U+7292,U+729F,U+72AC-72AD,U+72AF-72B0,U+72B4,U+72B6-72B9,U+72C1-72C4,U+72C8,U+72CD-72CE,U+72D0,U+72D2,U+72D7,U+72D9,U+72DE,U+72E0-72E1,U+72E8-72E9,U+72EC-72F4,U+72F7-72F8,U+72FA-72FC; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u73-e67705133584.woff2") format("woff2"); unicode-range: U+7301,U+7303,U+730A,U+730E,U+7313,U+7315-7317,U+731B-731E,U+7321-7322,U+7325,U+7329-732C,U+732E,U+7331,U+7334,U+7337-7339,U+733E-733F,U+734D,U+7350,U+7352,U+7357,U+7360,U+736C-736D,U+736F,U+737E,U+7384,U+7387,U+7389,U+738B,U+738E,U+7391,U+7396,U+739B,U+739F,U+73A2,U+73A9,U+73AB,U+73AE-73B0,U+73B2-73B3,U+73B7,U+73BA-73BB,U+73C0,U+73C2,U+73C8-73CA,U+73CD,U+73CF-73D1,U+73D9,U+73DE,U+73E0,U+73E5,U+73E7,U+73E9,U+73ED,U+73F2; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u74-03a4e7ac9df5.woff2") format("woff2"); unicode-range: U+7403,U+7405-7406,U+7409-740A,U+740F-7410,U+741A-741B,U+7422,U+7425-7426,U+7428,U+742A,U+742C,U+742E,U+7430,U+7433-7436,U+743C,U+7441,U+7455,U+7457,U+7459-745C,U+745E-745F,U+746D,U+7470,U+7476-7477,U+747E,U+7480-7481,U+7483,U+7487,U+748B,U+748E,U+7490,U+749C,U+749E,U+74A7-74A9,U+74BA,U+74D2,U+74DC,U+74DE,U+74E0,U+74E2-74E4,U+74E6,U+74EE-74EF,U+74F4,U+74F6-74F7,U+74FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u75-a2d30b327e65.woff2") format("woff2"); unicode-range: U+7504,U+750D,U+750F,U+7511,U+7513,U+7518-751A,U+751C,U+751F,U+7525,U+7528-7529,U+752B-752D,U+752F-7533,U+7535,U+7537-7538,U+753A-753B,U+753E,U+7540,U+7545,U+7548,U+754B-754C,U+754E-754F,U+7554,U+7559-755C,U+7565-7566,U+756A,U+7572,U+7574,U+7578-7579,U+757F,U+7583,U+7586,U+758B,U+758F,U+7591-7592,U+7594,U+7596-7597,U+7599-759A,U+759D,U+759F-75A1,U+75A3-75A5,U+75AB-75AC,U+75AE-75B5,U+75B8-75B9,U+75BC-75BE,U+75C2-75C5,U+75C7-75CA,U+75CD,U+75D2,U+75D4-75D6,U+75D8,U+75DB,U+75DE,U+75E2-75E4,U+75E6-75E8,U+75EA-75EB,U+75F0-75F1,U+75F4,U+75F9,U+75FC,U+75FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u76-c08fe029c988.woff2") format("woff2"); unicode-range: U+7600-7601,U+7603,U+7605,U+760A,U+760C,U+7610,U+7615,U+7617-7619,U+761B,U+761F-7620,U+7622,U+7624-7626,U+7629-762B,U+762D,U+7630,U+7633-7635,U+7638,U+763C,U+763E-7640,U+7643,U+764C-764D,U+7654,U+7656,U+765C,U+765E,U+7663,U+766B,U+766F,U+7678,U+767B,U+767D-767E,U+7682,U+7684,U+7686-7688,U+768B,U+768E,U+7691,U+7693,U+7696,U+7699,U+76A4,U+76AE,U+76B1-76B2,U+76B4,U+76BF,U+76C2,U+76C5-76C6,U+76C8,U+76CA,U+76CD-76D2,U+76D4,U+76D6-76D8,U+76DB,U+76DF,U+76E5,U+76EE-76EF,U+76F1-76F2,U+76F4,U+76F8-76F9,U+76FC,U+76FE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u77-76f03be1f4cb.woff2") format("woff2"); unicode-range: U+7701,U+7704,U+7707-7709,U+770B,U+770D,U+7719-771A,U+771F-7720,U+7722,U+7726,U+7728-7729,U+772D,U+772F,U+7735-7738,U+773A,U+773C,U+7740-7741,U+7743,U+7747,U+7750-7751,U+775A-775B,U+7761-7763,U+7765-7766,U+7768,U+776B-776C,U+7779,U+777D-7780,U+7784-7785,U+778C-778E,U+7791-7792,U+779F-77A0,U+77A2,U+77A5,U+77A7,U+77A9-77AA,U+77AC,U+77B0,U+77B3,U+77B5,U+77BB,U+77BD,U+77BF,U+77CD,U+77D7,U+77DB-77DC,U+77E2-77E3,U+77E5,U+77E7,U+77E9,U+77EB-77EE,U+77F3,U+77F6,U+77F8,U+77FD-77FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u78-5b721deaf582.woff2") format("woff2"); unicode-range: U+7800-7802,U+7809,U+780C-780D,U+7811-7812,U+7814,U+7816-7818,U+781A,U+781C-781D,U+781F,U+7823,U+7825-7827,U+7829,U+782C-782D,U+7830,U+7834,U+7837-783C,U+783E,U+7840,U+7845,U+7847,U+784C,U+784E,U+7850,U+7852,U+7855-7857,U+785D,U+786A-786E,U+7877,U+787C,U+7887,U+7889,U+788C-788E,U+7891,U+7893,U+7897-7898,U+789A-789C,U+789F,U+78A1,U+78A3,U+78A5,U+78A7,U+78B0-78B4,U+78B9,U+78BE,U+78C1,U+78C5,U+78C9-78CB,U+78D0,U+78D4-78D5,U+78D9,U+78E8,U+78EC,U+78F2,U+78F4,U+78F7,U+78FA; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u79-db7713c2eda4.woff2") format("woff2"); unicode-range: U+7901,U+7905,U+7913,U+791E,U+7924,U+7934,U+793A-793C,U+793E,U+7940-7941,U+7946,U+7948-7949,U+7953,U+7956-7957,U+795A-7960,U+7962,U+7965,U+7967-7968,U+796D,U+796F,U+7977-7978,U+797A,U+7980-7981,U+7984-7985,U+798A,U+798F,U+799A,U+79A7,U+79B3,U+79B9-79BB,U+79BD-79BE,U+79C0-79C1,U+79C3,U+79C6,U+79C9,U+79CB,U+79CD,U+79D1-79D2,U+79D5,U+79D8,U+79DF,U+79E3-79E4,U+79E6-79E7,U+79E9,U+79EB,U+79ED,U+79EF-79F0,U+79F8,U+79FB,U+79FD; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u7a-3e40d3726a09.woff2") format("woff2"); unicode-range: U+7A00,U+7A02-7A03,U+7A06,U+7A0B,U+7A0D-7A0E,U+7A14,U+7A17,U+7A1A,U+7A1E,U+7A20,U+7A23,U+7A33,U+7A37,U+7A39,U+7A3B-7A3D,U+7A3F,U+7A46,U+7A51,U+7A57,U+7A70,U+7A74,U+7A76-7A7A,U+7A7F-7A81,U+7A83-7A84,U+7A86,U+7A88,U+7A8D,U+7A91-7A92,U+7A95-7A98,U+7A9C-7A9D,U+7A9F-7AA0,U+7AA5-7AA6,U+7AA8,U+7AAC-7AAD,U+7AB3,U+7ABF,U+7ACB,U+7AD6,U+7AD9,U+7ADE-7AE0,U+7AE3,U+7AE5-7AE6,U+7AED,U+7AEF,U+7AF9-7AFA,U+7AFD,U+7AFF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u7b-a8204d1c9dba.woff2") format("woff2"); unicode-range: U+7B03-7B04,U+7B06,U+7B08,U+7B0A-7B0B,U+7B0F,U+7B11,U+7B14-7B15,U+7B19,U+7B1B,U+7B1E,U+7B20,U+7B24-7B26,U+7B28,U+7B2A-7B2C,U+7B2E,U+7B31,U+7B33,U+7B38,U+7B3A,U+7B3C,U+7B3E,U+7B45,U+7B47,U+7B49,U+7B4B-7B4C,U+7B4F-7B52,U+7B54,U+7B56,U+7B58,U+7B5A-7B5B,U+7B5D,U+7B60,U+7B62,U+7B6E,U+7B71-7B72,U+7B75,U+7B77,U+7B79,U+7B7B,U+7B7E,U+7B80,U+7B85,U+7B8D,U+7B90,U+7B94-7B95,U+7B97,U+7B9C-7B9D,U+7BA1-7BA2,U+7BA6-7BAD,U+7BB1,U+7BB4,U+7BB8,U+7BC1,U+7BC6-7BC7,U+7BCC,U+7BD1,U+7BD3,U+7BD9-7BDA,U+7BDD,U+7BE1,U+7BE5-7BE6,U+7BEA,U+7BEE,U+7BF1,U+7BF7,U+7BFC,U+7BFE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u7c-89bcdae046de.woff2") format("woff2"); unicode-range: U+7C07,U+7C0B-7C0C,U+7C0F,U+7C16,U+7C1F,U+7C26-7C27,U+7C2A,U+7C38,U+7C3F-7C41,U+7C4D,U+7C73-7C74,U+7C7B-7C7D,U+7C89,U+7C91-7C92,U+7C95,U+7C97-7C98,U+7C9C-7C9F,U+7CA2,U+7CA4-7CA5,U+7CAA,U+7CAE,U+7CB1-7CB3,U+7CB9,U+7CBC-7CBE,U+7CC1,U+7CC5,U+7CC7-7CC8,U+7CCA,U+7CCC-7CCD,U+7CD5-7CD7,U+7CD9,U+7CDC,U+7CDF-7CE0,U+7CE8,U+7CEF,U+7CF8,U+7CFB; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u7d-bcc45fa6351a.woff2") format("woff2"); unicode-range: U+7D0A,U+7D20,U+7D22,U+7D27,U+7D2B,U+7D2F,U+7D6E,U+7D77,U+7DA6,U+7DAE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u7e-49fab96d9269.woff2") format("woff2"); unicode-range: U+7E3B,U+7E41,U+7E47,U+7E82,U+7E9B,U+7E9F-7EAD,U+7EAF-7EB3,U+7EB5-7EBA,U+7EBD-7ED5,U+7ED7-7EE3,U+7EE5-7EEB,U+7EED-7EF8,U+7EFA-7EFF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u7f-dc110e1ecbf3.woff2") format("woff2"); unicode-range: U+7F00-7F09,U+7F0B-7F0F,U+7F11-7F1D,U+7F1F-7F36,U+7F38,U+7F3A,U+7F42,U+7F44-7F45,U+7F50-7F51,U+7F54-7F55,U+7F57-7F58,U+7F5A,U+7F5F,U+7F61-7F62,U+7F68-7F6A,U+7F6E,U+7F71-7F72,U+7F74,U+7F79,U+7F7E,U+7F81,U+7F8A,U+7F8C,U+7F8E,U+7F94,U+7F9A,U+7F9D-7F9F,U+7FA1,U+7FA4,U+7FA7,U+7FAF-7FB0,U+7FB2,U+7FB8-7FB9,U+7FBC-7FBD,U+7FBF,U+7FC1,U+7FC5,U+7FCA,U+7FCC,U+7FCE,U+7FD4-7FD5,U+7FD8,U+7FDF-7FE1,U+7FE5-7FE6,U+7FE9,U+7FEE,U+7FF0-7FF1,U+7FF3,U+7FFB-7FFC; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u80-c5ce9be0335e.woff2") format("woff2"); unicode-range: U+8000-8001,U+8003-8006,U+800B-800D,U+8010,U+8012,U+8014-8019,U+801C,U+8020,U+8022,U+8025-802A,U+8031,U+8033,U+8035-8038,U+803B,U+803D,U+803F,U+8042-8043,U+8046,U+804A-804D,U+8052,U+8054,U+8058,U+805A,U+8069-806A,U+8071,U+807F-8080,U+8083-8084,U+8086-8087,U+8089,U+808B-808C,U+8093,U+8096,U+8098,U+809A-809D,U+809F-80A2,U+80A4-80A5,U+80A9-80AB,U+80AD-80AF,U+80B1-80B2,U+80B4,U+80B7,U+80BA,U+80BC-80C4,U+80C6,U+80CC-80CE,U+80D6-80D7,U+80D9-80DE,U+80E1,U+80E4-80E5,U+80E7-80ED,U+80EF-80F4,U+80F6,U+80F8,U+80FA,U+80FC-80FD; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u81-b026091b3779.woff2") format("woff2"); unicode-range: U+8102,U+8106,U+8109-810A,U+810D-8114,U+8116,U+8118,U+811A,U+811E,U+812C,U+812F,U+8131-8132,U+8136,U+8138,U+813E,U+8146,U+8148,U+814A-814C,U+8150-8151,U+8153-8155,U+8159-815A,U+8160,U+8165,U+8167,U+8169,U+816D-816E,U+8170-8171,U+8174,U+8179-8180,U+8182,U+8188,U+818A,U+818F,U+8191,U+8198,U+819B-819D,U+81A3,U+81A6,U+81A8,U+81AA,U+81B3,U+81BA-81BB,U+81C0-81C3,U+81C6,U+81CA,U+81CC,U+81E3,U+81E7,U+81EA,U+81EC-81ED,U+81F3-81F4,U+81FB-81FC,U+81FE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u82-a7c6960e875d.woff2") format("woff2"); unicode-range: U+8200-8202,U+8204-8206,U+820C-820D,U+8210,U+8212,U+8214,U+821B-821C,U+821E-821F,U+8221-8223,U+8228,U+822A-822D,U+822F-8231,U+8233-8239,U+823B,U+823E,U+8244,U+8247,U+8249,U+824B,U+824F,U+8258,U+825A,U+825F,U+8268,U+826E-8270,U+8272-8274,U+8279-827A,U+827D-827F,U+8282,U+8284,U+8288,U+828A-828B,U+828D-828F,U+8291-8292,U+8297-8299,U+829C-829D,U+829F,U+82A1,U+82A4-82A6,U+82A8-82B1,U+82B3-82B4,U+82B7-82B9,U+82BD-82BE,U+82C1,U+82C4,U+82C7-82C8,U+82CA-82CF,U+82D1-82D5,U+82D7-82D8,U+82DB-82DC,U+82DE-82E1,U+82E3-82E6,U+82EB,U+82EF,U+82F1,U+82F4,U+82F7,U+82F9,U+82FB; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u83-4b7d1c2c50d4.woff2") format("woff2"); unicode-range: U+8301-8309,U+830C,U+830E-830F,U+8311,U+8314-8315,U+8317,U+831A-831C,U+8327-8328,U+832B-832D,U+832F,U+8331,U+8333-8336,U+8338-833A,U+833C,U+8340,U+8343,U+8346-8347,U+8349,U+834F-8352,U+8354,U+835A-835C,U+835E-8361,U+8363-836F,U+8377-8378,U+837B-837D,U+8385-8386,U+8389,U+838E,U+8392-8393,U+8398,U+839B-839C,U+839E,U+83A0,U+83A8-83AB,U+83B0-83B4,U+83B6-83BA,U+83BC-83BD,U+83C0-83C1,U+83C5,U+83C7,U+83CA,U+83CC,U+83CF,U+83D4,U+83D6,U+83D8,U+83DC-83DD,U+83DF-83E1,U+83E5,U+83E9-83EA,U+83F0-83F2,U+83F8-83F9,U+83FD; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u84-4119128100c8.woff2") format("woff2"); unicode-range: U+8401,U+8403-8404,U+8406,U+840B-840F,U+8411,U+8418,U+841C-841D,U+8424-8428,U+8431,U+8438,U+843C-843D,U+8446,U+8451,U+8457,U+8459-845C,U+8461,U+8463,U+8469,U+846B-846D,U+8471,U+8473,U+8475-8476,U+8478,U+847A,U+8482,U+8487-8489,U+848B-848C,U+848E,U+8497,U+8499,U+849C,U+84A1,U+84AF,U+84B2,U+84B4,U+84B8-84BA,U+84BD,U+84BF,U+84C1,U+84C4,U+84C9-84CA,U+84CD,U+84D0-84D1,U+84D3,U+84D6,U+84DD,U+84DF-84E0,U+84E3,U+84E5-84E6,U+84EC,U+84F0,U+84FC,U+84FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u85-ca43dd4c5411.woff2") format("woff2"); unicode-range: U+850C,U+8511,U+8513,U+8517,U+851A,U+851F,U+8521,U+852B-852C,U+8537-853D,U+8543,U+8548-854A,U+8556,U+8559,U+855E,U+8564,U+8568,U+8572,U+8574,U+8579-857B,U+857E,U+8584-8585,U+8587,U+858F,U+859B-859C,U+85A4,U+85A8,U+85AA,U+85AE-85B0,U+85B7,U+85B9,U+85C1,U+85C9,U+85CF-85D0,U+85D3,U+85D5,U+85DC,U+85E4,U+85E9,U+85FB,U+85FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u86-54fc0e3158fb.woff2") format("woff2"); unicode-range: U+8605,U+8611,U+8616,U+8627,U+8629,U+8638,U+863C,U+864D-8651,U+8654,U+865A,U+865E,U+8662,U+866B-866C,U+866E,U+8671,U+8679-8682,U+868A-868D,U+8693,U+8695,U+869C-869D,U+86A3-86A4,U+86A7-86AA,U+86AC,U+86AF-86B1,U+86B4-86B6,U+86BA,U+86C0,U+86C4,U+86C6-86C7,U+86C9-86CB,U+86CE-86D1,U+86D4,U+86D8-86D9,U+86DB,U+86DE-86DF,U+86E4,U+86E9,U+86ED-86EE,U+86F0-86F4,U+86F8-86F9,U+86FE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u87-b64f5eb55720.woff2") format("woff2"); unicode-range: U+8700,U+8702-8703,U+8707-870A,U+870D,U+8712-8713,U+8715,U+8717-8718,U+871A,U+871C,U+871E,U+8721-8723,U+8725,U+8729,U+872E,U+8731,U+8734,U+8737,U+873B,U+873E-873F,U+8747-8749,U+874C,U+874E,U+8753,U+8757,U+8759,U+8760,U+8763-8765,U+876E,U+8770,U+8774,U+8776,U+877B-877E,U+8782-8783,U+8785,U+8788,U+878B,U+878D,U+8793,U+8797,U+879F,U+87A8,U+87AB-87AD,U+87AF,U+87B3,U+87B5,U+87BA,U+87BD,U+87C0,U+87C6,U+87CA-87CB,U+87D1-87D3,U+87DB,U+87E0,U+87E5,U+87EA,U+87EE,U+87F9,U+87FE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u88-00feb1251f08.woff2") format("woff2"); unicode-range: U+8803,U+880A,U+8813,U+8815-8816,U+881B,U+8821-8822,U+8832,U+8839,U+883C,U+8840,U+8844-8845,U+884C-884D,U+8854,U+8857,U+8859,U+8861-8865,U+8868-8869,U+886B-886C,U+886E,U+8870,U+8872,U+8877,U+887D-887F,U+8881-8882,U+8884-8885,U+8888,U+888B,U+888D,U+8892,U+8896,U+889C,U+88A2,U+88A4,U+88AB,U+88AD,U+88B1,U+88B7,U+88BC,U+88C1-88C2,U+88C5-88C6,U+88C9,U+88CE,U+88D2,U+88D4-88D5,U+88D8-88D9,U+88DF,U+88E2-88E5,U+88E8,U+88F0-88F1,U+88F3-88F4,U+88F8-88F9,U+88FC,U+88FE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u89-db419435b316.woff2") format("woff2"); unicode-range: U+8902,U+890A,U+8910,U+8912-8913,U+8919-891B,U+8921,U+8925,U+892A-892B,U+8930,U+8934,U+8936,U+8941,U+8944,U+895E-895F,U+8966,U+897B,U+897F,U+8981,U+8983,U+8986,U+89C1-89C2,U+89C4-89CC,U+89CE-89D2,U+89D6,U+89DA,U+89DC,U+89DE,U+89E3,U+89E5-89E6,U+89EB,U+89EF,U+89F3; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u8a-06c11d45fb87.woff2") format("woff2"); unicode-range: U+8A00,U+8A07,U+8A3E,U+8A48,U+8A79,U+8A89-8A8A,U+8A93; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u8b-5c2f6fda436a.woff2") format("woff2"); unicode-range: U+8B07,U+8B26,U+8B66,U+8B6C,U+8BA0-8BAB,U+8BAD-8BB0,U+8BB2-8BBA,U+8BBC-8BC6,U+8BC8-8BCF,U+8BD1-8BE9,U+8BEB-8BFF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u8c-2b46d2d1f4cc.woff2") format("woff2"); unicode-range: U+8C00-8C08,U+8C0A-8C1D,U+8C1F-8C37,U+8C41,U+8C46-8C47,U+8C49,U+8C4C,U+8C55,U+8C5A,U+8C61-8C62,U+8C6A-8C6B,U+8C73,U+8C78-8C7A,U+8C82,U+8C85,U+8C89-8C8A,U+8C8C,U+8C94,U+8C98; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u8d-1a67d064000d.woff2") format("woff2"); unicode-range: U+8D1D-8D1F,U+8D21-8D50,U+8D53-8D56,U+8D58-8D5E,U+8D60-8D64,U+8D66-8D67,U+8D6B,U+8D6D,U+8D70,U+8D73-8D77,U+8D81,U+8D84-8D85,U+8D8A-8D8B,U+8D91,U+8D94,U+8D9F,U+8DA3,U+8DB1,U+8DB3-8DB5,U+8DB8,U+8DBA,U+8DBC,U+8DBE-8DBF,U+8DC3-8DC4,U+8DC6,U+8DCB-8DCC,U+8DCE-8DCF,U+8DD1,U+8DD6-8DD7,U+8DDA-8DDB,U+8DDD-8DDF,U+8DE3-8DE4,U+8DE8,U+8DEA-8DEC,U+8DEF,U+8DF3,U+8DF5,U+8DF7-8DFB,U+8DFD; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u8e-eb87baf0091c.woff2") format("woff2"); unicode-range: U+8E05,U+8E09-8E0A,U+8E0C,U+8E0F,U+8E14,U+8E1D-8E1F,U+8E22-8E23,U+8E29-8E2A,U+8E2C,U+8E2E-8E2F,U+8E31,U+8E35,U+8E39-8E3A,U+8E3D,U+8E40-8E42,U+8E44,U+8E47-8E4B,U+8E51-8E52,U+8E59,U+8E66,U+8E69,U+8E6C-8E6D,U+8E6F-8E70,U+8E72,U+8E74,U+8E76,U+8E7C,U+8E7F,U+8E81,U+8E85,U+8E87,U+8E8F-8E90,U+8E94,U+8E9C,U+8E9E,U+8EAB-8EAC,U+8EAF,U+8EB2,U+8EBA,U+8ECE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u8f-96c1f0632da6.woff2") format("woff2"); unicode-range: U+8F66-8F69,U+8F6B-8F7F,U+8F81-8F8B,U+8F8D-8F91,U+8F93-8F9C,U+8F9E-8F9F,U+8FA3,U+8FA8-8FA9,U+8FAB,U+8FB0-8FB1,U+8FB6,U+8FB9,U+8FBD-8FBE,U+8FC1-8FC2,U+8FC4-8FC5,U+8FC7-8FC8,U+8FCE,U+8FD0-8FD1,U+8FD3-8FD5,U+8FD8-8FD9,U+8FDB-8FDF,U+8FE2,U+8FE4-8FE6,U+8FE8-8FEB,U+8FED-8FEE,U+8FF0,U+8FF3,U+8FF7-8FF9,U+8FFD; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u90-86752dba8cbe.woff2") format("woff2"); unicode-range: U+9000-9006,U+9009-900B,U+900D,U+900F-9012,U+9014,U+9016-9017,U+901A-901B,U+901D-9022,U+9026,U+902D-902F,U+9035-9036,U+9038,U+903B-903C,U+903E,U+9041-9042,U+9044,U+9047,U+904D,U+904F-9053,U+9057-9058,U+905B,U+9062-9063,U+9065,U+9068,U+906D-906E,U+9074-9075,U+907D,U+907F-9080,U+9082-9083,U+9088,U+908B,U+9091,U+9093,U+9095,U+9097,U+9099,U+909B,U+909D,U+90A1-90A3,U+90A6,U+90AA,U+90AC,U+90AE-90B1,U+90B3-90B6,U+90B8-90BB,U+90BE,U+90C1,U+90C4-90C5,U+90C7,U+90CA,U+90CE-90D1,U+90D3,U+90D7,U+90DB-90DD,U+90E1-90E2,U+90E6-90E8,U+90EB,U+90ED,U+90EF,U+90F4,U+90F8,U+90FD-90FE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u91-0573b8548552.woff2") format("woff2"); unicode-range: U+9102,U+9104,U+9119,U+911E,U+9122-9123,U+912F,U+9131,U+9139,U+9143,U+9146,U+9149-9150,U+9152,U+9157,U+915A,U+915D-915E,U+9161-9165,U+9169-916A,U+916C,U+916E-9172,U+9174-9179,U+917D-917F,U+9185,U+9187,U+9189,U+918B-918D,U+9190-9192,U+919A-919B,U+91A2-91A3,U+91AA,U+91AD-91AF,U+91B4-91B5,U+91BA,U+91C7,U+91C9-91CA,U+91CC-91CF,U+91D1,U+91DC; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u92-f85ecf735974.woff2") format("woff2"); unicode-range: U+9274,U+928E,U+92AE,U+92C8; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u93-e7e0451735db.woff2") format("woff2"); unicode-range: U+933E,U+936A,U+938F,U+93CA,U+93D6; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u94-f3957ff98bcd.woff2") format("woff2"); unicode-range: U+943E,U+946B,U+9485-9490,U+9492-9495,U+9497,U+9499-94C6,U+94C8-94CE,U+94D0-94D2,U+94D5-94D9,U+94DB-94E5,U+94E7-94FA,U+94FC-94FF; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u95-b31129d29013.woff2") format("woff2"); unicode-range: U+9500-951B,U+951D-951F,U+9521-9526,U+9528-9532,U+9534-953C,U+953E-9542,U+9544-9547,U+9549-954A,U+954C-9554,U+9556-9559,U+955B-955F,U+9561-956D,U+956F-9573,U+9576,U+957F,U+95E8-95EB,U+95ED-95FE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u96-ca7f779c2c13.woff2") format("woff2"); unicode-range: U+9600-9606,U+9608-9612,U+9614-9617,U+9619-961A,U+961C-961D,U+961F,U+9621-9622,U+962A,U+962E,U+9631-9636,U+963B-963D,U+963F-9640,U+9642,U+9644-9649,U+964B-964D,U+9650,U+9654-9655,U+965B,U+965F,U+9661-9662,U+9664,U+9667-966A,U+966C,U+9672,U+9674-9677,U+9685-9686,U+9688,U+968B,U+968D,U+968F-9690,U+9694,U+9697-9699,U+969C,U+96A7,U+96B0,U+96B3,U+96B6,U+96B9,U+96BC-96BE,U+96C0-96C1,U+96C4-96C7,U+96C9,U+96CC-96CF,U+96D2,U+96D5,U+96E0,U+96E8-96EA,U+96EF,U+96F3,U+96F6-96F7,U+96F9,U+96FE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u97-100a25198b2c.woff2") format("woff2"); unicode-range: U+9700-9701,U+9704,U+9706-9709,U+970D-970F,U+9713,U+9716,U+971C,U+971E,U+972A,U+972D,U+9730,U+9732,U+9738-9739,U+973E,U+9752-9753,U+9756,U+9759,U+975B,U+975E,U+9760-9762,U+9765,U+9769,U+9773-9774,U+9776,U+977C,U+9785,U+978B,U+978D,U+9791-9792,U+9794,U+9798,U+97A0,U+97A3,U+97AB,U+97AD,U+97AF,U+97B2,U+97B4,U+97E6-97E7,U+97E9-97ED,U+97F3,U+97F5-97F6; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u98-59e4b784a94f.woff2") format("woff2"); unicode-range: U+9875-988A,U+988C-988D,U+988F-9891,U+9893-9894,U+9896-9898,U+989A-98A2,U+98A4-98A7,U+98CE,U+98D1-98D3,U+98D5,U+98D8-98DA,U+98DE-98DF,U+98E7-98E8; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u99-d35af6e30868.woff2") format("woff2"); unicode-range: U+990D,U+9910,U+992E,U+9954-9955,U+9963,U+9965,U+9967-9972,U+9974-9977,U+997A,U+997C-997D,U+997F-9981,U+9984-9988,U+998A-998B,U+998D,U+998F-9999,U+99A5,U+99A8; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u9a-1eb6f7cdfcfe.woff2") format("woff2"); unicode-range: U+9A6C-9A71,U+9A73-9A82,U+9A84-9A88,U+9A8A-9A8C,U+9A8F-9A93,U+9A96-9A98,U+9A9A-9AA5,U+9AA7-9AA8,U+9AB0-9AB1,U+9AB6-9AB8,U+9ABA,U+9ABC,U+9AC0-9AC2,U+9AC5,U+9ACB-9ACC,U+9AD1,U+9AD3,U+9AD8,U+9ADF,U+9AE1,U+9AE6,U+9AEB,U+9AED,U+9AEF,U+9AF9,U+9AFB; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u9b-8f428d81dcbb.woff2") format("woff2"); unicode-range: U+9B03,U+9B08,U+9B0F,U+9B13,U+9B1F,U+9B23,U+9B2F,U+9B32,U+9B3B-9B3C,U+9B41-9B45,U+9B47-9B49,U+9B4D,U+9B4F,U+9B51,U+9B54; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u9c-e10f7f8f0274.woff2") format("woff2"); unicode-range: U+9C7C,U+9C7F,U+9C81-9C82,U+9C85-9C88,U+9C8B,U+9C8D-9C8E,U+9C90-9C92,U+9C94-9C95,U+9C9A-9C9C,U+9C9E-9CA9,U+9CAB,U+9CAD-9CAE,U+9CB0-9CB8,U+9CBA-9CBD,U+9CC3-9CC7,U+9CCA-9CD0,U+9CD3-9CD9,U+9CDC-9CDF,U+9CE2; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u9e-2be65003b759.woff2") format("woff2"); unicode-range: U+9E1F-9E23,U+9E25-9E26,U+9E28-9E2D,U+9E2F,U+9E31-9E33,U+9E35-9E3A,U+9E3D-9E3F,U+9E41-9E4C,U+9E4E-9E4F,U+9E51,U+9E55,U+9E57-9E58,U+9E5A-9E5C,U+9E5E,U+9E63-9E64,U+9E66-9E6D,U+9E70-9E71,U+9E73,U+9E7E-9E7F,U+9E82,U+9E87-9E88,U+9E8B,U+9E92-9E93,U+9E9D,U+9E9F,U+9EA6,U+9EB4,U+9EB8,U+9EBB,U+9EBD-9EBE,U+9EC4,U+9EC9,U+9ECD-9ECF,U+9ED1,U+9ED4,U+9ED8,U+9EDB-9EDD,U+9EDF-9EE0,U+9EE2,U+9EE5,U+9EE7,U+9EE9-9EEA,U+9EEF,U+9EF9,U+9EFB-9EFC,U+9EFE; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-u9f-02c3d5224fdb.woff2") format("woff2"); unicode-range: U+9F0B,U+9F0D-9F0E,U+9F10,U+9F13,U+9F17,U+9F19,U+9F20,U+9F22,U+9F2C,U+9F2F,U+9F37,U+9F39,U+9F3B,U+9F3D-9F3E,U+9F44,U+9F50-9F51,U+9F7F-9F80,U+9F83-9F8C,U+9F99-9F9B,U+9F9F-9FA0; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-ufb-3eaee54bc476.woff2") format("woff2"); unicode-range: U+FB01-FB04; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-ufe-f64da8a3acce.woff2") format("woff2"); unicode-range: U+FE10-FE16,U+FE19,U+FE31,U+FE35-FE36,U+FE39-FE42,U+FE47-FE48; }
@font-face { font-family: "Commander FangYuan"; font-style: normal; font-weight: 200 700; font-display: swap; src: url("./api/commander-fonts/fangyuan-uff-0a6dcfb689fd.woff2") format("woff2"); unicode-range: U+FF01,U+FF08-FF09,U+FF0C-FF0D,U+FF0F,U+FF1A-FF1B,U+FF1F,U+FF21-FF3D,U+FF41-FF5A,U+FF5C,U+FF5E,U+FFE5; }
:root { --dsh-font-family-text-default: "Commander FangYuan", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
`;var Ce=require("react"),ci=require("react-dom");var jc=require("react");var ai={deepseek:"data:image/svg+xml;base64,PHN2ZyBmaWxsPSIjNEQ2QkZFIiBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPkRlZXBTZWVrPC90aXRsZT48cGF0aCBkPSJNMjMuNzQ4IDQuNDgyYy0uMjU0LS4xMjQtLjM2NC4xMTMtLjUxMi4yMzQtLjA1MS4wMzktLjA5NC4wOS0uMTM3LjEzNi0uMzcyLjM5Ny0uODA2LjY1Ny0xLjM3My42MjYtLjgyOS0uMDQ2LTEuNTM3LjIxNC0yLjE2My44NDgtLjEzMy0uNzgyLS41NzUtMS4yNDgtMS4yNDctMS41NDgtLjM1Mi0uMTU2LS43MDgtLjMxMS0uOTU1LS42NS0uMTcyLS4yNDEtLjIxOS0uNTEtLjMwNS0uNzc0LS4wNTUtLjE2LS4xMS0uMzIzLS4yOTMtLjM1LS4yLS4wMzEtLjI3OC4xMzYtLjM1Ni4yNzYtLjMxMy41NzItLjQzNCAxLjIwMi0uNDIyIDEuODQuMDI3IDEuNDM2LjYzMyAyLjU4IDEuODM4IDMuMzkzLjEzNy4wOTMuMTcyLjE4Ny4xMjkuMzIzLS4wODIuMjgtLjE4LjU1Mi0uMjY2LjgzMy0uMDU1LjE3OS0uMTM3LjIxNy0uMzI5LjE0YTUuNTI2IDUuNTI2IDAgMDEtMS43MzYtMS4xOGMtLjg1Ny0uODI4LTEuNjMxLTEuNzQyLTIuNTk3LTIuNDU4YTExLjM2NSAxMS4zNjUgMCAwMC0uNjg5LS40NzFjLS45ODUtLjk1Ny4xMy0xLjc0My4zODgtMS44MzYuMjctLjA5OC4wOTMtLjQzMi0uNzc5LS40MjgtLjg3Mi4wMDQtMS42Ny4yOTUtMi42ODcuNjg0YTMuMDU1IDMuMDU1IDAgMDEtLjQ2NS4xMzcgOS41OTcgOS41OTcgMCAwMC0yLjg4My0uMTAyYy0xLjg4NS4yMS0zLjM5IDEuMTAyLTQuNDk3IDIuNjIzQy4wODIgOC42MDYtLjIzMSAxMC42ODQuMTUyIDEyLjg1Yy40MDMgMi4yODQgMS41NjkgNC4xNzUgMy4zNiA1LjY1MyAxLjg1OCAxLjUzMyAzLjk5NyAyLjI4NCA2LjQzOCAyLjE0IDEuNDgyLS4wODUgMy4xMzMtLjI4NCA0Ljk5NC0xLjg2LjQ3LjIzNC45NjIuMzI3IDEuNzguMzk3LjYzLjA1OSAxLjIzNi0uMDMgMS43MDUtLjEyOC43MzUtLjE1Ni42ODQtLjgzNy40MTktLjk2MS0yLjE1NS0xLjAwNC0xLjY4Mi0uNTk1LTIuMTEzLS45MjYgMS4wOTYtMS4yOTYgMi43NDYtMi42NDIgMy4zOTItNy4wMDMuMDUtLjM0Ny4wMDctLjU2NSAwLS44NDUtLjAwNC0uMTcuMDM1LS4yMzcuMjMtLjI1NmE0LjE3MyA0LjE3MyAwIDAwMS41NDUtLjQ3NWMxLjM5Ni0uNzYzIDEuOTYtMi4wMTUgMi4wOTMtMy41MTcuMDItLjIzLS4wMDQtLjQ2Ny0uMjQ3LS41ODh6TTExLjU4MSAxOGMtMi4wODktMS42NDItMy4xMDItMi4xODMtMy41Mi0yLjE2LS4zOTIuMDI0LS4zMjEuNDcxLS4yMzUuNzYzLjA5LjI4OC4yMDcuNDg2LjM3MS43MzkuMTE0LjE2Ny4xOTIuNDE2LS4xMTMuNjAzLS42NzMuNDE2LTEuODQyLS4xNC0xLjg5Ny0uMTY3LTEuMzYxLS44MDItMi41LTEuODYtMy4zMDEtMy4zMDctLjc3NC0xLjM5My0xLjIyNC0yLjg4Ny0xLjI5OC00LjQ4Mi0uMDItLjM4Ni4wOTMtLjUyMi40NzctLjU5MmE0LjY5NiA0LjY5NiAwIDAxMS41MjktLjAzOWMyLjEzMi4zMTIgMy45NDYgMS4yNjUgNS40NjggMi43NzQuODY4Ljg2IDEuNTI1IDEuODg3IDIuMjAyIDIuODkxLjcyIDEuMDY2IDEuNDk0IDIuMDgyIDIuNDggMi45MTQuMzQ4LjI5Mi42MjUuNTE0Ljg5MS42NzctLjgwMi4wOS0yLjE0LjExLTMuMDU0LS42MTR6bTEtNi40NGEuMzA2LjMwNiAwIDAxLjQxNS0uMjg3LjMwMi4zMDIgMCAwMS4yLjI4OC4zMDYuMzA2IDAgMDEtLjMxLjMwNy4zMDMuMzAzIDAgMDEtLjMwNC0uMzA4em0zLjExIDEuNTk2Yy0uMi4wODEtLjM5OS4xNTEtLjU5LjE2YTEuMjQ1IDEuMjQ1IDAgMDEtLjc5OC0uMjU0Yy0uMjc0LS4yMy0uNDctLjM1OC0uNTUyLS43NThhMS43MyAxLjczIDAgMDEuMDE2LS41ODhjLjA3LS4zMjctLjAwOC0uNTM3LS4yMzktLjcyNy0uMTg3LS4xNTYtLjQyNi0uMTk5LS42ODgtLjE5OWEuNTU5LjU1OSAwIDAxLS4yNTQtLjA3OGMtLjExLS4wNTQtLjItLjE5LS4xMTQtLjM1OC4wMjgtLjA1NC4xNi0uMTg2LjE5Mi0uMjEuMzU2LS4yMDIuNzY3LS4xMzYgMS4xNDYuMDE2LjM1Mi4xNDQuNjE4LjQwOCAxLjAwMS43ODIuMzkxLjQ1MS40NjIuNTc2LjY4NS45MTQuMTc2LjI2NS4zMzYuNTM3LjQ0NS44NDguMDY3LjE5NS0uMDE5LjM1NC0uMjUuNDUyeiIgZmlsbD0iIzRENkJGRSI+PC9wYXRoPjwvc3ZnPg==",openai:"data:image/svg+xml;base64,PHN2ZyBmaWxsPSJjdXJyZW50Q29sb3IiIGZpbGwtcnVsZT0iZXZlbm9kZCIgaGVpZ2h0PSIxZW0iIHN0eWxlPSJmbGV4Om5vbmU7bGluZS1oZWlnaHQ6MSIgdmlld0JveD0iMCAwIDI0IDI0IiB3aWR0aD0iMWVtIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjx0aXRsZT5PcGVuQUk8L3RpdGxlPjxwYXRoIGQ9Ik0yMS41NSAxMC4wMDRhNS40MTYgNS40MTYgMCAwMC0uNDc4LTQuNTAxYy0xLjIxNy0yLjA5LTMuNjYyLTMuMTY2LTYuMDUtMi42NkE1LjU5IDUuNTkgMCAwMDEwLjgzMSAxQzguMzkuOTk1IDYuMjI0IDIuNTQ2IDUuNDczIDQuODM4QTUuNTUzIDUuNTUzIDAgMDAxLjc2IDcuNDk2YTUuNDg3IDUuNDg3IDAgMDAuNjkxIDYuNSA1LjQxNiA1LjQxNiAwIDAwLjQ3NyA0LjUwMmMxLjIxNyAyLjA5IDMuNjYyIDMuMTY1IDYuMDUgMi42NkE1LjU4NiA1LjU4NiAwIDAwMTMuMTY4IDIzYzIuNDQzLjAwNiA0LjYxLTEuNTQ2IDUuMzYxLTMuODRhNS41NTMgNS41NTMgMCAwMDMuNzE1LTIuNjYgNS40ODggNS40ODggMCAwMC0uNjkzLTYuNDk3di4wMDF6bS04LjM4MSAxMS41NThhNC4xOTkgNC4xOTkgMCAwMS0yLjY3NS0uOTU0Yy4wMzQtLjAxOC4wOTMtLjA1LjEzMi0uMDc0bDQuNDQtMi41M2EuNzEuNzEgMCAwMC4zNjQtLjYyM3YtNi4xNzZsMS44NzcgMS4wNjljLjAyLjAxLjAzMy4wMjkuMDM2LjA1djUuMTE1Yy0uMDAzIDIuMjc0LTEuODcgNC4xMTgtNC4xNzQgNC4xMjN6TTQuMTkyIDE3Ljc4YTQuMDU5IDQuMDU5IDAgMDEtLjQ5OC0yLjc2M2MuMDMyLjAyLjA5LjA1NS4xMzEuMDc4bDQuNDQgMi41M2MuMjI1LjEzLjUwNC4xMy43MyAwbDUuNDItMy4wODh2Mi4xMzhhLjA2OC4wNjggMCAwMS0uMDI3LjA1N0w5LjkgMTkuMjg4Yy0xLjk5OSAxLjEzNi00LjU1Mi40Ni01LjcwNy0xLjUxaC0uMDAxek0zLjAyMyA4LjIxNkE0LjE1IDQuMTUgMCAwMTUuMTk4IDYuNDFsLS4wMDIuMTUxdjUuMDZhLjcxMS43MTEgMCAwMC4zNjQuNjI0bDUuNDIgMy4wODctMS44NzYgMS4wN2EuMDY3LjA2NyAwIDAxLS4wNjMuMDA1bC00LjQ4OS0yLjU1OWMtMS45OTUtMS4xNC0yLjY3OS0zLjY1OC0xLjUzLTUuNjNoLjAwMXptMTUuNDE3IDMuNTRsLTUuNDItMy4wODhMMTQuODk2IDcuNmEuMDY3LjA2NyAwIDAxLjA2My0uMDA2bDQuNDg5IDIuNTU3YzEuOTk4IDEuMTQgMi42ODMgMy42NjIgMS41MjkgNS42MzNhNC4xNjMgNC4xNjMgMCAwMS0yLjE3NCAxLjgwN1YxMi4zOGEuNzEuNzEgMCAwMC0uMzYzLS42MjN6bTEuODY3LTIuNzczYTYuMDQgNi4wNCAwIDAwLS4xMzItLjA3OGwtNC40NC0yLjUzYS43MzEuNzMxIDAgMDAtLjcyOSAwbC01LjQyIDMuMDg4VjcuMzI1YS4wNjguMDY4IDAgMDEuMDI3LS4wNTdMMTQuMSA0LjcxM2MyLTEuMTM3IDQuNTU1LS40NiA1LjcwNyAxLjUxMy40ODcuODMzLjY2NCAxLjgwOS40OTkgMi43NTdoLjAwMXptLTExLjc0MSAzLjgxbC0xLjg3Ny0xLjA2OGEuMDY1LjA2NSAwIDAxLS4wMzYtLjA1MVY2LjU1OWMuMDAxLTIuMjc3IDEuODczLTQuMTIyIDQuMTgxLTQuMTIuOTc2IDAgMS45Mi4zMzggMi42NzEuOTU0LS4wMzQuMDE4LS4wOTIuMDUtLjEzMS4wNzNsLTQuNDQgMi41M2EuNzEuNzEgMCAwMC0uMzY1LjYyM2wtLjAwMyA2LjE3M3YuMDAyem0xLjAyLTIuMTY4TDEyIDkuMjVsMi40MTQgMS4zNzV2Mi43NUwxMiAxNC43NWwtMi40MTUtMS4zNzV2LTIuNzV6Ij48L3BhdGg+PC9zdmc+",anthropic:"data:image/svg+xml;base64,PHN2ZyBmaWxsPSIjRDk3NzU3IiBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGhlaWdodD0iMWVtIiBzdHlsZT0iZmxleDpub25lO2xpbmUtaGVpZ2h0OjEiIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjFlbSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+QW50aHJvcGljPC90aXRsZT48cGF0aCBkPSJNMTMuODI3IDMuNTJoMy42MDNMMjQgMjBoLTMuNjAzbC02LjU3LTE2LjQ4em0tNy4yNTggMGgzLjc2N0wxNi45MDYgMjBoLTMuNjc0bC0xLjM0My0zLjQ2MUg1LjAxN2wtMS4zNDQgMy40NkgwTDYuNTcgMy41MjJ6bTQuMTMyIDkuOTU5TDguNDUzIDcuNjg3IDYuMjA1IDEzLjQ4SDEwLjd6Ij48L3BhdGg+PC9zdmc+",google:"data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPkdvb2dsZTwvdGl0bGU+PHBhdGggZD0iTTIzIDEyLjI0NWMwLS45MDUtLjA3NS0xLjU2NS0uMjM2LTIuMjVoLTEwLjU0djQuMDgzaDYuMTg2Yy0uMTI0IDEuMDE0LS43OTcgMi41NDItMi4yOTQgMy41NjlsLS4wMjEuMTM2IDMuMzMyIDIuNTMuMjMuMDIyQzIxLjc3OSAxOC40MTcgMjMgMTUuNTkzIDIzIDEyLjI0NXoiIGZpbGw9IiM0Mjg1RjQiPjwvcGF0aD48cGF0aCBkPSJNMTIuMjI1IDIzYzMuMDMgMCA1LjU3NC0uOTc4IDcuNDMzLTIuNjY1bC0zLjU0Mi0yLjY4OGMtLjk0OC42NDgtMi4yMiAxLjEtMy44OTEgMS4xYTYuNzQ1IDYuNzQ1IDAgMDEtNi4zODYtNC41NzJsLS4xMzIuMDExLTMuNDY1IDIuNjI4LS4wNDUuMTI0QzQuMDQzIDIwLjUzMSA3LjgzNSAyMyAxMi4yMjUgMjN6IiBmaWxsPSIjMzRBODUzIj48L3BhdGg+PHBhdGggZD0iTTUuODQgMTQuMTc1QTYuNjUgNi42NSAwIDAxNS40NjMgMTJjMC0uNzU4LjEzOC0xLjQ5MS4zNjEtMi4xNzVsLS4wMDYtLjE0Ny0zLjUwOC0yLjY3LS4xMTUuMDU0QTEwLjgzMSAxMC44MzEgMCAwMDEgMTJjMCAxLjc3Mi40MzYgMy40NDcgMS4xOTcgNC45MzhsMy42NDItMi43NjN6IiBmaWxsPSIjRkJCQzA1Ij48L3BhdGg+PHBhdGggZD0iTTEyLjIyNSA1LjI1M2MyLjEwOCAwIDMuNTI5Ljg5MiA0LjM0IDEuNjM4bDMuMTY3LTMuMDMxQzE3Ljc4NyAyLjA4OCAxNS4yNTUgMSAxMi4yMjUgMSA3LjgzNCAxIDQuMDQzIDMuNDY5IDIuMTk3IDcuMDYybDMuNjMgMi43NjNhNi43NyA2Ljc3IDAgMDE2LjM5OC00LjU3MnoiIGZpbGw9IiNFQjQzMzUiPjwvcGF0aD48L3N2Zz4=",openrouter:"data:image/svg+xml;base64,PHN2ZyBmaWxsPSJjdXJyZW50Q29sb3IiIGZpbGwtcnVsZT0iZXZlbm9kZCIgaGVpZ2h0PSIxZW0iIHN0eWxlPSJmbGV4Om5vbmU7bGluZS1oZWlnaHQ6MSIgdmlld0JveD0iMCAwIDI0IDI0IiB3aWR0aD0iMWVtIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjx0aXRsZT5PcGVuUm91dGVyPC90aXRsZT48cGF0aCBkPSJNMTYuODA0IDEuOTU3bDcuMjIgNC4xMDV2LjA4N0wxNi43MyAxMC4yMWwuMDE3LTIuMTE3LS44MjEtLjAzYy0xLjA1OS0uMDI4LTEuNjExLjAwMi0yLjI2OC4xMS0xLjA2NC4xNzUtMi4wMzguNTc3LTMuMTQ3IDEuMzUyTDguMzQ1IDExLjAzYy0uMjg0LjE5NS0uNDk1LjMzNi0uNjguNDU1bC0uNTE1LjMyMi0uMzk3LjIzNC4zODUuMjMuNTMuMzM4Yy40NzYuMzE0IDEuMTcuNzk2IDIuNzAxIDEuODY2IDEuMTEuNzc1IDIuMDgzIDEuMTc3IDMuMTQ3IDEuMzUybC4zLjA0NWMuNjk0LjA5MSAxLjM3NS4wOTQgMi44MjUuMDMzbC4wMjItMi4xNTkgNy4yMiA0LjEwNXYuMDg3TDE2LjU4OSAyMmwuMDE0LTEuODYyLS42MzUuMDIyYy0xLjM4Ni4wNDItMi4xMzcuMDAyLTMuMTM4LS4xNjItMS42OTQtLjI4LTMuMjYtLjkyNi00Ljg4MS0yLjA1OWwtMi4xNTgtMS41YTIxLjk5NyAyMS45OTcgMCAwMC0uNzU1LS40OThsLS40NjctLjI4YTU1LjkyNyA1NS45MjcgMCAwMC0uNzYtLjQzQzIuOTA4IDE0LjczLjU2MyAxNC4xMTYgMCAxNC4xMTZWOS44ODhsLjE0LjAwNGMuNTY0LS4wMDcgMi45MS0uNjIyIDMuODA5LTEuMTI0bDEuMDE2LS41OC40MzgtLjI3NGMuNDI4LS4yOCAxLjA3Mi0uNzI2IDIuNjg2LTEuODUzIDEuNjIxLTEuMTMzIDMuMTg2LTEuNzggNC44ODEtMi4wNTkgMS4xNTItLjE5IDEuOTc0LS4yMTMgMy44MTQtLjEzOGwuMDItMS45MDd6Ij48L3BhdGg+PC9zdmc+",siliconflow:"data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPlNpbGljb25DbG91ZDwvdGl0bGU+PHBhdGggY2xpcC1ydWxlPSJldmVub2RkIiBkPSJNMjIuOTU2IDYuNTIxSDEyLjUyMmMtLjU3NyAwLTEuMDQ0LjQ2OC0xLjA0NCAxLjA0NHYzLjEzYzAgLjU3Ny0uNDY2IDEuMDQ0LTEuMDQzIDEuMDQ0SDEuMDQ0Yy0uNTc3IDAtMS4wNDQuNDY3LTEuMDQ0IDEuMDQ0djQuMTc0QzAgMTcuNTMzLjQ2NyAxOCAxLjA0NCAxOGgxMC40MzRjLjU3NyAwIDEuMDQ0LS40NjcgMS4wNDQtMS4wNDN2LTMuMTNjMC0uNTc4LjQ2Ni0xLjA0NCAxLjA0My0xLjA0NGg5LjM5MWMuNTc3IDAgMS4wNDQtLjQ2NyAxLjA0NC0xLjA0NFY3LjU2NWMwLS41NzYtLjQ2Ny0xLjA0NC0xLjA0NC0xLjA0NHoiIGZpbGw9IiM2RTI5RjYiIGZpbGwtcnVsZT0iZXZlbm9kZCI+PC9wYXRoPjwvc3ZnPg==",qwen:"data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPlF3ZW48L3RpdGxlPjxwYXRoIGQ9Ik0xMi42MDQgMS4zNGMuMzkzLjY5Ljc4NCAxLjM4MiAxLjE3NCAyLjA3NWEuMTguMTggMCAwMC4xNTcuMDkxaDUuNTUyYy4xNzQgMCAuMzIyLjExLjQ0Ni4zMjdsMS40NTQgMi41N2MuMTkuMzM3LjI0LjQ3OC4wMjQuODM3LS4yNi40My0uNTEzLjg2NC0uNzYgMS4zbC0uMzY3LjY1OGMtLjEwNi4xOTYtLjIyMy4yOC0uMDQuNTEybDIuNjUyIDQuNjM3Yy4xNzIuMzAxLjExMS40OTQtLjA0My43Ny0uNDM3Ljc4NS0uODgyIDEuNTY0LTEuMzM1IDIuMzQtLjE1OS4yNzItLjM1Mi4zNzUtLjY4LjM3LS43NzctLjAxNi0xLjU1Mi0uMDEtMi4zMjcuMDE2YS4wOTkuMDk5IDAgMDAtLjA4MS4wNSA1NzUuMDk3IDU3NS4wOTcgMCAwMS0yLjcwNSA0Ljc0Yy0uMTY5LjI5My0uMzguMzYzLS43MjUuMzY0LS45OTcuMDAzLTIuMDAyLjAwNC0zLjAxNy4wMDJhLjUzNy41MzcgMCAwMS0uNDY1LS4yNzFsLTEuMzM1LTIuMzIzYS4wOS4wOSAwIDAwLS4wODMtLjA0OUg0Ljk4MmMtLjI4NS4wMy0uNTUzLS4wMDEtLjgwNS0uMDkybC0xLjYwMy0yLjc3YS41NDMuNTQzIDAgMDEtLjAwMi0uNTRsMS4yMDctMi4xMmEuMTk4LjE5OCAwIDAwMC0uMTk3IDU1MC45NTEgNTUwLjk1MSAwIDAxLTEuODc1LTMuMjcybC0uNzktMS4zOTVjLS4xNi0uMzEtLjE3My0uNDk2LjA5NS0uOTY1LjQ2NS0uODEzLjkyNy0xLjYyNSAxLjM4Ny0yLjQzNi4xMzItLjIzNC4zMDQtLjMzNC41ODQtLjMzNWEzMzguMyAzMzguMyAwIDAxMi41ODktLjAwMS4xMjQuMTI0IDAgMDAuMTA3LS4wNjNsMi44MDYtNC44OTVhLjQ4OC40ODggMCAwMS40MjItLjI0NmMuNTI0LS4wMDEgMS4wNTMgMCAxLjU4My0uMDA2TDExLjcwNCAxYy4zNDEtLjAwMy43MjQuMDMyLjkuMzR6bS0zLjQzMi40MDNhLjA2LjA2IDAgMDAtLjA1Mi4wM0w2LjI1NCA2Ljc4OGEuMTU3LjE1NyAwIDAxLS4xMzUuMDc4SDMuMjUzYy0uMDU2IDAtLjA3LjAyNS0uMDQxLjA3NGw1LjgxIDEwLjE1NmMuMDI1LjA0Mi4wMTMuMDYyLS4wMzQuMDYzbC0yLjc5NS4wMTVhLjIxOC4yMTggMCAwMC0uMi4xMTZsLTEuMzIgMi4zMWMtLjA0NC4wNzgtLjAyMS4xMTguMDY4LjExOGw1LjcxNi4wMDhjLjA0NiAwIC4wOC4wMi4xMDQuMDYxbDEuNDAzIDIuNDU0Yy4wNDYuMDgxLjA5Mi4wODIuMTM5IDBsNS4wMDYtOC43Ni43ODMtMS4zODJhLjA1NS4wNTUgMCAwMS4wOTYgMGwxLjQyNCAyLjUzYS4xMjIuMTIyIDAgMDAuMTA3LjA2MmwyLjc2My0uMDJhLjA0LjA0IDAgMDAuMDM1LS4wMi4wNDEuMDQxIDAgMDAwLS4wNGwtMi45LTUuMDg2YS4xMDguMTA4IDAgMDEwLS4xMTNsLjI5My0uNTA3IDEuMTItMS45NzdjLjAyNC0uMDQxLjAxMi0uMDYyLS4wMzUtLjA2Mkg5LjJjLS4wNTkgMC0uMDczLS4wMjYtLjA0My0uMDc3bDEuNDM0LTIuNTA1YS4xMDcuMTA3IDAgMDAwLS4xMTRMOS4yMjUgMS43NzRhLjA2LjA2IDAgMDAtLjA1My0uMDMxem02LjI5IDguMDJjLjA0NiAwIC4wNTguMDIuMDM0LjA2bC0uODMyIDEuNDY1LTIuNjEzIDQuNTg1YS4wNTYuMDU2IDAgMDEtLjA1LjAyOS4wNTguMDU4IDAgMDEtLjA1LS4wMjlMOC40OTggOS44NDFjLS4wMi0uMDM0LS4wMS0uMDUyLjAyOC0uMDU0bC4yMTYtLjAxMiA2LjcyMi0uMDEyeiIgZmlsbD0idXJsKCNsb2JlLWljb25zLXF3ZW4tZmlsbCkiIGZpbGwtcnVsZT0ibm9uemVybyI+PC9wYXRoPjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0ibG9iZS1pY29ucy1xd2VuLWZpbGwiIHgxPSIwJSIgeDI9IjEwMCUiIHkxPSIwJSIgeTI9IjAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjNjMzNkU3IiBzdG9wLW9wYWNpdHk9Ii44NCI+PC9zdG9wPjxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iIzZGNjlGNyIgc3RvcC1vcGFjaXR5PSIuODQiPjwvc3RvcD48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48L3N2Zz4=",zhipu:"data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPlpoaXB1PC90aXRsZT48cGF0aCBkPSJNMTEuOTkxIDIzLjUwM2EuMjQuMjQgMCAwMC0uMjQ0LjI0OC4yNC4yNCAwIDAwLjI0NC4yNDkuMjQuMjQgMCAwMC4yNDUtLjI0OS4yNC4yNCAwIDAwLS4yMi0uMjQ3bC0uMDI1LS4wMDF6TTkuNjcxIDUuMzY1YTEuNjk3IDEuNjk3IDAgMDExLjA5OSAyLjEzMmwtLjA3MS4xNzItLjAxNi4wNC0uMDE4LjA1NGMtLjA3LjE2LS4xMDQuMzItLjEwNC40OTgtLjAzNS43MS40NyAxLjI3OSAxLjE4NiAxLjMxNGguMzY2YzEuMzA5LjA1MyAyLjMzOCAxLjE3MyAyLjI4NiAyLjUyMy0uMDUyIDEuMzMyLTEuMTUyIDIuMzgtMi40NzggMi4zMjdoLS4xNzRjLS43MTUuMDE4LTEuMjc0LjY0LTEuMjM5IDEuMzY4IDAgLjEyNC4wMTguMjMuMDUzLjMzNy4yMDkuMzczLjU0LjY1OC45Ni44Ljc1LjIzIDEuNTE3LS4xMjUgMS45LS43ODJsLjAxOC0uMDM1Yy40MDItLjY0IDEuMTctLjk2IDEuOTItLjcxMS44NTQuMjg0IDEuMzc4IDEuMjI2IDEuMDk5IDIuMTY3YTEuNjYxIDEuNjYxIDAgMDEtMi4wNzcgMS4xMDIgMS43MTEgMS43MTEgMCAwMS0uOTA3LS43MTFsLS4wMTctLjAzNWMtLjItLjMyMy0uNDYzLS41OC0uODUxLS43MTFsLS4wNTYtLjAxOGExLjY0NiAxLjY0NiAwIDAwLTEuOTU0Ljc0NiAxLjY2IDEuNjYgMCAwMS0xLjA2NS43NjQgMS42NzcgMS42NzcgMCAwMS0xLjk4OS0xLjI3OWMtLjIwOS0uOTA2LjMzMi0xLjgzIDEuMjU3LTIuMDQzYTEuNTEgMS41MSAwIDAxLjI5Ni0uMDM1aC4wMThjLjY4LS4wNzEgMS4xNTEtLjYyMiAxLjExNi0xLjMzM2ExLjMwNyAxLjMwNyAwIDAwLS4yMjctLjY5MyAyLjUxNSAyLjUxNSAwIDAxLS4zNjYtMS40MDMgMi4zOSAyLjM5IDAgMDEuMzY2LTEuMjA4Yy4xNC0uMTk1LjIxLS40NDQuMjI3LS42OTMuMDE4LS43MS0uNTA2LTEuMjYxLTEuMTg2LTEuMzMybC0uMDctLjAxOGExLjQzIDEuNDMgMCAwMS0uMjk5LS4wN2wtLjA1LS4wMTlhMS43IDEuNyAwIDAxLTEuMDQ3LTIuMTE0IDEuNjggMS42OCAwIDAxMi4wOTQtMS4xMDF6bS01LjU3NSAxMC4xMWMuMjYtLjI2NC42MzktLjM2Ny45OTQtLjI3LjM1NS4wOTYuNjMzLjM3OS43MjguNzQuMDk1LjM2Mi0uMDA3Ljc0OC0uMjY3IDEuMDEzLS40MDIuNDEtMS4wNTMuNDEtMS40NTUgMGExLjA2MiAxLjA2MiAwIDAxMC0xLjQ4MnptMTQuODQ1LS4yOTRjLjM1OS0uMDkuNzM4LjAyNC45OTIuMjk3LjI1NC4yNzQuMzQ0LjY2NS4yMzcgMS4wMjUtLjEwNy4zNi0uMzk2LjYzNC0uNzU2LjcxOC0uNTUxLjEyOC0xLjEtLjIyLTEuMjMtLjc4MWExLjA1IDEuMDUgMCAwMS43NTctMS4yNnptLS4wNjQtNC4zOWMuMzE0LjMyLjQ5Ljc1My40OSAxLjIwNiAwIC40NTItLjE3Ni44ODYtLjQ5IDEuMjA2LS4zMTUuMzItLjc0LjUtMS4xODUuNS0uNDQ0IDAtLjg3LS4xOC0xLjE4NC0uNWExLjcyNyAxLjcyNyAwIDAxMC0yLjQxMiAxLjY1NCAxLjY1NCAwIDAxMi4zNjkgMHptLTExLjI0My4xNjNjLjM2NC40ODQuNDQ3IDEuMTI4LjIxOCAxLjY5MWExLjY2NSAxLjY2NSAwIDAxLTIuMTg4LjkyM2MtLjg1NS0uMzYtMS4yNi0xLjM1OC0uOTA3LTIuMjI4YTEuNjggMS42OCAwIDAxMS4zMy0xLjAzOGMuNTkzLS4wOCAxLjE4My4xNjkgMS41NDcuNjUyem0xMS41NDUtNC4yMjFjLjM2OCAwIC43MDguMi44OTIuNTI0LjE4NC4zMjQuMTg0LjcyNCAwIDEuMDQ4YTEuMDI2IDEuMDI2IDAgMDEtLjg5Mi41MjRjLS41NjggMC0xLjAzLS40Ny0xLjAzLTEuMDQ4IDAtLjU3OS40NjItMS4wNDggMS4wMy0xLjA0OHptLTE0LjM1OCAwYy4zNjggMCAuNzA3LjIuODkxLjUyNC4xODQuMzI0LjE4NC43MjQgMCAxLjA0OGExLjAyNiAxLjAyNiAwIDAxLS44OTEuNTI0Yy0uNTY5IDAtMS4wMy0uNDctMS4wMy0xLjA0OCAwLS41NzkuNDYxLTEuMDQ4IDEuMDMtMS4wNDh6bTEwLjAzMS0xLjQ3NWMuOTI1IDAgMS42NzUuNzY0IDEuNjc1IDEuNzA2cy0uNzUgMS43MDUtMS42NzUgMS43MDUtMS42NzQtLjc2My0xLjY3NC0xLjcwNWMwLS45NDIuNzUtMS43MDYgMS42NzQtMS43MDZ6bS0yLjYyNi0uNjg0Yy4zNjItLjA4Mi42NTMtLjM1Ni43NjEtLjcxOGExLjA2MiAxLjA2MiAwIDAwLS4yMzgtMS4wMjggMS4wMTcgMS4wMTcgMCAwMC0uOTk2LS4yOTRjLS41NDcuMTQtLjg4MS43LS43NTIgMS4yNTcuMTMuNTU4LjY3NS45MDcgMS4yMjUuNzgzem0wIDE2Ljg3NmMuMzU5LS4wODcuNjQ0LS4zNi43NS0uNzJhMS4wNjIgMS4wNjIgMCAwMC0uMjM3LTEuMDE5IDEuMDE4IDEuMDE4IDAgMDAtLjk4NS0uMzAxIDEuMDM3IDEuMDM3IDAgMDAtLjc2Mi43MTdjLS4xMDguMzYxLS4wMTcuNzU0LjIzOSAxLjAyOC4yNDUuMjYzLjYwNi4zNzcuOTUzLjMwNWwuMDQzLS4wMXpNMTcuMTkgMy41YS42MzEuNjMxIDAgMDAuNjI4LS42NGMwLS4zNTUtLjI3OS0uNjQtLjYyOC0uNjRhLjYzMS42MzEgMCAwMC0uNjI4LjY0YzAgLjM1NS4yOC42NC42MjguNjR6bS0xMC4zOCAwYS42MzEuNjMxIDAgMDAuNjI4LS42NGMwLS4zNTUtLjI4LS42NC0uNjI4LS42NGEuNjMxLjYzMSAwIDAwLS42MjguNjRjMCAuMzU1LjI3OS42NC42MjguNjR6bS01LjE4MiA3Ljg1MmEuNjMxLjYzMSAwIDAwLS42MjguNjRjMCAuMzU0LjI4LjYzOS42MjguNjM5YS42My42MyAwIDAwLjYyNy0uNjA2bC4wMDEtLjAzNGEuNjIuNjIgMCAwMC0uNjI4LS42NHptNS4xODIgOS4xM2EuNjMxLjYzMSAwIDAwLS42MjguNjRjMCAuMzU1LjI3OS42NC42MjguNjRhLjYzMS42MzEgMCAwMC42MjgtLjY0YzAtLjM1NS0uMjgtLjY0LS42MjgtLjY0em0xMC4zOC4wMThhLjYzMS42MzEgMCAwMC0uNjI4LjY0YzAgLjM1NS4yOC42NC42MjguNjRhLjYzMS42MzEgMCAwMC42MjgtLjY0YzAtLjM1NS0uMjc5LS42NC0uNjI4LS42NHptNS4xODItOS4xNDhhLjYzMS42MzEgMCAwMC0uNjI4LjY0YzAgLjM1NC4yNzkuNjM5LjYyOC42MzlhLjYzMS42MzEgMCAwMC42MjgtLjY0YzAtLjM1NS0uMjgtLjY0LS42MjgtLjY0em0tLjM4NC00Ljk5MmEuMjQuMjQgMCAwMC4yNDQtLjI0OS4yNC4yNCAwIDAwLS4yNDQtLjI0OS4yNC4yNCAwIDAwLS4yNDQuMjQ5YzAgLjE0Mi4xMjIuMjQ5LjI0NC4yNDl6TTExLjk5MS40OTdhLjI0LjI0IDAgMDAuMjQ1LS4yNDhBLjI0LjI0IDAgMDAxMS45OSAwYS4yNC4yNCAwIDAwLS4yNDQuMjQ5YzAgLjEzMy4xMDguMjM2LjIyMy4yNDdsLjAyMS4wMDF6TTIuMDExIDYuMzZhLjI0LjI0IDAgMDAuMjQ1LS4yNDkuMjQuMjQgMCAwMC0uMjQ0LS4yNDkuMjQuMjQgMCAwMC0uMjQ0LjI0OS4yNC4yNCAwIDAwLjI0NC4yNDl6bTAgMTEuMjYzYS4yNC4yNCAwIDAwLS4yNDMuMjQ4LjI0LjI0IDAgMDAuMjQ0LjI0OS4yNC4yNCAwIDAwLjI0NC0uMjQ5LjI1Mi4yNTIgMCAwMC0uMjQ0LS4yNDh6bTE5Ljk5NS0uMDE4YS4yNC4yNCAwIDAwLS4yNDUuMjQ4LjI0LjI0IDAgMDAuMjQ1LjI1LjI0LjI0IDAgMDAuMjQ0LS4yNS4yNTIuMjUyIDAgMDAtLjI0NC0uMjQ4eiIgZmlsbD0iIzM4NTlGRiIgZmlsbC1ydWxlPSJub256ZXJvIj48L3BhdGg+PC9zdmc+",minimax:"data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPk1pbmltYXg8L3RpdGxlPjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0ibG9iZS1pY29ucy1taW5pbWF4LWZpbGwiIHgxPSIwJSIgeDI9IjEwMC4xODIlIiB5MT0iNTAuMDU3JSIgeTI9IjUwLjA1NyUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNFMjE2N0UiPjwvc3RvcD48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNGRTYwM0MiPjwvc3RvcD48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cGF0aCBkPSJNMTYuMjc4IDJjMS4xNTYgMCAyLjA5My45MjcgMi4wOTMgMi4wN3YxMi41MDFhLjc0Ljc0IDAgMDAuNzQ0LjcwOS43NC43NCAwIDAwLjc0My0uNzA5VjkuMDk5YTIuMDYgMi4wNiAwIDAxMi4wNzEtMi4wNDlBMi4wNiAyLjA2IDAgMDEyNCA5LjF2Ni41NjFhLjY0OS42NDkgMCAwMS0uNjUyLjY0NS42NDkuNjQ5IDAgMDEtLjY1My0uNjQ1VjkuMWEuNzYyLjc2MiAwIDAwLS43NjYtLjc1OC43NjIuNzYyIDAgMDAtLjc2Ni43NTh2Ny40NzJhMi4wMzcgMi4wMzcgMCAwMS0yLjA0OCAyLjAyNiAyLjAzNyAyLjAzNyAwIDAxLTIuMDQ4LTIuMDI2di0xMi41YS43ODUuNzg1IDAgMDAtLjc4OC0uNzUzLjc4NS43ODUgMCAwMC0uNzg5Ljc1MmwtLjAwMSAxNS45MDRBMi4wMzcgMi4wMzcgMCAwMTEzLjQ0MSAyMmEyLjAzNyAyLjAzNyAwIDAxLTIuMDQ4LTIuMDI2VjE4LjA0YzAtLjM1Ni4yOTItLjY0NS42NTItLjY0NS4zNiAwIC42NTIuMjg5LjY1Mi42NDV2MS45MzRjMCAuMjYzLjE0Mi41MDYuMzcyLjYzOC4yMy4xMzEuNTE0LjEzMS43NDQgMGEuNzM0LjczNCAwIDAwLjM3Mi0uNjM4VjQuMDdjMC0xLjE0My45MzctMi4wNyAyLjA5My0yLjA3em0tNS42NzQgMGMxLjE1NiAwIDIuMDkzLjkyNyAyLjA5MyAyLjA3djExLjUyM2EuNjQ4LjY0OCAwIDAxLS42NTIuNjQ1LjY0OC42NDggMCAwMS0uNjUyLS42NDVWNC4wN2EuNzg1Ljc4NSAwIDAwLS43ODktLjc4Ljc4NS43ODUgMCAwMC0uNzg5Ljc4djE0LjAxM2EyLjA2IDIuMDYgMCAwMS0yLjA3IDIuMDQ4IDIuMDYgMi4wNiAwIDAxLTIuMDcxLTIuMDQ4VjkuMWEuNzYyLjc2MiAwIDAwLS43NjYtLjc1OC43NjIuNzYyIDAgMDAtLjc2Ni43NTh2My44YTIuMDYgMi4wNiAwIDAxLTIuMDcxIDIuMDQ5QTIuMDYgMi4wNiAwIDAxMCAxMi45di0xLjM3OGMwLS4zNTcuMjkyLS42NDYuNjUyLS42NDYuMzYgMCAuNjUzLjI5LjY1My42NDZWMTIuOWMwIC40MTguMzQzLjc1Ny43NjYuNzU3cy43NjYtLjMzOS43NjYtLjc1N1Y5LjA5OWEyLjA2IDIuMDYgMCAwMTIuMDctMi4wNDggMi4wNiAyLjA2IDAgMDEyLjA3MSAyLjA0OHY4Ljk4NGMwIC40MTkuMzQzLjc1OC43NjcuNzU4LjQyMyAwIC43NjYtLjMzOS43NjYtLjc1OFY0LjA3YzAtMS4xNDMuOTM3LTIuMDcgMi4wOTMtMi4wN3oiIGZpbGw9InVybCgjbG9iZS1pY29ucy1taW5pbWF4LWZpbGwpIiBmaWxsLXJ1bGU9Im5vbnplcm8iPjwvcGF0aD48L3N2Zz4=",stepfun:"data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGcgY2xpcC1wYXRoPSJ1cmwoI2NsaXAwXzEwNjgzXzMxMTEpIj4KPHBhdGggZD0iTTIzLjI5NjQgMTQuNzM5NUgxNy40NDQ4VjIzLjI5ODFIMTIuOTU2NVYxMy4yMzA3SDIzLjI5NjRWMTQuNzM5NVpNMjAuMzU1IDguMjQzNDFIMTAuNDY4M1YyMC4xMTY1SDAuNjM5MTZWMTUuNzZINS45NDM4NUw1Ljk0Njc4IDMuOTA5NDJIMjAuMzU1VjguMjQzNDFaTTQuMDIwMDIgMTIuNTg4MUgyLjQ4Nzc5VjIuNTE2ODVINC4wMjAwMlYxMi41ODgxWk0yMi40MjcyIDEuNjA5NjJIMjMuMzM5NFYyLjUxNTg3SDIyLjQyNzJWNC4zMjU0NEgyMS41MTlWMi41MTU4N0gxOS42OTk3VjEuNjA5NjJIMjEuNTE5VjAuNzAyMzkzSDIyLjQyNzJWMS42MDk2MloiIGZpbGw9IiMwMDVBRkYiLz4KPC9nPgo8ZGVmcz4KPGNsaXBQYXRoIGlkPSJjbGlwMF8xMDY4M18zMTExIj4KPHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJ3aGl0ZSIvPgo8L2NsaXBQYXRoPgo8L2RlZnM+Cjwvc3ZnPgo=",xiaomimimo:"data:image/svg+xml;base64,PHN2ZyBmaWxsPSJjdXJyZW50Q29sb3IiIGhlaWdodD0iMWVtIiBzdHlsZT0iZmxleDpub25lO2xpbmUtaGVpZ2h0OjEiIHZpZXdCb3g9IjAgMCAxNTIgMTMyIiB3aWR0aD0iMWVtIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjx0aXRsZT5Mb2dvPC90aXRsZT48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMCA1OCkiPjxwYXRoIGQ9Ik02NC45MDA4IDAuMDAxMzg3NjlDNjQuNjg3NSAtMC4wMDQwMDY5NSA2NC40NzUzIDAuMDMzOTkwNCA2NC4yNzcxIDAuMTEzMDc1QzY0LjA3ODkgMC4xOTIxNTkgNjMuODk4OCAwLjMxMDY4MiA2My43NDc4IDAuNDYxNDU0QzYzLjU5NjggMC42MTIyMjYgNjMuNDc4IDAuNzkyMTA1IDYzLjM5ODUgMC45OTAxNzhDNjMuMzE5MSAxLjE4ODI1IDYzLjI4MDggMS40MDAzOSA2My4yODU4IDEuNjEzNzNDNjMuMjg1OCAyLjA0NTUzIDYzLjQ1NzQgMi40NTk2NCA2My43NjI3IDIuNzY0OTdDNjQuMDY4IDMuMDcwMyA2NC40ODIxIDMuMjQxODMgNjQuOTEzOSAzLjI0MTgzQzY1LjM0NTcgMy4yNDE4MyA2NS43NTk5IDMuMDcwMyA2Ni4wNjUyIDIuNzY0OTdDNjYuMzcwNSAyLjQ1OTY0IDY2LjU0MiAyLjA0NTUzIDY2LjU0MiAxLjYxMzczQzY2LjU0NzMgMS4zOTgxMSA2Ni41MDgyIDEuMTgzNzEgNjYuNDI3MSAwLjk4MzgxMkM2Ni4zNDYxIDAuNzgzOTE3IDY2LjIyNDkgMC42MDI3ODMgNjYuMDcxMSAwLjQ1MTYyOUM2NS45MTcyIDAuMzAwNDc2IDY1LjczNCAwLjE4MjUyMyA2NS41MzI3IDAuMTA1MDc2QzY1LjMzMTQgMC4wMjc2MjkgNjUuMTE2MyAtMC4wMDc2NjI0NyA2NC45MDA4IDAuMDAxMzg3NjlaIj48L3BhdGg+PHBhdGggZD0iTTY2LjE2ODkgNC41NTQ2OUg2My42Mjk2VjE1LjcyNTVINjYuMTY4OVY0LjU1NDY5WiI+PC9wYXRoPjxwYXRoIGQ9Ik0zOC44NjQzIDQuMDY2NDFDMzUuMzU4NiA0LjA2NjQxIDMzLjA4NzIgNi43NjA2NSAzMy4wODcyIDEwLjAzMjZDMzMuMDg3MiAxMy4zMDQ1IDM1LjM3MTcgMTYuMDAxNCAzOC44NjQzIDE2LjAwMTRDNDIuMzU2OCAxNi4wMDE0IDQ0LjY0MTQgMTMuMzA3MiA0NC42NDE0IDEwLjAzMjZDNDQuNjQxNCA2Ljc1ODAyIDQyLjM2NzMgNC4wNjY0MSAzOC44NjQzIDQuMDY2NDFaTTM4Ljg2NDMgMTMuNjkzMkMzNy4wMjYxIDEzLjY5MzIgMzUuNTg0NCAxMi4zNDA4IDM1LjU4NDQgMTAuMDMyNkMzNS41ODQ0IDcuNzI0MzcgMzcuMDI2MSA2LjM3NDYzIDM4Ljg2NDMgNi4zNzQ2M0M0MC43MDI1IDYuMzc0NjMgNDIuMTQxNSA3LjcyNyA0Mi4xNDE1IDEwLjAzMjZDNDIuMTQxNSAxMi4zMzgyIDQwLjcwMjUgMTMuNjkzMiAzOC44NjQzIDEzLjY5MzJaIj48L3BhdGg+PHBhdGggZD0iTTE3Ljc5MDkgMC4wMDA4OTA2OTNDMTcuNTc2NSAtMC4wMDYzMjE4MSAxNy4zNjI5IDAuMDMwMzMwNSAxNy4xNjMxIDAuMTA4NjAxQzE2Ljk2MzQgMC4xODY4NzIgMTYuNzgxNyAwLjMwNTExMSAxNi42MjkzIDAuNDU2MDczQzE2LjQ3NjggMC42MDcwMzQgMTYuMzU2OCAwLjc4NzUzNiAxNi4yNzY2IDAuOTg2NTE1QzE2LjE5NjQgMS4xODU0OSAxNi4xNTc3IDEuMzk4NzYgMTYuMTYyOCAxLjYxMzIzQzE2LjE2MjggMi4wNDUwMyAxNi4zMzQzIDIuNDU5MTQgMTYuNjM5NyAyLjc2NDQ3QzE2Ljk0NSAzLjA2OTggMTcuMzU5MSAzLjI0MTMzIDE3Ljc5MDkgMy4yNDEzM0MxOC4yMjI3IDMuMjQxMzMgMTguNjM2OCAzLjA2OTggMTguOTQyMSAyLjc2NDQ3QzE5LjI0NzUgMi40NTkxNCAxOS40MTkgMi4wNDUwMyAxOS40MTkgMS42MTMyM0MxOS40MjQxIDEuMzk4NzYgMTkuMzg1NCAxLjE4NTQ5IDE5LjMwNTIgMC45ODY1MTVDMTkuMjI1IDAuNzg3NTM2IDE5LjEwNSAwLjYwNzAzNCAxOC45NTI1IDAuNDU2MDczQzE4LjgwMDEgMC4zMDUxMTEgMTguNjE4NCAwLjE4Njg3MiAxOC40MTg3IDAuMTA4NjAxQzE4LjIxODkgMC4wMzAzMzA1IDE4LjAwNTMgLTAuMDA2MzIxODEgMTcuNzkwOSAwLjAwMDg5MDY5M1oiPjwvcGF0aD48cGF0aCBkPSJNMTEuNzU2NCAxNS43MjUyTDAuMzU5NzQxIDEuNjEzMjhIMy41MTYxNUwxNS4xMTI0IDE1LjcyNTJIMTEuNzU2NFoiPjwvcGF0aD48cGF0aCBkPSJNMy4zNTg2MSAxNS43MjUyTDE0Ljc1MjcgMS42MTMyOEgxMS41OTYzTDAgMTUuNzI1MkgzLjM1ODYxWiI+PC9wYXRoPjxwYXRoIGQ9Ik0xOS4wNjE4IDQuNTU0NjlIMTYuNTIyNVYxNS43MjU1SDE5LjA2MThWNC41NTQ2OVoiPjwvcGF0aD48cGF0aCBkPSJNMjYuNTkwNSAzLjc4OTA2QzI0LjUwNTUgMy43ODkwNiAyMy4wNDU0IDQuMzE0MjYgMjEuNzAwOSA1LjM2NDY0TDIyLjY5ODggNy4yMDI4MkMyMy42MzI4IDYuNDE2NTEgMjQuODA1NSA1Ljk2OTQ4IDI2LjAyNTkgNS45MzQ0OEMyNy43MzU0IDUuOTM0NDggMjguNzU0MyA2LjgyOTkzIDI4Ljc1NDMgOC4zODk3NUgyNi44MzQ3QzIzLjAxMzkgOC4zODk3NSAyMC45MTg0IDEwLjI2OTkgMjEuMTQ0MiAxMi44NTM5QzIxLjQwNjggMTUuOTIxIDI0LjYxNTggMTYuMDA1IDI0Ljk4MDggMTYuMDA1QzI2LjU1NjMgMTYuMDA1IDI4LjAzMjEgMTUuNDc5OSAyOC43NTQzIDE0LjUyMTRWMTUuNzE4OEgzMS4yOTM2VjguMzc2NjJDMzEuMjkzNiA3LjEyNDA0IDMwLjcwMDEgMy43ODkwNiAyNi41OTA1IDMuNzg5MDZaTTI4Ljc1NDMgMTEuMTQxOEMyOC43MjMxIDExLjg2NTggMjguNDEyOCAxMi41NDk2IDI3Ljg4ODUgMTMuMDVDMjcuMzY0MiAxMy41NTAzIDI2LjY2NjYgMTMuODI4MiAyNS45NDE5IDEzLjgyNTVDMjQuNzM5MiAxMy44MjU1IDIzLjkzMDQgMTMuMjUwNCAyMy44NDExIDEyLjMzNjZDMjMuNzUxOCAxMS40MjI3IDI0LjU5MjEgMTAuMjgzMSAyNy41MTc0IDEwLjI4MzFIMjguNzU2OUwyOC43NTQzIDExLjE0MThaIj48L3BhdGg+PHBhdGggZD0iTTU3LjcyMzggNC4xMTA4N0M1Ny4wNDk5IDQuMDkxNTggNTYuMzgzNyA0LjI1ODkzIDU1Ljc5ODkgNC41OTQ0NEM1NS4yMTQxIDQuOTI5OTQgNTQuNzMzNCA1LjQyMDU0IDU0LjQwOTkgNi4wMTIwN0M1My43OTU0IDQuNjQzOTQgNTIuNzkyMyA0LjExMDg3IDUxLjY4NjggNC4xMTA4N0M1MS4xNjg4IDQuMTMxNjUgNTAuNjYyNiA0LjI3MTMgNTAuMjA3MiA0LjUxOTAxQzQ5Ljc1MTkgNC43NjY3MiA0OS4zNTk2IDUuMTE1ODUgNDkuMDYwOCA1LjUzOTRWNC41NTIwM0g0Ni41MjE1VjE1LjcyNTVINDkuMDYwOFY5LjExODU5QzQ5LjA2MDggOC4yNTQ2NCA0OS4wNjA4IDYuNDAwNzEgNTAuODA0NCA2LjQwMDcxQzUyLjU0ODEgNi40MDA3MSA1Mi41NDgxIDguMjU0NjUgNTIuNTQ4MSA4LjcyNzMyVjE1LjcyNTVINTUuMDEzOVY4LjcyNzMyQzU1LjAxMzkgOC4yNTQ2NSA1NS4wMTM5IDYuNDAwNzEgNTYuNzU3NSA2LjQwMDcxQzU4LjUwMTEgNi40MDA3MSA1OC41MDM4IDguMjU0NjQgNTguNTAzOCA5LjExODU5VjE1LjcyNTVINjEuMDQwNFY4LjQwMTdDNjEuMDUzNiA1LjM5NzYgNTkuNjA5MyA0LjExMDg3IDU3LjcyMzggNC4xMTA4N1oiPjwvcGF0aD48cGF0aCBkPSJNNzMuNzQ0OSAxNS45OTg3QzczLjQwODMgMTUuOTk4IDczLjA4NTcgMTUuODYzOCA3Mi44NDc5IDE1LjYyNTZDNzIuNjEwMSAxNS4zODczIDcyLjQ3NjYgMTUuMDY0NCA3Mi40NzY2IDE0LjcyNzhWNy4xNjVDNzIuNDkxNCA2LjgzNzU3IDcyLjYzMiA2LjUyODQ4IDcyLjg2OSA2LjMwMjAzQzczLjEwNTkgNi4wNzU1OSA3My40MjExIDUuOTQ5MjIgNzMuNzQ4OCA1Ljk0OTIyQzc0LjA3NjYgNS45NDkyMiA3NC4zOTE4IDYuMDc1NTkgNzQuNjI4NyA2LjMwMjAzQzc0Ljg2NTcgNi41Mjg0OCA3NS4wMDYyIDYuODM3NTcgNzUuMDIxMSA3LjE2NVYxNC43Mjc4Qzc1LjAyMDggMTQuODk1IDc0Ljk4NzUgMTUuMDYwNiA3NC45MjMyIDE1LjIxNUM3NC44NTg4IDE1LjM2OTMgNzQuNzY0NyAxNS41MDk1IDc0LjY0NjIgMTUuNjI3NkM3NC41Mjc3IDE1Ljc0NTYgNzQuMzg3MSAxNS44MzkxIDc0LjIzMjUgMTUuOTAyOEM3NC4wNzc4IDE1Ljk2NjUgNzMuOTEyMiAxNS45OTkxIDczLjc0NDkgMTUuOTk4N1oiPjwvcGF0aD48cGF0aCBkPSJNODcuMzYwNyAxNS45OTkzQzg3LjAyMzQgMTUuOTk5MyA4Ni42OTk4IDE1Ljg2NTUgODYuNDYxMSAxNS42MjcyQzg2LjIyMjMgMTUuMzg5IDg2LjA4NzggMTUuMDY1NyA4Ni4wODcxIDE0LjcyODRWNC42Nzg4MUw4MS40NjU0IDkuNDUyODFDODEuMjMwNCA5LjY5NjU3IDgwLjkwODEgOS44MzY5NyA4MC41Njk1IDkuODQzMTJDODAuMjMxIDkuODQ5MjggNzkuOTAzOCA5LjcyMDY5IDc5LjY2MDEgOS40ODU2M0M3OS40MTYzIDkuMjUwNTggNzkuMjc1OSA4LjkyODMyIDc5LjI2OTcgOC41ODk3NkM3OS4yNjY3IDguNDIyMTEgNzkuMjk2NyA4LjI1NTUxIDc5LjM1OCA4LjA5OTQ3Qzc5LjQxOTQgNy45NDM0MiA3OS41MTA4IDcuODAwOTggNzkuNjI3MiA3LjY4MDI4TDg2LjQ0NjkgMC42NjEwODJDODYuNjIyOSAwLjQ3ODkyMSA4Ni44NDk0IDAuMzUzNTQgODcuMDk3MyAwLjMwMTAzM0M4Ny4zNDUxIDAuMjQ4NTI2IDg3LjYwMyAwLjI3MTI5MSA4Ny44Mzc4IDAuMzY2NDAzQzg4LjA3MjcgMC40NjE1MTYgODguMjczNyAwLjYyNDYzNyA4OC40MTUxIDAuODM0ODI3Qzg4LjU1NjYgMS4wNDUwMiA4OC42MzIgMS4yOTI2OCA4OC42MzE3IDEuNTQ2MDNWMTQuNzI4NEM4OC42MzE3IDE1LjA2NTUgODguNDk3OCAxNS4zODg3IDg4LjI1OTQgMTUuNjI3MUM4OC4wMjEgMTUuODY1NCA4Ny42OTc4IDE1Ljk5OTMgODcuMzYwNyAxNS45OTkzWiI+PC9wYXRoPjxwYXRoIGQ9Ik04MC41NTE0IDkuODI2MjFDODAuMzgyNCA5LjgyNzQ5IDgwLjIxNDkgOS43OTUxOCA4MC4wNTg0IDkuNzMxMTdDNzkuOTAyIDkuNjY3MTYgNzkuNzU5OSA5LjU3MjcyIDc5LjY0MDIgOS40NTMzMkw3Mi44MzM3IDIuNDMxNUM3Mi41OTkgMi4xODk0OCA3Mi40NzAxIDEuODY0MTQgNzIuNDc1MiAxLjUyNzA1QzcyLjQ4MDQgMS4xODk5NiA3Mi42MTkzIDAuODY4NzI2IDcyLjg2MTMgMC42MzQwMjNDNzMuMTAzMyAwLjM5OTMxOSA3My40Mjg3IDAuMjcwMzY5IDczLjc2NTggMC4yNzU1NEM3NC4xMDI4IDAuMjgwNzExIDc0LjQyNDEgMC40MTk1NzkgNzQuNjU4OCAwLjY2MTU5NUw4MS40NjUzIDcuNjY3NjdDODEuNjM4OSA3Ljg0NzM1IDgxLjc1NTggOC4wNzQxMyA4MS44MDE1IDguMzE5NzdDODEuODQ3MiA4LjU2NTQxIDgxLjgxOTYgOC44MTkwNiA4MS43MjIyIDkuMDQ5MTRDODEuNjI0OCA5LjI3OTIyIDgxLjQ2MTggOS40NzU1NyA4MS4yNTM3IDkuNjEzNzRDODEuMDQ1NSA5Ljc1MTkxIDgwLjgwMTMgOS44MjU4IDgwLjU1MTQgOS44MjYyMVoiPjwvcGF0aD48cGF0aCBkPSJNOTguMzAyOSAxNS45OTkyQzk3Ljk2NTkgMTUuOTk5MiA5Ny42NDI2IDE1Ljg2NTMgOTcuNDA0MiAxNS42MjdDOTcuMTY1OSAxNS4zODg2IDk3LjAzMiAxNS4wNjU0IDk3LjAzMiAxNC43MjgzVjcuMTY1NUM5Ny4wMzIgNi44Mjg0MiA5Ny4xNjU5IDYuNTA1MTQgOTcuNDA0MiA2LjI2Njc5Qzk3LjY0MjYgNi4wMjg0NCA5Ny45NjU5IDUuODk0NTMgOTguMzAyOSA1Ljg5NDUzQzk4LjY0IDUuODk0NTMgOTguOTYzMyA2LjAyODQ0IDk5LjIwMTcgNi4yNjY3OUM5OS40NCA2LjUwNTE0IDk5LjU3MzkgNi44Mjg0MiA5OS41NzM5IDcuMTY1NVYxNC43MjgzQzk5LjU3MzkgMTUuMDY1NCA5OS40NCAxNS4zODg2IDk5LjIwMTcgMTUuNjI3Qzk4Ljk2MzMgMTUuODY1MyA5OC42NCAxNS45OTkyIDk4LjMwMjkgMTUuOTk5MloiPjwvcGF0aD48cGF0aCBkPSJNMTExLjkxNiAxNi4wMDA0QzExMS41NzkgMTYuMDAwNCAxMTEuMjU2IDE1Ljg2NjQgMTExLjAxNyAxNS42MjgxQzExMC43NzkgMTUuMzg5NyAxMTAuNjQ1IDE1LjA2NjUgMTEwLjY0NSAxNC43Mjk0VjQuNjc5ODJMMTA2LjAyMyA5LjQ1MzgyQzEwNS43ODggOS42OTU4NCAxMDUuNDY3IDkuODM0NTcgMTA1LjEyOSA5LjgzOTQ5QzEwNC43OTIgOS44NDQ0MiAxMDQuNDY2IDkuNzE1MTMgMTA0LjIyNCA5LjQ4MDA4QzEwMy45ODIgOS4yNDUwMyAxMDMuODQ0IDguOTIzNDYgMTAzLjgzOSA4LjU4NjEzQzEwMy44MzQgOC4yNDg3OSAxMDMuOTYzIDcuOTIzMzEgMTA0LjE5OCA3LjY4MTNMMTExLjAwNSAwLjY2MjA5M0MxMTEuMTgxIDAuNDgzNTc1IDExMS40MDcgMC4zNjE0MDUgMTExLjY1MyAwLjMxMTAwN0MxMTEuODk5IDAuMjYwNjA5IDExMi4xNTUgMC4yODQyNDMgMTEyLjM4NyAwLjM3ODkyNUMxMTIuNjIgMC40NzM2MDggMTEyLjgxOSAwLjYzNTA5MyAxMTIuOTYgMC44NDI5OTRDMTEzLjEwMSAxLjA1MDg5IDExMy4xNzcgMS4yOTU4OSAxMTMuMTc5IDEuNTQ3MDRWMTQuNzI5NEMxMTMuMTc4IDE1LjA2NDkgMTEzLjA0NSAxNS4zODY2IDExMi44MDkgMTUuNjI0NkMxMTIuNTcyIDE1Ljg2MjUgMTEyLjI1MSAxNS45OTc2IDExMS45MTYgMTYuMDAwNFoiPjwvcGF0aD48cGF0aCBkPSJNMTA1LjEwOSA5LjgyNjE4QzEwNC45NCA5LjgyNzQ2IDEwNC43NzMgOS43OTUxNiAxMDQuNjE2IDkuNzMxMTVDMTA0LjQ2IDkuNjY3MTMgMTA0LjMxOCA5LjU3MjY5IDEwNC4xOTggOS40NTMyOUw5Ny4zOTE3IDIuNDMxNDdDOTcuMjY4NyAyLjMxMzI2IDk3LjE3MDggMi4xNzE1IDk3LjEwMzcgMi4wMTQ2M0M5Ny4wMzY3IDEuODU3NzcgOTcuMDAxOSAxLjY4OTAxIDk3LjAwMTUgMS41MTg0MkM5Ny4wMDEgMS4zNDc4MyA5Ny4wMzQ5IDEuMTc4OSA5Ny4xMDEyIDEuMDIxNjlDOTcuMTY3NCAwLjg2NDQ3NiA5Ny4yNjQ2IDAuNzIyMjA3IDk3LjM4NyAwLjYwMzM1N0M5Ny41MDkzIDAuNDg0NTA3IDk3LjY1NDQgMC4zOTE1MDkgOTcuODEzNSAwLjMyOTkwNUM5Ny45NzI1IDAuMjY4MzAyIDk4LjE0MjQgMC4yMzkzNTMgOTguMzEyOSAwLjI0NDc4NUM5OC40ODM0IDAuMjUwMjE3IDk4LjY1MTEgMC4yODk5MTggOTguODA1OSAwLjM2MTUyMkM5OC45NjA3IDAuNDMzMTI2IDk5LjA5OTYgMC41MzUxNjggOTkuMjE0MSAwLjY2MTU2NkwxMDYuMDIzIDcuNjY3NjRDMTA2LjE5NyA3Ljg0NzMyIDEwNi4zMTQgOC4wNzQxIDEwNi4zNTkgOC4zMTk3NEMxMDYuNDA1IDguNTY1MzggMTA2LjM3OCA4LjgxOTAzIDEwNi4yOCA5LjA0OTExQzEwNi4xODMgOS4yNzkxOSAxMDYuMDIgOS40NzU1NCAxMDUuODEyIDkuNjEzNzFDMTA1LjYwMyA5Ljc1MTg5IDEwNS4zNTkgOS44MjU3NyAxMDUuMTA5IDkuODI2MThaIj48L3BhdGg+PHBhdGggZD0iTTkyLjgzMDUgMTUuOTk5N0M5Mi40OTM1IDE1Ljk5OTcgOTIuMTcwMiAxNS44NjU4IDkxLjkzMTggMTUuNjI3NEM5MS42OTM1IDE1LjM4OTEgOTEuNTU5NiAxNS4wNjU4IDkxLjU1OTYgMTQuNzI4N1YxLjU0NjM2QzkxLjU1OTYgMS4yMDkyOCA5MS42OTM1IDAuODg2MDAxIDkxLjkzMTggMC42NDc2NDhDOTIuMTcwMiAwLjQwOTI5NiA5Mi40OTM1IDAuMjc1MzkxIDkyLjgzMDUgMC4yNzUzOTFDOTMuMTY3NiAwLjI3NTM5MSA5My40OTA5IDAuNDA5Mjk2IDkzLjcyOTIgMC42NDc2NDhDOTMuOTY3NiAwLjg4NjAwMSA5NC4xMDE1IDEuMjA5MjggOTQuMTAxNSAxLjU0NjM2VjE0LjcyODdDOTQuMTAxNSAxNC44OTU2IDk0LjA2ODYgMTUuMDYwOSA5NC4wMDQ4IDE1LjIxNTFDOTMuOTQwOSAxNS4zNjkzIDkzLjg0NzMgMTUuNTA5NCA5My43MjkyIDE1LjYyNzRDOTMuNjExMiAxNS43NDU0IDkzLjQ3MTEgMTUuODM5IDkzLjMxNjkgMTUuOTAyOUM5My4xNjI3IDE1Ljk2NjggOTIuOTk3NCAxNS45OTk3IDkyLjgzMDUgMTUuOTk5N1oiPjwvcGF0aD48cGF0aCBkPSJNMTIzLjQyIDE1Ljk4MTRDMTIyLjAzIDE1Ljk4NjUgMTIwLjY2MyAxNS42Mjg3IDExOS40NTQgMTQuOTQzM0MxMTguMjQ0IDE0LjI1NzkgMTE3LjIzNSAxMy4yNjg3IDExNi41MjUgMTIuMDczNUMxMTUuODE1IDEwLjg3ODMgMTE1LjQzIDkuNTE4NSAxMTUuNDA3IDguMTI4NjNDMTE1LjM4NCA2LjczODc1IDExNS43MjQgNS4zNjY5MiAxMTYuMzkzIDQuMTQ4OEMxMTYuNTYxIDMuODYzNTYgMTE2LjgzMyAzLjY1NDg3IDExNy4xNTIgMy41NjcwN0MxMTcuNDcxIDMuNDc5MjcgMTE3LjgxMSAzLjUxOTI4IDExOC4xMDEgMy42Nzg1OUMxMTguMzkxIDMuODM3OSAxMTguNjA4IDQuMTAzOTcgMTE4LjcwNCA0LjQyMDI2QzExOC44MDEgNC43MzY1NiAxMTguNzcxIDUuMDc4MTYgMTE4LjYyIDUuMzcyNUMxMTguMDUzIDYuNDA2NjQgMTE3LjgzNiA3LjU5NjkzIDExOC4wMDMgOC43NjQ2OEMxMTguMTY5IDkuOTMyNDMgMTE4LjcxIDExLjAxNDcgMTE5LjU0NCAxMS44NDg5QzEyMC4zNzggMTIuNjgzMSAxMjEuNDYgMTMuMjI0NCAxMjIuNjI4IDEzLjM5MTRDMTIzLjc5NSAxMy41NTg0IDEyNC45ODYgMTMuMzQyMSAxMjYuMDIgMTIuNzc1MUMxMjYuMzE1IDEyLjYxMjUgMTI2LjY2MyAxMi41NzM4IDEyNi45ODcgMTIuNjY3NkMxMjcuMzExIDEyLjc2MTQgMTI3LjU4NCAxMi45OCAxMjcuNzQ3IDEzLjI3NTNDMTI3LjkwOSAxMy41NzA2IDEyNy45NDggMTMuOTE4NCAxMjcuODU0IDE0LjI0MjJDMTI3Ljc2IDE0LjU2NiAxMjcuNTQyIDE0LjgzOTMgMTI3LjI0NiAxNS4wMDE5QzEyNi4wNzQgMTUuNjQ1NSAxMjQuNzU4IDE1Ljk4MjQgMTIzLjQyIDE1Ljk4MTRaIj48L3BhdGg+PHBhdGggZD0iTTEyOS4yODcgMTIuNTA1MkMxMjkuMDcxIDEyLjUwNDQgMTI4Ljg2IDEyLjQ0ODQgMTI4LjY3MiAxMi4zNDI0QzEyOC4zNzggMTIuMTc5NSAxMjguMTU5IDExLjkwNjYgMTI4LjA2NiAxMS41ODMzQzEyNy45NzIgMTEuMjYgMTI4LjAwOSAxMC45MTI2IDEyOC4xNzEgMTAuNjE3MUMxMjguNzM4IDkuNTgyOTcgMTI4Ljk1NSA4LjM5MjY4IDEyOC43ODggNy4yMjQ5M0MxMjguNjIyIDYuMDU3MTggMTI4LjA4MSA0Ljk3NDk2IDEyNy4yNDcgNC4xNDA3M0MxMjYuNDEzIDMuMzA2NDkgMTI1LjMzMSAyLjc2NTI1IDEyNC4xNjMgMi41OTgyNUMxMjIuOTk2IDIuNDMxMjUgMTIxLjgwNSAyLjY0NzQ5IDEyMC43NzEgMy4yMTQ1MkMxMjAuNjI0IDMuMzAwNTkgMTIwLjQ2MiAzLjM1NjQgMTIwLjI5MyAzLjM3ODYzQzEyMC4xMjUgMy40MDA4NyAxMTkuOTU0IDMuMzg5MDggMTE5Ljc5IDMuMzQzOTdDMTE5LjYyNiAzLjI5ODg2IDExOS40NzMgMy4yMjEzNCAxMTkuMzM5IDMuMTE2QzExOS4yMDYgMy4wMTA2NiAxMTkuMDk1IDIuODc5NjQgMTE5LjAxMyAyLjczMDY5QzExOC45MzEgMi41ODE3NCAxMTguODggMi40MTc4OCAxMTguODYzIDIuMjQ4ODJDMTE4Ljg0NSAyLjA3OTc1IDExOC44NjIgMS45MDg5MSAxMTguOTEyIDEuNzQ2NEMxMTguOTYyIDEuNTgzODkgMTE5LjA0NCAxLjQzMzAxIDExOS4xNTMgMS4zMDI3QzExOS4yNjIgMS4xNzIzOCAxMTkuMzk2IDEuMDY1MjcgMTE5LjU0NyAwLjk4NzcwNEMxMjEuMDY0IDAuMTU1NDkxIDEyMi44MDkgLTAuMTYyMjY2IDEyNC41MjIgMC4wODIxNDc0QzEyNi4yMzQgMC4zMjY1NjEgMTI3LjgyMiAxLjExOTk1IDEyOS4wNDUgMi4zNDMxOUMxMzAuMjY4IDMuNTY2NDIgMTMxLjA2MSA1LjE1MzQ3IDEzMS4zMDYgNi44NjYwNEMxMzEuNTUgOC41Nzg2IDEzMS4yMzIgMTAuMzI0MiAxMzAuNCAxMS44NDA4QzEzMC4yOTEgMTIuMDQxMSAxMzAuMTMgMTIuMjA4NCAxMjkuOTM0IDEyLjMyNTNDMTI5LjczOSAxMi40NDIyIDEyOS41MTUgMTIuNTA0MyAxMjkuMjg3IDEyLjUwNTJaIj48L3BhdGg+PC9nPjwvc3ZnPg==",kimi:"data:image/svg+xml;base64,PHN2ZyBmaWxsPSJjdXJyZW50Q29sb3IiIGZpbGwtcnVsZT0iZXZlbm9kZCIgaGVpZ2h0PSIxZW0iIHN0eWxlPSJmbGV4Om5vbmU7bGluZS1oZWlnaHQ6MSIgdmlld0JveD0iMCAwIDI0IDI0IiB3aWR0aD0iMWVtIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjx0aXRsZT5LaW1pPC90aXRsZT48cGF0aCBkPSJNMTkuNzM4IDUuNzc2Yy4xNjMtLjIwOS4zMDYtLjQuNDU3LS41ODUuMDctLjA4Ny4wNjQtLjE1My0uMDA0LS4yNDQtLjY1NS0uODYxLS43MTctMS44MTctLjM0LTIuNzg3LjI4My0uNzMuOTA5LTEuMDcyIDEuNjc0LTEuMTQ1LjQ3Ny0uMDQ1Ljk0NS4wMDQgMS4zNzkuMjM2LjU3LjMwNS45MDIuNzcgMS4wMSAxLjQxMi4wODYuNTEyLjA3IDEuMDEyLS4wNzUgMS41MDgtLjI1Ny44NzgtLjg4OCAxLjMzMy0xLjc1MyAxLjQ0OC0uNzE4LjA5Ni0xLjQ0Ni4xMDgtMi4xNy4xNTctLjA1Ni4wMDQtLjExMyAwLS4xNzggMHoiIGZpbGw9IiMwMjdBRkYiPjwvcGF0aD48cGF0aCBkPSJNMTcuOTYyIDEuODQ0aC00LjMyNmwtMy40MjUgNy44MUg1LjM2OVYxLjg3OEgxLjVWMjJoMy44N3YtOC40NzdoNi44MjRhMy4wMjUgMy4wMjUgMCAwMDIuNzQzLTEuNzVWMjJoMy44N3YtOC40NzdhMy44NyAzLjg3IDAgMDAtMy41ODgtMy44NnYtLjAxaC0yLjEyNWEzLjk0IDMuOTQgMCAwMDIuMzIzLTIuMTJsMi41NDUtNS42ODl6Ij48L3BhdGg+PC9zdmc+",mistral:"data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPk1pc3RyYWw8L3RpdGxlPjxwYXRoIGQ9Ik0zLjQyOCAzLjRoMy40Mjl2My40MjhIMy40MjhWMy40em0xMy43MTQgMGgzLjQzdjMuNDI4aC0zLjQzVjMuNHoiIGZpbGw9ImdvbGQiPjwvcGF0aD48cGF0aCBkPSJNMy40MjggNi44MjhoNi44NTd2My40MjlIMy40MjlWNi44Mjh6bTEwLjI4NiAwaDYuODU3djMuNDI5aC02Ljg1N1Y2LjgyOHoiIGZpbGw9IiNGRkFGMDAiPjwvcGF0aD48cGF0aCBkPSJNMy40MjggMTAuMjU4aDE3LjE0NHYzLjQyOEgzLjQyOHYtMy40Mjh6IiBmaWxsPSIjRkY4MjA1Ij48L3BhdGg+PHBhdGggZD0iTTMuNDI4IDEzLjY4NmgzLjQyOXYzLjQyOEgzLjQyOHYtMy40Mjh6bTYuODU4IDBoMy40Mjl2My40MjhoLTMuNDI5di0zLjQyOHptNi44NTYgMGgzLjQzdjMuNDI4aC0zLjQzdi0zLjQyOHoiIGZpbGw9IiNGQTUwMEYiPjwvcGF0aD48cGF0aCBkPSJNMCAxNy4xMTRoMTAuMjg2djMuNDI5SDB2LTMuNDI5em0xMy43MTQgMEgyNHYzLjQyOUgxMy43MTR2LTMuNDI5eiIgZmlsbD0iI0UxMDUwMCI+PC9wYXRoPjwvc3ZnPg==",ollama:"data:image/svg+xml;base64,PHN2ZyBmaWxsPSJjdXJyZW50Q29sb3IiIGZpbGwtcnVsZT0iZXZlbm9kZCIgaGVpZ2h0PSIxZW0iIHN0eWxlPSJmbGV4Om5vbmU7bGluZS1oZWlnaHQ6MSIgdmlld0JveD0iMCAwIDI0IDI0IiB3aWR0aD0iMWVtIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjx0aXRsZT5PbGxhbWE8L3RpdGxlPjxwYXRoIGQ9Ik03LjkwNSAxLjA5Yy4yMTYuMDg1LjQxMS4yMjUuNTg4LjQxLjI5NS4zMDYuNTQ0Ljc0NC43MzQgMS4yNjMuMTkxLjUyMi4zMTUgMS4xLjM2MiAxLjY4YTUuMDU0IDUuMDU0IDAgMDEyLjA0OS0uNjM2bC4wNTEtLjAwNGMuODctLjA3IDEuNzMuMDg3IDIuNDguNDc0LjEwMS4wNTMuMi4xMS4yOTcuMTcuMDUtLjU2OS4xNzItMS4xMzQuMzYtMS42NDQuMTktLjUyLjQzOS0uOTU3LjczMy0xLjI2NGExLjY3IDEuNjcgMCAwMS41ODktLjQxYy4yNTctLjEuNTMtLjExOC43OTYtLjA0Mi40MDEuMTE0Ljc0NS4zNjggMS4wMTYuNzM3LjI0OC4zMzcuNDM0Ljc2OS41NjEgMS4yODcuMjMuOTM0LjI3IDIuMTYzLjExNSAzLjY0NWwuMDUzLjA0LjAyNi4wMTljLjc1Ny41NzYgMS4yODQgMS4zOTcgMS41NjMgMi4zNS40MzUgMS40ODcuMjE2IDMuMTU1LS41MzQgNC4wODhsLS4wMTguMDIxLjAwMi4wMDNjLjQxNy43NjIuNjcgMS41NjcuNzI0IDIuNGwuMDAyLjAzYy4wNjQgMS4wNjUtLjIgMi4xMzctLjgxNCAzLjE5bC0uMDA3LjAxLjAxLjAyNGMuNDcyIDEuMTU3LjYyIDIuMzIyLjQzOCAzLjQ4NmwtLjAwNi4wMzlhLjY1MS42NTEgMCAwMS0uNzQ3LjUzNi42NDguNjQ4IDAgMDEtLjU0LS43NDJjLjE2Ny0xLjAzMy4wMS0yLjA2OS0uNDgtMy4xMjNhLjY0My42NDMgMCAwMS4wNC0uNjE3bC4wMDQtLjAwNmMuNjA0LS45MjQuODU0LTEuODMuOC0yLjcyLS4wNDYtLjc3OS0uMzI1LTEuNTQ0LS44LTIuMjczYS42NDQuNjQ0IDAgMDEuMTgtLjg4NmwuMDA5LS4wMDZjLjI0My0uMTU5LjQ2Ny0uNTY1LjU4LTEuMTJhNC4yMjkgNC4yMjkgMCAwMC0uMDk1LTEuOTc0Yy0uMjA1LS43LS41OC0xLjI4NC0xLjEwNS0xLjY4My0uNTk1LS40NTQtMS4zODMtLjY3My0yLjM4LS42MWEuNjUzLjY1MyAwIDAxLS42MzItLjM3MWMtLjMxNC0uNjY1LS43NzItMS4xNDEtMS4zNDMtMS40MzZhMy4yODggMy4yODggMCAwMC0xLjc3Mi0uMzMyYy0xLjI0NS4wOTktMi4zNDMuODAxLTIuNjcgMS42ODZhLjY1Mi42NTIgMCAwMS0uNjEuNDI1Yy0xLjA2Ny4wMDItMS44OTMuMjUyLTIuNDk3LjcwMy0uNTIyLjM5LS44NzguOTM1LTEuMDY2IDEuNTg4YTQuMDcgNC4wNyAwIDAwLS4wNjggMS44ODZjLjExMi41NTguMzMxIDEuMDIuNTgyIDEuMjY5bC4wMDguMDA3Yy4yMTIuMjA3LjI1Ny41My4xMDkuNzg1LS4zNi42MjItLjYyOSAxLjU0OS0uNjczIDIuNDQtLjA1IDEuMDE4LjE4NiAxLjkwMi43MTkgMi41MzZsLjAxNi4wMTlhLjY0My42NDMgMCAwMS4wOTUuNjljLS41NzYgMS4yMzYtLjc1MyAyLjI1Mi0uNTYyIDMuMDUyYS42NTIuNjUyIDAgMDEtMS4yNjkuMjk4Yy0uMjQzLTEuMDE4LS4wNzgtMi4xODQuNDczLTMuNDk4bC4wMTQtLjAzNS0uMDA4LS4wMTJhNC4zMzkgNC4zMzkgMCAwMS0uNTk4LTEuMzA5bC0uMDA1LS4wMTlhNS43NjQgNS43NjQgMCAwMS0uMTc3LTEuNzg1Yy4wNDQtLjkxLjI3OC0xLjg0Mi42MjItMi41OWwuMDEyLS4wMjYtLjAwMi0uMDAyYy0uMjkzLS40MTgtLjUxLS45NTMtLjYzLTEuNTQ1bC0uMDA1LS4wMjRhNS4zNTIgNS4zNTIgMCAwMS4wOTMtMi40OWMuMjYyLS45MTUuNzc3LTEuNzAxIDEuNTM2LTIuMjY5LjA2LS4wNDUuMTIzLS4wOS4xODYtLjEzMi0uMTU5LTEuNDkzLS4xMTktMi43My4xMTItMy42Ny4xMjctLjUxOC4zMTQtLjk1LjU2Mi0xLjI4Ny4yNy0uMzY4LjYxNC0uNjIyIDEuMDE1LS43MzcuMjY2LS4wNzYuNTQtLjA1OS43OTcuMDQyem00LjExNiA5LjA5Yy45MzYgMCAxLjguMzEzIDIuNDQ2Ljg1NS42My41MjcgMS4wMDUgMS4yMzUgMS4wMDUgMS45NCAwIC44ODgtLjQwNiAxLjU4LTEuMTMzIDIuMDIyLS42Mi4zNzUtMS40NTEuNTU3LTIuNDAzLjU1Ny0xLjAwOSAwLTEuODcxLS4yNTktMi40OTMtLjczNC0uNjE3LS40Ny0uOTYzLTEuMTMtLjk2My0xLjg0NSAwLS43MDcuMzk4LTEuNDE3IDEuMDU2LTEuOTQ2LjY2OC0uNTM3IDEuNTUtLjg0OSAyLjQ4NS0uODQ5em0wIC44OTZhMy4wNyAzLjA3IDAgMDAtMS45MTYuNjVjLS40NjEuMzctLjcyMi44MzUtLjcyMiAxLjI1IDAgLjQyOC4yMS44MjkuNjEgMS4xMzQuNDU1LjM0NyAxLjEyNC41NDggMS45NDMuNTQ4Ljc5OSAwIDEuNDczLS4xNDcgMS45MzItLjQyNi40NjMtLjI4LjctLjY4Ni43LTEuMjU3IDAtLjQyMy0uMjQ2LS44OS0uNjgzLTEuMjU2LS40ODQtLjQwNS0xLjE0LS42NDMtMS44NjQtLjY0M3ptLjY2MiAxLjIxbC4wMDQuMDA0Yy4xMi4xNTEuMDk1LjM3LS4wNTYuNDlsLS4yOTIuMjN2LjQ0NmEuMzc1LjM3NSAwIDAxLS4zNzYuMzczLjM3NS4zNzUgMCAwMS0uMzc2LS4zNzN2LS40NmwtLjI3MS0uMjE4YS4zNDcuMzQ3IDAgMDEtLjA1Mi0uNDkuMzUzLjM1MyAwIDAxLjQ5NC0uMDUxbC4yMTUuMTcyLjIyLS4xNzRhLjM1My4zNTMgMCAwMS40OS4wNTF6bS01LjA0LTEuOTE5Yy40NzggMCAuODY3LjM5Ljg2Ny44NzFhLjg3Ljg3IDAgMDEtLjg2OC44NzEuODcuODcgMCAwMS0uODY3LS44Ny44Ny44NyAwIDAxLjg2Ny0uODcyem04LjcwNiAwYy40OCAwIC44NjguMzkuODY4Ljg3MWEuODcuODcgMCAwMS0uODY4Ljg3MS44Ny44NyAwIDAxLS44NjctLjg3Ljg3Ljg3IDAgMDEuODY3LS44NzJ6TTcuNDQgMi4zbC0uMDAzLjAwMmEuNjU5LjY1OSAwIDAwLS4yODUuMjM4bC0uMDA1LjAwNmMtLjEzOC4xODktLjI1OC40NjctLjM0OC44MzItLjE3LjY5Mi0uMjE2IDEuNjMxLS4xMjQgMi43ODIuNDMtLjEyOC44OTktLjIwOCAxLjQwNC0uMjM3bC4wMS0uMDAxLjAxOS0uMDM0Yy4wNDYtLjA4Mi4wOTUtLjE2MS4xNDgtLjIzOS4xMjMtLjc3MS4wMjItMS42OTItLjI1My0yLjQ0NC0uMTM0LS4zNjQtLjI5Ny0uNjUtLjQ1My0uODEzYS42MjguNjI4IDAgMDAtLjEwNy0uMDlMNy40NCAyLjN6bTkuMTc0LjA0bC0uMDAyLjAwMWEuNjI4LjYyOCAwIDAwLS4xMDcuMDljLS4xNTYuMTYzLS4zMi40NS0uNDUzLjgxNC0uMjkuNzk0LS4zODcgMS43NzYtLjIzIDIuNTcybC4wNTguMDk3LjAwOC4wMTRoLjAzYTUuMTg0IDUuMTg0IDAgMDExLjQ2Ni4yMTJjLjA4Ni0xLjEyNC4wMzgtMi4wNDMtLjEyOC0yLjcyMi0uMDktLjM2NS0uMjEtLjY0My0uMzQ5LS44MzJsLS4wMDQtLjAwNmEuNjU5LjY1OSAwIDAwLS4yODUtLjIzOWgtLjAwNHoiPjwvcGF0aD48L3N2Zz4=",xai:"data:image/svg+xml;base64,PHN2ZyBmaWxsPSJjdXJyZW50Q29sb3IiIGZpbGwtcnVsZT0iZXZlbm9kZCIgaGVpZ2h0PSIxZW0iIHN0eWxlPSJmbGV4Om5vbmU7bGluZS1oZWlnaHQ6MSIgdmlld0JveD0iMCAwIDI0IDI0IiB3aWR0aD0iMWVtIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjx0aXRsZT5Hcm9rPC90aXRsZT48cGF0aCBkPSJNNi40NjkgOC43NzZMMTYuNTEyIDIzaC00LjQ2NEwyLjAwNSA4Ljc3Nkg2LjQ3em0tLjAwNCA3LjlsMi4yMzMgMy4xNjRMNi40NjcgMjNIMmw0LjQ2NS02LjMyNHpNMjIgMi41ODJWMjNoLTMuNjU5VjcuNzY0TDIyIDIuNTgyek0yMiAxbC05Ljk1MiAxNC4wOTUtMi4yMzMtMy4xNjNMMTcuNTMzIDFIMjJ6Ij48L3BhdGg+PC9zdmc+"};var Fs={"deepseek-account":"deepseek","deepseek-api":"deepseek","openai-api":"openai","openai-codex":"openai",claude:"anthropic","anthropic-api":"anthropic",gemini:"google","google-gemini":"google","google-gemini-cli":"google","google-generative-ai":"google","google-vertex":"google",dashscope:"qwen",alibaba:"qwen",zai:"zhipu","z-ai":"zhipu",moonshot:"kimi",mimo:"xiaomimimo"},Bs=new Set(["deepseek","openai","anthropic","google","openrouter","siliconflow","qwen","zhipu","minimax","stepfun","xiaomimimo","kimi","mistral","ollama","xai"]);function ii(e,t=!1){let n=typeof e=="string"?e.trim().toLowerCase():"";return n==="deepseek-official"?"deepseek":t?null:Fs[n]||(Bs.has(n)?n:null)}function ri(e,t){let n=String(e||t||"?").trim();return Array.from(n)[0]?.toLocaleUpperCase()||"?"}var Yn=require("react/jsx-runtime");function ht({id:e,name:t,declared:n=!1,size:i=20}){let o=ii(e,n),a=ai[o];return(0,Yn.jsx)("span",{className:"cmd-provider-brand","data-provider-brand":o||"custom","aria-hidden":"true",style:{display:"inline-flex",alignItems:"center",justifyContent:"center",flexShrink:0,width:i,height:i,verticalAlign:"middle"},children:a?(0,Yn.jsx)("img",{src:a,alt:"",width:i,height:i,draggable:!1,style:{display:"block",width:i,height:i,objectFit:"contain",filter:"none"}}):(0,Yn.jsx)("span",{className:"cmd-provider-brand-initial",style:{display:"inline-flex",alignItems:"center",justifyContent:"center",width:i,height:i,borderRadius:5,background:"var(--dsw-alias-interactive-bg-hover, #8881)",fontSize:Math.max(11,i*.6),fontWeight:600,lineHeight:1},children:ri(t,e)})})}var Sc=require("react");var si={gemini:"data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPkdlbWluaTwvdGl0bGU+PHBhdGggZD0iTTIwLjYxNiAxMC44MzVhMTQuMTQ3IDE0LjE0NyAwIDAxLTQuNDUtMy4wMDEgMTQuMTExIDE0LjExMSAwIDAxLTMuNjc4LTYuNDUyLjUwMy41MDMgMCAwMC0uOTc1IDAgMTQuMTM0IDE0LjEzNCAwIDAxLTMuNjc5IDYuNDUyIDE0LjE1NSAxNC4xNTUgMCAwMS00LjQ1IDMuMDAxYy0uNjUuMjgtMS4zMTguNTA1LTIuMDAyLjY3OGEuNTAyLjUwMiAwIDAwMCAuOTc1Yy42ODQuMTcyIDEuMzUuMzk3IDIuMDAyLjY3N2ExNC4xNDcgMTQuMTQ3IDAgMDE0LjQ1IDMuMDAxIDE0LjExMiAxNC4xMTIgMCAwMTMuNjc5IDYuNDUzLjUwMi41MDIgMCAwMC45NzUgMGMuMTcyLS42ODUuMzk3LTEuMzUxLjY3Ny0yLjAwM2ExNC4xNDUgMTQuMTQ1IDAgMDEzLjAwMS00LjQ1IDE0LjExMyAxNC4xMTMgMCAwMTYuNDUzLTMuNjc4LjUwMy41MDMgMCAwMDAtLjk3NSAxMy4yNDUgMTMuMjQ1IDAgMDEtMi4wMDMtLjY3OHoiIGZpbGw9IiMzMTg2RkYiPjwvcGF0aD48cGF0aCBkPSJNMjAuNjE2IDEwLjgzNWExNC4xNDcgMTQuMTQ3IDAgMDEtNC40NS0zLjAwMSAxNC4xMTEgMTQuMTExIDAgMDEtMy42NzgtNi40NTIuNTAzLjUwMyAwIDAwLS45NzUgMCAxNC4xMzQgMTQuMTM0IDAgMDEtMy42NzkgNi40NTIgMTQuMTU1IDE0LjE1NSAwIDAxLTQuNDUgMy4wMDFjLS42NS4yOC0xLjMxOC41MDUtMi4wMDIuNjc4YS41MDIuNTAyIDAgMDAwIC45NzVjLjY4NC4xNzIgMS4zNS4zOTcgMi4wMDIuNjc3YTE0LjE0NyAxNC4xNDcgMCAwMTQuNDUgMy4wMDEgMTQuMTEyIDE0LjExMiAwIDAxMy42NzkgNi40NTMuNTAyLjUwMiAwIDAwLjk3NSAwYy4xNzItLjY4NS4zOTctMS4zNTEuNjc3LTIuMDAzYTE0LjE0NSAxNC4xNDUgMCAwMTMuMDAxLTQuNDUgMTQuMTEzIDE0LjExMyAwIDAxNi40NTMtMy42NzguNTAzLjUwMyAwIDAwMC0uOTc1IDEzLjI0NSAxMy4yNDUgMCAwMS0yLjAwMy0uNjc4eiIgZmlsbD0idXJsKCNsb2JlLWljb25zLWdlbWluaS1maWxsLTApIj48L3BhdGg+PHBhdGggZD0iTTIwLjYxNiAxMC44MzVhMTQuMTQ3IDE0LjE0NyAwIDAxLTQuNDUtMy4wMDEgMTQuMTExIDE0LjExMSAwIDAxLTMuNjc4LTYuNDUyLjUwMy41MDMgMCAwMC0uOTc1IDAgMTQuMTM0IDE0LjEzNCAwIDAxLTMuNjc5IDYuNDUyIDE0LjE1NSAxNC4xNTUgMCAwMS00LjQ1IDMuMDAxYy0uNjUuMjgtMS4zMTguNTA1LTIuMDAyLjY3OGEuNTAyLjUwMiAwIDAwMCAuOTc1Yy42ODQuMTcyIDEuMzUuMzk3IDIuMDAyLjY3N2ExNC4xNDcgMTQuMTQ3IDAgMDE0LjQ1IDMuMDAxIDE0LjExMiAxNC4xMTIgMCAwMTMuNjc5IDYuNDUzLjUwMi41MDIgMCAwMC45NzUgMGMuMTcyLS42ODUuMzk3LTEuMzUxLjY3Ny0yLjAwM2ExNC4xNDUgMTQuMTQ1IDAgMDEzLjAwMS00LjQ1IDE0LjExMyAxNC4xMTMgMCAwMTYuNDUzLTMuNjc4LjUwMy41MDMgMCAwMDAtLjk3NSAxMy4yNDUgMTMuMjQ1IDAgMDEtMi4wMDMtLjY3OHoiIGZpbGw9InVybCgjbG9iZS1pY29ucy1nZW1pbmktZmlsbC0xKSI+PC9wYXRoPjxwYXRoIGQ9Ik0yMC42MTYgMTAuODM1YTE0LjE0NyAxNC4xNDcgMCAwMS00LjQ1LTMuMDAxIDE0LjExMSAxNC4xMTEgMCAwMS0zLjY3OC02LjQ1Mi41MDMuNTAzIDAgMDAtLjk3NSAwIDE0LjEzNCAxNC4xMzQgMCAwMS0zLjY3OSA2LjQ1MiAxNC4xNTUgMTQuMTU1IDAgMDEtNC40NSAzLjAwMWMtLjY1LjI4LTEuMzE4LjUwNS0yLjAwMi42NzhhLjUwMi41MDIgMCAwMDAgLjk3NWMuNjg0LjE3MiAxLjM1LjM5NyAyLjAwMi42NzdhMTQuMTQ3IDE0LjE0NyAwIDAxNC40NSAzLjAwMSAxNC4xMTIgMTQuMTEyIDAgMDEzLjY3OSA2LjQ1My41MDIuNTAyIDAgMDAuOTc1IDBjLjE3Mi0uNjg1LjM5Ny0xLjM1MS42NzctMi4wMDNhMTQuMTQ1IDE0LjE0NSAwIDAxMy4wMDEtNC40NSAxNC4xMTMgMTQuMTEzIDAgMDE2LjQ1My0zLjY3OC41MDMuNTAzIDAgMDAwLS45NzUgMTMuMjQ1IDEzLjI0NSAwIDAxLTIuMDAzLS42Nzh6IiBmaWxsPSJ1cmwoI2xvYmUtaWNvbnMtZ2VtaW5pLWZpbGwtMikiPjwvcGF0aD48ZGVmcz48bGluZWFyR3JhZGllbnQgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiIGlkPSJsb2JlLWljb25zLWdlbWluaS1maWxsLTAiIHgxPSI3IiB4Mj0iMTEiIHkxPSIxNS41IiB5Mj0iMTIiPjxzdG9wIHN0b3AtY29sb3I9IiMwOEI5NjIiPjwvc3RvcD48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMwOEI5NjIiIHN0b3Atb3BhY2l0eT0iMCI+PC9zdG9wPjwvbGluZWFyR3JhZGllbnQ+PGxpbmVhckdyYWRpZW50IGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIiBpZD0ibG9iZS1pY29ucy1nZW1pbmktZmlsbC0xIiB4MT0iOCIgeDI9IjExLjUiIHkxPSI1LjUiIHkyPSIxMSI+PHN0b3Agc3RvcC1jb2xvcj0iI0Y5NDU0MyI+PC9zdG9wPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI0Y5NDU0MyIgc3RvcC1vcGFjaXR5PSIwIj48L3N0b3A+PC9saW5lYXJHcmFkaWVudD48bGluZWFyR3JhZGllbnQgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiIGlkPSJsb2JlLWljb25zLWdlbWluaS1maWxsLTIiIHgxPSIzLjUiIHgyPSIxNy41IiB5MT0iMTMuNSIgeTI9IjEyIj48c3RvcCBzdG9wLWNvbG9yPSIjRkFCQzEyIj48L3N0b3A+PHN0b3Agb2Zmc2V0PSIuNDYiIHN0b3AtY29sb3I9IiNGQUJDMTIiIHN0b3Atb3BhY2l0eT0iMCI+PC9zdG9wPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjwvc3ZnPg==",grok:"data:image/svg+xml;base64,PHN2ZyBmaWxsPSJjdXJyZW50Q29sb3IiIGZpbGwtcnVsZT0iZXZlbm9kZCIgaGVpZ2h0PSIxZW0iIHN0eWxlPSJmbGV4Om5vbmU7bGluZS1oZWlnaHQ6MSIgdmlld0JveD0iMCAwIDI0IDI0IiB3aWR0aD0iMWVtIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjx0aXRsZT5Hcm9rPC90aXRsZT48cGF0aCBkPSJNOS4yNyAxNS4yOWw3Ljk3OC01Ljg5N2MuMzkxLS4yOS45NS0uMTc3IDEuMTM3LjI3Mi45OCAyLjM2OS41NDIgNS4yMTUtMS40MSA3LjE2OS0xLjk1MSAxLjk1NC00LjY2NyAyLjM4Mi03LjE0OSAxLjQwNmwtMi43MTEgMS4yNTdjMy44ODkgMi42NjEgOC42MTEgMi4wMDMgMTEuNTYyLS45NTMgMi4zNDEtMi4zNDQgMy4wNjYtNS41MzkgMi4zODgtOC40MmwuMDA2LjAwN2MtLjk4My00LjIzMi4yNDItNS45MjQgMi43NS05LjM4My4wNi0uMDgyLjEyLS4xNjQuMTc5LS4yNDhsLTMuMzAxIDMuMzA1di0uMDFMOS4yNjcgMTUuMjkyTTcuNjIzIDE2LjcyM2MtMi43OTItMi42Ny0yLjMxLTYuODAxLjA3MS05LjE4NCAxLjc2MS0xLjc2MyA0LjY0Ny0yLjQ4MyA3LjE2Ni0xLjQyNWwyLjcwNS0xLjI1YTcuODA4IDcuODA4IDAgMDAtMS44MjktMUE4Ljk3NSA4Ljk3NSAwIDAwNS45ODQgNS44M2MtMi41MzMgMi41MzYtMy4zMyA2LjQzNi0xLjk2MiA5Ljc2NCAxLjAyMiAyLjQ4Ny0uNjUzIDQuMjQ2LTIuMzQgNi4wMjItLjU5OS42My0xLjE5OSAxLjI1OS0xLjY4MiAxLjkyNWw3LjYyLTYuODE1Ij48L3BhdGg+PC9zdmc+",openclaw:"data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMTIwIDEyMCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0ibG9ic3Rlci1ncmFkaWVudCIgeDE9IjAlIiB5MT0iMCUiIHgyPSIxMDAlIiB5Mj0iMTAwJSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNmZjRkNGQiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjOTkxYjFiIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogIDwvZGVmcz4KICA8IS0tIEJvZHkgLS0+CiAgPHBhdGggZD0iTTYwIDEwIEMzMCAxMCAxNSAzNSAxNSA1NSBDMTUgNzUgMzAgOTUgNDUgMTAwIEw0NSAxMTAgTDU1IDExMCBMNTUgMTAwIEM1NSAxMDAgNjAgMTAyIDY1IDEwMCBMNjUgMTEwIEw3NSAxMTAgTDc1IDEwMCBDOTAgOTUgMTA1IDc1IDEwNSA1NSBDMTA1IDM1IDkwIDEwIDYwIDEwWiIgZmlsbD0idXJsKCNsb2JzdGVyLWdyYWRpZW50KSIvPgogIDwhLS0gTGVmdCBDbGF3IC0tPgogIDxwYXRoIGQ9Ik0yMCA0NSBDNSA0MCAwIDUwIDUgNjAgQzEwIDcwIDIwIDY1IDI1IDU1IEMyOCA0OCAyNSA0NSAyMCA0NVoiIGZpbGw9InVybCgjbG9ic3Rlci1ncmFkaWVudCkiLz4KICA8IS0tIFJpZ2h0IENsYXcgLS0+CiAgPHBhdGggZD0iTTEwMCA0NSBDMTE1IDQwIDEyMCA1MCAxMTUgNjAgQzExMCA3MCAxMDAgNjUgOTUgNTUgQzkyIDQ4IDk1IDQ1IDEwMCA0NVoiIGZpbGw9InVybCgjbG9ic3Rlci1ncmFkaWVudCkiLz4KICA8IS0tIEFudGVubmEgLS0+CiAgPHBhdGggZD0iTTQ1IDE1IFEzNSA1IDMwIDgiIHN0cm9rZT0iI2ZmNGQ0ZCIgc3Ryb2tlLXdpZHRoPSIzIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICA8cGF0aCBkPSJNNzUgMTUgUTg1IDUgOTAgOCIgc3Ryb2tlPSIjZmY0ZDRkIiBzdHJva2Utd2lkdGg9IjMiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgogIDwhLS0gRXllcyAtLT4KICA8Y2lyY2xlIGN4PSI0NSIgY3k9IjM1IiByPSI2IiBmaWxsPSIjMDUwODEwIi8+CiAgPGNpcmNsZSBjeD0iNzUiIGN5PSIzNSIgcj0iNiIgZmlsbD0iIzA1MDgxMCIvPgogIDxjaXJjbGUgY3g9IjQ2IiBjeT0iMzQiIHI9IjIuNSIgZmlsbD0iIzAwZTVjYyIvPgogIDxjaXJjbGUgY3g9Ijc2IiBjeT0iMzQiIHI9IjIuNSIgZmlsbD0iIzAwZTVjYyIvPgo8L3N2Zz4K",mcode:"data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPk1pbmltYXg8L3RpdGxlPjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0ibG9iZS1pY29ucy1taW5pbWF4LWZpbGwiIHgxPSIwJSIgeDI9IjEwMC4xODIlIiB5MT0iNTAuMDU3JSIgeTI9IjUwLjA1NyUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNFMjE2N0UiPjwvc3RvcD48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNGRTYwM0MiPjwvc3RvcD48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cGF0aCBkPSJNMTYuMjc4IDJjMS4xNTYgMCAyLjA5My45MjcgMi4wOTMgMi4wN3YxMi41MDFhLjc0Ljc0IDAgMDAuNzQ0LjcwOS43NC43NCAwIDAwLjc0My0uNzA5VjkuMDk5YTIuMDYgMi4wNiAwIDAxMi4wNzEtMi4wNDlBMi4wNiAyLjA2IDAgMDEyNCA5LjF2Ni41NjFhLjY0OS42NDkgMCAwMS0uNjUyLjY0NS42NDkuNjQ5IDAgMDEtLjY1My0uNjQ1VjkuMWEuNzYyLjc2MiAwIDAwLS43NjYtLjc1OC43NjIuNzYyIDAgMDAtLjc2Ni43NTh2Ny40NzJhMi4wMzcgMi4wMzcgMCAwMS0yLjA0OCAyLjAyNiAyLjAzNyAyLjAzNyAwIDAxLTIuMDQ4LTIuMDI2di0xMi41YS43ODUuNzg1IDAgMDAtLjc4OC0uNzUzLjc4NS43ODUgMCAwMC0uNzg5Ljc1MmwtLjAwMSAxNS45MDRBMi4wMzcgMi4wMzcgMCAwMTEzLjQ0MSAyMmEyLjAzNyAyLjAzNyAwIDAxLTIuMDQ4LTIuMDI2VjE4LjA0YzAtLjM1Ni4yOTItLjY0NS42NTItLjY0NS4zNiAwIC42NTIuMjg5LjY1Mi42NDV2MS45MzRjMCAuMjYzLjE0Mi41MDYuMzcyLjYzOC4yMy4xMzEuNTE0LjEzMS43NDQgMGEuNzM0LjczNCAwIDAwLjM3Mi0uNjM4VjQuMDdjMC0xLjE0My45MzctMi4wNyAyLjA5My0yLjA3em0tNS42NzQgMGMxLjE1NiAwIDIuMDkzLjkyNyAyLjA5MyAyLjA3djExLjUyM2EuNjQ4LjY0OCAwIDAxLS42NTIuNjQ1LjY0OC42NDggMCAwMS0uNjUyLS42NDVWNC4wN2EuNzg1Ljc4NSAwIDAwLS43ODktLjc4Ljc4NS43ODUgMCAwMC0uNzg5Ljc4djE0LjAxM2EyLjA2IDIuMDYgMCAwMS0yLjA3IDIuMDQ4IDIuMDYgMi4wNiAwIDAxLTIuMDcxLTIuMDQ4VjkuMWEuNzYyLjc2MiAwIDAwLS43NjYtLjc1OC43NjIuNzYyIDAgMDAtLjc2Ni43NTh2My44YTIuMDYgMi4wNiAwIDAxLTIuMDcxIDIuMDQ5QTIuMDYgMi4wNiAwIDAxMCAxMi45di0xLjM3OGMwLS4zNTcuMjkyLS42NDYuNjUyLS42NDYuMzYgMCAuNjUzLjI5LjY1My42NDZWMTIuOWMwIC40MTguMzQzLjc1Ny43NjYuNzU3cy43NjYtLjMzOS43NjYtLjc1N1Y5LjA5OWEyLjA2IDIuMDYgMCAwMTIuMDctMi4wNDggMi4wNiAyLjA2IDAgMDEyLjA3MSAyLjA0OHY4Ljk4NGMwIC40MTkuMzQzLjc1OC43NjcuNzU4LjQyMyAwIC43NjYtLjMzOS43NjYtLjc1OFY0LjA3YzAtMS4xNDMuOTM3LTIuMDcgMi4wOTMtMi4wN3oiIGZpbGw9InVybCgjbG9iZS1pY29ucy1taW5pbWF4LWZpbGwpIiBmaWxsLXJ1bGU9Im5vbnplcm8iPjwvcGF0aD48L3N2Zz4=",hermes:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAWvUlEQVR42uVbeVRU5/l+5s4MMAz7IgKyClEEogmCFaNEMSQuRGMVTfRUJGmDtWm10Z6TRds0R2uMS5JazVq3uMY0JjEq8YjEBNwVEQMIyDIo67AODMMsz+8PmSsjAw6Y/PV7z/kOy73fvd/3fu/6vO+VkHQBEAVAgv9fRAD5MgBRJpPplCAIMpPJ9Ku8SRCEAc/5tdZiXo/JZDIIgpAo6z55OQDpYBZqC2m1WtTV1aG0tBSFhYWoqKhAXV0dNBoNSMLZ2Rn+/v4YOTICjz4ajfDwcCgUil9bAiQAJLIe4gCSD/dEyT0tamlpRUNDPVpaWtDc3IyamhpUVVWhqKgIV69exbVr16yesp1cjtDQ4Uh4MgGzZs3CpEmToFQq7y6S4lJ/iXUSACQkJ5hMpixBEGSDZYB543q9HgUFBfj55wK0tbbC3t4OQ319ERwcgrCwMAiCBGZGFxYW4vPPP8fHH3+MhoaGPp8dFRmFtBfTkJqaCnd3d/xSB9WtAk+C5ASj0agnSZPJNKBhpqamJm7fvp0TJ06kt7c37e3tKZFI2M1lKhQKRkVF8Y033mBpaSl7UmFhIWfOnCne29eIiIjgoUOHxHkm08DX23Pd3XueMGgGkGRHRwe3b9/OESNGPHAD5uHt7c2NGzeyq6tL3IxOp+Py5cttmp+ens7WtraHYsJDMcBMp06d4m9+8xubN37/mDVrFmtqaiyk4a9//atNc6dMmcKqqioORmofigEk2dbWxpUrV9LOzm7QmzePsWPHUqVSiQzQ6w1MSUnp835BECgIAgHwqaeeYk1NLQerugNmAEneuHGDEyZMGPSGJRIJBUGgq6srAVAmkzEuLo5NjU0iE+rq6jhy5EircyUSCQMChtHHx4dKpZKbNm1ia2srB6O+ZgYItlrNkydPYubMmTh/4YKFu7O3t4dcLu93vlwuh6+vL0jC3d0dvr6+mDFjBlatWgUPDw8s+9MykAQJeHt7Y/PmzZDJZL3W4O7ujoYGNeLi4uDj4wOpVIqruVe73ekgA9kHSQBJfvvtUYaGhtDXdyjt7e0pCAKlUmm3dY+kRCKhg4MDpVKphfU3D7lczoUvvMAxo0dTLpdzx46dbG1to8lk4rFjxxgYGMgvvvhCNGwkOW/ePAKgu7s7Xd1cu393Y1RUFNPS0rh//36eP3+e27ZtY17e9QFJgc0qQJLnzp1jfHw8n5gwgSEhIfT19aWjoyOVSiXnz5/PwMBAujg7083NjeHh4eKmzTZCEAQ6Oztz+vTpzMjI4Jw5c2gwGEiSWm0nJ02axNTUVE6ePJkdHVpRFS5dukQ7OzvK5XL+4eWX6ezsLBrPe67QxKSkJC5fvlx85kAZIOtP7NXqRuzcuRPjxo1DZmYmQkNDcPXqVQQGBsLT0xOhIaE4ePAgwsLCUF1djdmzZ6O4uAR1dbUwmUy4ePESZDIpXFxcMDM5GQkJCQAAlaoSbm7uKCoqQltbGwoLC/Hee++hpKQY0dHRIIHHHnscf//73yGVSjF/wQJMTUxEQUEBkpOT0draCrlcjtzcXNTV1uHK5ctYuHAhxo4dO2ANkPV3MScnGy+99BJI4oknnsDmLZsxalQk6uvrsWzZMigUCvz+979HRUUFIiMjMXXqVPztb3+Dl5cXGhsb8dJLLyExMRExMTGIjY2DVCpg5MiRmDJlCry9vVBbVweZIMO1a9ewdu1ajBkzBtHR0d0JiwRjx47Fa6+9Bl9fXyiVShw4cABNTU3Iy8vD3LlzcfHiRTg5O6FBrcbBgwcRExMDiUQysEjRmgqQZGVlJbNOZ7G6uloUrczMTK5fv567du3ipUuXqFarRdfY3NzMr7/+mtu2bWPZrVtUqVQ8efKkhZ/XarXUaDRctGiRaNm9vLxEu+Hi4sLKyntuUd2gpo+PDwVBYFraEgvvMH36dE6fPp3BwcF0d3fniBEjWF5RQVvduVkFrOYCEokEW/+9FWHhYYiMjAJA+Pn5obi4BAWFBSgo+BkVZRVwVDrC2dkZdbW1+CknG+PHjcex48fQ1toGO3s7jB49Gm1tbZg3bx5UKhXCw8NhMBiwb98+XLp0SUxN73qAu+/et28fnn/+efGAFi9ejN27d0MQBEycOBHZ2dkwGAzw8/PFY489jtzcXABAdXU1PvnkE6SlpT1QAnrmAjJrF1taWnDg4AEEDAtAeUU5goODkJg4FceOHUNOTg7s7e1gNJpw+/Zti7m3Sm/Bw8MdbZo2QANkZmYCAC5dvgQnpRN8fYfCwd4BqqqqPvP+M2fOYMGCBaitrUVtbS1GjRol3lddXY3AwEDcunUL1dU1GDq0Gs7OzqitrQUAHDlyBCkpKXBycrJdDe5XAZI8evQoo6OjOWxYAEeOHElXV1cGBgZSJpWKFt4ckd0/JkyYQJlM1mckJ5VK6ejo2GewlPBkAtesWUNPT086ODhw2bJl4v329vZMSEiwyCtGjhhBpVJJR0dHDhkyhD/+9BNtCer6DYQyT51Ce3s7amqqIZVK0drairq6OhiMRgBAV1dXn4iNk5MTAgIC+kR5jEYjOjo6+jyQG/k3IJVK4eXlhYiICDQ3N4v363Q66HQ6eHl5AQCampqgaW+/q0oSCerr63G6W+psRoes6AYuXb4MlUoFQRCgVqtBEp2dnTY9sKamBk888cSgc/WGhgYcP34cDg4OKC8vh1QQMHnyZNg7OAAAKisrMXz4cACAwWBAe3s7TCYTDEYjSCInJwft7e0W0arNDACA1tZWlJWVQa/Xw2QyobGxcUAbuHnzJuLi4uDk5DQoBgwZMgRDfXzw888/o7m5GYe++AKNjY14JCwcEokENTU18PTwhFQqBQB0dnZCIpGgq6sLcrkcBQUFqKysHJwEmBnQ2toqcrirq6vPhfaF/1VXV1tY8oGQXq/H8RPHIZPJ4OrqCnt7e9y8eRP5+fkgCZPJhJbWFvj5+d1Viy6dGeSEVCpFTU0N8vPzB88Ao8lkEyLr4+ODmJgYq9f279+P1NRU+Pj4WIfP+pHOpqYm6HRd6OzsRHNzM1paWqDVasEeWGB5eTlCQ0Pv2hWjCXq9XrQxOp0OV65cGTwDlI6ONiGyxcXFSElJQVjY8F7XysrKcPDgQTz33HPWvA4iRkbY4p36tTMeHh4i3N6l04kSCwBXrlyByWSyyQ70igPc3T0QEBCAurq6fid2dnbi3Llz+OKLw3jzzTfh7+8PrVaLzMzT+OMflyIpKQmPPPIIPD09UVlZCaVSCYlEgFQmxaPR0di9ezfKy8tx+/btAYOcRqMRmrY2DBkyBDU1NaJsmCW3sLAQTU3N8PT0GGgccDcEXb16db/ARmhoKA8dOsSK7tCTJA0GAzdv3sxvjx7la6+/xuRnk7l06VJ++eWX7NTpaI3q6+oZHR09KHBlxIhHOH78eKvX5HI5L1++zP5S/D7TYZIsKyujt7cXAdDf358KhUJ88Ecffsjs7GxevHjRYjNGo5Ek+dl//8vAoCAqlUpxQbGxsczIyOgBZN6bl5DwZL8AamRkJN3d3Xtdc3R05Jw5c/qcu3PnLpsYIPSWCCA4OBhbtrwHmUwGnU6HadOm3fO7HR0oLyvHuXPnUVBQIOqrWd+G+vhgy+bNYrDi6uqK+Ph4/OEPf8CaNWvQ3q5BT9U01wrup9/+di727t2LdevW4fDhw5g1a5bFdXNw5OrqanX+hQvnHwYRuns6e/fupZeXF5csWcIlS5YQAKVSKR977DE6OzvzzTfftAAnSLK9vYMkxYxvwoQJrK+vZ3r6UmZn5/RClydNSrB6gkOHDhVP3t/fn2FhYb3uiYuL4+jRj1qdHxcX1ydIYgMidE9MS0pK+dZbbzHn7Fm++uqr3eK1k/b29pw7d26vFzQ2NvLHMz/y8JeHmZ6ezrfffptr165lfn4+70+5DQYDx44dO2iQ1dPTk8nJyVavubm5sbKy8oEMkPVdOQZICYYPD8WaNWvQpdfjRneA0dLSgmeeeQbpL7/cq97o7u6OqOhoeN7xRMTICEgECQKGBVjN0LRaLZqamgYdNqvVasjlcigUCmi1Wotrzc3NyMvL6zMvsQkRAgjzmu3kclRUVEAikSAr6zQWL16MxKlT79vU3fvd3Fzh5ub6QL/e1NQEtVr9UHW+O3fuIDgoCAWFhVYQrRzMmDFjYIHQgxIdkvjd7xaLQY61YMMMcd8d7NPPV1VViWH3YKm0tBTD+jjls2fPWhjoh2ZAbW0tfHx84ODgAJKoq6vrJ0vkA0vZRUVFNoXdMpmsz02o1WooFA5ictST8vPzHxjQ2VwYIYnqmhoEBAQgIiICubm50Ol0aGhosDn1vJ+uX7/ebzFF6egIZycn2NnZ9VmSN5lM0GjarbrDhoYG5OXl/TIqoNPp0KhWQxAEBAUFidWgYcOGDTiUNS++PwYYjUZ06fXo0GrR0dHR6x0ODg5i9aihoUGMO+5XxR9++OGXYUBbmwYtLS1Qq9XQ6XSora0Vc/67GxqYFLS0tODmzZv99gjp9XoYu1GonsyTCALs7e3FpK2urk5snrifsrKyYDQa+5RSmxnQ1NSI9vZ2qFQqlJdXoKSkBHv27MGpU5nIy8uDRIIBqYJKpUJ1dfWgujvs7ewgCILIgObmZgs1kdvZiTbh2rVrKC8vH6wbvEf19fXQ6XQgiaPfHcX8lBQkJyfDz88fBoMe8fHxmDZtGuLi4mxSiaKiIqtgi5+fHxoaGvoEYgCImzNvWqfTQa/Xi8CIk1IJHx8fFBYWQqPRIDs7W4TRBi0BPdPWnTt2wE5uh7S0NLz55hv48n//w8SJE/tEiaxRwc8FVk/3+eeft2r0euq1RBAgkUhERpBEe3u7OE+j0SA+Pl60Ed9//73tNqAvMVapVBbuJeP7DCQkJKCp6a74TZkyBcHBwTYbxMKi3oFLUFAQnk1OfqBrlHYzoOd9bZo20TDr9XoEBAYiMjJSjAda29qs7q0XKqzXG6xuoqyszOLvf/3rXwgLG47p06fBTi7vN+CxhjyXlpb2upaUlISIyFH9SoBUKoVUKoUgCBYxSLum3aIhs6O9HTNmzgQAVFRUoLCg4MES0NbWhjNnsqxKxK1btyxFuKAA27Zt79G/ZztpNG2oqeltAOfOnQdvL2+4u3v0Gx+YdV2j0fRw012Q9EitGxsb8XRSEiQSCYxGo1iKu18KLBjw8Ucfo6tL36u1taOjoxcDAGDTpk24ffs2BhoHNTQ0Qq22hNtHjBiBMWNG44MPPkB9fd/Rm4uz811ITKOxkAC9vgsmo8kCXY4YNQpubm4AgKu5uTCZTL2Mq2AuUHZ0dGDP53swdKivVQNY1aOe1zM3+Oc/377nn/sZ3Z2poku9vzrk7e2N2bNn4y9/+Uu/HsBRqUR7ezs6OzstVK6rqwu6bnAUABwdHeHu7g4Pj7vSVNSdLJ06dQqdnTrxkEU3WF1djZKSEguxMtPly5fR3l2Cup8+/fQTKJWOWLhwIVxcXMTwuLy8HMU3b6K6pgbPJj+L2c/NFlVFq9X2CnB++ukneHp6Yvv27SgtLcXGjRt7vcvOTg6drtMqg4xGo8Uz/fz9LYDSO3fuiGpz4MABpKYuvocIkdTn598gAK5cubIXeDljxoxeHVv3AxAymYyOjo60t7e3em3Xrl3i886ePdfrGSkpKSwrKyNJHj9+wirIoVAobG7P279/P+/cqRZba7y9valWNzI3N5eJUxLZ1aW/hwiR1Gdn54hV1h07dlKj0VCj0XDTpk2UdleFAfDxxx8XQdKBDGdnZ549e5YkqVKpxFY5M0PNoClJfvLJJ1aZbO1/1oZUKuX1/HwePHhQ/J+Hhwera2pYUVlJf39/FhYWWjIgIyODMTEx4oTw8HCLpicADAkJ4YoVK2xeyP0jNjaWXV1d/Oabb+jg4GBxbfTo0dy9ezdXrFjR69pAR0hICFtaWjh58mQLhLmhoYElJSV0cHBgRkaGJQMOHjrI1atX9/lyT09PfvvtUcbHx4un4evrO+DFzZ07l05OTvT393/oTtO+xp///Gfu27fP4qBCQ0PZ1dXFzMxMAuBXX31lCYsHBQbh+vXrWL/+HQscTRAETJkyBVlZWSguvomcnJzuCpI7QkJCBpzMHD58GEuXLsWJEyfg7OyMX5ocHR3h6uqK5cuXW3gJPz8/yOVynDp1CgDuvdssAQaDgZMnT+YzTz/N7777jocOHeLne/fyypUr7Ozs5NatWymXy0WOTp06dVDN0q+/9rqo65s2bvrFT1+pVIqGr+d4deVKarVahoaGUqFQsLS0tDcsnp9/g0O8valQKJiSksItW7bwnXfe4aRJk3pZ9ffff59eXl42G8CgoCBu2ryZWq2WL774IouKikiSW7dupYuLy6+mDuaRk5PD7ds/JABOnDiRBoOhNwNIMjc3l+PGjev3Ya+++io3b95s88vXrVvH1tZW7tq1ixs2bODGjRu5ZcsWURIuXLjAp556yqoL7dlbJJHc/SmXyy2k8UEjPj6excXFos3auXMnSVorjFCs7uzYsYOJiYl0dnGho6MjFQoFg4KD+Y9//IPl5eUMDg62eQFhYWGsr6/nd999x7i4OK5atYqPPvqoRR/hhQsX6OPjI27MxcWFSUlJTHo6iSEhIXRxcaGrqyuDgoIYGxvLpKQkpqam8uX09H4LrDKZjEeOHBHb8OPj49nR0SEyoM8+QTOtX78et2/fxiuvvIKAgAC0tbVh0aJFOHnyJADAy9sbjWr1A1PYtLQ0fPbZZ3jvvffQ2tqKsLAwBAYGYmxMDD7497+xdu1axMbGYty4cbCzs8O4ceOwf/9+HDt2DM888wzmzZuH4OBgODk5QSqVoba2Fteu5aKkpATjx49HcXExVq9ebREOA0B6ejpcXFywYcMG+Pr64vvvv0dUVJRt3wyRZO7VXLq6unLatGlMSUmhn5/fvfqdjw8XLnzBprhAEARmZGQwLy+PH330EZubm3ngwAHGxMQwMjKSe/bsYWFhIUtKSnjmzA8MCQmhq6srvzx8mP1RVVUVFy5cxLfeeouffvqpqEYSiYQxMTFcsGABAXB4WBjP5uT0rGbb9sEESb777ru9Njls2DCeOHGiz9qctTF5ymRWV1fzww8/ZHh4OD09PbllyxZqNBpWqVTsaO/glStX6eLiQj8/P54/f96i+Np7sPvbJS1TUlKYmprKN954Q4wGXd3cCICLFi2yqBMO8IsRc/v6Za5bt44rVqzg+++/T5VKxVu3bln0AfQ37OzsKJVKGRkZSYVCwdmzZ4ueQKVS8VbpLZaWljIiIoJDhw7l1atXbWx/p/gB19SpiUxPTxcbJ6ZNn87Tp0/3YuKAGdCzoaEnLVu2zOYPpCKjIunv78+jR7/luXPn7nWJNDQwKyuLLS2tHDNmDF1cXJidnT2ADyDure/27duMjY3lggULmJCQQL1eb1WCrDHAwAHSD1k/9NvyalaZhIQEvvLKK/Tw8GBODx0kyfr6ev7pT8tYX1/Pr44coSAI/Prrr/kwdOTIEU6bNo2vv/56v/d173mCrHvBegC0pU4nCAJyc3ORuiTVasvrkCFDMGfOHISHh+M///kPQkNDsXv3buzZswfjx4+HyWSCIAhobGxCSkoKnnzySXh5eeHbb77BCy+8gGefffahPpyeOnUqZDIZgoKC+nxONxhiAEAZgHxBEBIBSGz9ePrdd9/tBZKaadmyZVi1ahV+/PFH+Pn54ejRo4iIiEBycnLPl+PcubM4ffo0NmzYIGKO8+fPt7hnMKRUKh9YEu9+BwHk/x/Xx9fQlyLCcAAAAABJRU5ErkJggg==",pi:"data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgODAwIDgwMCIgd2lkdGg9IjFlbSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+UGk8L3RpdGxlPjxwYXRoIGZpbGw9IiNGMDkwODIiIGQ9Ik0xNjUuMjkgMTY1LjI5SDUxNy4zNlY0MDBINDAwVjI4Mi42NUgxNjUuMjlaIi8+PHBhdGggZmlsbD0iIzREOUFCRiIgZD0iTTE2NS4yOSAyODIuNjVIMjgyLjY1VjQwMEg0MDBWNTE3LjM2SDI4Mi42NVY2MzQuNzJIMTY1LjI5WiIvPjxwYXRoIGZpbGw9IiNGMUJFNTgiIGQ9Ik01MTcuMzYgNDAwSDYzNC43MlY2MzQuNzJINTE3LjM2WiIvPjwvc3ZnPg=="};var Pn=require("react/jsx-runtime");function Tt({tool:e,size:t=20,muted:n=!1}){let i=e==="claude-desktop"||e==="claude-code"?"claude":e,o=si[i]||(qt[i]?"data:image/svg+xml,"+encodeURIComponent(qt[i]):null);return(0,Pn.jsx)("span",{className:"cmd-tool-brand","data-muted":n||void 0,"aria-hidden":"true",style:{display:"inline-flex",alignItems:"center",justifyContent:"center",width:t,height:t,flexShrink:0,verticalAlign:"middle"},children:o?(0,Pn.jsx)("img",{src:o,alt:"",width:t,height:t,draggable:!1,style:{display:"block",width:t,height:t,objectFit:"contain"}}):(0,Pn.jsx)("span",{style:{fontSize:t*.7},children:"\u2318"})})}var jt=e=>Array.isArray(e)?e:[],Rs={id:"deepseek",name:"DeepSeek",installed:!0,chatSupported:!0,routeSupported:!0};function Eo(e){let t=new Set(["deepseek"]);return[Rs,...jt(e?.tools).filter(n=>!n?.id||t.has(n.id)||!n.installed||!n.chatSupported?!1:(t.add(n.id),!0))]}function ko(e){return typeof e=="string"&&e.startsWith("commander-")?e.slice(10):"deepseek"}function Yt(e,t){return!e||e.authMode!=="subscription"?!0:jt(e.harnessTools).includes(t)}function Lo(e,t,n,i){let o=a=>t.reasoning?.efforts?.some(r=>r.id===a);if(i!==void 0){if(!o(i))throw Error("\u8BE5\u6A21\u578B\u4E0D\u652F\u6301\u6240\u9009\u601D\u8003\u5F3A\u5EA6\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9");return i}return n?.provider===e&&n.model===t.id&&o(n.reasoningEffort)?n.reasoningEffort:o(t.reasoning?.defaultEffort)?t.reasoning.defaultEffort:void 0}function So(e,t,n){let i=new Map,o=(a,r,s,d,c)=>{i.has(a)||i.set(a,{id:a,name:r||a,models:[]});let f=i.get(a);f.models.some(u=>u.group.id===s.id&&u.model.id===d.id)||f.models.push({group:s,model:d,nativeModelId:c})};for(let a of jt(e))if(n==="deepseek"){if(a.id.startsWith("commander-"))continue;let r=jt(t?.providers).find(s=>s.id===a.id);if(!Yt(r,n)||Array.isArray(r?.tools)&&!r.tools.includes(n))continue;for(let s of jt(a.models))o(a.id,a.name,a,s,s.id);jt(a.models).length||i.set(a.id,{id:a.id,name:a.name||a.id,models:[]})}else if(a.id==="commander-"+n)for(let r of jt(t?.routes).filter(s=>s.tool===n)){let s=jt(a.models).find(d=>d.id===r.modelId);s&&o(r.providerId,r.providerName,a,s,r.nativeModelId)}for(let a of jt(t?.providers).filter(r=>r.nativeRequired&&Yt(r,n)))i.has(a.id)||i.set(a.id,{id:a.id,name:a.name||a.id,models:[]});return[...i.values()].map(a=>{let r=jt(t?.providers).find(s=>s.id===a.id);return{...a,...r?.declared===!0?{declared:!0}:{},...r?.authMode==="subscription"?{authMode:r.authMode,harnessTools:r.harnessTools,nativeRequired:r.nativeRequired,configured:r.configured,routeReason:r.routeReason}:{}}})}var di=`/* Model trigger button */
.cmd-model-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 240px;
  min-width: 0;
  flex-shrink: 0;
  box-sizing: border-box;
  padding: 5px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 160ms cubic-bezier(0.16, 1, 0.3, 1);
}
.cmd-model-caption{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmd-model-trigger:hover:not(:disabled) {
  background: color-mix(in srgb, currentColor 7%, transparent);
}
.cmd-model-trigger:active:not(:disabled) {
  transform: scale(0.985);
}

/* Outer Popup Container: pure transparent wrapper */
.cmd-model-popup {
  z-index: 10050;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0;
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  font: inherit;
  font-size: 13px;
  line-height: 1.45;
  animation: cmd-picker-enter 180ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

/* Translucent White Glassmorphic Overlay with Pure Black Kinetic LOADING Letters */
.cmd-model-loading-overlay {
  position: absolute;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.65);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  animation: cmd-overlay-fade 160ms ease both;
  pointer-events: all;
  user-select: none;
}
[data-ds-dark-theme] .cmd-model-loading-overlay {
  background: rgba(20, 22, 26, 0.7);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}
.cmd-model-shimmer-text {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  font-weight: 750;
  letter-spacing: 0.28em;
  padding-left: 0.28em;
}
.cmd-model-shimmer-text span {
  display: inline-block;
  animation: cmd-letter-wave 1.3s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  animation-delay: calc(var(--char-idx) * 85ms);
  color: var(--cmd-shimmer-idle, rgba(16, 18, 20, 0.2));
}
[data-ds-dark-theme] .cmd-model-shimmer-text span {
  --cmd-shimmer-idle: rgba(255, 255, 255, 0.2);
}
@keyframes cmd-letter-wave {
  0%, 100% {
    color: rgba(16, 18, 20, 0.2);
    transform: translateY(0);
  }
  35% {
    color: #000000;
    transform: translateY(-2.5px);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  }
  70% {
    color: rgba(16, 18, 20, 0.35);
    transform: translateY(0);
  }
}
[data-ds-dark-theme] .cmd-model-shimmer-text span {
  animation-name: cmd-letter-wave-dark;
}
@keyframes cmd-letter-wave-dark {
  0%, 100% {
    color: rgba(255, 255, 255, 0.2);
    transform: translateY(0);
  }
  35% {
    color: #ffffff;
    transform: translateY(-2.5px);
    text-shadow: 0 0 6px rgba(255, 255, 255, 0.4);
  }
  70% {
    color: rgba(255, 255, 255, 0.4);
    transform: translateY(0);
  }
}
@keyframes cmd-overlay-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes cmd-picker-enter {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* Card 1: Provider & Model Selector Card */
.cmd-model-provider-card {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, currentColor 8%, transparent);
  background: var(--dsw-alias-bg-layer-2, #ffffff) !important;
  color: var(--dsw-alias-label-primary, #1e2022);
  box-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.04) !important;
}
[data-ds-dark-theme] .cmd-model-provider-card {
  background: var(--dsw-alias-bg-layer-2, #1c1d21) !important;
  color: var(--dsw-alias-label-primary, #f0f2f5);
  border-color: rgba(255, 255, 255, 0.08);
  box-shadow: 0 6px 20px -2px rgba(0, 0, 0, 0.45) !important;
}

/* Header within Provider Card */
.cmd-model-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 48px;
  padding: 0 12px;
  box-sizing: border-box;
  font-weight: 550;
  border-bottom: 1px solid color-mix(in srgb, currentColor 6%, transparent);
}
.cmd-model-heading {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  padding-left: 2px;
}
.cmd-model-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  height: 30px;
  padding: 0 6px 0 2px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 150ms ease;
}
.cmd-model-back:hover {
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.cmd-model-back > span {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* Tool Switcher Button in Header */
.cmd-model-tool-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 28px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, currentColor 9%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, currentColor 3%, transparent);
  color: inherit;
  font: inherit;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 150ms ease;
}
.cmd-model-tool-trigger:hover:not(:disabled) {
  background: color-mix(in srgb, currentColor 7%, transparent);
  border-color: color-mix(in srgb, currentColor 14%, transparent);
}
.cmd-model-tool-trigger:disabled {
  opacity: 0.5;
  cursor: default;
}
.cmd-model-tool-trigger > span:not(.cmd-tool-brand):not(.cmd-ui-icon) {
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Tool dropdown menu */
.cmd-model-tool-menu {
  position: absolute;
  z-index: 10;
  top: 48px;
  right: 12px;
  width: min(250px, calc(100% - 24px));
  max-height: 260px;
  overflow: auto;
  box-sizing: border-box;
  padding: 5px;
  border: 1px solid color-mix(in srgb, currentColor 9%, transparent);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, #fff);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
}
[data-ds-dark-theme] .cmd-model-tool-menu {
  background: #1c1d21;
  border-color: rgba(255, 255, 255, 0.1);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.cmd-model-tool-menu > button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.cmd-model-tool-menu > button:hover:not(:disabled) {
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.cmd-model-tool-menu > button.is-selected {
  background: color-mix(in srgb, #4d6bfe 10%, transparent);
  color: var(--dsw-alias-label-link, #4d6bfe);
  font-weight: 550;
}
.cmd-model-tool-menu > small {
  display: block;
  padding: 6px 10px;
  font-size: 10.5px;
  opacity: 0.5;
}

/* Search bar */
.cmd-model-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 10px 4px;
  padding: 0 10px;
  height: 32px;
  border-radius: 7px;
  background: color-mix(in srgb, currentColor 3.5%, transparent);
  border: 1px solid transparent;
  transition: all 160ms ease;
}
.cmd-model-search:focus-within {
  background: transparent;
  border-color: var(--dsw-alias-label-link, #4d6bfe);
  box-shadow: 0 0 0 2px color-mix(in srgb, #4d6bfe 18%, transparent);
}
.cmd-model-search > .cmd-ui-icon {
  opacity: 0.45;
  flex: none;
}
.cmd-model-search input {
  appearance: none;
  width: 100%;
  min-width: 0;
  border: 0 !important;
  outline: none !important;
  background: transparent !important;
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 0;
  margin: 0;
}
.cmd-model-search input::placeholder {
  color: inherit;
  opacity: 0.42;
}

/* Options List (Providers or Models) */
.cmd-model-options {
  overflow-y: auto;
  overflow-x: hidden;
  max-height: 250px;
  padding: 4px 6px 6px;
  box-sizing: border-box;
}
.cmd-model-options::-webkit-scrollbar {
  width: 4px;
}
.cmd-model-options::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, currentColor 14%, transparent);
  border-radius: 4px;
}

/* Provider list row */
.cmd-model-provider {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
  transition: background 150ms ease;
}
.cmd-model-provider:hover:not(:disabled) {
  background: color-mix(in srgb, currentColor 5%, transparent);
}
.cmd-model-provider.is-selected {
  background: color-mix(in srgb, #4d6bfe 8%, transparent);
}
.cmd-model-provider-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: color-mix(in srgb, currentColor 5%, transparent);
  flex: none;
}
.cmd-model-provider-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.cmd-model-provider-copy > span {
  font-size: 12.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmd-model-provider-copy > small {
  font-size: 11px;
  opacity: 0.5;
}
.cmd-model-popup .cmd-model-next {
  transform: rotate(180deg);
  opacity: 0.4;
  flex: none;
}

/* Model Choice Row */
.cmd-model-choice {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 38px;
  padding: 0 4px;
  border-radius: 8px;
  margin-bottom: 2px;
  transition: background 140ms ease;
}
.cmd-model-choice:hover {
  background: color-mix(in srgb, currentColor 4%, transparent);
}
.cmd-model-choice.is-selected {
  background: color-mix(in srgb, #4d6bfe 7%, transparent);
}
.cmd-model-choice > button:first-child {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.cmd-model-choice-label {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.cmd-model-choice-label > span {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmd-model-choice-label > small {
  font-size: 10.5px;
  opacity: 0.5;
  font-family: ui-monospace, SFMono-Regular, monospace;
}
.cmd-model-choice.is-selected .cmd-model-choice-label > span {
  color: var(--dsw-alias-label-link, #4d6bfe);
  font-weight: 600;
}

/* Pinned Icon Button (Strict 26x26 square, centered) */
.cmd-model-pin {
  box-sizing: border-box !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 26px !important;
  height: 26px !important;
  min-width: 26px !important;
  min-height: 26px !important;
  flex: 0 0 26px !important;
  padding: 0 !important;
  margin: 0 4px 0 0 !important;
  border: 1px solid transparent !important;
  border-radius: 6px !important;
  background: transparent !important;
  color: var(--dsw-alias-label-secondary, #71767b) !important;
  cursor: pointer !important;
  opacity: 0;
  transition: opacity 140ms ease, background 140ms ease, border-color 140ms ease !important;
}
.cmd-model-choice:hover .cmd-model-pin,
.cmd-model-pin:focus-visible,
.cmd-model-pin.is-pinned {
  opacity: 1;
}
.cmd-model-pin:hover {
  background: color-mix(in srgb, currentColor 8%, transparent) !important;
  color: var(--dsw-alias-label-primary, #1e2022) !important;
}
.cmd-model-pin.is-pinned {
  color: var(--dsw-alias-label-link, #4d6bfe) !important;
  background: color-mix(in srgb, #4d6bfe 10%, transparent) !important;
  border-color: color-mix(in srgb, #4d6bfe 24%, transparent) !important;
}
.cmd-model-pin svg {
  display: block;
  margin: auto;
  flex: none;
}

/* Native required notice */
.cmd-model-native-required {
  padding: 10px;
  text-align: center;
}
.cmd-model-native-required p {
  margin: 0 0 8px;
  font-size: 11.5px;
  opacity: 0.6;
}
.cmd-model-native-required button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, currentColor 4%, transparent);
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

/* ============================================================ */
/* Card 2: Current Model & Reasoning Slider Card                */
/* ============================================================ */
.cmd-model-current-card {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 12px 14px 14px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, currentColor 8%, transparent);
  background: var(--dsw-alias-bg-layer-2, #ffffff) !important;
  color: var(--dsw-alias-label-primary, #1e2022);
  box-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.04) !important;
}
[data-ds-dark-theme] .cmd-model-current-card {
  background: var(--dsw-alias-bg-layer-2, #1c1d21) !important;
  color: var(--dsw-alias-label-primary, #f0f2f5);
  border-color: rgba(255, 255, 255, 0.08);
  box-shadow: 0 6px 20px -2px rgba(0, 0, 0, 0.45) !important;
}

/* Current Model header row: "\u5F53\u524D\u6A21\u578B" on left, "Provider / Model" on right */
.cmd-model-current-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  margin-bottom: 2px;
}
.cmd-model-current-title > span {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--dsw-alias-label-secondary, #71767b);
  flex: none;
}
.cmd-model-current-title > strong {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmd-model-current-title em {
  font-style: normal;
  color: var(--dsw-alias-label-secondary, #71767b);
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmd-model-current-title i {
  font-style: normal;
  opacity: 0.35;
  font-weight: 300;
}
.cmd-model-current-title b {
  font-weight: 600;
  color: inherit;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Reasoning effort block inside Card 2 */
.cmd-model-effort-section {
  display: flex;
  flex-direction: column;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed color-mix(in srgb, currentColor 8%, transparent);
}
.cmd-model-effort-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.cmd-model-effort-heading > span {
  font-size: 11px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary, #71767b);
}
.cmd-model-effort-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.cmd-model-effort-spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid color-mix(in srgb, #0099ff 30%, transparent);
  border-top-color: #0099ff;
  border-radius: 50%;
  animation: cmd-effort-spin 700ms linear infinite;
}
@keyframes cmd-effort-spin {
  to { transform: rotate(360deg); }
}
.cmd-model-effort-heading strong {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: #0b8054;
  background: color-mix(in srgb, #00c885 14%, transparent);
  transition: all 160ms ease;
}
.cmd-model-effort-heading strong[data-off="true"] {
  color: var(--dsw-alias-label-secondary, #71767b);
  background: color-mix(in srgb, currentColor 6%, transparent);
}

/* ============================================================ */
/* THE DRAG TRACK & CYBERPUNK ION PARTICLES                     */
/* Large sleek rounded rail with embedded circular thumb         */
/* ============================================================ */
.cmd-model-effort-track {
  position: relative;
  box-sizing: border-box;
  height: 38px;
  padding: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 6%, transparent);
  border: 1px solid color-mix(in srgb, currentColor 7%, transparent);
  cursor: pointer;
  touch-action: none;
  user-select: none;
  outline: none;
  transition: border-color 160ms ease, box-shadow 160ms ease;
}
.cmd-model-effort-track:focus-visible {
  border-color: var(--dsw-alias-label-link, #4d6bfe);
  box-shadow: 0 0 0 3px color-mix(in srgb, #4d6bfe 22%, transparent);
}
.cmd-model-effort-track.is-dragging {
  cursor: grabbing;
}

/* Inner rail containing the fill, ticks and thumb */
.cmd-model-effort-rail {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 999px;
  overflow: visible;
}

/* Background step ticks (subtle dots along the rail) */
.cmd-model-effort-ticks {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.cmd-model-effort-tick {
  position: absolute;
  top: 50%;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: color-mix(in srgb, currentColor 14%, transparent);
  transition: background 150ms ease, transform 150ms ease;
}
.cmd-model-effort-tick.is-active {
  background: rgba(255, 255, 255, 0.55);
}

/* Active Fill Bar: stretches from left pad (16px) to thumb center */
/* Active Fill Bar: stretches from 0 to thumb position, or 100% when activeRatio is near 1 */
.cmd-model-effort-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  /* Expands to 100% full container right side when reached or near max */
  width: calc(16px + (100% - 32px) * var(--effort-ratio) + 16px * max(0, (var(--effort-ratio) - 0.85) / 0.15));
  max-width: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #02b37d 0%, #0099ff 55%, #7a42f4 100%);
  overflow: hidden;
  pointer-events: none;
  transition: opacity 160ms ease;
  opacity: calc(0.12 + 0.88 * var(--effort-intensity));
}
.cmd-model-effort-track.is-off:not(.is-dragging) .cmd-model-effort-fill {
  opacity: 0;
}

/* Ambient glow on the active fill: very soft, light & refined */
.cmd-model-effort-glow {
  position: absolute;
  right: -6px;
  top: -6px;
  bottom: -6px;
  width: 24px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(0, 190, 255, 0.28) 0%, transparent 70%);
  filter: blur(3px);
  pointer-events: none;
  opacity: 0.6;
}

/* ============================================================ */
/* ION PARTICLES LAYER: ULTRA-FINE MULTI-TIER STAR FIELD         */
/* Higher density of micro-particles (0.8px - 1.2px), soft glow  */
/* ============================================================ */
.cmd-model-effort-ions {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  opacity: calc(0.4 + 0.6 * var(--effort-intensity));
  mix-blend-mode: screen;
}
.cmd-model-effort-ions-a {
  /* Tier 1: Dense micro stardust field */
  background-image:
    radial-gradient(0.9px 0.9px at 6% 32%, rgba(255, 255, 255, 0.95) 100%, transparent 0),
    radial-gradient(1.1px 1.1px at 16% 68%, rgba(210, 250, 255, 0.85) 100%, transparent 0),
    radial-gradient(0.8px 0.8px at 27% 24%, rgba(255, 255, 255, 0.9) 100%, transparent 0),
    radial-gradient(1.2px 1.2px at 38% 76%, rgba(180, 240, 255, 0.85) 100%, transparent 0),
    radial-gradient(0.9px 0.9px at 49% 36%, rgba(255, 255, 255, 0.9) 100%, transparent 0),
    radial-gradient(1.1px 1.1px at 61% 62%, rgba(210, 245, 255, 0.85) 100%, transparent 0),
    radial-gradient(0.8px 0.8px at 73% 28%, rgba(255, 255, 255, 0.9) 100%, transparent 0),
    radial-gradient(1.2px 1.2px at 84% 74%, rgba(190, 235, 255, 0.85) 100%, transparent 0),
    radial-gradient(0.9px 0.9px at 94% 40%, rgba(255, 255, 255, 0.95) 100%, transparent 0);
  background-size: 80px 100%;
  animation: cmd-ions-drift calc(3.2s / max(0.5, var(--effort-intensity))) linear infinite;
}
.cmd-model-effort-ions-b {
  /* Tier 2: Floating interstellar dust */
  background-image:
    radial-gradient(0.8px 0.8px at 10% 72%, rgba(255, 255, 255, 0.8) 100%, transparent 0),
    radial-gradient(1.1px 1.1px at 22% 42%, rgba(170, 250, 230, 0.8) 100%, transparent 0),
    radial-gradient(0.9px 0.9px at 34% 82%, rgba(255, 255, 255, 0.85) 100%, transparent 0),
    radial-gradient(1.2px 1.2px at 45% 20%, rgba(200, 230, 255, 0.8) 100%, transparent 0),
    radial-gradient(0.8px 0.8px at 56% 70%, rgba(255, 255, 255, 0.8) 100%, transparent 0),
    radial-gradient(1.1px 1.1px at 68% 38%, rgba(180, 245, 240, 0.85) 100%, transparent 0),
    radial-gradient(0.9px 0.9px at 80% 80%, rgba(255, 255, 255, 0.85) 100%, transparent 0),
    radial-gradient(1.2px 1.2px at 91% 25%, rgba(215, 225, 255, 0.8) 100%, transparent 0);
  background-size: 104px 100%;
  animation: cmd-ions-drift-rev calc(4.2s / max(0.5, var(--effort-intensity))) linear infinite;
  opacity: 0.75;
}
@keyframes cmd-ions-drift {
  from { background-position: 0 0; }
  to { background-position: 80px 0; }
}
@keyframes cmd-ions-drift-rev {
  from { background-position: 104px 0; }
  to { background-position: 0 0; }
}

/* ============================================================ */
/* PURE METALLIC SOLID THUMB (NO INNER RECTANGLES/RINGS)        */
/* Seamless radial machined alloy coin with physical bevel      */
/* ============================================================ */
.cmd-model-effort-thumb {
  position: absolute;
  top: 50%;
  left: calc(16px + (100% - 32px) * var(--effort-ratio));
  width: 28px;
  height: 28px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  /* Real machined metal surface: subtle brushed radial reflection with soft top specular */
  background:
    radial-gradient(circle at 40% 30%, #ffffff 0%, #edf1f6 38%, #d8e0e8 72%, #b9c4d0 100%);
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.22),
    0 3px 10px rgba(0, 0, 0, 0.14),
    inset 0 1.5px 1.5px rgba(255, 255, 255, 0.95),
    inset 0 -1.5px 1.5px rgba(0, 0, 0, 0.2),
    0 0 0 1px rgba(0, 0, 0, 0.12);
  pointer-events: none;
  transition: transform 120ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 150ms ease;
}

/* Precision metallic chamfer reflection */
.cmd-model-effort-thumb::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(
    from 45deg,
    rgba(255, 255, 255, 0.6) 0deg,
    rgba(140, 160, 185, 0.2) 90deg,
    rgba(255, 255, 255, 0.75) 180deg,
    rgba(130, 150, 175, 0.2) 270deg,
    rgba(255, 255, 255, 0.6) 360deg
  );
  mix-blend-mode: overlay;
  pointer-events: none;
}

.cmd-model-effort-track.is-dragging .cmd-model-effort-thumb {
  transform: translate(-50%, -50%) scale(1.06);
  box-shadow:
    0 2px 6px rgba(0, 0, 0, 0.25),
    0 4px 12px rgba(0, 0, 0, 0.16),
    0 0 0 2px rgba(0, 153, 255, 0.2),
    inset 0 1px 1.5px #ffffff;
}
[data-ds-dark-theme] .cmd-model-effort-thumb {
  background:
    radial-gradient(circle at 40% 30%, #545c6b 0%, #3a424e 42%, #262c35 78%, #1c2027 100%);
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.65),
    0 4px 14px rgba(0, 0, 0, 0.5),
    inset 0 1.5px 1.5px rgba(255, 255, 255, 0.35),
    inset 0 -1.5px 1.5px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(255, 255, 255, 0.1);
}
/* Step Labels under the slider */
.cmd-model-effort-scale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding: 0 4px;
}
.cmd-model-effort-step {
  padding: 2px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #71767b);
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 140ms ease;
}
.cmd-model-effort-step:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary, #1e2022);
  background: color-mix(in srgb, currentColor 5%, transparent);
}
.cmd-model-effort-step.is-current {
  color: var(--dsw-alias-label-link, #4d6bfe);
  font-weight: 600;
}
[data-ds-dark-theme] .cmd-model-effort-step.is-current {
  color: #5c82ff;
}

/* Footer / status */
.cmd-model-footer {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #fff);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  font-size: 11px;
}
.cmd-model-footer span {
  flex: 1;
  overflow-wrap: anywhere;
  opacity: 0.75;
}
.cmd-model-footer button {
  padding: 4px 8px;
  border: 0;
  border-radius: 4px;
  background: color-mix(in srgb, currentColor 6%, transparent);
  color: inherit;
  font: inherit;
  cursor: pointer;
}

/* Responsive adjustments */
@media(max-width:767px){.cmd-model-trigger{max-width:min(180px,46vw);flex-shrink:1}}
@media (prefers-reduced-motion: reduce) {
  .cmd-model-popup,
  .cmd-model-popup * {
    animation: none !important;
    transition: none !important;
  }
}
`;function li(e){if(e.type==="tool.output")return{label:"\u547D\u4EE4\u8F93\u51FA",detail:String(e.data?.text||"").trim().slice(-180),state:"running"};if(e.type!=="item")return null;let t=e.data?.item||e.data?.part||e.data,n=t?.type||t?.kind,i=e.data?.phase||e.data?.delta?.type;if(/reasoning|thought/i.test(n||""))return{label:"\u6B63\u5728\u601D\u8003",detail:"",state:"running"};if(/commandExecution|command_execution|tool_call|mcpTool|webSearch|image|browser/i.test(n||"")){let o=t.command||t.rawInput||t.input||t.title||"",a=/completed|end|update/i.test(i||"")||/completed|success|failed/i.test(t.status||""),r=/commandExecution|command_execution/i.test(n)?"\u547D\u4EE4":/file/i.test(n)?"\u6587\u4EF6\u64CD\u4F5C":/mcp/i.test(n)?"MCP \u5DE5\u5177":/webSearch|browser/i.test(n)?"\u7F51\u9875\u641C\u7D22":/image/i.test(n)?"\u56FE\u50CF\u5DE5\u5177":"\u5DE5\u5177";return{label:a?`${r}\u5DF2\u5B8C\u6210`:`\u6B63\u5728\u8C03\u7528${r}`,detail:typeof o=="string"?o.slice(0,180):JSON.stringify(o).slice(0,180),state:a?"done":"running"}}return/fileChange|file_change/i.test(n||"")?{label:"\u6587\u4EF6\u53D8\u66F4",detail:String(t.title||t.status||"").slice(0,180),state:"running"}:null}var Qn=require("@deepseek-ai/dsh-client-ui-primitives"),W=require("react/jsx-runtime");function ui(e){let t=document.createElement("style");t.textContent=di,document.head.append(t),e.effect(()=>()=>t.remove()),e.slots.inject("conversation.input.model",()=>e.slots.register({name:"conversation.input.model",priority:-10,inject:n=>{let i=e.modelDirectories.directoryFor(n);return{available:e.sessions.subagentAddress(n)===void 0,hooks:{directory:i.store},load:()=>i.load(),select:o=>i.select(o),binding:async()=>{let o=await fetch(new URL("api/commander",document.baseURI),{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({action:"binding",harnessSessionId:n})}),a=await Xe(o,new URL("api/commander",document.baseURI));if(a.error)throw Error(a.error||"\u4F1A\u8BDD\u7ED1\u5B9A\u72B6\u6001\u8BFB\u53D6\u5931\u8D25");return a},openToolSettings:()=>{let a=e.slots.entries("sidebar.settings").find(r=>r.children?.["settings.section"])?.store?.create().actions;if(!a?.openSection)throw Error("\u8BF7\u6253\u5F00\u8BBE\u7F6E\u4E2D\u7684 Harness \u5DE5\u5177\uFF0C\u4F7F\u7528\u5BF9\u5E94\u5DE5\u5177\u7684\u672C\u673A\u8BA2\u9605\u767B\u5F55\u3002");a.openSection("harness-tools")}}}},Qs)),e.slots.inject("conversation.input.dock",()=>e.slots.register({name:"conversation.input.dock",id:"commander-native-activity",order:-20,inject:n=>({sessionId:n})},Ps))}function Ps({sessionId:e}){let[t,n]=(0,Ce.useState)(null);return(0,Ce.useEffect)(()=>{let i=!0,o,a,r=0,s=[],d=async f=>{let u=await fetch(new URL("api/commander",document.baseURI),{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(f)}),l=await Xe(u,new URL("api/commander",document.baseURI));if(l.error)throw Error(l.error||"\u8BFB\u53D6\u539F\u751F\u5DE5\u5177\u6D3B\u52A8\u5931\u8D25");return l},c=async()=>{try{if(!a){let l=await d({action:"binding",harnessSessionId:e});if(!i)return;if(!l.bound){o=setTimeout(c,2e3);return}a=l.id,r=Math.max(0,(l.cursor||0)-40)}let f=await d({action:"events",id:a,after:r});if(!i)return;r=f.cursor,s=[...s,...f.events||[]].slice(-20);let u=s.map(li).filter(Boolean).slice(-8);u.length&&n({provider:f.session.provider,status:f.session.status,rows:u}),["running","waiting","connecting"].includes(f.session.status)?o=setTimeout(c,700):u.length||n(null)}catch{i&&(o=setTimeout(c,2500))}};return c(),()=>{i=!1,clearTimeout(o)}},[e]),t?(0,W.jsxs)("section",{className:"cmd-native-activity","aria-label":"\u539F\u751F\u5DE5\u5177\u6D3B\u52A8","aria-live":"polite",children:[(0,W.jsxs)("header",{children:[(0,W.jsxs)("span",{children:[t.provider==="codex"?"Codex":t.provider," \u6D3B\u52A8"]}),(0,W.jsx)("span",{children:t.status==="running"?"\u8FD0\u884C\u4E2D":t.status==="waiting"?"\u7B49\u5F85\u786E\u8BA4":t.status==="connecting"?"\u8FDE\u63A5\u4E2D":"\u5DF2\u5B8C\u6210"})]}),(0,W.jsx)("ol",{children:t.rows.map((i,o)=>(0,W.jsxs)("li",{"data-state":i.state,children:[(0,W.jsx)("span",{children:i.label}),i.detail&&(0,W.jsx)("code",{children:i.detail})]},o))})]}):null}function Qs({locked:e,available:t,useDirectory:n,load:i,select:o,binding:a,openToolSettings:r}){let s=n(U=>U),[d,c]=(0,Ce.useState)(!1),[f,u]=(0,Ce.useState)("deepseek"),[l,p]=(0,Ce.useState)(null),[M,D]=(0,Ce.useState)(""),[g,y]=(0,Ce.useState)(null),[I,L]=(0,Ce.useState)(!1),[b,x]=(0,Ce.useState)(0),[F,_]=(0,Ce.useState)(!1),[Z,Q]=(0,Ce.useState)(null),[v,E]=(0,Ce.useState)(""),[O,P]=(0,Ce.useState)(""),[G,j]=(0,Ce.useState)(null),[J,oe]=(0,Ce.useState)(""),[R,T]=(0,Ce.useState)(null),[V,de]=(0,Ce.useState)(null),$=(0,Ce.useRef)((()=>{try{return JSON.parse(localStorage.getItem("commander.pinned-models")||"{}")||{}}catch{return{}}})()),se=(0,Ce.useRef)(null),re=(0,Ce.useRef)(null),ee=(0,Ce.useRef)(null),X=(0,Ce.useRef)(!1),B=(0,Ce.useRef)(null),S=(0,Ce.useId)(),H=ko(s.current?.provider),ae=Eo(g),he=ae.find(U=>U.id===f),ge=s.groups.find(U=>U.id===s.current?.provider),Re=ge?.models.find(U=>U.id===s.current?.model),Ye=s.status==="selecting",je=s.status==="loading"||I;(0,Ce.useEffect)(()=>{T(null),de(null)},[s.current?.provider,s.current?.model]),(0,Ce.useEffect)(()=>{let U=!0,ie,xe=async()=>{try{let Ne=await a();U&&(j(Ne),oe(""))}catch(Ne){U&&oe(Ne.message)}finally{U&&(ie=setTimeout(xe,2e3))}};return j(null),oe(""),xe(),()=>{U=!1,clearTimeout(ie)}},[]);let Ze=e||typeof a=="function"&&(G===null||!!J||!!G?.bound&&!G?.route?.providerId),pe=G?.bound?G.provider:null,Y=G?.bound?G.route?.providerId:null,le=Ze||!!pe,be=J||(G?.bound&&!G?.route?.providerId?"\u6B64\u5BF9\u8BDD\u4F7F\u7528\u672C\u673A\u9ED8\u8BA4\u6A21\u578B\uFF0C\u5F53\u524D\u4E0D\u80FD\u5728\u4F1A\u8BDD\u4E2D\u5207\u6362\u4F9B\u5E94\u5546\u6A21\u578B":G?.bound?"\u5F53\u524D\u4F1A\u8BDD\u53EF\u5728\u5DF2\u9009\u5DE5\u5177\u548C\u4F9B\u5E94\u5546\u5185\u5207\u6362\u6A21\u578B":G===null?"\u6B63\u5728\u786E\u8BA4\u4F1A\u8BDD\u7ED1\u5B9A\u72B6\u6001\u2026":""),h=()=>{c(!1),p(null),_(!1),D(""),T(null)},ne=()=>{E(""),x(U=>U+1),i().catch(U=>E(U.message))};(0,Ce.useEffect)(()=>{if(!d)return;let U=new AbortController;return L(!0),P(""),(async()=>{let ie=await fetch(new URL("api/commander/tooling",document.baseURI),{method:"POST",credentials:"same-origin",signal:U.signal,headers:{"content-type":"application/json"},body:JSON.stringify({action:"pickerCatalog"})}),xe=await Xe(ie,new URL("api/commander/tooling",document.baseURI));if(xe.error)throw Error(typeof xe.error=="string"?xe.error:xe.error?.message||"\u5DE5\u5177\u76EE\u5F55\u52A0\u8F7D\u5931\u8D25");U.signal.aborted||(y(xe),u(Ne=>Eo(xe).some(et=>et.id===Ne&&et.routeSupported)?Ne:"deepseek"))})().catch(ie=>{U.signal.aborted||P(ie.message)}).finally(()=>{U.signal.aborted||L(!1)}),()=>U.abort()},[d,b]),(0,Ce.useEffect)(()=>{if(!d)return;let U=()=>{let Ne=se.current?.getBoundingClientRect();if(!Ne)return;let et=Math.min(368,window.innerWidth-24),Wt=window.innerHeight-Ne.bottom,sn=(window.top,Ne.top),dn=sn>Wt;Q({position:"fixed",width:et,left:Math.max(12,Math.min(Ne.right-et,window.innerWidth-et-12)),...dn?{bottom:window.innerHeight-Ne.top+8}:{top:Ne.bottom+8},maxHeight:Math.max(100,Math.min(520,(dn?sn:Wt)-20))})};U();let ie=Ne=>{!re.current?.contains(Ne.target)&&!se.current?.contains(Ne.target)&&h()},xe=Ne=>{Ne.key==="Escape"&&(Ne.preventDefault(),Ne.stopPropagation(),F?(_(!1),B.current?.focus()):(h(),se.current?.focus()))};return document.addEventListener("pointerdown",ie),document.addEventListener("keydown",xe,!0),window.addEventListener("resize",U),window.addEventListener("scroll",U,!0),()=>{document.removeEventListener("pointerdown",ie),document.removeEventListener("keydown",xe,!0),window.removeEventListener("resize",U),window.removeEventListener("scroll",U,!0)}},[d,F]),(0,Ce.useEffect)(()=>{d&&!F&&ee.current?.focus()},[d,l,F]),(0,Ce.useEffect)(()=>{F&&re.current?.querySelector('.cmd-model-tool-menu button[aria-checked="true"]')?.focus()},[F]);let C=async(U,ie,xe,Ne=!1)=>{if(X.current||Ze||I||!g||O)return!1;X.current=!0,E("");try{let et=g.routes?.find(xn=>xn.modelId===ie.id&&"commander-"+xn.tool===U.id),Wt=g.providers?.find(xn=>xn.id===(et?.providerId||U.id));if(!Yt(Wt,ko(U.id)))throw Error("\u6B64\u8BA2\u9605\u4EC5\u5141\u8BB8\u4F7F\u7528\u5BF9\u5E94\u7684 Harness \u5DE5\u5177");let sn=Lo(U.id,ie,s.current,xe),dn=await o({provider:U.id,model:ie.id,...sn===void 0?{}:{reasoningEffort:sn}});if(!dn?.ok)throw new Error(dn?.error?.message??"\u6A21\u578B\u9009\u62E9\u4E0D\u53EF\u7528");return Ne||(h(),se.current?.focus()),!0}catch(et){return E(et.message),!1}finally{X.current=!1}},m=(U,ie)=>`${U.id}/${ie.id}`,q=(U,ie)=>($.current||{})[m(U,ie)]===!0,fe=(U,ie,xe)=>{xe.stopPropagation(),$.current={...$.current||{},[m(U,ie)]:!q(U,ie)};try{localStorage.setItem("commander.pinned-models",JSON.stringify($.current))}catch{}x(Ne=>Ne+1)},_e=So(s.groups,g,f).filter(U=>!Y||U.id===Y),Pe=_e.find(U=>U.id===l),st=U=>U.toLowerCase().includes(M.trim().toLowerCase()),Me=_e.filter(U=>st(U.name+" "+U.id)),He=(Pe?.models||[]).filter(({model:U,nativeModelId:ie})=>st(U.name+" "+(ie||U.id))).sort((U,ie)=>Number(q(ie.group,ie.model))-Number(q(U.group,U.model))),wt=Re&&Lo(ge.id,Re,s.current),Dt=So(s.groups,g,H).find(U=>U.models.some(({group:ie,model:xe})=>ie.id===s.current?.provider&&xe.id===s.current?.model)),Ht=g?.routes?.find(U=>U.modelId===s.current?.model&&("commander-"+U.tool===s.current?.provider||U.tool==="deepseek"&&s.current?.provider===U.providerId)),dt=Re?{group:ge,model:Re,providerName:Dt?.name||Ht?.providerName||ge?.name||ge?.id}:null,ce=dt?.model.reasoning?.efforts||[],It=V!==null&&ce.some(U=>U.id===V)?V:wt,fr=Math.max(0,ce.findIndex(U=>U.id===It)),wn=Math.max(1,ce.length-1),hr=ce.length>1?fr/wn:1,an=R!==null?R:hr,Ot=ce.length>1?Math.round(an*wn):0,Gt=ce[Ot]||ce[0],fo=R===null&&(!Gt||Gt.id==="off"||ce.length>1&&Ot===0&&/off|关|无/i.test(Gt.id+" "+Gt.name)),br=fo?0:R!==null?Math.max(.45,an):ce.length>1?Math.max(.2,an):1,ho=async U=>{let ie=ce[U];if(!ie||!dt||(de(ie.id),ie.id===wt))return;await C(dt.group,dt.model,ie.id,!0)||de(null)},bo=U=>{let ie=U.currentTarget.getBoundingClientRect(),xe=16,Ne=Math.max(1,ie.width-xe*2);return Math.max(0,Math.min(1,(U.clientX-ie.left-xe)/Ne))},yn=Re?.reasoning?.efforts?.find(U=>U.id===It)?.name,Mr=s.failures?.filter(U=>f==="deepseek"?!U.id?.startsWith("commander-"):U.id==="commander-"+f)||[],Ko=Re?.name??s.current?.model??"\u9009\u62E9\u6A21\u578B",Xo=v||O||s.error||Mr.map(U=>U.message).join("\uFF1B"),wr=U=>{if(U.key!=="ArrowDown"&&U.key!=="ArrowUp")return;let xe=[...(F?re.current.querySelector(".cmd-model-tool-menu"):re.current).querySelectorAll("button:not(:disabled),input")],Ne=xe.indexOf(document.activeElement),et=U.key==="ArrowDown"?1:-1;U.preventDefault(),xe[(Ne+et+xe.length)%xe.length]?.focus()},rn=Ye||!g||!!O;return(0,W.jsxs)(W.Fragment,{children:[(0,W.jsxs)("button",{ref:se,type:"button",className:"cmd-model-trigger",disabled:Ze||!t||Ye,title:be||void 0,"aria-label":"\u9009\u62E9\u5DE5\u5177\u4E0E\u6A21\u578B\uFF0C\u5F53\u524D "+(ae.find(U=>U.id===H)?.name??H)+" "+(Re?.name??s.current?.model??"")+(G?.bound?"\u3002\u53EF\u5728\u5F53\u524D\u5DE5\u5177\u548C\u4F9B\u5E94\u5546\u5185\u5207\u6362\u6A21\u578B":be?"\u3002"+be:""),"aria-haspopup":"dialog","aria-expanded":d,"aria-controls":d?S:void 0,onClick:()=>{d?h():(u(H),p(null),D(""),_(!1),c(!0),ne())},children:[(0,W.jsxs)("span",{className:"cmd-model-caption",title:Ko+(yn?" \xB7 "+yn:""),children:[Ko,yn?" \xB7 "+yn:""]}),(0,W.jsx)(te,{name:"chevronDown",size:14})]}),d&&Z&&(0,ci.createPortal)((0,W.jsxs)("div",{ref:re,id:S,role:"dialog","aria-label":"\u5DE5\u5177\u4E0E\u6A21\u578B",className:"cmd-model-popup",style:Z,onKeyDown:wr,children:[I&&(0,W.jsx)("div",{className:"cmd-model-loading-overlay","aria-label":"\u6B63\u5728\u52A0\u8F7D\u6A21\u578B\u76EE\u5F55","aria-live":"polite",children:(0,W.jsx)("div",{className:"cmd-model-shimmer-text","aria-hidden":"true",children:"LOADING".split("").map((U,ie)=>(0,W.jsx)("span",{style:{"--char-idx":ie},children:U},ie))})}),(0,W.jsxs)("div",{className:"cmd-model-provider-card",children:[(0,W.jsxs)("header",{className:"cmd-model-header",children:[l?(0,W.jsxs)("button",{type:"button",className:"cmd-model-back","aria-label":"\u8FD4\u56DE\u4F9B\u5E94\u5546\u5217\u8868",disabled:Ye,onClick:()=>{p(null),D("")},children:[(0,W.jsx)(te,{name:"chevronLeft",size:16}),(0,W.jsx)("span",{children:Pe?.name||"\u4F9B\u5E94\u5546"})]}):(0,W.jsx)("span",{className:"cmd-model-heading",children:"\u9009\u62E9\u4F9B\u5E94\u5546"}),(0,W.jsxs)("button",{ref:B,type:"button",className:"cmd-model-tool-trigger","aria-label":"\u9009\u62E9 Agent \u5DE5\u5177","aria-haspopup":"menu","aria-expanded":F,disabled:Ye||le,title:pe?"\u5F53\u524D\u5DE5\u5177\u4E3A "+pe+"\uFF0C\u53EA\u80FD\u5207\u6362\u8BE5\u5DE5\u5177\u7684\u6A21\u578B":void 0,onClick:()=>_(U=>!U),children:[(0,W.jsx)(Tt,{tool:f,size:18}),(0,W.jsx)("span",{children:he?.name||(I?"\u8BC6\u522B\u5DE5\u5177\u2026":f)}),(0,W.jsx)(te,{name:"chevronDown",size:13})]})]}),F&&(0,W.jsxs)("div",{className:"cmd-model-tool-menu",role:"menu","aria-label":"\u672C\u673A\u53EF\u7528 Agent \u5DE5\u5177",children:[ae.map(U=>(0,W.jsxs)("button",{type:"button",role:"menuitemradio",disabled:le||!U.routeSupported||!Yt(Pe,U.id),"aria-checked":f===U.id,className:f===U.id?"is-selected":"",onClick:()=>{Yt(Pe,U.id)&&(u(U.id),p(null),D(""),_(!1))},children:[(0,W.jsx)(Tt,{tool:U.id,size:20}),(0,W.jsxs)("span",{children:[U.name,Yt(Pe,U.id)?!U.routeSupported&&(0,W.jsx)("small",{children:U.routeReason||"\u4F9B\u5E94\u5546\u9694\u79BB\u5F85\u9002\u914D"}):(0,W.jsx)("small",{children:"\u6B64\u8BA2\u9605\u4EC5\u9650\u5BF9\u5E94\u5DE5\u5177"})]}),f===U.id&&(0,W.jsx)(te,{name:"check",size:16})]},U.id)),(0,W.jsx)("small",{children:pe?`\u5F53\u524D\u5DE5\u5177\u4E3A ${pe}\uFF0C\u53EF\u5728\u5F53\u524D\u4F9B\u5E94\u5546\u5185\u5207\u6362\u6A21\u578B`:I?"\u6B63\u5728\u8BC6\u522B\u672C\u673A\u5DE5\u5177\u2026":"\u81EA\u52A8\u8BC6\u522B\u672C\u673A\u5DF2\u5B89\u88C5\u7684\u5BF9\u8BDD\u5DE5\u5177"})]}),(0,W.jsxs)("label",{className:"cmd-model-search",children:[(0,W.jsx)(te,{name:"search",size:16}),(0,W.jsx)("input",{ref:ee,type:"search",autoComplete:"off",spellCheck:!1,"aria-label":l?"\u641C\u7D22\u6A21\u578B":"\u641C\u7D22\u4F9B\u5E94\u5546",placeholder:l?"\u641C\u7D22\u6A21\u578B":"\u641C\u7D22\u4F9B\u5E94\u5546",value:M,onChange:U=>D(U.target.value)})]}),(0,W.jsxs)("div",{className:"cmd-model-options",children:[l?He.map(({group:U,model:ie,nativeModelId:xe})=>{let Ne=s.current?.provider===U.id&&s.current?.model===ie.id,et=q(U,ie);return(0,W.jsxs)("div",{className:"cmd-model-choice"+(Ne?" is-selected":""),children:[(0,W.jsxs)("button",{type:"button",role:"menuitemradio","aria-checked":Ne,disabled:Ye||I||!g||!!O,className:Ne?"is-selected":"",onClick:()=>void C(U,ie),children:[(0,W.jsxs)("span",{children:[ie.name,xe&&xe!==ie.name&&(0,W.jsx)("small",{children:xe})]}),Ne&&(0,W.jsx)(te,{name:"check",size:16})]}),(0,W.jsx)("button",{type:"button",className:"cmd-model-pin"+(et?" is-pinned":""),"aria-label":et?"\u53D6\u6D88\u7F6E\u9876\u6A21\u578B":"\u7F6E\u9876\u6A21\u578B","aria-pressed":et,onClick:Wt=>fe(U,ie,Wt),children:et?(0,W.jsx)(Qn.IconPinFillRegular,{size:14}):(0,W.jsx)(Qn.IconPinOutlineRegular,{size:14})})]},U.id+"/"+ie.id)}):Me.map(U=>{let ie=U.models.some(({group:xe,model:Ne})=>s.current?.provider===xe.id&&s.current?.model===Ne.id);return(0,W.jsxs)("button",{type:"button",disabled:Ye||I||!g||!!O||!U.models.length&&!U.nativeRequired,className:"cmd-model-provider"+(ie?" is-selected":""),onClick:()=>{p(U.id),D("")},children:[(0,W.jsx)("span",{className:"cmd-model-provider-mark",children:(0,W.jsx)(ht,{id:U.id,name:U.name,declared:U.declared,size:22})}),(0,W.jsxs)("span",{className:"cmd-model-provider-copy",children:[(0,W.jsx)("span",{children:U.name}),(0,W.jsx)("small",{children:U.nativeRequired?"\u8BA2\u9605 \xB7 \u4F7F\u7528\u672C\u673A\u767B\u5F55":U.models.length+" \u4E2A\u6A21\u578B"})]}),(0,W.jsx)(te,{name:"chevronLeft",className:"cmd-model-next",size:15})]},U.id)}),Pe?.nativeRequired?(0,W.jsxs)("div",{className:"cmd-model-native-required",children:[(0,W.jsx)("p",{role:"status",children:Pe.routeReason||"\u6B64\u8BA2\u9605\u4EC5\u80FD\u7528\u4E8E\u5BF9\u5E94\u5DE5\u5177\uFF0C\u8BF7\u4F7F\u7528\u8BE5\u5DE5\u5177\u7684\u672C\u673A\u767B\u5F55\u3002"}),(0,W.jsxs)("button",{type:"button",disabled:Ye,onClick:()=>{try{r(),h()}catch(U){E(U.message)}},children:[(0,W.jsx)(te,{name:"settings",size:15}),"\u6253\u5F00 Harness \u5DE5\u5177"]})]}):!(l?He:Me).length&&(0,W.jsx)("p",{role:"status",children:je?"\u6B63\u5728\u52A0\u8F7D\u2026":M?"\u6CA1\u6709\u5339\u914D\u7ED3\u679C":l?"\u6682\u65E0\u53EF\u7528\u6A21\u578B":f==="deepseek"?"\u8BF7\u5148\u5728\u6A21\u578B\u8BBE\u7F6E\u4E2D\u6DFB\u52A0\u4F9B\u5E94\u5546":"\u6682\u65E0\u53EF\u7528\u4F9B\u5E94\u5546\uFF0C\u8BF7\u5728\u6A21\u578B\u8BBE\u7F6E\u4E2D\u914D\u7F6E\u6B64\u5DE5\u5177"})]},f+"/"+(l||""))]}),dt&&(0,W.jsxs)("section",{className:"cmd-model-current-card","aria-label":"\u5F53\u524D\u6A21\u578B\u4E0E\u63A8\u7406\u5F3A\u5EA6",children:[(0,W.jsxs)("div",{className:"cmd-model-current-title",children:[(0,W.jsx)("span",{children:"\u5F53\u524D\u6A21\u578B"}),(0,W.jsxs)("strong",{children:[(0,W.jsx)("em",{children:dt.providerName}),(0,W.jsx)("i",{children:"/"}),(0,W.jsx)("b",{children:dt.model.name})]})]}),ce.length>0&&(0,W.jsxs)("div",{className:"cmd-model-effort-section",children:[(0,W.jsxs)("div",{className:"cmd-model-effort-heading",children:[(0,W.jsx)("span",{children:"\u63A8\u7406\u5F3A\u5EA6"}),(0,W.jsx)("strong",{"data-off":fo?"true":"false",children:Gt?.name||ce[0].name})]}),(0,W.jsx)("div",{className:"cmd-model-effort-track"+(R!==null?" is-dragging":"")+(fo?" is-off":""),role:"slider",tabIndex:rn?-1:0,"aria-disabled":rn,"aria-label":"\u63A8\u7406\u5F3A\u5EA6\u6863\u4F4D","aria-valuemin":0,"aria-valuemax":Math.max(0,ce.length-1),"aria-valuenow":Ot,"aria-valuetext":Gt?.name||ce[0].name,style:{"--effort-ratio":an,"--effort-intensity":br},onPointerDown:U=>{rn||(U.preventDefault(),U.stopPropagation(),U.currentTarget.setPointerCapture?.(U.pointerId),T(bo(U)))},onPointerMove:U=>{R!==null&&(U.stopPropagation(),T(bo(U)))},onPointerUp:U=>{if(R===null)return;U.stopPropagation();let ie=bo(U),xe=ce.length>1?Math.round(ie*wn):0;U.currentTarget.hasPointerCapture?.(U.pointerId)&&U.currentTarget.releasePointerCapture(U.pointerId),T(null),ho(xe)},onPointerCancel:U=>{U.stopPropagation(),U.currentTarget.hasPointerCapture?.(U.pointerId)&&U.currentTarget.releasePointerCapture(U.pointerId),T(null)},onClick:U=>U.stopPropagation(),onKeyDown:U=>{if(rn)return;let ie=Ot;if(U.key==="ArrowLeft"||U.key==="ArrowDown")ie=Math.max(0,Ot-1);else if(U.key==="ArrowRight"||U.key==="ArrowUp")ie=Math.min(ce.length-1,Ot+1);else if(U.key==="Home")ie=0;else if(U.key==="End")ie=Math.max(0,ce.length-1);else return;U.preventDefault(),U.stopPropagation(),T(null),ho(ie)},children:(0,W.jsxs)("div",{className:"cmd-model-effort-rail",children:[(0,W.jsx)("div",{className:"cmd-model-effort-ticks","aria-hidden":"true",children:ce.map((U,ie)=>{let xe=ce.length>1?ie/wn:1,Ne=an+.001>=xe;return(0,W.jsx)("span",{className:"cmd-model-effort-tick"+(Ne?" is-active":""),style:{left:`calc(16px + (100% - 32px) * ${xe})`}},U.id)})}),(0,W.jsxs)("div",{className:"cmd-model-effort-fill","aria-hidden":"true",children:[(0,W.jsx)("span",{className:"cmd-model-effort-ions cmd-model-effort-ions-a"}),(0,W.jsx)("span",{className:"cmd-model-effort-ions cmd-model-effort-ions-b"}),(0,W.jsx)("span",{className:"cmd-model-effort-glow"})]}),(0,W.jsx)("div",{className:"cmd-model-effort-thumb","aria-hidden":"true"})]})}),ce.length>1&&(0,W.jsx)("div",{className:"cmd-model-effort-scale",children:ce.map((U,ie)=>(0,W.jsx)("button",{type:"button",tabIndex:-1,disabled:rn,className:"cmd-model-effort-step"+(ie===Ot?" is-current":""),onClick:xe=>{xe.stopPropagation(),T(null),ho(ie)},children:U.name},U.id))})]})]}),Xo&&(0,W.jsxs)("footer",{className:"cmd-model-footer",children:[(0,W.jsx)("span",{role:"alert",children:Xo}),(0,W.jsx)("button",{type:"button",onClick:ne,disabled:Ye||je,children:"\u91CD\u8BD5"})]})]}),document.body)]})}var St=Mo(require("react"),1),ro=require("@deepseek-ai/dsh-client-ui-primitives");var it=require("react"),Lt=require("@deepseek-ai/dsh-client-ui-primitives");var _n=["off","minimal","low","medium","high","xhigh","max"],Zn={standard:{off:null,low:"low",medium:"medium",high:"high"},full:Object.fromEntries(_n.map(e=>[e,e==="off"?null:e]))};function pi(e,t){let n={...e};return t===void 0?delete n.reasoningEfforts:n.reasoningEfforts=t,n}function To(e){if(e===void 0||e===!1)return;if(!e||typeof e!="object"||Array.isArray(e))return"\u8BF7\u9009\u62E9\u601D\u8003\u6863\u4F4D\uFF0C\u6216\u6062\u590D\u7EE7\u627F";let t=Object.entries(e);if(!t.length)return"\u81F3\u5C11\u542F\u7528\u4E00\u4E2A\u601D\u8003\u6863\u4F4D\uFF0C\u6216\u6062\u590D\u7EE7\u627F";for(let[n,i]of t){if(!_n.includes(n))return"\u4E0D\u652F\u6301\u7684\u601D\u8003\u6863\u4F4D\uFF1A"+n;if(!(i===null&&n==="off")&&(typeof i!="string"||!i.trim()))return n+" \u7684\u534F\u8BAE\u503C\u4E0D\u80FD\u4E3A\u7A7A\uFF1B\u4EC5 off \u53EF\u9009\u62E9\u4E0D\u53D1\u9001"}if(!t.some(([n])=>n!=="off"))return"\u81F3\u5C11\u542F\u7528\u4E00\u4E2A\u975E off \u6863\u4F4D\uFF1B\u4E0D\u652F\u6301\u601D\u8003\u8BF7\u9009\u201C\u975E\u63A8\u7406\u6A21\u578B\u201D"}function Hn(e){if(Array.isArray(e))for(let[t,n]of e.entries()){let i=To(n?.reasoningEfforts);if(i)return"\u6A21\u578B "+(t+1)+"\uFF1A"+i}}var mt=require("react");var _s=/^[\x21-\x7E]+$/,Zs=/^[A-Z][A-Z0-9_]*=[^=]/;function Hs(e){let t=e[0];return t!=='"'&&t!=="'"&&t!=="`"?!1:e.length>1&&e.endsWith(t)}function Gn(e){if(e.length===0)return;let t=e.trim();if(t.length===0)return"keyBlank";if(Zs.test(t)||Hs(t)||!_s.test(t))return"keyIllegalCharacters"}var gi=require("react");var mi="commander-official-models-style";if(!document.getElementById(mi)){let e=document.createElement("style");e.id=mi,e.textContent=`/* deepseek-harness/packages/client/ui-settings-models/src/client/ModelsSection.module.css */
.ModelsSection_section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
}
.ModelsSection_title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.ModelsSection_intro {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}
.ModelsSection_notice {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-warn-label);
}
.ModelsSection_savedNotice {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-success-primary);
}
.ModelsSection_rows {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ModelsSection_rowCard {
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  border-radius: var(--dsw-radius-xl);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ModelsSection_rowHead {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ModelsSection_rowIdentity {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ModelsSection_rowName {
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.ModelsSection_rowTag {
  flex: none;
  padding: 1px 6px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-xs);
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}
.ModelsSection_credentialDot {
  box-sizing: border-box;
  display: inline-block;
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  corner-shape: round;
}
.ModelsSection_credentialDotConfigured {
  background: var(--dsw-alias-state-success-primary);
}
.ModelsSection_credentialDotMissing {
  background: var(--dsw-alias-state-error-primary);
}
.ModelsSection_accountStatus {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-state-success-primary);
}
.ModelsSection_rowActions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.ModelsSection_primaryButton,
.ModelsSection_secondaryButton,
.ModelsSection_addButton {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: var(--dsw-radius-md);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
.ModelsSection_primaryButton {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.ModelsSection_primaryButton:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
}
.ModelsSection_secondaryButton,
.ModelsSection_addButton {
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: transparent;
  color: var(--dsw-alias-label-primary);
}
.ModelsSection_secondaryButton:hover:not(:disabled),
.ModelsSection_addButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.ModelsSection_secondaryButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-solid);
}
.ModelsSection_dangerButton {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
.ModelsSection_dangerButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}
.ModelsSection_rowActions .ModelsSection_secondaryButton,
.ModelsSection_rowActions .ModelsSection_dangerButton {
  height: 28px;
  padding: 0 10px;
  border-radius: var(--dsw-radius-sm);
  font-size: 12px;
  line-height: 18px;
}
.ModelsSection_primaryButton:disabled,
.ModelsSection_secondaryButton:disabled,
.ModelsSection_dangerButton:disabled,
.ModelsSection_addButton:disabled,
.ModelsSection_linkButton:disabled,
.ModelsSection_addModelButton:disabled {
  opacity: 0.4;
  cursor: default;
}
.ModelsSection_primaryButton:focus-visible,
.ModelsSection_secondaryButton:focus-visible,
.ModelsSection_dangerButton:focus-visible,
.ModelsSection_addButton:focus-visible,
.ModelsSection_linkButton:focus-visible,
.ModelsSection_addModelButton:focus-visible,
.ModelsSection_iconButton:focus-visible,
.ModelsSection_customizedSummary:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.ModelsSection_editor {
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-module-platform);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.ModelsSection_editorHeader {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.ModelsSection_editorTitle {
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.ModelsSection_editorRoute {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.ModelsSection_field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ModelsSection_fieldLabel {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.ModelsSection_helpButton {
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 50%;
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 11px;
  line-height: 15px;
  text-align: center;
  cursor: help;
}
.ModelsSection_helpButton:hover,
.ModelsSection_helpButton:focus-visible {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-tertiary);
}
.ModelsSection_linkButton {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.ModelsSection_linkButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.ModelsSection_advancedHint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.ModelsSection_editorActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.ModelsSection_addBlock {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ModelsSection_addActions {
  display: flex;
}
.ModelsSection_addButton {
  flex: 1 1 0;
  min-width: 180px;
  gap: 6px;
  height: 44px;
  border: 1px dashed var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-lg);
}
.ModelsSection_addModes {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.ModelsSection_addPanel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.ModelsSection_addPanel[hidden] {
  display: none;
}
.ModelsSection_addCard,
.ModelsSection_setupCard {
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-module-platform);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  list-style: none;
}
.ModelsSection_addCard .ModelsSection_editor,
.ModelsSection_setupCard .ModelsSection_editor {
  background: none;
  padding: 0;
}
.ModelsSection_customized {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  padding-top: 10px;
}
.ModelsSection_customizedSummary {
  display: flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  padding: 2px 4px;
  margin-left: -4px;
  border-radius: var(--dsw-radius-sm);
  cursor: pointer;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  list-style: none;
}
.ModelsSection_customizedSummary::-webkit-details-marker {
  display: none;
}
.ModelsSection_customizedSummary::before {
  content: "";
  width: 5px;
  height: 5px;
  border-right: 1.5px solid currentcolor;
  border-bottom: 1.5px solid currentcolor;
  transform: rotate(-45deg) translate(-1px, -1px);
  transition: transform 120ms ease;
}
.ModelsSection_customized[open] > .ModelsSection_customizedSummary::before {
  transform: rotate(45deg) translate(-1px, -1px);
}
.ModelsSection_customizedSummary:hover {
  color: var(--dsw-alias-label-primary);
}
.ModelsSection_customizedBody {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 12px;
}
.ModelsSection_modelCatalog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.ModelsSection_modelCatalogHeading {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ModelsSection_modelCatalogTitle {
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.ModelsSection_modelCatalogMeta,
.ModelsSection_modelEmpty {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.ModelsSection_modelList {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ModelsSection_modelListHead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.ModelsSection_modelEntry {
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-lg);
  padding: 6px;
}
.ModelsSection_modelRow {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 6px;
}
.ModelsSection_iconButton {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.ModelsSection_iconButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.ModelsSection_iconButton:disabled {
  cursor: default;
  opacity: 0.4;
}
.ModelsSection_iconButtonDanger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}
.ModelsSection_modelAdvanced {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 8px 4px 2px;
}
.ModelsSection_modelField {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 4px;
}
.ModelsSection_modelInputTypes {
  grid-column: 1 / -1;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
}
.ModelsSection_modelInputTypes legend {
  padding: 0;
  margin-bottom: 4px;
}
.ModelsSection_modelInputChoices {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  min-height: 32px;
  align-items: center;
}
.ModelsSection_modelFieldLabel {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.ModelsSection_modelEmpty {
  padding: 12px;
  border: 1px dashed var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-lg);
  text-align: center;
}
.ModelsSection_addModelButton {
  box-sizing: border-box;
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.ModelsSection_addModelButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.ModelsSection_input {
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
}
select.ModelsSection_input {
  max-width: 240px;
  cursor: pointer;
}
.ModelsSection_input:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.ModelsSection_input::placeholder {
  color: var(--dsw-alias-label-dimmed);
}
.ModelsSection_input:disabled {
  opacity: 0.6;
  cursor: default;
}
.ModelsSection_keyInput {
  position: relative;
}
.ModelsSection_keyInputFilled {
  padding-right: 40px;
}
.ModelsSection_keyToggle {
  position: absolute;
  inset: 1px 1px 1px auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: none;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.ModelsSection_keyToggle:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
}
.ModelsSection_keyToggle:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.ModelsSection_keyToggle:disabled {
  opacity: 0.6;
  cursor: default;
}
.ModelsSection_selectInput {
  appearance: none;
  padding-right: 32px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  background-size: 12px 12px;
}
.ModelsSection_error {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}
.ModelsSection_deleteDialog {
  width: min(480px, 100%);
}
.ModelsSection_deleteConfirm:not(:disabled) {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
.ModelsSection_deleteConfirm:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}
.ModelsSection_hiddenLabel {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .ModelsSection_customizedSummary::before,
  .ModelsSection_switchThumb {
    transition: none;
  }
}
.ModelsSection_fetchDialog {
  max-width: 520px;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.ModelsSection_candidateToolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.ModelsSection_candidateSearch {
  min-width: 0;
  flex: 1 1 240px;
}
.ModelsSection_candidateList {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  margin: 0;
  overflow-y: auto;
  padding: 0;
  list-style: none;
}
.ModelsSection_candidate {
  border-radius: var(--dsw-radius-md);
}
.ModelsSection_candidateLabel {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  cursor: pointer;
}
.ModelsSection_candidateId {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--ds-font-family-code);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ModelsSection_candidateEmpty {
  margin: 24px 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  text-align: center;
}
`,document.head.append(e)}var A={section:"ModelsSection_section",title:"ModelsSection_title",intro:"ModelsSection_intro",notice:"ModelsSection_notice",savedNotice:"ModelsSection_savedNotice",rows:"ModelsSection_rows",rowCard:"ModelsSection_rowCard",rowHead:"ModelsSection_rowHead",rowIdentity:"ModelsSection_rowIdentity",rowName:"ModelsSection_rowName",rowTag:"ModelsSection_rowTag",credentialDot:"ModelsSection_credentialDot",credentialDotConfigured:"ModelsSection_credentialDotConfigured",credentialDotMissing:"ModelsSection_credentialDotMissing",accountStatus:"ModelsSection_accountStatus",rowActions:"ModelsSection_rowActions",primaryButton:"ModelsSection_primaryButton",secondaryButton:"ModelsSection_secondaryButton",addButton:"ModelsSection_addButton",dangerButton:"ModelsSection_dangerButton",linkButton:"ModelsSection_linkButton",addModelButton:"ModelsSection_addModelButton",iconButton:"ModelsSection_iconButton",customizedSummary:"ModelsSection_customizedSummary",editor:"ModelsSection_editor",editorHeader:"ModelsSection_editorHeader",editorTitle:"ModelsSection_editorTitle",editorRoute:"ModelsSection_editorRoute",field:"ModelsSection_field",fieldLabel:"ModelsSection_fieldLabel",helpButton:"ModelsSection_helpButton",advancedHint:"ModelsSection_advancedHint",editorActions:"ModelsSection_editorActions",addBlock:"ModelsSection_addBlock",addActions:"ModelsSection_addActions",addModes:"ModelsSection_addModes",addPanel:"ModelsSection_addPanel",addCard:"ModelsSection_addCard",setupCard:"ModelsSection_setupCard",customized:"ModelsSection_customized",customizedBody:"ModelsSection_customizedBody",modelCatalog:"ModelsSection_modelCatalog",modelCatalogHeading:"ModelsSection_modelCatalogHeading",modelCatalogTitle:"ModelsSection_modelCatalogTitle",modelCatalogMeta:"ModelsSection_modelCatalogMeta",modelEmpty:"ModelsSection_modelEmpty",modelList:"ModelsSection_modelList",modelListHead:"ModelsSection_modelListHead",modelEntry:"ModelsSection_modelEntry",modelRow:"ModelsSection_modelRow",iconButtonDanger:"ModelsSection_iconButtonDanger",modelAdvanced:"ModelsSection_modelAdvanced",modelField:"ModelsSection_modelField",modelInputTypes:"ModelsSection_modelInputTypes",modelInputChoices:"ModelsSection_modelInputChoices",modelFieldLabel:"ModelsSection_modelFieldLabel",input:"ModelsSection_input",keyInput:"ModelsSection_keyInput",keyInputFilled:"ModelsSection_keyInputFilled",keyToggle:"ModelsSection_keyToggle",selectInput:"ModelsSection_selectInput",error:"ModelsSection_error",deleteDialog:"ModelsSection_deleteDialog",deleteConfirm:"ModelsSection_deleteConfirm",hiddenLabel:"ModelsSection_hiddenLabel",switchThumb:"ModelsSection_switchThumb",fetchDialog:"ModelsSection_fetchDialog",candidateToolbar:"ModelsSection_candidateToolbar",candidateSearch:"ModelsSection_candidateSearch",candidateList:"ModelsSection_candidateList",candidate:"ModelsSection_candidate",candidateLabel:"ModelsSection_candidateLabel",candidateId:"ModelsSection_candidateId",candidateEmpty:"ModelsSection_candidateEmpty"};var Pt=require("react/jsx-runtime"),fi="M1.5 8C2.9 5.25 5.25 3.5 8 3.5C10.75 3.5 13.1 5.25 14.5 8C13.1 10.75 10.75 12.5 8 12.5C5.25 12.5 2.9 10.75 1.5 8Z",Gs=`${fi}M10 8C10 9.1 9.1 10 8 10C6.9 10 6 9.1 6 8C6 6.9 6.9 6 8 6C9.1 6 10 6.9 10 8Z`,Ws=`${fi}M2.5 2.5L13.5 13.5`;function Wn({value:e,t,...n}){let[i,o]=(0,gi.useState)(),a=e.length>0&&i===e;return(0,Pt.jsxs)("div",{className:A.keyInput,children:[(0,Pt.jsx)("input",{...n,className:`${A.input} ${e.length>0?A.keyInputFilled:""}`,type:a?"text":"password",autoComplete:"new-password",value:e,onChange:r=>{o(void 0),n.onChange?.(r)}}),e.length===0?null:(0,Pt.jsx)("button",{type:"button",className:A.keyToggle,"aria-label":t(a?"keyHide":"keyReveal"),"aria-pressed":a,disabled:n.disabled,onClick:()=>{o(a?void 0:e)},children:(0,Pt.jsx)("svg",{width:"16",height:"16",viewBox:"0 0 16 16",fill:"none",stroke:"currentColor",strokeWidth:1.3,strokeLinecap:"round","aria-hidden":"true",children:(0,Pt.jsx)("path",{d:a?Ws:Gs})})})]})}var mn=require("react/jsx-runtime");function Vn(e){let{t}=e;return(0,mn.jsxs)("div",{className:A.editorActions,children:[(0,mn.jsx)("button",{type:"button",className:A.secondaryButton,disabled:e.busy,onClick:e.onCancel,children:t(e.cancelLabelKey??"cancel")}),(0,mn.jsx)("button",{type:"button",className:A.primaryButton,disabled:e.submitDisabled,onClick:e.onSubmit,children:e.busy?t(e.submitBusyLabelKey):t(e.submitLabelKey)})]})}var zo=require("react"),Mi=require("@deepseek-ai/dsh-client-ui-primitives");var en=require("@deepseek-ai/dsh-client-ui-primitives");var hi=require("@deepseek-ai/dsh-client-ui-primitives");var $t=require("react/jsx-runtime");function bi({model:e,field:t,position:n,disabled:i,fallback:o,t:a,onChange:r}){let s=e[t],d=Array.isArray(s)&&s.length>0?s:o??["text"];return(0,$t.jsxs)("fieldset",{className:A.modelInputTypes,"aria-label":`${a("modelInputTypes")} ${String(n)}`,children:[(0,$t.jsx)("legend",{className:A.modelFieldLabel,children:a("modelInputTypes")}),(0,$t.jsx)("div",{className:A.modelInputChoices,children:["text","image"].map(c=>(0,$t.jsx)(hi.Checkbox,{label:a(c==="text"?"modelInputText":"modelInputImage"),checked:d.includes(c),disabled:i||d.length===1&&d.includes(c),onChange:f=>{let u=["text","image"].filter(p=>p===c?f:d.includes(p)),l={...e,[t]:u};t==="inputModalities"&&!u.includes("image")&&(Reflect.deleteProperty(l,"imagePixelBudget"),Reflect.deleteProperty(l,"imageMaxBytes")),r(l)}},c))})]})}var ut=require("react/jsx-runtime");function Jn(e){let{model:t,position:n,t:i,disabled:o}=e;return(0,ut.jsxs)("div",{className:A.modelEntry,children:[(0,ut.jsxs)("div",{className:A.modelRow,children:[["id","name"].map(a=>(0,ut.jsx)("input",{className:A.input,type:"text",value:typeof t[a]=="string"?t[a]:"",placeholder:i(a==="id"?"modelId":"modelName"),"aria-label":`${i(a==="id"?"modelId":"modelName")} ${String(n)}`,disabled:o,onChange:r=>{let s=r.target.value;e.onFieldChange(a,a==="name"&&s===""?void 0:s)},onBlur:a==="id"?r=>e.onIdBlur?.(r.target.value):void 0},a)),(0,ut.jsx)("button",{type:"button",className:A.iconButton,"aria-label":`${i("modelAdvanced")} ${String(n)}`,"aria-expanded":e.expanded,title:i("modelAdvanced"),onClick:e.onToggle,children:e.expanded?(0,ut.jsx)(en.IconChevronDownOutlineRegular,{}):(0,ut.jsx)(en.IconChevronRightOutlineRegular,{})}),(0,ut.jsx)("button",{type:"button",className:`${A.iconButton} ${A.iconButtonDanger}`,"aria-label":`${i("removeModel")} ${String(n)}`,title:i("removeModel"),disabled:o,onClick:e.onRemove,children:(0,ut.jsx)(en.IconTrashOutlineRegular,{size:14})})]}),e.expanded?(0,ut.jsxs)("div",{className:A.modelAdvanced,children:[["contextWindow","maxTokens"].map(a=>(0,ut.jsxs)("label",{className:A.modelField,children:[(0,ut.jsx)("span",{className:A.modelFieldLabel,children:i(a)}),(0,ut.jsx)("input",{className:A.input,type:"text",inputMode:"numeric",value:e[a].value,placeholder:e[a].placeholder,"aria-label":`${i(a)} ${String(n)}`,disabled:o,onChange:r=>{e[a].onChange(r.target.value)},onBlur:e[a].onBlur})]},a)),(0,ut.jsx)(bi,{model:t,field:e.inputField,position:n,fallback:e.inputFallback,disabled:o||e.inputLoading===!0,t:i,onChange:e.onChange}),e.extraSettings]}):null]})}var bt=require("react/jsx-runtime");function Vs(e){return Number(e.slice(0,e.indexOf(":")))}var Js=/^(\d+(?:\.\d+)?)([km])?$/i,gn={k:1e3,m:1e6};function Kn(e){let t=e.trim();if(t.length===0)return;let n=Js.exec(t);if(n===null)return Number.NaN;let i=n[2]?.toLowerCase(),o=i==="k"||i==="m"?gn[i]:1,a=Number(n[1])*o,r=Math.round(a);return Math.abs(a-r)<1e-6?r:a}function Xn(e){return!Number.isInteger(e)||e<=0?String(e):e%gn.m===0?`${String(e/gn.m)}M`:e%gn.k===0?`${String(e/gn.k)}K`:String(e)}function Fo(e){return Array.isArray(e)?e.map(t=>typeof t=="object"&&t!==null&&!Array.isArray(t)?t:{}):[]}function fn(e){if(e===void 0)return;let t=Fo(e),n=new Set;for(let[i,o]of t.entries()){let a=o.id,r=typeof a=="string"?a.trim():void 0;if(r===void 0||r.length===0)return{index:i,key:"modelIdRequired"};if(n.has(r))return{index:i,key:"modelIdDuplicate"};n.add(r);let s=o.name;if(s!==void 0&&(typeof s!="string"||s.length===0))return{index:i,key:"modelNameInvalid"};let d=o.contextWindow;if(d!==void 0&&(typeof d!="number"||!Number.isInteger(d)||d<=0))return{index:i,key:"modelContextInvalid"};let c=o.maxTokens;if(c!==void 0&&(typeof c!="number"||!Number.isInteger(c)||c<=0))return{index:i,key:"modelMaxTokensInvalid"}}}function wi(e){let[t,n]=(0,zo.useState)(()=>new Map),[i,o]=(0,zo.useState)(()=>new Set),a=(l,p,M)=>{let D=e.models.map((g,y)=>{let I={...g};return y!==l||(M===void 0?Reflect.deleteProperty(I,p):I[p]=M),I});e.onChange(D)},r=l=>{n(p=>{let M=new Map;for(let[D,g]of p){let y=Vs(D);y!==l&&M.set(y>l?D.replace(/^\d+/,String(y-1)):D,g)}return M}),o(p=>{let M=new Set;for(let D of p)D!==l&&M.add(D>l?D-1:D);return M}),e.onChange(e.models.filter((p,M)=>M!==l).map(p=>({...p})))},s=()=>{n(new Map),o(new Set),e.onReset()},d=l=>{o(p=>{let M=new Set(p);return M.delete(l)||M.add(l),M})},c=(l,p,M)=>{let D=t.get(`${String(p)}:${M}`);if(D!==void 0)return D;let g=l[M];return typeof g=="number"?Xn(g):""},f=(l,p)=>{let M=`${String(l)}:${p}`,D=t.get(M);if(D===void 0)return;let g=Kn(D);g!==void 0&&Number.isNaN(g)||n(y=>{let I=new Map(y);return I.delete(M),I})},u=(l,p,M,D)=>({value:c(l,p,M),placeholder:D===void 0?e.t(M==="contextWindow"?"contextWindowPlaceholder":"maxTokensPlaceholder"):Xn(D),onChange:g=>{n(y=>new Map(y).set(`${String(p)}:${M}`,g)),a(p,M,Kn(g))},onBlur:()=>{f(p,M)}});return(0,bt.jsxs)("section",{className:A.modelCatalog,"aria-label":e.t("models"),children:[(0,bt.jsxs)("div",{className:A.modelListHead,children:[(0,bt.jsxs)("div",{className:A.modelCatalogHeading,children:[(0,bt.jsx)("span",{className:A.modelCatalogTitle,children:e.t("models")}),(0,bt.jsx)("span",{className:A.modelCatalogMeta,children:e.overridden?e.t("modelsCustomized"):e.t("modelsInherited")})]}),e.overridden?(0,bt.jsx)("button",{type:"button",className:A.linkButton,disabled:e.disabled,onClick:s,children:e.t("resetModels")}):null]}),e.models.length===0?(0,bt.jsx)("p",{className:A.modelEmpty,children:e.t("modelsEmpty")}):(0,bt.jsx)("div",{className:A.modelList,children:e.models.map((l,p)=>(0,bt.jsx)(Jn,{model:l,position:p+1,inputField:"inputModalities",expanded:i.has(p),disabled:e.disabled,t:e.t,contextWindow:u(l,p,"contextWindow",e.defaultContextWindow),maxTokens:u(l,p,"maxTokens",e.defaultMaxTokens),onFieldChange:(M,D)=>{a(p,M,D)},onIdBlur:M=>{let D=M.trim();D!==M&&a(p,"id",D)},onChange:M=>{e.onChange(e.models.map((D,g)=>g===p?M:D))},onToggle:()=>{d(p)},onRemove:()=>{r(p)}},p))}),(0,bt.jsxs)("button",{type:"button",className:A.addModelButton,disabled:e.disabled,onClick:()=>{e.onChange([...e.models.map(l=>({...l})),{id:""}])},children:[(0,bt.jsx)(Mi.IconPlusOutlineRegular,{size:14}),e.t("addModel")]})]})}var qn=Mo(require("react"),1);var $e=require("react"),xi=require("react-dom");var yi=`.dowork-select,.dowork-select-popup{--picker-paper:var(--dc-paper,var(--link-paper,var(--dsw-alias-bg-base,#fff)));--picker-ink:var(--dc-ink,var(--link-ink,var(--dsw-alias-label-primary,#222)));--picker-muted:var(--dc-muted,var(--link-muted,var(--dsw-alias-label-tertiary,#777)));--picker-border:var(--dc-line,var(--link-faint,var(--dsw-alias-border-l1,#8883)));--picker-hover:var(--dc-panel,var(--link-hover,var(--dsw-alias-interactive-bg-hover,#8881)));--picker-accent:var(--dc-accent,var(--link-accent,var(--dsw-alias-state-business-primary,#4d6bfe)));box-sizing:border-box;font:inherit;font-size:13px;color:var(--picker-ink)}
.dowork-select{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-width:0;min-height:38px;padding:9px 11px;border:1px solid var(--picker-border);border-radius:9px;background:var(--picker-paper);text-align:left;cursor:pointer;transition:border-color 140ms,background 140ms}
.dowork-select:hover:not(:disabled),.dowork-select[aria-expanded=true]{border-color:color-mix(in srgb,var(--picker-accent) 55%,var(--picker-border))}
.dowork-select:focus-visible{outline:2px solid color-mix(in srgb,var(--picker-accent) 65%,transparent);outline-offset:2px}
.dowork-select:disabled{cursor:default;opacity:.45}
.dowork-select-value{display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400}
.dowork-select-value[data-placeholder]{color:var(--picker-muted)}
.dowork-select-chevron{flex:none;width:6px;height:6px;margin:0 2px 3px 0;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);opacity:.55;transition:transform 140ms}
.dowork-select[aria-expanded=true] .dowork-select-chevron{transform:translateY(3px) rotate(225deg)}
.dowork-select-popup{z-index:10000;display:flex;flex-direction:column;padding:5px;border:1px solid var(--picker-border);border-radius:11px;background:var(--picker-paper);box-shadow:0 12px 32px #0002,0 2px 8px #0000000d;outline:none;overscroll-behavior:contain}
.dowork-select-options{min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
.dowork-select-option{display:flex;align-items:center;gap:8px;min-height:36px;padding:8px 9px;box-sizing:border-box;border-radius:6px;cursor:pointer;line-height:1.4;user-select:none}
.dowork-select-option>span:not(.dowork-select-check){flex:1;min-width:0;overflow-wrap:anywhere}
.dowork-select-option[data-active]{background:var(--picker-hover)}
.dowork-select-option[aria-selected=true]{color:var(--picker-accent);background:color-mix(in srgb,var(--picker-accent) 9%,var(--picker-paper))}
.dowork-select-option[aria-disabled=true]{opacity:.4;cursor:default}
.dowork-select-check{flex:none;width:8px;height:4px;margin-right:2px;border-left:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg)}
.dowork-select-popup input.dowork-select-search{flex:none;width:100%;box-sizing:border-box;min-height:35px;margin:0 0 4px;padding:7px 9px;border:0;border-bottom:1px solid var(--picker-border);border-radius:0;background:transparent;color:var(--picker-ink);outline:none;box-shadow:none;font:inherit;font-size:12px}
.dowork-select-empty{margin:0;padding:12px 9px;color:var(--picker-muted);font-size:12px}
@media(pointer:coarse){.dowork-select,.dowork-select-option{min-height:44px}}
@media(prefers-reduced-motion:reduce){.dowork-select,.dowork-select-chevron{transition:none}}
`;var at=require("react/jsx-runtime");function Ui({value:e,options:t=[],onChange:n,disabled:i=!1,placeholder:o="\u8BF7\u9009\u62E9",searchable:a=!1,className:r="",id:s,name:d,...c}){let f=(0,$e.useId)(),u=(0,$e.useRef)(null),l=(0,$e.useRef)(null),p=(0,$e.useRef)(null),M=(0,$e.useRef)({text:"",time:0}),[D,g]=(0,$e.useState)(!1),[y,I]=(0,$e.useState)(""),[L,b]=(0,$e.useState)(-1),[x,F]=(0,$e.useState)(null),_=t.find(j=>j.value===e),Z=t.filter(j=>!y||String(j.searchText??j.label??j.value).toLocaleLowerCase().includes(y.toLocaleLowerCase())),Q=Z.map((j,J)=>j.disabled?-1:J).filter(j=>j>=0),v=(j=!1)=>{g(!1),I(""),j&&u.current?.focus({preventScroll:!0})},E=j=>{!j||j.disabled||(n?.(j.value),v(!0))},O=(j=!1)=>{if(i)return;I("");let J=t.findIndex(R=>R.value===e&&!R.disabled),oe=t.map((R,T)=>R.disabled?-1:T).filter(R=>R>=0);b(J>=0?J:j?oe.at(-1)??-1:oe[0]??-1),g(!0)};(0,$e.useEffect)(()=>{if(document.getElementById("dowork-custom-select-style"))return;let j=document.createElement("style");j.id="dowork-custom-select-style",j.textContent=yi,document.head.append(j)},[]),(0,$e.useEffect)(()=>{i&&v()},[i]),(0,$e.useLayoutEffect)(()=>{if(!D)return;let j=()=>{let oe=u.current;if(!oe)return;let R=oe.getBoundingClientRect(),T=window.visualViewport,V=T?.offsetLeft||0,de=T?.offsetTop||0,$=T?.width||window.innerWidth,se=T?.height||window.innerHeight,re=de+se-R.bottom-14,ee=R.top-de-14,X=re<220&&ee>re,B=Math.min(Math.max(R.width,180),$-24),S=getComputedStyle(oe),H={};for(let ae=0;ae<S.length;ae++){let he=S[ae];(he.startsWith("--link-")||he.startsWith("--dsw-")||he.startsWith("--dc-"))&&(H[he]=S.getPropertyValue(he))}F({...H,position:"fixed",width:B,maxHeight:Math.max(80,Math.min(360,X?ee:re)),left:Math.max(V+12,Math.min(R.left,V+$-B-12)),...X?{bottom:window.innerHeight-R.top+6}:{top:R.bottom+6},fontFamily:S.fontFamily})};j();let J=oe=>{!u.current?.contains(oe.target)&&!l.current?.contains(oe.target)&&v()};return document.addEventListener("pointerdown",J,!0),document.addEventListener("focusin",J),window.addEventListener("resize",j),window.addEventListener("scroll",j,!0),window.visualViewport?.addEventListener("resize",j),window.visualViewport?.addEventListener("scroll",j),()=>{document.removeEventListener("pointerdown",J,!0),document.removeEventListener("focusin",J),window.removeEventListener("resize",j),window.removeEventListener("scroll",j,!0),window.visualViewport?.removeEventListener("resize",j),window.visualViewport?.removeEventListener("scroll",j)}},[D]),(0,$e.useEffect)(()=>{D&&x&&(a?p.current:l.current)?.focus({preventScroll:!0})},[D,!!x,a]),(0,$e.useEffect)(()=>{D&&document.getElementById(f+"-"+L)?.scrollIntoView({block:"nearest"})},[L,D,f]);let P=j=>{if(j.key==="Escape"){j.preventDefault(),j.stopPropagation(),v(!0);return}if(j.key==="Tab"){v(!0);return}if(j.key==="Enter"||j.key===" "&&j.target!==p.current){j.preventDefault(),E(Z[L]);return}if(["ArrowDown","ArrowUp","Home","End"].includes(j.key)){j.preventDefault(),j.stopPropagation();let J=Q.indexOf(L);b(j.key==="Home"?Q[0]??-1:j.key==="End"?Q.at(-1)??-1:Q[(J+(j.key==="ArrowDown"?1:-1)+Q.length)%Q.length]??-1);return}if(!a&&j.key.length===1&&!j.ctrlKey&&!j.metaKey&&!j.altKey){j.preventDefault();let J=Date.now(),oe=M.current,R=J-oe.time<700?oe.text+j.key:j.key;M.current={text:R,time:J};let T=Z.findIndex(V=>!V.disabled&&String(V.label??V.value).toLocaleLowerCase().startsWith(R.toLocaleLowerCase()));T>=0&&b(T)}},G=u.current?.closest("[role=dialog], dialog, .link-dialog, .dc-dialog")||(typeof document<"u"?document.body:null);return(0,at.jsxs)(at.Fragment,{children:[(0,at.jsxs)("button",{...c,type:"button",id:s,ref:u,className:"dowork-select "+r,disabled:i,"aria-haspopup":"listbox","aria-expanded":D&&!i,"aria-controls":D?f:void 0,onClick:()=>D?v():O(),onKeyDown:j=>{["ArrowDown","ArrowUp","Home","End"].includes(j.key)&&(j.preventDefault(),O(j.key==="ArrowUp"||j.key==="End"))},children:[(0,at.jsxs)("span",{className:"dowork-select-value","data-placeholder":!_||void 0,children:[_?.icon,_?.label??o]}),(0,at.jsx)("span",{className:"dowork-select-chevron","aria-hidden":"true"})]}),d&&(0,at.jsx)("input",{type:"hidden",name:d,value:e??"",disabled:i}),D&&!i&&G&&(0,xi.createPortal)((0,at.jsxs)("div",{ref:l,className:"dowork-select-popup",style:x??{visibility:"hidden",position:"fixed"},onKeyDown:P,tabIndex:a?void 0:-1,role:a?void 0:"listbox",id:a?void 0:f,"aria-label":a?void 0:c["aria-label"]||"\u9009\u9879","aria-labelledby":a?void 0:c["aria-labelledby"],"aria-activedescendant":!a&&L>=0?f+"-"+L:void 0,children:[a&&(0,at.jsx)("input",{ref:p,className:"dowork-select-search",role:"combobox","aria-label":"\u641C\u7D22"+(c["aria-label"]||"\u9009\u9879"),"aria-autocomplete":"list","aria-expanded":"true","aria-controls":f,"aria-activedescendant":L>=0?f+"-"+L:void 0,placeholder:"\u641C\u7D22\u2026",value:y,onChange:j=>{let J=j.target.value;I(J),b(t.filter(oe=>!J||String(oe.searchText??oe.label??oe.value).toLocaleLowerCase().includes(J.toLocaleLowerCase())).findIndex(oe=>!oe.disabled))}}),(0,at.jsxs)("div",{className:"dowork-select-options",role:a?"listbox":"presentation",id:a?f:void 0,"aria-label":a?c["aria-label"]||"\u9009\u9879":void 0,children:[Z.map((j,J)=>(0,at.jsxs)("div",{id:f+"-"+J,role:"option","aria-selected":j.value===e,"aria-disabled":j.disabled||void 0,"data-active":J===L||void 0,className:"dowork-select-option",onPointerMove:()=>{j.disabled||b(J)},onPointerDown:oe=>oe.preventDefault(),onClick:()=>E(j),children:[j.icon,(0,at.jsx)("span",{children:j.label}),j.value===e&&(0,at.jsx)("span",{className:"dowork-select-check","aria-hidden":"true"})]},j.value)),!Z.length&&(0,at.jsx)("p",{className:"dowork-select-empty",children:"\u6CA1\u6709\u53EF\u9009\u9879"})]})]}),G)]})}var vi=require("react/jsx-runtime");function $n({children:e,onChange:t,...n}){let i=[],o=a=>qn.default.Children.forEach(a,r=>{qn.default.isValidElement(r)&&(r.type==="option"?i.push({value:r.props.value,label:r.props.children,disabled:r.props.disabled}):(r.type===qn.default.Fragment||r.type==="optgroup")&&o(r.props.children))});return o(e),(0,vi.jsx)(Ui,{...n,options:i,onChange:a=>t?.({target:{value:a}})})}var Mu=require("react");var ze=require("react/jsx-runtime");function Di({model:e,position:t,disabled:n,onChange:i,styles:o}){let a=e.reasoningEfforts,r=a===void 0?"inherit":a===!1?"disabled":"custom",s=a&&typeof a=="object"&&!Array.isArray(a)?a:{},d=To(a),c=l=>i(pi(e,l)),f=(l,p)=>c({...s,[l]:p}),u="\u6A21\u578B "+t+" \u601D\u8003\u6863\u4F4D";return(0,ze.jsxs)("fieldset",{disabled:n,className:o.modelInputTypes,children:[(0,ze.jsx)("legend",{className:o.modelFieldLabel,children:"\u601D\u8003\u6863\u4F4D"}),(0,ze.jsxs)("div",{style:{display:"grid",gap:8,minWidth:0},children:[(0,ze.jsxs)($n,{className:o.input,"aria-label":u,value:r,onChange:l=>c(l.target.value==="inherit"?void 0:l.target.value==="disabled"?!1:{...Zn.standard}),children:[(0,ze.jsx)("option",{value:"inherit",children:"\u7EE7\u627F\u6A21\u578B\u9ED8\u8BA4\u80FD\u529B"}),(0,ze.jsx)("option",{value:"disabled",children:"\u975E\u63A8\u7406\u6A21\u578B"}),(0,ze.jsx)("option",{value:"custom",children:"\u81EA\u5B9A\u4E49\u6863\u4F4D\u4E0E\u534F\u8BAE\u503C"})]}),(0,ze.jsx)("p",{className:o.advancedHint,children:"\u6BCF\u4E2A\u6A21\u578B\u5355\u72EC\u914D\u7F6E\uFF1B\u4EC5\u542F\u7528\u63A5\u53E3\u652F\u6301\u7684\u6863\u4F4D\u3002\u7EE7\u627F\u4F1A\u79FB\u9664\u672C\u6A21\u578B\u7684\u8986\u76D6\u914D\u7F6E\u3002"}),r==="custom"&&(0,ze.jsxs)(ze.Fragment,{children:[(0,ze.jsxs)("div",{style:{display:"flex",flexWrap:"wrap",alignItems:"center",gap:4},children:[(0,ze.jsx)("span",{className:o.modelFieldLabel,children:"\u586B\u5165\u6A21\u677F"}),(0,ze.jsx)("button",{type:"button",className:o.linkButton,onClick:()=>c({...Zn.standard}),children:"\u6807\u51C6\u4E09\u6863"}),(0,ze.jsx)("button",{type:"button",className:o.linkButton,onClick:()=>c({...Zn.full}),children:"\u5B8C\u6574\u4E03\u6863"})]}),(0,ze.jsx)("div",{style:{display:"grid",gap:6},children:_n.map(l=>{let p=Object.hasOwn(s,l),M=l==="off"&&s.off===null;return(0,ze.jsxs)("div",{style:{display:"flex",flexWrap:"wrap",alignItems:"center",gap:8},children:[(0,ze.jsxs)("label",{className:o.modelFieldLabel,style:{display:"flex",alignItems:"center",gap:6,minWidth:86},children:[(0,ze.jsx)("input",{type:"checkbox",checked:p,"aria-label":u+" \u542F\u7528 "+l,onChange:D=>{if(D.target.checked)f(l,l==="off"?null:l);else{let g={...s};delete g[l],c(g)}}}),l]}),p&&(0,ze.jsxs)(ze.Fragment,{children:[l==="off"&&(0,ze.jsxs)("label",{className:o.modelFieldLabel,style:{display:"flex",alignItems:"center",gap:6},children:[(0,ze.jsx)("input",{type:"checkbox",checked:M,"aria-label":u+" off \u4E0D\u53D1\u9001\u534F\u8BAE\u503C",onChange:D=>f("off",D.target.checked?null:"off")}),"\u4E0D\u53D1\u9001\u534F\u8BAE\u503C"]}),!M&&(0,ze.jsx)("input",{className:o.input,style:{flex:"1 1 140px",minWidth:100},value:typeof s[l]=="string"?s[l]:"","aria-label":u+" "+l+" \u534F\u8BAE\u503C","aria-invalid":typeof s[l]!="string"||!s[l].trim(),placeholder:"\u63A5\u53E3\u5B9E\u9645\u63A5\u6536\u7684\u503C",onChange:D=>f(l,D.target.value)})]})]},l)})}),(0,ze.jsx)("p",{className:o.advancedHint,children:"\u6309\u63A5\u53E3\u6587\u6863\u586B\u5199\u5B9E\u9645\u534F\u8BAE\u503C\uFF1B\u6A21\u677F\u4E0D\u4EE3\u8868\u6A21\u578B\u652F\u6301\u8FD9\u4E9B\u6863\u4F4D\u3002\u591A\u4E2A\u6863\u4F4D\u53EF\u6620\u5C04\u5230\u540C\u4E00\u503C\uFF1Boff \u9009\u201C\u4E0D\u53D1\u9001\u534F\u8BAE\u503C\u201D\u8868\u793A\u4E0D\u53D1\u9001\u8BE5\u6863\u4F4D\u7684\u534F\u8BAE\u503C\uFF0C\u5177\u4F53\u5F00\u5173\u7531\u9002\u914D\u5668\u5904\u7406\u3002"})]}),d&&(0,ze.jsx)("p",{role:"alert",className:o.error,children:d})]})]})}var pt=require("react"),zt=require("@deepseek-ai/dsh-client-ui-primitives");var Le=require("react/jsx-runtime");function Bo(e,t){let n=e[t];return typeof n=="string"?n:""}function Xs(e,t){let n=e[t];return typeof n=="number"?n:void 0}var Ni={contextWindow:"256K",maxTokens:"32K"};function qs(e){return e===void 0?"":Xn(e)}function $s(e){return{id:e.id,...e.name===void 0?{}:{name:e.name},...e.contextWindow===void 0?{}:{contextWindow:e.contextWindow},...e.maxTokens===void 0?{}:{maxTokens:e.maxTokens},...e.inputModalities===void 0?{}:{input:[...e.inputModalities]}}}function eo(e){let{models:t,onChange:n,probe:i,operations:o,t:a,disabled:r,onBusyChange:s}=e,{catalogProvider:d}=e,[c,f]=(0,pt.useState)(!1);(0,pt.useEffect)(()=>{s(c)},[c,s]);let[u,l]=(0,pt.useState)(void 0),[p,M]=(0,pt.useState)(void 0);(0,pt.useEffect)(()=>{if(d===void 0)return;let B=!0;return o.discoverModels(i.settingsNs,{provider:d}).then(S=>{B&&(M({provider:d,models:S.kind==="found"?S.models:[]}),l(S.kind==="refused"?S.message:void 0))}),()=>{B=!1}},[d,o,i.settingsNs]);let D=p?.provider===d?p?.models:void 0,g=(0,pt.useMemo)(()=>new Map(D?.map(B=>[B.id,B.inputModalities])),[D]),[y,I]=(0,pt.useState)(void 0),[L,b]=(0,pt.useState)(new Set),[x,F]=(0,pt.useState)(""),[_,Z]=(0,pt.useState)(new Set),[Q,v]=(0,pt.useState)(new Map),E=(B,S)=>`${String(B)}:${S}`,O=(B,S,H)=>{v(ae=>new Map(ae).set(E(B,S),H)),J(B,{[S]:Kn(H)})},P=(B,S,H)=>Q.get(E(S,H))??qs(Xs(B,H)),G=(B,S)=>{let H=new Map;for(let[ae,he]of B){let ge=Number(ae.slice(0,ae.indexOf(":")));ge!==S&&H.set(ge>S?ae.replace(/^\d+/,String(ge-1)):ae,he)}return H},j=B=>{Z(S=>{let H=new Set(S);return H.delete(B)||H.add(B),H})},J=(B,S)=>{n(t.map((H,ae)=>{if(ae!==B)return H;let he=new Set(Object.entries(S).filter(([,ge])=>ge===void 0||ge==="").map(([ge])=>ge));return Object.fromEntries(Object.entries({...H,...S}).filter(([ge])=>!he.has(ge)))}))},oe=async()=>{f(!0),l(void 0);try{let B=await o.discoverModels(i.settingsNs,{...i.provider===void 0?{}:{provider:i.provider},...i.baseURL===void 0||i.baseURL.length===0?{}:{baseURL:i.baseURL},...i.api===void 0?{}:{api:i.api},...i.apiKey===void 0?{}:{apiKey:i.apiKey}});if(B.kind==="refused"){l(B.message);return}let S=B.models;if(d!==void 0&&M({provider:d,models:S}),S.length===0){l(a("fetchEmpty"));return}let H=new Set(t.map(ae=>Bo(ae,"id")));F(""),I(S),b(new Set(S.filter(ae=>!H.has(ae.id)).map(ae=>ae.id)))}finally{f(!1)}},R=()=>{I(void 0),b(new Set),F("")},T=()=>{if(y===void 0)return;let B=new Map(t.map(S=>[Bo(S,"id"),S]));for(let S of y)L.has(S.id)&&B.set(S.id,B.get(S.id)??$s(S));n([...B.values()]),R()},V=B=>{b(S=>{let H=new Set(S);return H.delete(B)||H.add(B),H})},de=y??[],$=x.trim().toLowerCase(),se=$.length===0?de:de.filter(B=>B.id.toLowerCase().includes($)||B.name?.toLowerCase().includes($)===!0),re=se.length>0&&se.every(B=>L.has(B.id)),ee=()=>{b(B=>{if(se.every(H=>B.has(H.id)))return new Set;let S=new Set(B);for(let H of se)S.add(H.id);return S})},X=i.provider!==void 0||i.baseURL!==void 0&&i.baseURL.length>0;return(0,Le.jsxs)("section",{className:A.modelCatalog,"aria-label":a("models"),children:[(0,Le.jsxs)("div",{className:A.modelListHead,children:[(0,Le.jsxs)("div",{className:A.modelCatalogHeading,children:[(0,Le.jsx)("span",{className:A.modelCatalogTitle,children:a("models")}),e.overridden===void 0?null:(0,Le.jsx)("span",{className:A.modelCatalogMeta,children:e.overridden?a("modelsCustomized"):a("modelsInherited")})]}),e.overridden===!0&&e.onReset!==void 0?(0,Le.jsx)("button",{type:"button",className:A.linkButton,disabled:r,onClick:e.onReset,children:a("resetModels")}):null,(0,Le.jsx)("button",{type:"button",className:A.linkButton,disabled:r||c||!X||e.probeBlocked!==void 0,title:e.probeBlocked!==void 0?a(e.probeBlocked):X?void 0:a("fetchNeedsBaseUrl"),onClick:()=>{oe()},children:a(c?"fetching":"fetchModels")})]}),t.length===0?(0,Le.jsx)("p",{className:A.modelEmpty,children:a("modelsEmpty")}):null,(0,Le.jsx)("div",{className:A.modelList,children:t.map((B,S)=>(0,Le.jsx)(Jn,{model:B,position:S+1,inputField:"input",inputFallback:g.get(Bo(B,"id"))??e.defaultInput,inputLoading:d!==void 0&&D===void 0,expanded:_.has(S),disabled:r,t:a,contextWindow:{value:P(B,S,"contextWindow"),placeholder:Ni.contextWindow,onChange:H=>{O(S,"contextWindow",H)}},maxTokens:{value:P(B,S,"maxTokens"),placeholder:Ni.maxTokens,onChange:H=>{O(S,"maxTokens",H)}},extraSettings:(0,Le.jsx)(Di,{model:B,position:S+1,disabled:r,styles:A,onChange:H=>{n(t.map((ae,he)=>he===S?H:ae))}}),onFieldChange:(H,ae)=>{J(S,{[H]:ae})},onChange:H=>{n(t.map((ae,he)=>he===S?H:ae))},onToggle:()=>{j(S)},onRemove:()=>{n(t.filter((H,ae)=>ae!==S)),Z(H=>{let ae=new Set;for(let he of H)he<S?ae.add(he):he>S&&ae.add(he-1);return ae}),v(H=>G(H,S))}},S))}),(0,Le.jsxs)("button",{type:"button",className:A.addModelButton,disabled:r,onClick:()=>{n([...t,{id:""}])},children:[(0,Le.jsx)(zt.IconPlusOutlineRegular,{size:14}),a("addModel")]}),u!==void 0?(0,Le.jsx)("p",{className:A.error,children:u}):null,(0,Le.jsxs)(zt.Modal,{open:y!==void 0,onClose:R,title:a("fetchTitle"),closeLabel:a("close"),description:a("fetchDescription"),className:A.fetchDialog,footer:(0,Le.jsxs)(Le.Fragment,{children:[(0,Le.jsx)(zt.Button,{variant:"outline",onClick:R,children:a("cancel")}),(0,Le.jsx)(zt.Button,{variant:"outline",onClick:T,children:a("fetchAdopt")})]}),children:[(0,Le.jsxs)("div",{className:A.candidateToolbar,children:[(0,Le.jsx)("input",{className:`${A.input} ${A.candidateSearch}`,type:"search",value:x,placeholder:a("fetchSearch"),"aria-label":a("fetchSearch"),onChange:B=>{F(B.target.value)}}),(0,Le.jsx)(zt.Button,{variant:"ghost",size:"sm",disabled:se.length===0,onClick:ee,children:a(re?"fetchDeselectAll":"fetchSelectAll")})]}),se.length===0?(0,Le.jsx)("p",{className:A.candidateEmpty,role:"status",children:a("fetchNoMatches")}):(0,Le.jsx)("ul",{className:A.candidateList,children:se.map(B=>(0,Le.jsx)("li",{className:A.candidate,children:(0,Le.jsxs)("label",{className:A.candidateLabel,children:[(0,Le.jsx)("input",{type:"checkbox",checked:L.has(B.id),onChange:()=>{V(B.id)}}),(0,Le.jsx)("span",{className:A.candidateId,title:B.name??B.id,children:B.id})]})},B.id))})]})]})}var ed=require("@deepseek-ai/dsh-client-store"),td="\0probe";function tn(e){return`${e.toUpperCase().replace(/[^A-Z0-9]+/g,"_")}_API_KEY`}function to(e,t){if(e===void 0)return[];let i=t.nodeAtPath(t.rehydrate(e.schema),["providers",td,"api"]);return i?.type!=="union"||i.list===void 0?[]:i.list.map(o=>o.value).filter(o=>typeof o=="string")}function Ai(e){return e.entry.active?e.entry.provider==="deepseek-account"?e.accountAvailable===!0:e.apiKeyEnv===void 0?!0:e.credential?.configured===!0:!1}var nd={"openai-completions":"protocolOpenAiCompletions","openai-responses":"protocolOpenAiResponses","anthropic-messages":"protocolAnthropicMessages"};function no(e,t){let n=nd[t];return n===void 0?t:e(n)}var Fe=require("react/jsx-runtime"),ji="llm-pi-ai",od=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;function ad(e){try{let t=new URL(e).protocol;return t==="http:"||t==="https:"}catch{return!1}}function Ci(e){let{taken:t,protocols:n,operations:i,t:o,onBusyChange:a}=e,[r]=(0,mt.useState)(()=>e.revision),[s,d]=(0,mt.useState)(e.preset?.id??""),[c,f]=(0,mt.useState)(e.preset?.name??""),[u,l]=(0,mt.useState)(e.preset?.baseURL??""),[p,M]=(0,mt.useState)(e.preset?.protocol&&n.includes(e.preset.protocol)?e.preset.protocol:n[0]??""),D=oo(s),[g,y]=(0,mt.useState)(""),[I,L]=(0,mt.useState)([]),[b,x]=(0,mt.useState)(!1),[F,_]=(0,mt.useState)(!1);(0,mt.useEffect)(()=>{a?.(b||F)},[b,F,a]);let[Z,Q]=(0,mt.useState)(void 0),[v,E]=(0,mt.useState)(!1),O=e.readOnly||b,P=O||v,G=s.length>0&&!od.test(s),j=t.includes(s),J=u.trim(),oe=u.length>0&&!ad(J),R=Hn(I),T=fn(I),V=Gn(g),de=g.trim(),$=s.length>0&&!G&&!j&&J.length>0&&!oe&&I.length>0&&T===void 0&&V===void 0&&R===void 0,se=Z!==void 0||$||V!==void 0||s.length===0||G||j||oe?void 0:J.length===0?o("customNeedsBaseUrl"):T!==void 0?`${o("model")} ${String(T.index+1)}: ${o(T.key)}`:R??o("customNeedsModels"),re=async()=>{if(!v&&R!==void 0)return R;let X=tn(s),B=de.length>0;if(!v){let S={...c.length===0?{}:{displayName:c},...B?{apiKeyEnv:X}:{},api:p,baseURL:J,models:I.map(ae=>({...ae}))},H=await i.writeSettings(ji,[{op:"set",path:["providers",s],value:S}],r);if(H.kind!=="written")return H.kind==="conflict"?o("conflict"):H.message;E(!0)}if(B){let S=await i.storeCredential(X,de);if(S!==void 0)return S}},ee=async()=>{x(!0),Q(void 0);try{let X=await re();if(X!==void 0){Q(X);return}await D.save(),e.onClose(!0)}catch(X){Q(X instanceof Error?X.message:String(X))}finally{x(!1)}};return(0,Fe.jsxs)("div",{className:A.editor,"data-commander-provider-editor":"true",children:[(0,Fe.jsx)(ao,{value:D,disabled:O}),(0,Fe.jsxs)("div",{className:A.field,children:[(0,Fe.jsx)("span",{className:A.fieldLabel,children:o("customRoute")}),(0,Fe.jsx)("input",{className:A.input,type:"text",value:s,placeholder:"acme-gateway","aria-label":o("customRoute"),disabled:P,onChange:X=>{d(X.target.value)}})]}),G||j?(0,Fe.jsx)("p",{className:A.error,children:o(G?"customRouteInvalid":"customRouteTaken")}):(0,Fe.jsx)("p",{className:A.advancedHint,children:o("customRouteHint")}),(0,Fe.jsxs)("div",{className:A.field,children:[(0,Fe.jsx)("span",{className:A.fieldLabel,children:o("customDisplayName")}),(0,Fe.jsx)("input",{className:A.input,type:"text",value:c,placeholder:s.length===0?o("customDisplayName"):s,"aria-label":o("customDisplayName"),disabled:P,onChange:X=>{f(X.target.value)}})]}),(0,Fe.jsxs)("div",{className:A.field,children:[(0,Fe.jsx)("span",{className:A.fieldLabel,children:o("baseUrl")}),(0,Fe.jsx)("input",{className:A.input,type:"text",value:u,placeholder:o(p==="anthropic-messages"?"customAnthropicBaseUrlPlaceholder":"customBaseUrlPlaceholder"),"aria-label":o("baseUrl"),"aria-invalid":oe,disabled:P,onChange:X=>{l(X.target.value)}})]}),oe?(0,Fe.jsx)("p",{className:A.error,children:o("customBaseUrlInvalid")}):null,(0,Fe.jsxs)("div",{className:A.field,children:[(0,Fe.jsx)("span",{className:A.fieldLabel,children:o("customApi")}),(0,Fe.jsx)("select",{className:`${A.input} ${A.selectInput}`,value:p,"aria-label":o("customApi"),disabled:P,onChange:X=>{M(X.target.value)},children:n.map(X=>(0,Fe.jsx)("option",{value:X,children:no(o,X)},X))})]}),(0,Fe.jsxs)("div",{className:A.field,children:[(0,Fe.jsx)("span",{className:A.fieldLabel,children:o("keyInput")}),(0,Fe.jsx)(Wn,{t:o,value:g,placeholder:o("keyPlaceholder"),"aria-label":o("keyInput"),disabled:O,onChange:X=>{y(X.target.value)}}),V===void 0?null:(0,Fe.jsx)("p",{className:A.error,children:o(V==="keyBlank"?"keyBlankNew":V)})]}),(0,Fe.jsx)(eo,{models:I,onChange:L,probe:{settingsNs:ji,baseURL:J,api:p,...de.length===0?{}:{apiKey:de}},probeBlocked:oe?"customBaseUrlInvalid":V==="keyBlank"?"keyBlankNew":V,operations:i,t:o,disabled:P,onBusyChange:_}),Z!==void 0?(0,Fe.jsx)("p",{className:A.error,children:Z}):null,se===void 0?null:(0,Fe.jsx)("p",{className:A.advancedHint,children:se}),(0,Fe.jsx)(Vn,{t:o,busy:b,submitDisabled:O||!$,submitLabelKey:"create",submitBusyLabelKey:"creating",onCancel:()=>{e.onClose(v)},onSubmit:()=>{ee()}})]})}var gt=require("react"),Ii=require("@deepseek-ai/dsh-client-ui-primitives");var ye=require("react/jsx-runtime");function id(e,t,n){let i=e.getPath(t.user,n);return typeof i!="object"||i===null||Array.isArray(i)?{}:structuredClone(i)}function rd(e,t,n){let i=typeof t=="object"&&t!==null&&!Array.isArray(t)?t:{},o=[];for(let[a,r]of Object.entries(n))JSON.stringify(i[a])!==JSON.stringify(r)&&o.push({op:"set",path:[...e,a],value:r});for(let a of Object.keys(i))a in n||o.push({op:"unset",path:[...e,a]});return o}function sd(e){return e==="llm-deepseek"?"deepseek":e==="llm-pi-ai"?"pi-ai":"unknown"}function dd(e,t,n,i){let o=e.getPath(t.value,n),a=typeof o=="object"&&o!==null?o.apiKeyEnv:void 0;return typeof a=="string"&&a.length>0?a:tn(i)}function Oo(e){let{namespace:t,schema:n,settingsPath:i,operations:o,t:a}=e,r=oo(e.provider),[s,d]=(0,gt.useState)(()=>id(n,t,i)),[c,f]=(0,gt.useState)(""),[u,l]=(0,gt.useState)(!1),[p,M]=(0,gt.useState)(!1),{onBusyChange:D}=e;(0,gt.useEffect)(()=>{D?.(u||p)},[u,p,D]);let[g,y]=(0,gt.useState)(void 0),[I,L]=(0,gt.useState)(()=>n.getPath(t.user,i)),[b,x]=(0,gt.useState)(()=>t.revision),F=(0,gt.useMemo)(()=>n.rehydrate(t.schema),[t.schema,n]),_=(0,gt.useMemo)(()=>n.nodeAtPath(F,i),[F,n,i]),Z=n.getPath(t.value,i),Q=e.readOnly||u,v=sd(t.ns),E=dd(n,t,i,e.provider),O=(0,gt.useMemo)(()=>v==="pi-ai"?to(t,n):[],[v,t,n]),P=(S,H)=>{let ae=n.getPath(S,[H]);return typeof ae=="string"&&ae.trim().length>0?ae:void 0},G=(S,H)=>{let ae=H===void 0||H.trim().length===0?void 0:H;d(he=>ae===void 0?n.deletePath(he,[S]):n.setPath(he,[S],ae))},j=v==="pi-ai"&&e.credentialOnly!==!0?Hn(n.getPath(s,["models"])):void 0,J=fn(n.getPath(s,["models"])),oe=Gn(c),R=c.trim(),V=(e.credentialRequired===!0&&c.length>0&&R.length===0?"keyRequired":void 0)??oe,de=P(s,"api")??P(Z,"api"),$=P(s,"baseURL")??P(Z,"baseURL"),se={settingsNs:t.ns,provider:e.provider,...$===void 0?{}:{baseURL:$},...de===void 0?{}:{api:de},...R.length===0?{}:{apiKey:R}},re=async()=>{let S=t.ns,H=v==="pi-ai"&&P(s,"apiKeyEnv")===void 0&&P(Z,"apiKeyEnv")===void 0&&R.length>0?n.setPath(s,["apiKeyEnv"],E):s;if(e.credentialOnly!==!0){if(j!==void 0)return j;let ge=fn(n.getPath(H,["models"]));if(ge!==void 0)return`${a("model")} ${String(ge.index+1)}: ${a(ge.key)}`}if(e.credentialOnly!==!0&&_!==void 0&&i.length===0){let ge=n.validate(_,H);if(ge!==void 0)return ge}let ae=v==="pi-ai"&&Z===void 0&&I===void 0&&Object.keys(H).length===0,he=e.credentialOnly===!0?[]:ae?[{op:"set",path:[...i],value:{}}]:rd(i,I,H);if(he.length>0){let ge=await o.writeSettings(S,he,b);if(ge.kind!=="written")return ge.kind==="conflict"?a("conflict"):ge.message;L(n.getPath(ge.view.user,i)),x(ge.view.revision),d(H)}if(R.length>0){let ge=await o.storeCredential(E,R);if(ge!==void 0)return ge}f("")},ee=async()=>{l(!0),y(void 0);try{let S=await re();if(S!==void 0){y(S);return}e.credentialOnly!==!0&&await r.save(),e.onClose(!0)}catch(S){y(S instanceof Error?S.message:String(S))}finally{l(!1)}};if(_===void 0)return(0,ye.jsxs)("p",{className:A.error,children:[e.provider,": ",e.t("settingsPathUnresolvable")]});let X=()=>n.getPath(t.base,[...i,"models"])??n.nodeAtPath(F,[...i,"models"])?.meta.default,B=S=>{let H=S==="pi-ai"&&e.declared===!0,ae=n.getPath(s,["models"]),he=n.hasPath(s,["models"]),ge=Fo(he?ae:X()),Re=n.getPath(Z,["defaultContextWindow"]),Ye=n.getPath(Z,["maxTokens"]),je=n.getPath(Z,["defaultInput"]),Ze=P(Z,"baseURL")??e.defaultBaseURL,pe=e.baseURLEnv??[],Y=S==="deepseek"?a("deepSeekEndpointHint"):Ze===void 0&&pe.length>0?a("baseUrlEnvironment").replace("{env}",()=>pe.join(", ")):void 0,le=P(Z,"apiKeyEnv"),be=le===void 0?e.nativeAuth:void 0,h=le===void 0?(be?.env??[]).filter(ce=>!pe.includes(ce)):[le],ne=h.filter(ce=>!ce.toLowerCase().includes("oauth")),C=ne[0],m=h.map(ce=>[ce,e.credentialChecks?.[ce]??(ce===le?e.credential:void 0)]),q=m.find(([,ce])=>ce?.configured===!0),fe=q?.[0],_e=fe===void 0||!ne.includes(fe)?void 0:fe,Pe=m.length>0&&m.every(([,ce])=>ce?.configured===!1),st=q?.[1]?.source==="file",Me=c.length>0||st||C===void 0||e.credentialRequired===!0?void 0:a(fe===void 0?Pe?"keyFallbackMissing":"keyFallbackUnchecked":_e===void 0?"keyFallbackDetectedHidden":"keyFallbackDetected").replace("{hint}",()=>_e??C),He=ne.length===0?void 0:a("keyHelp").replace("{env}",()=>ne.join(" / ")),wt=He===void 0?null:(0,ye.jsx)(Ii.Tooltip,{label:He,side:"right",delayMs:0,focusDelayMs:0,portal:!0,openOnClick:!0,children:(0,ye.jsx)("button",{type:"button",className:A.helpButton,"aria-label":a("authHelp"),children:"?"})}),Dt=be?.env.length===0&&be.oauth,Ht=C===void 0||e.credentialRequired===!0?a("keyPlaceholder"):a(st?"keyPlaceholderSaved":"keyPlaceholderFallback").replace("{hint}",()=>C),dt={models:ge,overridden:he,t:a,disabled:Q,onChange:ce=>{d(It=>n.setPath(It,["models"],ce))},onReset:()=>{d(ce=>n.deletePath(ce,["models"]))}};return(0,ye.jsxs)(ye.Fragment,{children:[Dt?null:(0,ye.jsxs)("div",{className:A.field,children:[(0,ye.jsxs)("span",{className:A.fieldLabel,children:[a("keyInput"),wt]}),(0,ye.jsx)(Wn,{t:a,value:c,placeholder:Ht,"aria-label":a("keyInput"),"aria-invalid":V!==void 0,"aria-describedby":Me===void 0?void 0:`${e.provider}-credential-hint`,required:e.credentialRequired===!0,autoFocus:e.autoFocusCredential===!0,disabled:Q,onChange:ce=>{f(ce.target.value)}}),Me===void 0?null:(0,ye.jsx)("p",{id:`${e.provider}-credential-hint`,className:A[Pe?"notice":fe===void 0?"advancedHint":"savedNotice"],children:Me}),V===void 0?null:(0,ye.jsx)("p",{className:A.error,children:a(V)})]}),e.credentialOnly===!0?null:(0,ye.jsxs)("details",{className:A.customized,children:[(0,ye.jsx)("summary",{className:A.customizedSummary,children:a("customized")}),(0,ye.jsxs)("div",{className:A.customizedBody,children:[H?(0,ye.jsxs)("div",{className:A.field,children:[(0,ye.jsx)("span",{className:A.fieldLabel,children:a("customDisplayName")}),(0,ye.jsx)("input",{className:A.input,type:"text",value:P(s,"displayName")??"",placeholder:P(n.getPath(t.base,i),"displayName")??e.provider,"aria-label":a("customDisplayName"),disabled:Q,onChange:ce=>{G("displayName",ce.target.value)}})]}):null,(0,ye.jsxs)("div",{className:A.field,children:[(0,ye.jsx)("span",{className:A.fieldLabel,children:a("baseUrl")}),(0,ye.jsx)("input",{className:A.input,type:"text",value:P(s,"baseURL")??"",placeholder:S==="deepseek"?a("deepSeekBaseUrl"):Ze===void 0?a(pe.length>0?"baseUrlConfigured":"baseUrlDefault"):a("baseUrlPlaceholder").replace("{url}",()=>Ze),"aria-describedby":Y===void 0?void 0:`${e.provider}-endpoint-hint`,"aria-label":a("baseUrl"),disabled:Q,onChange:ce=>{G("baseURL",ce.target.value===""?void 0:ce.target.value)}}),Y===void 0?null:(0,ye.jsx)("span",{id:`${e.provider}-endpoint-hint`,className:A.advancedHint,children:Y})]}),H?(0,ye.jsxs)("div",{className:A.field,children:[(0,ye.jsx)("span",{className:A.fieldLabel,children:a("customApi")}),(0,ye.jsxs)("select",{className:`${A.input} ${A.selectInput}`,value:de??"","aria-label":a("customApi"),disabled:Q,onChange:ce=>{G("api",ce.target.value)},children:[de===void 0?(0,ye.jsx)("option",{value:"",children:a("customApiUnset")}):null,O.map(ce=>(0,ye.jsx)("option",{value:ce,children:no(a,ce)},ce))]})]}):null,S==="deepseek"?(0,ye.jsx)(wi,{...dt,defaultContextWindow:typeof Re=="number"?Re:void 0,defaultMaxTokens:typeof Ye=="number"?Ye:void 0}):(0,ye.jsx)(eo,{...dt,catalogProvider:e.declared===!0?void 0:e.provider,defaultInput:Array.isArray(je)?je:void 0,probe:se,probeBlocked:oe,operations:o,onBusyChange:M})]})]})]})};return(0,ye.jsxs)("div",{className:e.credentialOnly===!0?A.addBlock:A.editor,"data-commander-provider-editor":e.credentialOnly===!0?void 0:"true",children:[e.credentialOnly===!0?null:(0,ye.jsx)(ao,{value:r,disabled:Q}),e.hideTitle===!0?null:(0,ye.jsxs)("div",{className:A.editorHeader,children:[(0,ye.jsx)(ht,{id:e.provider,name:e.displayName,declared:e.declared===!0}),(0,ye.jsx)("span",{className:A.editorTitle,children:e.displayName}),e.provider!==e.displayName?(0,ye.jsx)("span",{className:A.editorRoute,children:e.provider}):null]}),v==="unknown"?(0,ye.jsx)("p",{className:A.advancedHint,children:`${a("advancedHint")} (${t.ns})`}):B(v),g!==void 0?(0,ye.jsx)("p",{className:A.error,children:g}):null,e.credentialOnly!==!0&&j!==void 0?(0,ye.jsx)("p",{role:"alert",className:A.error,children:j}):null,e.credentialOnly===!0||J===void 0?null:(0,ye.jsx)("p",{className:A.advancedHint,children:`${a("model")} ${String(J.index+1)}: ${a(J.key)}`}),(0,ye.jsx)(Vn,{t:a,busy:u,submitDisabled:Q||v==="unknown"||e.credentialOnly!==!0&&(J!==void 0||j!==void 0)||V!==void 0||e.credentialRequired===!0&&R.length===0,submitLabelKey:e.submitLabelKey??"apply",submitBusyLabelKey:e.submitBusyLabelKey??"applying",...e.cancelLabelKey===void 0?{}:{cancelLabelKey:e.cancelLabelKey},onCancel:()=>{e.onClose(!1)},onSubmit:()=>{e.onSubmitCredential?.(),ee()}})]})}var ue=require("react/jsx-runtime");function Ei({target:e,row:t,...n}){return(0,ue.jsx)(Oo,{provider:e.provider,displayName:e.displayName,settingsPath:e.settingsPath,...e.declared===!0?{declared:!0}:{},...e.defaultBaseURL===void 0?{}:{defaultBaseURL:e.defaultBaseURL},...e.baseURLEnv===void 0?{}:{baseURLEnv:e.baseURLEnv},...e.nativeAuth===void 0?{}:{nativeAuth:e.nativeAuth},...t.credential===void 0?{}:{credential:t.credential},...t.credentialChecks===void 0?{}:{credentialChecks:t.credentialChecks},...n})}async function ld(e,t,n){if(n.credentialRef!==void 0){let o=await e.removeCredential(n.credentialRef);if(o!==void 0)return o}let i=await e.writeSettings(n.settingsNs,[{op:"unset",path:[...n.settingsPath]}],void 0);if(i.kind!=="written")return i.message;await t.load()}function cd(e,t){return t||e.entry.provider==="deepseek-account"||e.entry.settingsPath.length>0?!1:e.credential?.configured!==!0}function Ro(e){return e.apiKeyEnv!==void 0?e.credential?.configured===!0:e.derivedCredential?.configured===!0}function io(e){let t=tn(e.entry.provider),n=e.apiKeyEnv===t&&e.credential?.configured===!0&&e.credential.writable?t:void 0;return{provider:e.entry.provider,displayName:e.entry.displayName,settingsNs:e.entry.settingsNs,settingsPath:e.entry.settingsPath,...n===void 0?{}:{credentialRef:n},...e.entry.declared===!0?{declared:!0}:{},...e.entry.defaultBaseURL===void 0?{}:{defaultBaseURL:e.entry.defaultBaseURL},...e.entry.baseURLEnv===void 0?{}:{baseURLEnv:e.entry.baseURLEnv},...e.entry.nativeAuth===void 0?{}:{nativeAuth:e.entry.nativeAuth}}}function ud(e){return e.provider===e.displayName?e.provider:`${e.displayName} (${e.provider})`}function nn(e,t){return e.replace("{provider}",()=>ud(t))}function Yo(e){let{controller:t,useSnapshot:n,operations:i,schema:o,t:a,renderSlot:r}=e;return t===void 0||n===void 0||i===void 0||o===void 0||a===void 0?null:(0,ue.jsx)(pd,{injected:{controller:t,useSnapshot:n,operations:i,schema:o,t:a},renderSlot:r})}function pd({injected:e,renderSlot:t}){let{controller:n,operations:i,schema:o,t:a}=e,r=e.useSnapshot(C=>C),s={...r,rows:r.rows.map(C=>C.entry.provider==="deepseek-account"?{...C,entry:{...C.entry,displayName:a("deepSeekAccount")}}:C)},[d,c]=(0,it.useState)(s.status==="ready");s.status==="ready"&&!d&&c(!0),s.status==="error"&&d&&c(!1);let[f,u]=(0,it.useState)(void 0),[l,p]=(0,it.useState)(!1),[M,D]=(0,it.useState)("catalog"),[g,y]=(0,it.useState)(void 0),[I,L]=(0,it.useState)(()=>new Set),[b,x]=(0,it.useState)(!1),[F,_]=(0,it.useState)(!1),Z=(0,it.useId)(),[Q,v]=(0,it.useState)(void 0),[E,O]=(0,it.useState)(!1),[P,G]=(0,it.useState)(void 0),[j,J]=(0,it.useState)(void 0),[oe,R]=(0,it.useState)(()=>new Set),T=C=>{n.load().then(()=>{J(C)})},V=()=>{u(void 0),p(!1),x(!1),_(!1)},de=(C,m)=>{V(),C&&T(m)},$=(C,m)=>{R(q=>new Set([...q,m.provider])),C&&T(m)},se=()=>{E||(v(void 0),G(void 0))},re=()=>{Q===void 0||E||(O(!0),G(void 0),ld(i,n,Q).then(C=>{if(C!==void 0){G(C);return}v(void 0)}).finally(()=>{O(!1)}))};if(s.status==="idle"&&n.load(),s.status==="error"){let C=s.error??"";return(0,ue.jsxs)("div",{className:A.section,children:[(0,ue.jsx)("p",{className:A.error,children:`${a("loadFailed")}: ${C}`}),(0,ue.jsx)("button",{type:"button",className:A.secondaryButton,onClick:()=>{n.load()},children:a("retry")})]})}if(!d&&s.status!=="ready")return(0,ue.jsxs)("div",{className:A.section,children:[(0,ue.jsx)("h2",{className:A.title,children:a("title")}),(0,ue.jsx)("p",{className:A.intro,children:a("intro")})]});let ee=j===void 0?void 0:s.rows.find(C=>C.entry.provider===j.provider),X=ee===void 0?j:{provider:ee.entry.provider,displayName:ee.entry.displayName},B=s.rows.some(Ai),S=s.rows.filter(C=>C.configured),H=s.rows.filter(C=>s.namespaces.has(C.entry.settingsNs)),ae=s.rows.flatMap(C=>{let m=s.namespaces.get(C.entry.settingsNs);return m===void 0||C.configured?[]:[{row:C,namespace:m}]}),he=s.namespaces.get("llm-pi-ai"),ge=to(he,o),Re=H.length>0,Ye=ae.length>0,je=he!==void 0,Ze=ge.length>0,pe=Re&&je,Y=pe?M:je?"custom":"catalog",le=C=>Y===C||I.has(C),be=b||F,h=(()=>{if(!l||!Re)return;let C=f===void 0?void 0:s.namespaces.get(f.settingsNs);if(f!==void 0&&C!==void 0)return{target:f,namespace:C};let m=ae[0];return m===void 0?void 0:{target:io(m.row),namespace:m.namespace}})(),ne=h===void 0?void 0:s.rows.find(C=>C.entry.provider===h.target.provider);return(0,ue.jsxs)("div",{className:A.section,children:[(0,ue.jsx)("h2",{className:A.title,children:a("title")}),(0,ue.jsx)("p",{className:A.intro,children:a("intro")}),!s.writable&&s.status==="ready"?(0,ue.jsx)("p",{className:A.notice,children:a("readOnly")}):null,X===void 0?null:(0,ue.jsx)("p",{className:A.savedNotice,role:"status","aria-live":"polite",children:nn(a("savedProvider"),X)}),(0,ue.jsx)("ul",{className:A.rows,children:S.map(C=>{let m=io(C),q=s.namespaces.get(m.settingsNs);if(q===void 0)return null;let fe=C.entry.error===void 0?null:(0,ue.jsx)("p",{role:"alert",className:A.error,children:C.entry.error});if(cd(C,B)&&!oe.has(C.entry.provider))return(0,ue.jsxs)("li",{className:A.setupCard,children:[fe,Ei({target:m,row:C,namespace:q,schema:o,operations:i,t:a,readOnly:!s.writable,onClose:Me=>{$(Me,m)}}),t("settings.models.provider-card",{provider:C.entry,configured:C.configured,keyConfigured:Ro(C)},{entryKey:C.entry.settingsNs})]},C.entry.provider);let _e=!l&&f?.provider===C.entry.provider,Pe=C.credential?.configured===!0,st=!Pe&&C.apiKeyEnv!==void 0&&C.credential?.configured===!1;return(0,ue.jsxs)("li",{className:A.rowCard,children:[(0,ue.jsxs)("div",{className:A.rowHead,children:[(0,ue.jsxs)("span",{className:A.rowIdentity,children:[(0,ue.jsx)(ht,{id:C.entry.provider,name:C.entry.displayName,declared:C.entry.declared===!0}),(0,ue.jsx)("span",{className:A.rowName,children:C.entry.displayName}),C.entry.declared===!0?(0,ue.jsx)("span",{className:A.rowTag,children:a("customTag")}):null,C.entry.provider==="deepseek-account"?(0,ue.jsxs)("span",{className:A.accountStatus,children:[(0,ue.jsx)("span",{className:`${A.credentialDot} ${A.credentialDotConfigured}`,"aria-hidden":"true"}),a("accountSignedIn")]}):null,Pe?(0,ue.jsx)("span",{className:`${A.credentialDot} ${A.credentialDotConfigured}`,role:"img","aria-label":a("credentialConfigured"),title:a("credentialConfigured")}):st?(0,ue.jsx)("span",{className:`${A.credentialDot} ${A.credentialDotMissing}`,role:"img","aria-label":a("credentialMissing"),title:a("credentialMissing")}):null]}),(0,ue.jsxs)("span",{className:A.rowActions,children:[C.entry.provider==="deepseek-account"?null:(0,ue.jsx)("button",{type:"button",className:A.secondaryButton,"aria-label":nn(a("editProvider"),m),disabled:!_e&&s.status!=="ready",onClick:()=>{!_e&&n.store.getSnapshot().status!=="ready"||(J(void 0),p(!1),u(_e?void 0:m))},children:a("edit")}),C.removable?(0,ue.jsx)("button",{type:"button",className:A.dangerButton,"aria-label":nn(a("removeProvider"),m),disabled:!s.writable||s.status!=="ready",onClick:()=>{n.store.getSnapshot().status==="ready"&&(J(void 0),G(void 0),v(m))},children:a("remove")}):null]})]}),fe,t("settings.models.provider-card",{provider:C.entry,configured:C.configured,keyConfigured:Ro(C)},{entryKey:C.entry.settingsNs}),_e?Ei({target:m,row:C,namespace:q,schema:o,operations:i,t:a,readOnly:!s.writable,onClose:Me=>{de(Me,m)}}):null]},C.entry.provider)})}),(0,ue.jsx)("div",{className:A.addBlock,children:l?(0,ue.jsxs)("div",{className:A.addCard,children:[(0,ue.jsxs)("div",{className:A.addModes,children:[(0,ue.jsx)(ki,{value:Y==="custom"?g?.id??"__custom":h?.target.provider,options:ae.map(({row:C})=>({id:C.entry.provider,name:C.entry.displayName,declared:C.entry.declared===!0})),label:a("provider"),disabled:b||F,customEnabled:Ze,routerAvailable:!s.rows.some(C=>C.entry.provider==="routergo"&&C.configured),onChange:C=>{let m=ae.find(q=>q.row.entry.provider===C);m&&(y(void 0),u(io(m.row)),D("catalog"),L(q=>new Set([...q,"catalog"])))},onPreset:C=>{y(C),D("custom"),L(m=>new Set([...m,"custom"]))}}),pe?(0,ue.jsx)(Lt.SegmentedControl,{id:Z,label:a("addMode"),value:Y,disabled:be,options:[{value:"catalog",label:a("addCatalog"),disabled:!Ye,...Ye?{}:{title:a("addCatalogExhausted")}},{value:"custom",label:a("addCustom"),disabled:!Ze,...Ze?{}:{title:a("addCustomUnavailable")}}],onChange:C=>{D(C),L(m=>new Set([...m,C]))}}):(0,ue.jsx)("div",{className:A.editorHeader,children:(0,ue.jsx)("span",{className:A.editorTitle,children:a(Y==="catalog"?"addCatalog":"addCustom")})}),(0,ue.jsx)("p",{className:A.advancedHint,children:a(Y==="catalog"?"addCatalogHint":"addCustomHint")})]}),le("catalog")&&h!==void 0?(0,ue.jsxs)("div",{id:`${Z}-catalog-panel`,...pe?{role:"tabpanel","aria-labelledby":`${Z}-catalog`}:{},hidden:Y!=="catalog",className:A.addPanel,children:[(0,ue.jsx)(Oo,{provider:h.target.provider,displayName:h.target.displayName,hideTitle:!0,namespace:h.namespace,schema:o,settingsPath:h.target.settingsPath,operations:i,...h.target.defaultBaseURL===void 0?{}:{defaultBaseURL:h.target.defaultBaseURL},...h.target.baseURLEnv===void 0?{}:{baseURLEnv:h.target.baseURLEnv},...h.target.nativeAuth===void 0?{}:{nativeAuth:h.target.nativeAuth},...ne?.credentialChecks===void 0?{}:{credentialChecks:ne.credentialChecks},t:a,readOnly:!s.writable,onClose:C=>{de(C,h.target)},onBusyChange:x},h.target.provider),ne===void 0?null:t("settings.models.provider-card",{provider:ne.entry,configured:ne.configured,keyConfigured:Ro(ne)},{entryKey:ne.entry.settingsNs})]}):null,le("custom")&&he!==void 0?(0,ue.jsx)("div",{id:`${Z}-custom-panel`,...pe?{role:"tabpanel","aria-labelledby":`${Z}-custom`}:{},hidden:Y!=="custom",className:A.addPanel,children:(0,ue.jsx)(Ci,{preset:g,taken:s.rows.map(C=>C.entry.provider),protocols:ge,revision:he.revision,operations:i,t:a,readOnly:!s.writable,onClose:C=>{V(),C&&n.load()},onBusyChange:_},g?.id??"custom")}):null]}):Re||je?(0,ue.jsx)("div",{className:A.addActions,children:(0,ue.jsxs)("button",{type:"button",className:A.addButton,disabled:!s.writable||s.status!=="ready"||!Ye&&!Ze,onClick:()=>{if(n.store.getSnapshot().status!=="ready")return;let C=ae[0],m=Ye?"catalog":"custom";J(void 0),y(void 0),u(C===void 0?void 0:io(C.row)),D(m),L(new Set([m])),p(!0)},children:[(0,ue.jsx)(Lt.IconPlusOutlineRegular,{size:14}),a("add")]})}):null}),t("settings.models.footer",{}),(0,ue.jsx)(Lt.Modal,{open:Q!==void 0,onClose:se,title:Q===void 0?"":nn(a("deleteTitle"),Q),closeLabel:a("close"),description:Q===void 0?"":nn(Q.credentialRef===void 0?a("deleteDescription"):a("deleteDescriptionWithCredential"),Q),className:A.deleteDialog,footer:(0,ue.jsxs)(ue.Fragment,{children:[(0,ue.jsx)(Lt.Button,{variant:"outline","data-modal-autofocus":!0,disabled:E,onClick:se,children:a("cancel")}),(0,ue.jsx)(Lt.Button,{variant:"outline",className:A.deleteConfirm,disabled:E,onClick:re,children:Q===void 0?"":nn(a(E?"deleting":"deleteConfirm"),Q)})]}),children:P===void 0?null:(0,ue.jsx)("p",{className:A.error,children:P})})]})}var Li=`.cmd-provider-select { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 38px; padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l1, #8883); border-radius: 6px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.cmd-provider-select > span:nth-child(2), .cmd-provider-card > span:nth-child(2) { flex: 1; min-width: 0; }
.cmd-provider-select:disabled { opacity: .5; cursor: default; }
.cmd-provider-dialog { width: min(480px, 100%); max-height: 100%; border-radius: 10px; }
.cmd-provider-content { min-height: 0; overflow-y: auto; scrollbar-width: none; }
.cmd-provider-content::-webkit-scrollbar, .cmd-provider-grid::-webkit-scrollbar { display: none; }
.cmd-provider-search { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; background: var(--dsw-alias-interactive-bg-hover, #8881); }
.cmd-provider-search input { width: 100%; min-width: 0; padding: 0; border: 0; background: transparent; outline: none; box-shadow: none; color: inherit; font: inherit; font-size: 12px; }
.cmd-provider-search input:focus-visible { outline: none; box-shadow: none; }
.cmd-provider-search:focus-within { box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-focus-ring-color, #888) 18%, transparent); }
.cmd-provider-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; max-height: 360px; margin-top: 14px; overflow-y: auto; scrollbar-width: none; }
.cmd-provider-card { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 11px 9px; border: 1px solid var(--dsw-alias-border-l1, #8882); border-radius: 7px; background: transparent; color: inherit; text-align: left; font: inherit; font-size: 12px; cursor: pointer; transition: background 140ms ease, border-color 140ms ease; }
.cmd-provider-card:hover, .cmd-provider-card[aria-pressed=true], .cmd-provider-select:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #8881); }
.cmd-provider-card > .cmd-ui-icon:last-child { opacity: .5; }
.cmd-provider-empty { margin: 16px 0 0; color: var(--dsw-alias-label-tertiary, #888); font-size: 12px; }
.cmd-provider-select:focus-visible, .cmd-provider-card:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-focus-ring-color, #888) 45%, transparent); outline-offset: 2px; }
@media (max-width: 560px) { .cmd-provider-grid { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .cmd-provider-card { transition: none; } }
/* Shared supplier fields live inside the official editor, before credentials. */
.cmd-provider-harness{display:flex;flex-direction:column;align-items:flex-start;gap:8px;min-width:0;padding:0 0 14px;box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l1,#8882);color:var(--dsw-alias-label-primary,inherit)}
.cmd-provider-harness-label{font-size:12px;font-weight:500;white-space:nowrap}
.cmd-provider-harness-options{display:flex;flex-direction:row;flex-wrap:wrap;align-items:center;gap:6px;width:100%;min-width:0}
.cmd-provider-harness-options>button{position:relative;display:flex;flex:0 0 38px;align-items:center;justify-content:center;width:38px;height:38px;border:0;border-radius:9px;padding:7px;color:var(--dsw-alias-label-secondary,#777);background:transparent;font:inherit;font-size:11px;cursor:pointer;transition:background 160ms,color 160ms,transform 160ms}
.cmd-provider-harness-options>button[aria-pressed=true]{color:var(--dsw-alias-state-business-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 10%,transparent)}
.cmd-provider-harness-options>button:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 15%,transparent)}
.cmd-provider-harness-options>button:active{transform:scale(.96)}
.cmd-provider-harness-options>button:disabled{opacity:.5;cursor:default}
.cmd-provider-harness-options>button[aria-pressed=true]:disabled{opacity:1}
.cmd-provider-harness-options>button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:2px}
.cmd-provider-harness-check{position:absolute;right:0;bottom:0;display:flex;border-radius:3px;background:var(--dsw-alias-bg-layer-2,#fff)}
.cmd-provider-harness>small{color:var(--dsw-alias-label-secondary,#888);font-size:11px;line-height:1.6;overflow-wrap:anywhere}
[data-commander-provider-editor=true]{min-width:0}
.cmd-provider-harness>small>button{border:0;background:transparent;color:var(--dsw-alias-state-business-primary,#4d6bfe);font:inherit;cursor:pointer}
.cmd-provider-select,.cmd-provider-card{border-color:transparent;background:var(--dsw-alias-interactive-bg-hover,#8881);border-radius:9px;transition:background 160ms,transform 160ms}
.cmd-provider-card[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 9%,transparent)}
.cmd-provider-card:active{transform:scale(.98)}
.cmd-provider-search:focus-within{box-shadow:none}
@media(prefers-reduced-motion:reduce){.cmd-provider-harness-options>button,.cmd-provider-select,.cmd-provider-card{transition:none}}

/* Opaque themed surfaces: official dialogs must never reveal the editor below. */
.cmd-provider-dialog{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#242424);box-shadow:var(--dsw-elevation-prominent,0 16px 56px #0003)}
.cmd-provider-content{padding:0 20px;box-sizing:border-box}
[data-ds-dark-theme] .cmd-provider-dialog{background:var(--dsw-alias-bg-layer-2,#252525);color:var(--dsw-alias-label-primary,#eee)}
`;var ke=require("react/jsx-runtime");function Ti(e){let t=document.createElement("style");t.textContent=Li,document.head.append(t),e.effect(()=>()=>{t.remove(),document.getElementById("commander-official-models-style")?.remove()}),e.effect(()=>{let n=e.slots.entries("settings.section").find(o=>o.options.id==="models"&&o.children?.["settings.models.provider-card"]);if(!n)throw new Error("Official Models settings entry is unavailable");let i=n.component;return n.component=Yo,()=>{n.component===Yo&&(n.component=i)}})}var Po={id:"routergo",name:"RouterGo",baseURL:"https://routergo.cn/api/v1",protocol:"openai-completions"};function ki({value:e,options:t,disabled:n,label:i,customEnabled:o,routerAvailable:a,onChange:r,onPreset:s}){let[d,c]=(0,St.useState)(!1),[f,u]=(0,St.useState)(""),l=e==="routergo"?Po:e==="__custom"?{name:"\u81EA\u5B9A\u4E49\u4F9B\u5E94\u5546"}:t.find(g=>g.id===e),M=[...o&&a&&!t.some(g=>g.id==="routergo")?[{...Po,preset:!0}]:[],...t.map(g=>({...g,preset:!1})),...o?[{id:"__custom",name:"\u81EA\u5B9A\u4E49\u4F9B\u5E94\u5546",preset:!0}]:[]].sort((g,y)=>+(y.id==="routergo")-+(g.id==="routergo")).filter(g=>(g.name+" "+g.id).toLowerCase().includes(f.trim().toLowerCase())),D=()=>{c(!1),u("")};return(0,ke.jsxs)(ke.Fragment,{children:[(0,ke.jsxs)("button",{type:"button",className:"cmd-provider-select",disabled:n,"aria-label":i,"aria-haspopup":"dialog","aria-expanded":d,onClick:()=>c(!0),children:[(0,ke.jsx)(ht,{id:l?.id,name:l?.name,declared:l?.declared}),(0,ke.jsx)("span",{children:l?.name||i}),(0,ke.jsx)(te,{name:"chevronDown",size:14})]}),(0,ke.jsxs)(ro.Modal,{open:d,onClose:D,title:i,closeLabel:"\u5173\u95ED",className:"cmd-provider-dialog",contentClassName:"cmd-provider-content",children:[(0,ke.jsxs)("label",{className:"cmd-provider-search",children:[(0,ke.jsx)(te,{name:"search",size:16}),(0,ke.jsx)("input",{"data-modal-autofocus":!0,"aria-label":"\u641C\u7D22\u4F9B\u5E94\u5546",placeholder:"\u641C\u7D22\u4F9B\u5E94\u5546",value:f,onChange:g=>u(g.target.value)})]}),(0,ke.jsx)("div",{className:"cmd-provider-grid",children:M.map(g=>(0,ke.jsxs)("button",{type:"button",className:"cmd-provider-card","aria-pressed":e===g.id,onClick:()=>{D(),g.preset?s(g.id==="routergo"?Po:void 0):r(g.id)},children:[(0,ke.jsx)(ht,{id:g.id,name:g.name,declared:g.declared}),(0,ke.jsx)("span",{children:g.name}),e===g.id?(0,ke.jsx)(te,{name:"check",size:16}):(0,ke.jsx)(te,{name:"chevronDown",size:14})]},g.id))}),!M.length&&(0,ke.jsx)("p",{className:"cmd-provider-empty",children:"\u6CA1\u6709\u5339\u914D\u7684\u4F9B\u5E94\u5546"})]})]})}async function Si(e,t={},n){let i=await fetch(new URL("api/commander/tooling",document.baseURI),{method:"POST",credentials:"same-origin",signal:n,headers:{"content-type":"application/json"},body:JSON.stringify({action:e,...t})}),o=await Xe(i,new URL("api/commander/tooling",document.baseURI));if(o.error)throw Error(o.error||"\u65E0\u6CD5\u8BFB\u53D6 Harness \u9002\u7528\u8303\u56F4");return o}var gd={id:"harness",name:"DeepSeek Harness"};function oo(e){let[t,n]=(0,St.useState)(null),[i,o]=(0,St.useState)(null),[a,r]=(0,St.useState)(""),[s,d]=(0,St.useState)(0);St.default.useEffect(()=>{let g=new AbortController;return n(null),o(null),r(""),Si("catalog",{},g.signal).then(y=>{g.signal.aborted||n(y)}).catch(y=>{g.signal.aborted||r(y.message)}),()=>g.abort()},[s]);let c=t?[gd,...(t.tools||[]).filter(g=>g.configSupported!==!1)]:[],f=t?.providerAccess?.find(g=>g.id===e),u=f?.authMode==="subscription",l=u?f.harnessTools||[]:c.map(g=>g.id),p=t?.bindings?.[e],M=u?l:(i??(Array.isArray(p)?p:l)).filter(g=>l.includes(g));return{tools:c,current:M,toggle:g=>{u||!l.includes(g)||o(y=>{let I=y??M;return I.includes(g)?I.filter(L=>L!==g):[...I,g]})},restricted:u,permitted:l,access:f,loading:!t&&!a,failure:a,retry:()=>d(g=>g+1),async save(){if(i!==null){if(!e||!t)throw Error("\u4F9B\u5E94\u5546\u5DF2\u4FDD\u5B58\uFF0C\u4F46 Harness \u9002\u7528\u8303\u56F4\u5C1A\u672A\u5C31\u7EEA\uFF0C\u8BF7\u91CD\u8BD5\u4FDD\u5B58");try{let g=await Si("setBindings",{providerId:e,tools:i});n(y=>({...y,bindings:g.bindings})),o(null)}catch(g){throw Error("\u4F9B\u5E94\u5546\u5DF2\u4FDD\u5B58\uFF1BHarness \u9002\u7528\u8303\u56F4\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\uFF1A"+g.message)}}}}}function ao({value:e,disabled:t}){return(0,ke.jsxs)("aside",{className:"cmd-provider-harness","aria-label":"\u652F\u6301\u7684 Harness \u5DE5\u5177",children:[(0,ke.jsx)("span",{className:"cmd-provider-harness-label",children:"\u9002\u7528\u5DE5\u5177"}),(0,ke.jsx)("div",{className:"cmd-provider-harness-options",role:"group","aria-label":"\u9002\u7528 Harness \u5DE5\u5177",children:e.tools.map(n=>(0,ke.jsx)(ro.Tooltip,{label:n.name,side:"top",portal:!0,children:(0,ke.jsxs)("button",{type:"button",disabled:t||e.loading||e.restricted,"aria-label":n.name+(e.current.includes(n.id)?"\uFF0C\u5DF2\u542F\u7528":e.restricted?"\uFF0C\u6B64\u8BA2\u9605\u4E0D\u652F\u6301":"\uFF0C\u672A\u542F\u7528"),"aria-pressed":e.current.includes(n.id),onClick:()=>e.toggle(n.id),children:[(0,ke.jsx)(Tt,{tool:n.id==="harness"?"deepseek":n.id,size:20}),(0,ke.jsx)("span",{className:"cmd-provider-harness-check",children:e.current.includes(n.id)&&(0,ke.jsx)(te,{name:"check",size:10})})]})},n.id))}),e.loading?(0,ke.jsx)("small",{children:"\u52A0\u8F7D\u4E2D\u2026"}):e.failure?(0,ke.jsxs)("small",{role:"alert",children:[e.failure," ",(0,ke.jsx)("button",{type:"button",disabled:t,onClick:e.retry,children:"\u91CD\u8BD5"})]}):(0,ke.jsx)("small",{children:e.restricted?e.access?.configured?"\u8BA2\u9605\u767B\u5F55\u4EC5\u9650\u5BF9\u5E94\u5DE5\u5177\uFF1B\u4F7F\u7528\u672C\u673A\u767B\u5F55\u3002":"\u4EC5\u9650\u5BF9\u5E94\u5DE5\u5177\uFF0C\u8BF7\u5148\u5B8C\u6210\u767B\u5F55\u3002":"\u9009\u62E9\u53EF\u4F7F\u7528\u6B64\u4F9B\u5E94\u5546\u7684\u5DE5\u5177"})]})}var nt=require("react"),Qt=require("@deepseek-ai/dsh-client-ui-primitives");var me=require("react/jsx-runtime");function zi({api:e,onClose:t,onSelected:n}){let[i,o]=(0,nt.useState)("browse"),[a,r]=(0,nt.useState)(null),[s,d]=(0,nt.useState)(""),[c,f]=(0,nt.useState)(""),[u,l]=(0,nt.useState)(!1),[p,M]=(0,nt.useState)(!0),[D,g]=(0,nt.useState)(""),[y,I]=(0,nt.useState)(""),L=(0,nt.useRef)(0),b=(0,nt.useRef)(!0),x=(0,nt.useRef)(),F=(0,nt.useId)(),_=globalThis.__DSH_DIRECTORY_PICKER__,Z=async R=>{let T=++L.current;x.current=R,M(!0),I(""),g(""),d("");try{let V=await e("browse",R?{path:R}:{});b.current&&T===L.current&&r(V)}catch(V){b.current&&T===L.current&&(r(null),I(V.message))}finally{b.current&&T===L.current&&M(!1)}};(0,nt.useEffect)(()=>(b.current=!0,Z(),()=>{b.current=!1,L.current++}),[]);let Q=async R=>{if(!u){l(!0),g("");try{let T=await R();T?.project&&await n(T.project)}catch(T){b.current&&g(T.message)}finally{b.current&&l(!1)}}},v=()=>Q(()=>e("project",{path:a.path})),E=()=>Q(async()=>{let R=await _.pick();return R?e("project",{path:R}):null}),O=R=>{R.preventDefault(),Q(()=>e("clone",{url:c.trim()}))},P=R=>{o(R),g("")},G=R=>{if(!["ArrowLeft","ArrowRight","Home","End"].includes(R.key))return;R.preventDefault();let T=R.key==="Home"?"browse":R.key==="End"||i==="browse"?"github":"browse";P(T),document.getElementById(`${F}-${T}-tab`)?.focus()},j=(a?.entries??[]).filter(R=>R.name.toLowerCase().includes(s.trim().toLowerCase())),J=a?.path.replace(/[\\/]+$/,"").split(/[\\/]/).pop()||a?.path,oe=()=>{u||t()};return(0,me.jsxs)(Qt.Modal,{open:!0,headless:!0,onClose:oe,title:"\u6DFB\u52A0\u9879\u76EE",className:"cmd-project-dialog",children:[(0,me.jsxs)("header",{className:"cmd-project-header",children:[(0,me.jsx)("h2",{children:"\u6DFB\u52A0\u9879\u76EE"}),(0,me.jsx)("button",{type:"button",className:"cmd-project-icon-button","aria-label":"\u5173\u95ED",disabled:u,onClick:oe,children:(0,me.jsx)(te,{name:"close",size:16})})]}),(0,me.jsxs)("div",{className:"cmd-project-content",children:[(0,me.jsxs)("div",{className:"cmd-project-tabs",role:"tablist","aria-label":"\u6DFB\u52A0\u65B9\u5F0F",children:[(0,me.jsxs)("button",{type:"button",role:"tab",id:`${F}-browse-tab`,"aria-controls":`${F}-browse-panel`,"aria-selected":i==="browse",tabIndex:i==="browse"?0:-1,onKeyDown:G,onClick:()=>P("browse"),disabled:u,children:[(0,me.jsx)(te,{name:"folderOpen",size:16,selected:i==="browse"}),"\u6587\u4EF6\u5939"]}),(0,me.jsxs)("button",{type:"button",role:"tab",id:`${F}-github-tab`,"aria-controls":`${F}-github-panel`,"aria-selected":i==="github",tabIndex:i==="github"?0:-1,onKeyDown:G,onClick:()=>P("github"),disabled:u,children:[(0,me.jsx)(Qt.LinkIconMedium,{kind:"url",href:"https://github.com",size:16}),"GitHub"]})]}),i==="browse"?(0,me.jsxs)("div",{className:"cmd-folder-browser",role:"tabpanel",id:`${F}-browse-panel`,"aria-labelledby":`${F}-browse-tab`,children:[(0,me.jsxs)("div",{className:"cmd-folder-location",children:[(0,me.jsx)(Qt.Tooltip,{label:"\u4E0A\u4E00\u7EA7",portal:!0,children:(0,me.jsx)("button",{type:"button",className:"cmd-project-icon-button","aria-label":"\u4E0A\u4E00\u7EA7",disabled:!a?.parent||p||u,onClick:()=>void Z(a.parent),children:(0,me.jsx)(te,{name:"chevronLeft",size:16})})}),(0,me.jsx)("button",{type:"button",className:"cmd-folder-home",onClick:()=>void Z(a?.home),disabled:p||u,children:"\u4E3B\u76EE\u5F55"}),(0,me.jsx)("span",{"aria-label":"\u5F53\u524D\u76EE\u5F55",title:a?.path,children:a?.path??"\u9009\u62E9\u6587\u4EF6\u5939"}),_&&(0,me.jsx)(Qt.Tooltip,{label:"\u7CFB\u7EDF\u9009\u62E9\u6587\u4EF6\u5939",portal:!0,children:(0,me.jsx)("button",{type:"button",className:"cmd-project-icon-button","aria-label":"\u7CFB\u7EDF\u9009\u62E9\u6587\u4EF6\u5939",onClick:()=>void E(),disabled:u,children:(0,me.jsx)(te,{name:"external",size:16})})})]}),(0,me.jsxs)("label",{className:"cmd-folder-search",children:[(0,me.jsx)(te,{name:"search",size:16}),(0,me.jsx)("input",{type:"search","data-modal-autofocus":!0,"aria-label":"\u641C\u7D22\u6587\u4EF6\u5939",placeholder:"\u641C\u7D22\u6587\u4EF6\u5939",value:s,onChange:R=>d(R.target.value),disabled:u||p||!a})]}),(0,me.jsx)("div",{className:"cmd-folder-entries","aria-label":"\u6587\u4EF6\u5939\u5217\u8868","aria-busy":p,children:p?(0,me.jsx)("div",{className:"cmd-folder-empty",role:"status",children:"\u6B63\u5728\u8BFB\u53D6\u2026"}):y?(0,me.jsxs)("div",{className:"cmd-folder-empty",role:"alert",children:[(0,me.jsx)("span",{children:"\u65E0\u6CD5\u8BFB\u53D6\u76EE\u5F55"}),(0,me.jsx)("span",{className:"cmd-folder-error-detail",children:y}),(0,me.jsx)("button",{type:"button",className:"cmd-folder-retry",onClick:()=>void Z(x.current),disabled:u,children:"\u91CD\u8BD5"})]}):j.length?j.map(R=>(0,me.jsxs)("button",{type:"button",title:R.name,disabled:u,onClick:()=>void Z(R.path),children:[(0,me.jsx)(te,{name:"folder",size:17}),(0,me.jsx)("span",{children:R.name}),(0,me.jsx)(te,{name:"chevronDown",size:12,className:"cmd-folder-next"})]},R.path)):(0,me.jsx)("div",{className:"cmd-folder-empty",role:"status",children:s.trim()?"\u672A\u627E\u5230\u6587\u4EF6\u5939":"\u6B64\u76EE\u5F55\u6CA1\u6709\u5B50\u6587\u4EF6\u5939"})}),D&&(0,me.jsx)("div",{className:"cmd-project-error",role:"alert",children:D}),(0,me.jsxs)("div",{className:"cmd-project-submit",children:[(0,me.jsxs)("div",{className:"cmd-project-selection",title:a?.path,children:[(0,me.jsx)("span",{children:"\u5F53\u524D\u6587\u4EF6\u5939"}),(0,me.jsx)("strong",{children:a?J:"\u5C1A\u672A\u9009\u62E9"})]}),(0,me.jsx)("button",{type:"button",className:"cmd-dialog-button cmd-dialog-primary",disabled:!a||p||u,onClick:()=>void v(),children:u?"\u6DFB\u52A0\u4E2D\u2026":"\u6DFB\u52A0\u9879\u76EE"})]})]}):(0,me.jsxs)("form",{className:"cmd-github-form",role:"tabpanel",id:`${F}-github-panel`,"aria-labelledby":`${F}-github-tab`,onSubmit:O,children:[(0,me.jsx)("label",{htmlFor:`${F}-repo`,children:"\u4ED3\u5E93\u5730\u5740"}),(0,me.jsx)("input",{id:`${F}-repo`,type:"url",required:!0,placeholder:"https://github.com/owner/repo","aria-describedby":`${F}-github-hint`,value:c,onChange:R=>f(R.target.value),disabled:u}),(0,me.jsx)("p",{id:`${F}-github-hint`,children:"\u79C1\u6709\u4ED3\u5E93\u9700\u914D\u7F6E Git \u51ED\u636E\u3002"}),D&&(0,me.jsx)("div",{className:"cmd-project-error",role:"alert",children:D}),(0,me.jsx)("div",{className:"cmd-project-submit",children:(0,me.jsx)("button",{type:"submit",className:"cmd-dialog-button cmd-dialog-primary",disabled:u||!c.trim(),children:u?"\u514B\u9686\u4E2D\u2026":"\u514B\u9686\u5E76\u6DFB\u52A0"})})]})]})]})}var Se=require("react"),_t=require("@deepseek-ai/dsh-client-ui-primitives");var fd=new Set(["queued","running"]),hd=new Set(["config","settings","auth","profile","meta"]),Fi={queued:"\u6392\u961F\u4E2D",running:"\u6267\u884C\u4E2D",succeeded:"\u5DF2\u5B8C\u6210",failed:"\u5931\u8D25",cancelled:"\u5DF2\u53D6\u6D88"};function Mt(e){return!!e&&fd.has(e.status)}function Bi(e,t={}){return{installed:!!e.installed,installation:e.installed?"\u7CFB\u7EDF\u5DF2\u5B89\u88C5":"\u672A\u5B89\u88C5",configSupported:t.configSupported??e.configSupported??!1,chatSupported:t.sessionSupported??e.chatSupported??!1,canInstall:!!e.canInstall&&!Mt(e.job),canUpdate:!!e.canUpdate&&!Mt(e.job),canReinstall:!!e.canReinstall&&!Mt(e.job),canUninstall:!!e.canUninstall&&!Mt(e.job)}}function Qo(e){let t;try{t=JSON.parse(e||"{}")}catch{throw Error("\u9AD8\u7EA7\u914D\u7F6E\u5FC5\u987B\u662F\u6709\u6548 JSON")}if(!t||typeof t!="object"||Array.isArray(t))throw Error("\u9AD8\u7EA7\u914D\u7F6E\u5FC5\u987B\u662F JSON \u5BF9\u8C61");for(let i of Object.keys(t))if(!hd.has(i))throw Error("\u914D\u7F6E\u9876\u5C42\u4EC5\u652F\u6301 config\u3001settings\u3001auth\u3001profile\u3001meta");let n=i=>{if(!(!i||typeof i!="object"))for(let[o,a]of Object.entries(i)){if(["__proto__","prototype","constructor"].includes(o))throw Error("\u9AD8\u7EA7\u914D\u7F6E\u542B\u4E0D\u5B89\u5168\u5B57\u6BB5");if(/(?:api.?key|(?:auth|access|bearer|refresh|id)[_-]?token|^token$|secret|password|authorization|credential|base.?url|endpoint|url|headers|^env$|command|executable)/i.test(o))throw Error("\u5BC6\u94A5\u3001\u5730\u5740\u3001\u73AF\u5883\u548C\u6267\u884C\u5165\u53E3\u8BF7\u5728\u5B98\u65B9\u4F9B\u5E94\u5546\u8BBE\u7F6E\u4E2D\u7EF4\u62A4");n(a)}};return n(t),t}function so(e){return{providerId:e?.providerId||"",model:e?.model||"",protocol:e?.protocol||"",overrides:JSON.stringify(e?.overrides||{},null,2),quickSettings:{...e?.quickSettings},revision:e?.revision}}function Oi(e,t,n,i=[]){return e.filter(o=>{let a=i.find(r=>r.id===o.id)||o;return(a.authMode!=="subscription"||a.harnessTools?.includes(n))&&(!Array.isArray(t?.[o.id])||t[o.id].includes(n))})}function Ri(e,t,n){let i={...e};return n===void 0||n===""?delete i[t]:i[t]=n,i}function Yi(e,t){if(e?.routeSupported===!1)return!0;try{return Object.keys(Qo(t)).length>0}catch{return!0}}function Pi(e,t,n){if(!e.length)return t;if(n==="Home")return e[0].id;if(n==="End")return e.at(-1).id;let i=e.findIndex(o=>o.id===t);return n==="ArrowRight"||n==="ArrowDown"?e[(i+1)%e.length].id:n==="ArrowLeft"||n==="ArrowUp"?e[(i-1+e.length)%e.length].id:t}function Qi(e){return Object.fromEntries((e?.files||[]).map(t=>[t.path,t.checksum??null]))}var lo=e=>e.map(t=>({value:t,label:t})),Be=(e,t,n,i,o={})=>({key:e,label:t,type:n,group:"\u5FEB\u6377\u914D\u7F6E",role:"config",path:i,...o}),bd=[Be("agentTeams","\u591A Agent \u534F\u4F5C","boolean",["env","CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"],{role:"settings",group:"\u901A\u7528\u914D\u7F6E",description:"\u5F00\u542F Claude Code \u5B9E\u9A8C\u6027 Agent Teams\uFF1B\u7531\u5DE5\u5177\u7248\u672C\u51B3\u5B9A\u662F\u5426\u652F\u6301\u3002"}),Be("agentWindow","Agent \u7A97\u53E3","select",["teammateMode"],{role:"settings",group:"\u901A\u7528\u914D\u7F6E",options:[{value:"in-process",label:"\u5F53\u524D\u8FDB\u7A0B"},{value:"auto",label:"\u81EA\u52A8"},{value:"tmux",label:"tmux \u5206\u5C4F"},{value:"iterm2",label:"iTerm2 \u5206\u5C4F"}],description:"\u5206\u5C4F\u6A21\u5F0F\u9700\u8981\u672C\u673A\u76F8\u5E94\u7EC8\u7AEF\u652F\u6301\u3002"}),Be("thinking","\u6269\u5C55\u601D\u8003","boolean",["alwaysThinkingEnabled"],{role:"settings"}),Be("effort","\u63A8\u7406\u5F3A\u5EA6","select",["effortLevel"],{role:"settings",options:lo(["low","medium","high","xhigh"])}),Be("disableHooks","\u7981\u7528 Hooks","boolean",["disableAllHooks"],{role:"settings"})],_i={claude:bd,codex:[Be("multiAgent","\u591A Agent \u534F\u4F5C","boolean",["features","multi_agent"],{group:"\u901A\u7528\u914D\u7F6E"}),Be("agentThreads","\u5E76\u53D1 Agent \u6570","number",["agents","max_threads"],{group:"\u901A\u7528\u914D\u7F6E",min:1,max:32}),Be("agentDepth","Agent \u6700\u5927\u6DF1\u5EA6","number",["agents","max_depth"],{group:"\u901A\u7528\u914D\u7F6E",min:1,max:8}),Be("effort","\u63A8\u7406\u5F3A\u5EA6","select",["model_reasoning_effort"],{options:lo(["minimal","low","medium","high","xhigh"])}),Be("contextWindow","\u4E0A\u4E0B\u6587\u7A97\u53E3","number",["model_context_window"],{min:1024,max:1e7}),Be("compactLimit","\u81EA\u52A8\u538B\u7F29\u9608\u503C","number",["model_auto_compact_token_limit"],{min:1024,max:1e7})],gemini:[Be("previewFeatures","\u9884\u89C8\u529F\u80FD","boolean",["general","previewFeatures"],{role:"settings"}),Be("promptCompletion","\u63D0\u793A\u8BCD\u81EA\u52A8\u8865\u5168","boolean",["general","enablePromptCompletion"],{role:"settings"}),Be("maxTurns","\u4F1A\u8BDD\u6700\u5927\u8F6E\u6570","number",["model","maxSessionTurns"],{role:"settings",min:1,max:1e4})],opencode:[Be("autoUpdate","\u81EA\u52A8\u66F4\u65B0","boolean",["autoupdate"]),Be("snapshot","\u6587\u4EF6\u5FEB\u7167","boolean",["snapshot"]),Be("share","\u4F1A\u8BDD\u5206\u4EAB","select",["share"],{options:[{value:"disabled",label:"\u5173\u95ED"},{value:"manual",label:"\u624B\u52A8"},{value:"auto",label:"\u81EA\u52A8"}]})],openclaw:[Be("concurrency","\u5E76\u53D1 Agent \u6570","number",["agents","defaults","maxConcurrent"],{group:"\u901A\u7528\u914D\u7F6E",min:1,max:32}),Be("contextWindow","\u4E0A\u4E0B\u6587\u7A97\u53E3","number",["agents","defaults","contextTokens"],{min:1024,max:1e7})],pi:[Be("thinking","\u601D\u8003\u7EA7\u522B","select",["defaultThinkingLevel"],{role:"settings",options:lo(["off","minimal","low","medium","high","xhigh"])}),Be("compaction","\u81EA\u52A8\u538B\u7F29","boolean",["compaction","enabled"],{role:"settings"}),Be("retry","\u5931\u8D25\u91CD\u8BD5","boolean",["retry","enabled"],{role:"settings"})],hermes:[Be("maxTurns","Agent \u6700\u5927\u8F6E\u6570","number",["agent","max_turns"],{min:1,max:1e4}),Be("effort","\u63A8\u7406\u5F3A\u5EA6","select",["agent","reasoning_effort"],{options:lo(["low","medium","high"])})],grok:[Be("contextWindow","\u4E0A\u4E0B\u6587\u7A97\u53E3","number",["model","benchgo","context_window"],{min:1024,max:1e7})]};function Zi(e){return structuredClone(_i[e]||[])}function Hi(e,t={}){if(!t||typeof t!="object"||Array.isArray(t))throw new Error("\u5FEB\u6377\u914D\u7F6E\u5FC5\u987B\u4E3A\u5BF9\u8C61");let n=_i[e]||[],i={};for(let[o,a]of Object.entries(t)){let r=n.find(s=>s.key===o);if(!r)throw new Error("\u6B64\u5DE5\u5177\u4E0D\u652F\u6301\u5FEB\u6377\u914D\u7F6E\uFF1A"+o);if(r.type==="boolean"&&typeof a!="boolean"||r.type==="select"&&!r.options.some(s=>s.value===a)||r.type==="number"&&(!Number.isSafeInteger(a)||a<r.min||a>r.max))throw new Error("\u65E0\u6548\u7684\u5FEB\u6377\u914D\u7F6E\uFF1A"+r.label);i[o]=a}if(i.compactLimit&&i.contextWindow&&i.compactLimit>i.contextWindow)throw new Error("\u81EA\u52A8\u538B\u7F29\u9608\u503C\u4E0D\u80FD\u8D85\u8FC7\u4E0A\u4E0B\u6587\u7A97\u53E3");return i}function Gi(){let e=null,t=!1,n=i=>{!e||i.pointerId!==e.pointerId||(delete e.viewport.dataset.dragging,e=null)};return{onPointerDown(i){if(i.pointerType!=="mouse"||i.button!==0||e)return;t=!1;let o=i.currentTarget;if(o.scrollWidth<=o.clientWidth)return;e={viewport:o,pointerId:i.pointerId,startX:i.clientX,scrollLeft:o.scrollLeft},(i.target.closest("button")||o).setPointerCapture(i.pointerId)},onPointerMove(i){if(!e||i.pointerId!==e.pointerId)return;if(!(i.buttons&1)){n(i);return}let o=i.clientX-e.startX;!t&&Math.abs(o)<5||(t=!0,e.viewport.dataset.dragging="true",i.preventDefault(),e.viewport.scrollLeft=e.scrollLeft-o)},onPointerUp:n,onPointerCancel:n,onLostPointerCapture:n,onClickCapture(i){!t||i.detail===0||(t=!1,i.preventDefault(),i.stopPropagation())},onDragStart(i){i.preventDefault()}}}var Wi=`.cmd-tool-settings { color: var(--dsw-alias-label-primary, inherit); font-size: 13px; min-width: 0; }
.cmd-tool-heading, .cmd-tool-detail-heading, .cmd-tool-config-heading, .cmd-tool-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.cmd-tool-heading { margin-bottom: 20px; align-items: flex-start; }
.cmd-tool-heading h2 { font-size: 19px; font-weight: 600; margin: 0; }
.cmd-tool-heading p { margin-top: 7px; }
.cmd-tool-heading p, .cmd-tool-hint, .cmd-tool-footer > span { margin: 0; font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary, #888); }
.cmd-tool-workbench { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
.cmd-tool-tabs { display: flex; align-items: center; gap: 5px; width: 100%; min-width: 0; padding: 0 0 13px; overflow-x: auto; scrollbar-width: none; cursor: grab; user-select: none; touch-action: pan-x pan-y; border-bottom: 1px solid var(--dsw-alias-border-l1, #8882); }
.cmd-tool-tabs::-webkit-scrollbar { display: none; }
.cmd-tool-tabs[data-dragging=true], .cmd-tool-tabs[data-dragging=true] > button { cursor: grabbing; }
.cmd-tool-tabs[data-dragging=true] .cmd-tool-tab-name { transition: none; }
.cmd-tool-tabs > button { position: relative; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; box-sizing: border-box; min-width: 40px; min-height: 42px; padding: 10px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: inherit; font: inherit; cursor: pointer; transition: background 160ms ease, border-color 160ms ease; }
.cmd-tool-tabs > button:hover, .cmd-tool-tabs > button:focus-visible { background: var(--dsw-alias-interactive-bg-hover, #8881); }
.cmd-tool-tabs > button[aria-selected=true] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 8%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 20%, transparent); }
.cmd-tool-tab-name { display: inline-block; box-sizing: border-box; max-width: 0; overflow: hidden; opacity: 0; white-space: nowrap; font-size: 12px; font-weight: 550; transition: max-width 220ms ease, opacity 170ms ease, padding 220ms ease; }
.cmd-tool-tabs > button:hover .cmd-tool-tab-name, .cmd-tool-tabs > button:focus-visible .cmd-tool-tab-name { max-width: 170px; padding-left: 9px; opacity: 1; }
.cmd-tool-brand[data-muted] { filter: grayscale(1); opacity: .55; }
.cmd-tool-detail { min-width: 0; animation: cmd-tool-enter 150ms ease both; }
.cmd-tool-detail h3 { display: flex; align-items: center; gap: 9px; margin: 0 0 9px; font-size: 17px; font-weight: 600; }
.cmd-tool-detail-heading { align-items: flex-start; margin-bottom: 12px; }
.cmd-tool-badges { display: flex; flex-wrap: wrap; gap: 5px; }
.cmd-tool-badges span { padding: 3px 6px; font-size: 10px; color: var(--dsw-alias-label-secondary, #888); border-radius: 4px; background: var(--dsw-alias-interactive-bg-hover, #8881); }
.cmd-tool-badges span[data-ready=true] { color: var(--dsw-alias-status-success, #398361); }
.cmd-tool-install-actions { display: flex; flex-wrap: wrap; gap: 5px; }
.cmd-tool-button, .cmd-tool-icon { color: inherit; background: transparent; border: 1px solid var(--dsw-alias-border-l1, #8883); border-radius: 6px; min-height: 32px; padding: 6px 10px; font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; transition: background 140ms ease; }
.cmd-tool-button:hover:not(:disabled), .cmd-tool-icon:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #8882); }
.cmd-tool-button:disabled, .cmd-tool-icon:disabled, .cmd-tool-select:disabled { opacity: .45; cursor: default; }
.cmd-tool-icon { display: grid; place-items: center; padding: 7px; border: 0; }
.cmd-tool-primary { background: var(--dsw-alias-interactive-bg-active, #8882); font-weight: 550; }
.cmd-tool-detail { width: 100%; }
.cmd-tool-editor { margin-top: 27px; padding-top: 21px; border-top: 1px solid var(--dsw-alias-border-l1, #8882); }
.cmd-tool-config { min-width: 0; }
.cmd-tool-native-status { display: flex; align-items: flex-start; gap: 8px; padding: 12px 0 4px; color: var(--dsw-alias-label-secondary, #888); }
.cmd-tool-native-status > .cmd-ui-icon { flex: none; margin-top: 2px; color: var(--dsw-alias-status-success, #398361); }
.cmd-tool-native-status strong { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.cmd-tool-native-status p { margin: 5px 0 0; font-size: 11px; line-height: 1.7; }
.cmd-tool-paths { margin-top: 10px; color: var(--dsw-alias-label-secondary, #888); font-size: 11px; }
.cmd-tool-paths summary { cursor: pointer; padding: 3px 0; }
.cmd-tool-paths p { display: flex; gap: 12px; margin: 9px 0; line-height: 1.7; }
.cmd-tool-paths p > span { flex: none; min-width: 82px; }
.cmd-tool-paths code { min-width: 0; overflow-wrap: anywhere; font: inherit; font-family: var(--dsw-font-family-code, ui-monospace, monospace); }
.cmd-tool-subscription { margin-top: 16px; padding: 12px 14px; border-radius: 9px; background: var(--dsw-alias-interactive-bg-hover, #8881); }
.cmd-tool-subscription strong { font-size: 12px; font-weight: 550; }
.cmd-tool-subscription p { margin: 6px 0; color: var(--dsw-alias-label-secondary, #888); font-size: 11px; line-height: 1.7; }
.cmd-tool-subscription > span { display: inline-block; margin: 4px 8px 0 0; font-size: 11px; }
.cmd-tool-quick-settings { margin-top: 22px; }
.cmd-tool-quick-settings fieldset { margin: 0 0 21px; padding: 0; border: 0; min-width: 0; }
.cmd-tool-quick-settings legend { padding: 0; font-size: 12px; font-weight: 600; }
.cmd-tool-quick-field { min-width: 0; }
.cmd-tool-quick-field > .cmd-tool-hint { margin-top: 7px; font-size: 11px; }
.cmd-tool-config-heading { margin-bottom: 8px; }
.cmd-tool-config h4 { font-size: 13px; font-weight: 600; margin: 0; }
.cmd-tool-link { color: var(--dsw-alias-label-secondary, #888); border: 0; padding: 3px 0; background: transparent; font: inherit; font-size: 11px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.cmd-tool-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.cmd-tool-field { display: flex; flex-direction: column; gap: 7px; margin-top: 15px; min-width: 0; }
.cmd-tool-field > span { font-size: 12px; font-weight: 500; }
.cmd-tool-field small, .cmd-tool-advanced small, .cmd-tool-backups small { color: var(--dsw-alias-label-secondary, #888); font-size: 10px; font-weight: normal; margin-left: 5px; }
.cmd-tool-field > input, .cmd-tool-select, .cmd-tool-advanced textarea { width: 100%; box-sizing: border-box; min-width: 0; border: 1px solid var(--dsw-alias-border-l1, #8883); border-radius: 6px; background: transparent; color: inherit; padding: 8px 10px; font: inherit; font-size: 12px; }
.cmd-tool-select-anchor { display: flex; width: 100%; min-width: 0; }
.cmd-tool-select { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 35px; text-align: left; cursor: pointer; }
.cmd-tool-select > span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.cmd-tool-select-menu { min-width: 230px; max-width: min(360px, 90vw); }
.cmd-tool-select-menu input { border: 0; border-radius: 5px; background: var(--dsw-alias-interactive-bg-hover, #8881); color: inherit; padding: 8px; margin: 4px; font: inherit; font-size: 12px; outline: 0; }
.cmd-tool-select-menu button { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 9px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.cmd-tool-select-menu button:hover, .cmd-tool-select-menu button[data-selected=true] { background: var(--dsw-alias-interactive-bg-hover, #8881); }
.cmd-tool-select-menu p { padding: 9px; font-size: 12px; opacity: .6; }
.cmd-tool-advanced, .cmd-tool-backups { margin-top: 20px; }
.cmd-tool-advanced summary, .cmd-tool-backups summary, .cmd-tool-job summary { cursor: pointer; padding: 5px 0; font-size: 12px; }
.cmd-tool-advanced .cmd-tool-hint { margin: 7px 0; }
.cmd-tool-advanced textarea { min-height: 175px; resize: vertical; font-family: var(--dsw-font-family-code, ui-monospace, monospace); line-height: 1.65; }
.cmd-tool-footer { margin-top: 17px; }
.cmd-tool-job { margin-top: 15px; padding: 11px 12px; border: 1px solid var(--dsw-alias-border-l1, #8882); border-radius: 7px; }
.cmd-tool-job > div:first-child { display: flex; align-items: center; gap: 9px; font-size: 12px; }
.cmd-tool-job > div:first-child > span { flex: 1; color: var(--dsw-alias-label-secondary, #888); }
.cmd-tool-job pre { font-size: 11px; line-height: 1.6; max-height: 160px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.cmd-tool-progress { height: 2px; margin-top: 12px; overflow: hidden; border-radius: 2px; background: var(--dsw-alias-interactive-bg-hover, #8882); }
.cmd-tool-progress > span { display: block; height: 100%; width: 35%; background: currentColor; opacity: .5; animation: cmd-tool-progress 1.5s ease-in-out infinite; }
.cmd-tool-error { color: var(--dsw-alias-status-error, #bd5353); font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.cmd-tool-notice { color: var(--dsw-alias-status-success, #398361); font-size: 12px; }
.cmd-tool-empty { margin: 20px 0; color: var(--dsw-alias-label-secondary, #888); font-size: 12px; line-height: 1.7; }
.cmd-tool-modal { width: min(590px, 100%); background:var(--dsw-alias-bg-layer-2,#fff); color:var(--dsw-alias-label-primary,#222); }
.cmd-tool-preview > div, .cmd-tool-backups > div { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; }
.cmd-tool-preview code { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
.cmd-tool-preview span { white-space: nowrap; font-size: 11px; color: var(--dsw-alias-label-secondary, #888); }
.cmd-tool-preview p { font-size: 12px; line-height: 1.7; }
.cmd-tool-settings button:focus-visible, .cmd-tool-settings input:focus-visible, .cmd-tool-settings textarea:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 60%, transparent); outline-offset: 2px; }
@keyframes cmd-tool-enter { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
@keyframes cmd-tool-progress { from { transform: translateX(-100%); } to { transform: translateX(390%); } }
@media (max-width: 680px) { .cmd-tool-workbench { gap: 20px; } .cmd-tool-tabs { gap: 2px; } .cmd-tool-tabs > button { padding: 9px; min-width: 38px; } .cmd-tool-fields { grid-template-columns: 1fr; gap: 0; } .cmd-tool-detail-heading, .cmd-tool-footer { flex-wrap: wrap; } }
@media (prefers-reduced-motion: reduce) { .cmd-tool-detail, .cmd-tool-progress > span { animation: none; } .cmd-tool-settings button, .cmd-tool-tab-name { transition: none; } }
.cmd-tool-current-provider{display:flex;align-items:center;gap:14px;padding:13px 14px;margin:12px 0 3px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover,#8881)}
.cmd-tool-route-status{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:11px;color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.cmd-tool-current-provider>div{display:flex;flex-direction:column;gap:4px;min-width:0}
.cmd-tool-current-provider strong{font-size:13px;font-weight:550;overflow-wrap:anywhere}
.cmd-tool-current-provider small{font-size:12px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#888)}
.cmd-tool-config-heading>span{font-size:11px;color:var(--dsw-alias-label-secondary,#888)}
.cmd-tool-native-sync{display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin-top:18px}
.cmd-tool-native-sync>small{font-size:11px;color:var(--dsw-alias-label-secondary,#888)}
.cmd-tool-advanced>.cmd-tool-advanced{margin-top:12px}
.cmd-tool-config>.cmd-tool-advanced{padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1,#8882)}
.cmd-tool-select{border-color:transparent;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover,#8881);min-height:39px;transition:background 160ms}
.cmd-tool-select:hover:not(:disabled),.cmd-tool-select[aria-expanded=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 7%,transparent)}
.cmd-tool-select-menu{border-radius:11px;padding:6px;scrollbar-width:none}
.cmd-tool-select-menu::-webkit-scrollbar{display:none}
.cmd-tool-select-menu button{border-radius:7px;margin:2px 0;min-height:36px}
.cmd-tool-select-menu button[data-selected=true]{color:var(--dsw-alias-state-business-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 9%,transparent)}
.cmd-tool-select-menu input{background:transparent}
/* The shared Menu inserts a viewport between the portal card and options. */
.cmd-tool-select-menu{min-width:260px;padding:6px!important;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#222);border-radius:12px!important;border:1px solid var(--dsw-alias-border-l1,#8882);box-shadow:0 12px 40px #00000014,0 2px 8px #00000008;animation:cmd-tool-enter 160ms ease both}
.cmd-tool-select-menu input{display:block;appearance:none;box-sizing:border-box;width:calc(100% - 8px);padding:10px;margin:4px 4px 7px;border:0!important;outline:0!important;box-shadow:none!important;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:20px}
.cmd-tool-select-menu button{appearance:none;box-sizing:border-box;min-height:38px;padding:10px 12px;gap:16px;font-size:12px;line-height:18px;transition:background 140ms,color 140ms}
.cmd-tool-select-menu button>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmd-tool-select-menu button:focus-visible{outline:0;background:var(--dsw-alias-interactive-bg-hover,#8881)}
.cmd-tool-select-menu [role=presentation]{scrollbar-width:none;overscroll-behavior:contain}
.cmd-tool-select-menu [role=presentation]::-webkit-scrollbar{display:none}
.cmd-tool-select[aria-expanded=true]>.cmd-ui-icon{transform:rotate(180deg)}
.cmd-tool-select>.cmd-ui-icon{transition:transform 180ms ease;flex:none}
@media(prefers-reduced-motion:reduce){.cmd-tool-select-menu{animation:none}.cmd-tool-select-menu button,.cmd-tool-select>.cmd-ui-icon{transition:none}}

.cmd-tool-option-label{display:flex;align-items:center;gap:9px;min-width:0}
.cmd-tool-option-label>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmd-tool-select-menu button>.cmd-ui-icon{flex:none}
`;var w=require("react/jsx-runtime");function Ji(e){let t=document.createElement("style");t.textContent=Wi,document.head.append(t),e.effect(()=>()=>t.remove())}async function xt(e,t={},n){let i=await fetch(new URL("api/commander/tooling",document.baseURI),{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({action:e,...t}),signal:n}),o=await Xe(i,new URL("api/commander/tooling",document.baseURI));if(o.error)throw Error(o.error||"\u5DE5\u5177\u7BA1\u7406\u8BF7\u6C42\u5931\u8D25");return o}var _o=e=>Array.isArray(e)?e:Object.values(e||{}),Vi=(e,t)=>Array.isArray(e)?e.find(n=>n.tool===t):e?.[t],wd=(e,t)=>Array.isArray(e)?e.find(n=>n.tool===t||n.id===t):e?.[t];function yd({label:e,children:t}){return(0,w.jsx)(_t.Tooltip,{label:e,delayMs:450,portal:!0,children:t})}function co({label:e,value:t,options:n,onChange:i,disabled:o,empty:a="\u8BF7\u9009\u62E9"}){let r=(0,Se.useRef)(null),[s,d]=(0,Se.useState)(!1),[c,f]=(0,Se.useState)(""),u=n.find(M=>M.value===t),l=n.filter(M=>(M.label+" "+M.value).toLowerCase().includes(c.toLowerCase()));(0,Se.useEffect)(()=>{o&&d(!1)},[o]);let p=(0,w.jsxs)("button",{type:"button",className:"cmd-tool-select",ref:r,disabled:o,"aria-label":e,"aria-haspopup":"menu","aria-expanded":s&&!o,onClick:()=>{f(""),d(M=>!M)},children:[(0,w.jsxs)("span",{className:"cmd-tool-option-label",children:[u?.icon,(0,w.jsx)("span",{children:u?.label||t||a})]}),(0,w.jsx)(te,{name:"chevronDown",size:14})]});return(0,w.jsxs)("div",{className:"cmd-tool-field",children:[(0,w.jsx)("span",{children:e}),(0,w.jsxs)(_t.Menu,{open:s&&!o,onClose:()=>d(!1),anchor:p,className:"cmd-tool-select-anchor",getAnchorRect:()=>r.current?.getBoundingClientRect()??null,side:"bottom",align:"start",portal:!0,autoFocus:!0,listClassName:"cmd-tool-select-menu",children:[(0,w.jsx)("input",{autoFocus:!0,"aria-label":"\u641C\u7D22"+e,value:c,placeholder:"\u641C\u7D22"+e,onChange:M=>f(M.target.value),onKeyDown:M=>{if(M.key==="ArrowDown"||M.key==="ArrowUp"){M.preventDefault();let D=M.currentTarget.closest("[role=menu]")?.querySelectorAll("[role=menuitem]");D?.length&&D[M.key==="ArrowDown"?0:D.length-1].focus()}M.key!=="Escape"&&M.stopPropagation()}}),l.map(M=>(0,w.jsxs)("button",{role:"menuitem","data-selected":M.value===t,type:"button",onClick:()=>{i(M.value),d(!1)},children:[(0,w.jsxs)("span",{className:"cmd-tool-option-label",children:[M.icon,(0,w.jsx)("span",{children:M.label})]}),M.value===t&&(0,w.jsx)(te,{name:"check",size:14})]},M.value)),!l.length&&(0,w.jsx)("p",{children:"\u6CA1\u6709\u53EF\u9009\u9879"})]})]})}function xd({tools:e,selected:t,disabled:n,onChange:i}){let o=(0,Se.useRef)(null);return o.current||(o.current=Gi()),(0,w.jsx)("nav",{className:"cmd-tool-tabs",role:"tablist","aria-label":"Harness \u5DE5\u5177","aria-orientation":"horizontal",...o.current,onKeyDown:a=>{if(n||!["ArrowLeft","ArrowRight","Home","End"].includes(a.key))return;a.preventDefault();let r=Pi(e,t,a.key);i(r),a.currentTarget.querySelector('[data-tool="'+r+'"]')?.focus()},children:e.map(a=>(0,w.jsxs)("button",{type:"button",role:"tab",id:"cmd-tool-tab-"+a.id,"data-tool":a.id,"aria-label":a.name,"aria-selected":t===a.id,"aria-controls":"cmd-tool-panel-"+a.id,tabIndex:t===a.id?0:-1,disabled:n,onClick:()=>i(a.id),children:[(0,w.jsx)(Tt,{tool:a.id,size:22,muted:!a.installed}),(0,w.jsx)("span",{className:"cmd-tool-tab-name",children:a.name})]},a.id))})}function Ud({tool:e,values:t,disabled:n,onChange:i,isolated:o}){let a=Zi(e);return(0,w.jsxs)("div",{className:"cmd-tool-quick-settings",children:[["\u901A\u7528\u914D\u7F6E","\u5FEB\u6377\u914D\u7F6E"].map(r=>{let s=a.filter(d=>d.group===r);return s.length>0&&(0,w.jsxs)("fieldset",{children:[(0,w.jsx)("legend",{children:r}),(0,w.jsx)("div",{className:"cmd-tool-fields",children:s.map(d=>(0,w.jsxs)("div",{className:"cmd-tool-quick-field",children:[d.type==="boolean"||d.type==="select"?(0,w.jsx)(co,{label:d.label,value:t[d.key]===void 0?"":String(t[d.key]),options:[{value:"",label:"\u8DDF\u968F\u5DE5\u5177\u9ED8\u8BA4"},...d.type==="boolean"?[{value:"true",label:"\u5F00\u542F"},{value:"false",label:"\u5173\u95ED"}]:d.options],disabled:n,onChange:c=>i(d.key,c===""?void 0:d.type==="boolean"?c==="true":c)}):(0,w.jsxs)("label",{className:"cmd-tool-field",children:[(0,w.jsx)("span",{children:d.label}),(0,w.jsx)("input",{type:d.type==="number"?"number":"text",min:d.min,max:d.max,step:d.type==="number"?1:void 0,placeholder:"\u8DDF\u968F\u5DE5\u5177\u9ED8\u8BA4",value:t[d.key]??"",disabled:n,onChange:c=>i(d.key,c.target.value===""?void 0:d.type==="number"?Number(c.target.value):c.target.value)})]}),d.description&&(0,w.jsx)("p",{className:"cmd-tool-hint",children:d.description})]},d.key))})]},r)}),(0,w.jsx)("p",{className:"cmd-tool-hint",children:a.length?o?"\u672A\u8BBE\u7F6E\u7684\u9009\u9879\u8DDF\u968F\u5DE5\u5177\u9ED8\u8BA4\uFF1B\u4FDD\u5B58\u540E\u7528\u4E8E\u65B0\u7684\u9694\u79BB\u4F1A\u8BDD\u3002":"\u5FEB\u6377\u914D\u7F6E\u4FDD\u5B58\u5728 BenchGo\uFF1B\u7CFB\u7EDF\u5DE5\u5177\u4ECD\u7531\u672C\u673A\u5B89\u88C5\u6765\u6E90\u7BA1\u7406\u3002":"\u6B64\u5DE5\u5177\u6682\u672A\u63D0\u4F9B\u5DF2\u9A8C\u8BC1\u7684\u5FEB\u6377\u914D\u7F6E\uFF0C\u53EF\u5728\u9AD8\u7EA7\u9009\u9879\u4E2D\u7F16\u8F91\u652F\u6301\u7684\u914D\u7F6E JSON\u3002"})]})}function Ki({close:e}){let[t,n]=(0,Se.useState)(null),[i,o]=(0,Se.useState)([]),[a,r]=(0,Se.useState)(""),[s,d]=(0,Se.useState)(!0),[c,f]=(0,Se.useState)(""),[u,l]=(0,Se.useState)(""),[p,M]=(0,Se.useState)(!1),[D,g]=(0,Se.useState)(0),[y,I]=(0,Se.useState)(()=>so()),[L,b]=(0,Se.useState)([]),[x,F]=(0,Se.useState)(!1),[_,Z]=(0,Se.useState)(""),[Q,v]=(0,Se.useState)(0),[E,O]=(0,Se.useState)(null),[P,G]=(0,Se.useState)(null),[j,J]=(0,Se.useState)(null),oe=(0,Se.useRef)(!0),R=h=>{O(h),h&&n(ne=>ne&&{...ne,tools:ne.tools.map(C=>C.id===h.toolId?{...C,job:h}:C)})};(0,Se.useEffect)(()=>(oe.current=!0,()=>{oe.current=!1}),[]),(0,Se.useEffect)(()=>{let h=new AbortController;return d(!0),f(""),Promise.all([xt("catalog",{},h.signal),xt("providers",{},h.signal)]).then(([ne,C])=>{h.signal.aborted||(n(ne),o(C.providers||[]),r(m=>ne.tools?.some(q=>q.id===m)?m:ne.tools?.[0]?.id||""))}).catch(ne=>{h.signal.aborted||f(ne.message)}).finally(()=>{h.signal.aborted||d(!1)}),()=>h.abort()},[D]);let T=t?.tools?.find(h=>h.id===a),V=wd(t?.capabilities,a)||{},de=T?Bi(T,V):{},$=Vi(t?.profiles,a),se=Vi(t?.defaults,a),re=i.find(h=>h.id===se?.providerId),ee=t?.providerAccess||[],B=(ee.find(h=>h.id===y.providerId)||i.find(h=>h.id===y.providerId))?.authMode==="subscription";(0,Se.useEffect)(()=>{I(so($)),J(null),Z(""),O(T?.job||null)},[a,$]),(0,Se.useEffect)(()=>{O(T?.job||null)},[a,T?.job]),(0,Se.useEffect)(()=>{let h=new AbortController;if(b([]),Z(""),F(!1),!(!y.providerId||B))return F(!0),xt("models",{providerId:y.providerId},h.signal).then(ne=>{h.signal.aborted||b(ne.models||[])}).catch(ne=>{h.signal.aborted||Z(ne.message)}).finally(()=>{h.signal.aborted||F(!1)}),()=>h.abort()},[y.providerId,B,Q]),(0,Se.useEffect)(()=>{if(!Mt(E))return;let h=new AbortController,ne,C=async()=>{try{let m=await xt("job",{id:E.id},h.signal);if(h.signal.aborted)return;R(m.job),Mt(m.job)?ne=setTimeout(C,1e3):g(q=>q+1)}catch(m){h.signal.aborted||f(m.message)}};return ne=setTimeout(C,650),()=>{h.abort(),clearTimeout(ne)}},[E?.id,E?.status]);let S=async h=>{M(!0),f(""),l("");try{await h()}catch(ne){oe.current&&f(ne.message)}finally{oe.current&&M(!1)}},H=h=>S(async()=>{let ne=await xt(h,{tool:a,...h==="uninstall"?{snapshot:P?.preview?.snapshot}:{}});R(ne.job),G(null)}),ae=()=>S(async()=>{let h=Qo(y.overrides),ne=Hi(a,y.quickSettings);if(B)throw Error("\u8BA2\u9605\u767B\u5F55\u8BF7\u5728\u6A21\u578B\u9009\u62E9\u5668\u4E2D\u4F7F\u7528\u5BF9\u5E94\u5DE5\u5177\uFF0C\u672C\u673A\u767B\u5F55\u4F1A\u4FDD\u7559");if(!y.providerId||!y.model.trim())throw Error("\u8BF7\u9009\u62E9\u4F9B\u5E94\u5546\u548C\u6A21\u578B");let C=await xt("saveProfile",{tool:a,providerId:y.providerId,model:y.model.trim(),...y.protocol?{protocol:y.protocol}:{},quickSettings:ne,overrides:h,...y.revision!==void 0?{expectedRevision:y.revision}:{}});I(so(C.profile)),n(q=>({...q,profiles:_o(q.profiles).filter(fe=>fe.tool!==a).concat(C.profile)}));let m=T.routeSupported===!1||Object.keys(h).length>0;m||await xt("setDefault",{tool:a,revision:C.profile.revision}),l(m?"\u914D\u7F6E\u65B9\u6848\u5DF2\u4FDD\u5B58\uFF1B\u672C\u673A\u672A\u4FEE\u6539\uFF0C\u53EF\u9884\u89C8\u540E\u5355\u72EC\u786E\u8BA4\u540C\u6B65\u3002":"\u9ED8\u8BA4\u65B9\u6848\u5DF2\u4FDD\u5B58\uFF0C\u65B0\u4F1A\u8BDD\u751F\u6548\u3002\u672C\u673A\u914D\u7F6E\u672A\u4FEE\u6539\u3002"),g(q=>q+1)}),he=(h,ne)=>{I(C=>({...C,[h]:ne,...h==="providerId"?{model:""}:{}})),J(null),l("")},ge=t?.bindings||{},Re=Oi(i,ge,a,ee),Ye=t?.tools||[],je=_o(t?.native).find(h=>h.tool===a),Ze=Re.filter(h=>{let ne=ee.find(C=>C.id===h.id)||h;return ne.authMode==="subscription"&&ne.configured===!0}),pe=h=>{p||(l(""),r(h))},Y=T?.installed,le=Yi(T,y.overrides),be=_o(t?.backups).filter(h=>h.tool===a||h.toolId===a);return(0,w.jsxs)("section",{className:"cmd-tool-settings","aria-busy":s,children:[(0,w.jsxs)("header",{className:"cmd-tool-heading",children:[(0,w.jsxs)("div",{children:[(0,w.jsx)("h2",{children:"Harness \u5DE5\u5177"}),(0,w.jsx)("p",{children:"\u53D1\u73B0\u5E76\u7BA1\u7406\u672C\u673A Harness\uFF0C\u7EDF\u4E00\u7BA1\u7406 BenchGo \u4F1A\u8BDD\u65B9\u6848\u3002"})]}),(0,w.jsx)(yd,{label:"\u91CD\u65B0\u68C0\u6D4B",children:(0,w.jsx)("button",{type:"button",className:"cmd-tool-icon",disabled:s||p,"aria-label":"\u91CD\u65B0\u68C0\u6D4B\u5DE5\u5177",onClick:()=>g(h=>h+1),children:(0,w.jsx)(te,{name:"refresh",size:16})})})]}),c&&(0,w.jsx)("p",{className:"cmd-tool-error",role:"alert",children:c}),u&&(0,w.jsx)("p",{className:"cmd-tool-notice",role:"status",children:u}),s&&!t?(0,w.jsx)("p",{className:"cmd-tool-empty",role:"status",children:"\u6B63\u5728\u68C0\u6D4B\u5DF2\u5B89\u88C5\u5DE5\u5177\u2026"}):t?(0,w.jsx)(w.Fragment,{children:(0,w.jsxs)("div",{className:"cmd-tool-workbench",children:[(0,w.jsx)(xd,{tools:Ye,selected:a,disabled:p,onChange:pe}),T&&(0,w.jsxs)("main",{className:"cmd-tool-detail",role:"tabpanel",id:"cmd-tool-panel-"+a,"aria-labelledby":"cmd-tool-tab-"+a,children:[(0,w.jsxs)("div",{className:"cmd-tool-detail-heading",children:[(0,w.jsxs)("div",{children:[(0,w.jsxs)("h3",{children:[(0,w.jsx)(Tt,{tool:T.id,size:22}),T.name]}),(0,w.jsxs)("div",{className:"cmd-tool-badges",children:[(0,w.jsxs)("span",{"data-ready":de.installed,children:[de.installation,T.version?" \xB7 "+T.version:""]}),(0,w.jsx)("span",{"data-ready":de.chatSupported,children:de.chatSupported?"\u53EF\u5BF9\u8BDD":"\u4EC5\u914D\u7F6E"}),T.source&&!["none","unknown"].includes(T.source)&&(0,w.jsx)("span",{children:T.source})]})]}),(0,w.jsxs)("div",{className:"cmd-tool-install-actions",children:[!Y&&(0,w.jsx)("button",{type:"button",className:"cmd-tool-button",disabled:!de.canInstall||p||Mt(E),title:T.installReason||void 0,onClick:()=>void H("install"),children:T.systemExecutable||T.source==="external"?"\u5B89\u88C5\u7CFB\u7EDF\u5DE5\u5177":"\u5B89\u88C5"}),Y&&(0,w.jsxs)(w.Fragment,{children:[(0,w.jsx)("button",{type:"button",className:"cmd-tool-button",disabled:!de.canUpdate||p||Mt(E),title:T.updateReason||void 0,onClick:()=>void H("update"),children:"\u66F4\u65B0\u7CFB\u7EDF\u5DE5\u5177"}),(0,w.jsx)("button",{type:"button",className:"cmd-tool-button",disabled:!de.canReinstall||p||Mt(E),title:T.reinstallReason||void 0,onClick:()=>G({kind:"reinstall"}),children:"\u91CD\u88C5"}),(0,w.jsx)("button",{type:"button",className:"cmd-tool-button",disabled:!de.canUninstall||p||Mt(E),title:T.uninstallReason||void 0,onClick:()=>void S(async()=>{let h=await xt("uninstallPreview",{tool:a});G({kind:"uninstall",preview:h.preview})}),children:"\u5378\u8F7D\u7CFB\u7EDF\u5DE5\u5177"})]})]})]}),(0,w.jsxs)("div",{className:"cmd-tool-native-status",children:[(0,w.jsx)(te,{name:"check",size:15}),(0,w.jsxs)("div",{children:[(0,w.jsx)("strong",{children:je?.hasConfiguration?"\u5DF2\u53D1\u73B0\u672C\u673A\u914D\u7F6E\uFF0C\u4FDD\u6301\u539F\u6837":"\u7CFB\u7EDF\u5DE5\u5177\u7684\u767B\u5F55\u4E0E\u914D\u7F6E\u7531\u539F\u5DE5\u5177\u7BA1\u7406"}),(0,w.jsx)("p",{children:"\u4FDD\u5B58\u65B9\u6848\u53EA\u5199\u5165 BenchGo\uFF1B\u7CFB\u7EDF\u5DE5\u5177\u5B89\u88C5\u3001\u5347\u7EA7\u548C\u5378\u8F7D\u6309\u5DF2\u63A2\u6D4B\u6765\u6E90\u6267\u884C\u3002"})]})]}),(T.systemExecutable||T.installations?.length)&&(0,w.jsxs)("details",{className:"cmd-tool-paths",children:[(0,w.jsxs)("summary",{children:["\u5B89\u88C5\u4F4D\u7F6E",T.systemExecutable&&" \xB7 \u4F18\u5148\u4F7F\u7528\u7CFB\u7EDF\u5DE5\u5177"]}),T.systemExecutable&&(0,w.jsxs)("p",{children:[(0,w.jsx)("span",{children:"\u7CFB\u7EDF\u5DE5\u5177"}),(0,w.jsx)("code",{children:T.systemExecutable})]}),T.installations?.slice(1).map(h=>(0,w.jsxs)("p",{children:[(0,w.jsx)("span",{children:h.source}),(0,w.jsx)("code",{children:h.path})]},h.realpath))]}),!Y&&!T.canInstall&&T.installReason&&(0,w.jsx)("p",{className:"cmd-tool-hint",children:T.id==="claude-desktop"?"Claude Desktop \u9700\u8981\u4F7F\u7528\u5B98\u65B9\u5E73\u53F0\u5B89\u88C5\u5668\u624B\u52A8\u5B89\u88C5\u3002":T.installReason}),de.installed&&!T.canUninstall&&T.uninstallReason&&(0,w.jsx)("p",{className:"cmd-tool-hint",children:T.uninstallReason}),E&&(0,w.jsxs)("div",{className:"cmd-tool-job",role:"status",children:[(0,w.jsxs)("div",{children:[(0,w.jsx)("strong",{children:Fi[E.status]||E.status}),(0,w.jsx)("span",{children:E.message}),Mt(E)&&(0,w.jsx)("button",{className:"cmd-tool-button",type:"button",disabled:p,onClick:()=>void S(async()=>R((await xt("cancel",{id:E.id})).job)),children:"\u53D6\u6D88\u4EFB\u52A1"})]}),Mt(E)&&(0,w.jsx)("div",{className:"cmd-tool-progress","aria-label":"\u4EFB\u52A1\u6B63\u5728\u6267\u884C",children:(0,w.jsx)("span",{})}),E.error&&(0,w.jsx)("p",{className:"cmd-tool-error",children:E.error}),E.logs?.length>0&&(0,w.jsxs)("details",{children:[(0,w.jsx)("summary",{children:"\u6267\u884C\u65E5\u5FD7"}),(0,w.jsx)("pre",{children:E.logs.join(`
`)})]})]}),de.configSupported?(0,w.jsx)("div",{className:"cmd-tool-editor",children:(0,w.jsxs)("div",{className:"cmd-tool-config",children:[(0,w.jsxs)("div",{className:"cmd-tool-config-heading",children:[(0,w.jsx)("h4",{children:T.routeSupported===!1?"\u914D\u7F6E\u65B9\u6848":"\u65B0\u4F1A\u8BDD\u9ED8\u8BA4\u65B9\u6848"}),(0,w.jsx)("span",{children:T.routeSupported===!1?"\u4EC5\u4FDD\u5B58\u5230 BenchGo":"\u72EC\u7ACB\u4E8E\u672C\u673A\u914D\u7F6E"})]}),(0,w.jsxs)("div",{className:"cmd-tool-current-provider","aria-label":"\u5F53\u524D\u751F\u6548\u65B9\u6848",children:[(0,w.jsxs)("span",{className:"cmd-tool-route-status",children:[se&&(0,w.jsx)(te,{name:"check",size:13}),se?"\u5DF2\u751F\u6548":"\u672A\u8BBE\u7F6E"]}),se&&(0,w.jsx)(ht,{id:re?.id||se.providerId,name:re?.name||se.providerId,declared:re?.declared,size:22}),(0,w.jsxs)("div",{children:[(0,w.jsx)("strong",{children:se?re?.name||se.providerId:"\u8BF7\u9009\u62E9\u4F9B\u5E94\u5546\u548C\u6A21\u578B"}),se?.model&&(0,w.jsx)("small",{children:se.model})]})]}),i.length>0&&!Re.length&&(0,w.jsx)("p",{className:"cmd-tool-empty",children:"\u8BF7\u5728\u300C\u6A21\u578B\u300D\u8BBE\u7F6E\u4E2D\uFF0C\u4E3A\u4F9B\u5E94\u5546\u542F\u7528\u6B64\u5DE5\u5177\u3002"}),!i.length&&(0,w.jsx)("p",{className:"cmd-tool-empty",children:"\u8BF7\u5148\u5728\u300C\u6A21\u578B\u300D\u8BBE\u7F6E\u4E2D\u6DFB\u52A0\u4F9B\u5E94\u5546\u3002"}),T.routeSupported===!1&&(0,w.jsxs)("p",{className:"cmd-tool-hint",children:[T.routeReason||"\u6B64\u5DE5\u5177\u6682\u4E0D\u652F\u6301\u72EC\u7ACB\u4F9B\u5E94\u5546\u914D\u7F6E","\u3002\u53EF\u4FDD\u5B58\u65B9\u6848\uFF0C\u518D\u5355\u72EC\u9884\u89C8\u540C\u6B65\u5230\u672C\u673A\u3002"]}),Ze.length>0&&(0,w.jsxs)("div",{className:"cmd-tool-subscription",children:[(0,w.jsxs)("strong",{children:["\u8BA2\u9605\u767B\u5F55\u4EC5\u9650 ",T.name]}),(0,w.jsx)("p",{children:"\u672C\u673A\u767B\u5F55\u4FDD\u6301\u539F\u6837\u3002\u5728\u5BF9\u8BDD\u7684\u6A21\u578B\u9009\u62E9\u5668\u4E2D\u9009\u62E9\u6B64\u8BA2\u9605\u53CA\u5BF9\u5E94\u5DE5\u5177\uFF1B\u5C1A\u672A\u767B\u5F55\u65F6\u8BF7\u5148\u5728\u539F\u5DE5\u5177\u4E2D\u5B8C\u6210\u767B\u5F55\u3002"}),Ze.map(h=>(0,w.jsx)("span",{children:h.name||h.id},h.id)),e&&(0,w.jsx)("button",{type:"button",className:"cmd-tool-link",onClick:e,children:"\u8FD4\u56DE\u5BF9\u8BDD\u9009\u62E9\u6A21\u578B"})]}),(0,w.jsxs)("div",{className:"cmd-tool-fields",children:[(0,w.jsx)(co,{label:"\u4F9B\u5E94\u5546",value:y.providerId,options:Re.map(h=>({value:h.id,label:(h.name||h.id)+((ee.find(ne=>ne.id===h.id)||h).authMode==="subscription"?" \xB7 \u8BA2\u9605\u767B\u5F55":""),icon:(0,w.jsx)(ht,{id:h.id,name:h.name||h.id,declared:h.declared,size:18})})),onChange:h=>he("providerId",h),disabled:p||!Re.length,empty:"\u9009\u62E9\u4F9B\u5E94\u5546"}),(0,w.jsx)(co,{label:x?"\u6A21\u578B \xB7 \u52A0\u8F7D\u4E2D":"\u6A21\u578B",value:B?"":y.model,options:L.map(h=>({value:h.id,label:h.name||h.id})),onChange:h=>he("model",h),disabled:p||x||!y.providerId||B,empty:B?"\u5728\u5BF9\u8BDD\u6A21\u578B\u9009\u62E9\u5668\u4E2D\u4F7F\u7528":"\u9009\u62E9\u6A21\u578B"})]}),_&&(0,w.jsxs)("p",{className:"cmd-tool-error",role:"alert",children:["\u6A21\u578B\u52A0\u8F7D\u5931\u8D25\uFF1A",_," ",(0,w.jsx)("button",{type:"button",className:"cmd-tool-link",onClick:()=>v(h=>h+1),children:"\u91CD\u8BD5"})]}),(0,w.jsxs)("details",{className:"cmd-tool-advanced cmd-tool-quick-settings-advanced",children:[(0,w.jsxs)("summary",{children:["\u5FEB\u6377\u9009\u9879 ",(0,w.jsx)("small",{children:"\u6309\u9700\u8C03\u6574 Harness \u884C\u4E3A"})]}),(0,w.jsx)(Ud,{tool:a,values:y.quickSettings,disabled:p||B,isolated:["claude","codex"].includes(a),onChange:(h,ne)=>he("quickSettings",Ri(y.quickSettings,h,ne))},a)]}),(0,w.jsxs)("div",{className:"cmd-tool-footer",children:[(0,w.jsx)("span",{children:B?"\u672C\u673A\u8BA2\u9605\u767B\u5F55\u4FDD\u6301\u539F\u6837\uFF0C\u8BF7\u4ECE\u5BF9\u8BDD\u6A21\u578B\u9009\u62E9\u5668\u4F7F\u7528\u3002":le?"\u9AD8\u7EA7 JSON \u4EC5\u4FDD\u5B58\u4F9B\u672C\u673A\u540C\u6B65\uFF0C\u5F53\u524D\u65B0\u4F1A\u8BDD\u9ED8\u8BA4\u4E0D\u53D8\u3002":"\u6CBF\u7528\u300C\u6A21\u578B\u300D\u4E2D\u7684\u914D\u7F6E\uFF0C\u672C\u673A\u8BB0\u5F55\u4E0D\u53D7\u5F71\u54CD\u3002"}),(0,w.jsx)("button",{type:"button",className:"cmd-tool-button cmd-tool-primary",disabled:p||B||!y.providerId||!y.model.trim(),onClick:()=>void ae(),children:p?"\u4FDD\u5B58\u4E2D\u2026":le?"\u4FDD\u5B58\u914D\u7F6E\u65B9\u6848":"\u4FDD\u5B58\u9ED8\u8BA4\u65B9\u6848"})]}),(0,w.jsxs)("details",{className:"cmd-tool-advanced",children:[(0,w.jsx)("summary",{children:"\u9AD8\u7EA7\u9009\u9879"}),(0,w.jsxs)("label",{className:"cmd-tool-field",children:[(0,w.jsx)("span",{children:"\u81EA\u5B9A\u4E49\u6A21\u578B ID"}),(0,w.jsx)("input",{value:y.model,disabled:p||B,placeholder:"\u624B\u52A8\u586B\u5199\u6A21\u578B ID",onChange:h=>he("model",h.target.value)})]}),V.protocols?.length>0&&(0,w.jsx)(co,{label:"\u534F\u8BAE",value:y.protocol,options:[{value:"",label:"\u81EA\u52A8\u9009\u62E9"},...V.protocols.map(h=>({value:h,label:h}))],disabled:p||B,onChange:h=>he("protocol",h)}),(0,w.jsxs)("details",{className:"cmd-tool-advanced",children:[(0,w.jsx)("summary",{children:"\u914D\u7F6E JSON"}),(0,w.jsx)("p",{className:"cmd-tool-hint",children:"\u586B\u5199 config / settings / auth / profile / meta \u8986\u76D6\u9879\uFF0C\u4EC5\u7528\u4E8E\u663E\u5F0F\u540C\u6B65\u672C\u673A\uFF1B\u9694\u79BB\u4F1A\u8BDD\u4F7F\u7528\u4E0A\u65B9\u5DF2\u9A8C\u8BC1\u7684\u5FEB\u6377\u914D\u7F6E\u3002\u5BC6\u94A5\u4E0E\u63A5\u53E3\u5730\u5740\u5728\u300C\u6A21\u578B\u300D\u8BBE\u7F6E\u4E2D\u7EF4\u62A4\u3002"}),(0,w.jsx)("textarea",{spellCheck:!1,"aria-label":T.name+" \u9AD8\u7EA7\u914D\u7F6E JSON",value:y.overrides,disabled:p||B,onChange:h=>he("overrides",h.target.value)})]}),(0,w.jsxs)("div",{className:"cmd-tool-native-sync",children:[(0,w.jsx)("button",{type:"button",className:"cmd-tool-link",disabled:p||B||!$,onClick:()=>void S(async()=>{let h=await xt("preview",{tool:a});J(h.preview)}),children:"\u9884\u89C8\u540C\u6B65\u5DF2\u4FDD\u5B58\u65B9\u6848\u5230\u672C\u673A\u2026"}),(0,w.jsx)("small",{children:"\u6B64\u64CD\u4F5C\u4F1A\u6539\u5199\u672C\u673A\u4F9B\u5E94\u5546\u914D\u7F6E\uFF0C\u53EF\u80FD\u5207\u6362\u73B0\u6709\u767B\u5F55\u4F7F\u7528\u7684\u63A5\u53E3\u3002\u9700\u5355\u72EC\u786E\u8BA4\u5E76\u81EA\u52A8\u5907\u4EFD\u3002"})]}),je?.files?.length>0&&(0,w.jsxs)("details",{className:"cmd-tool-paths",children:[(0,w.jsxs)("summary",{children:["\u672C\u673A\u914D\u7F6E\u6587\u4EF6",je.files.some(h=>h.externalChanged)?" \xB7 \u68C0\u6D4B\u5230\u5916\u90E8\u4FEE\u6539":""]}),je.lastSyncAt&&(0,w.jsxs)("p",{children:[(0,w.jsx)("span",{children:"\u6700\u8FD1\u540C\u6B65"}),(0,w.jsx)("time",{dateTime:je.lastSyncAt,children:new Date(je.lastSyncAt).toLocaleString("zh-CN")})]}),je.files.map(h=>(0,w.jsxs)("p",{children:[(0,w.jsx)("span",{children:h.unavailable?"\u65E0\u6CD5\u68C0\u6D4B":h.externalChanged?"\u540C\u6B65\u540E\u5DF2\u4FEE\u6539":h.exists?"\u5DF2\u5B58\u5728":"\u672A\u521B\u5EFA"}),(0,w.jsx)("code",{children:h.path})]},h.path))]})]}),be.length>0&&(0,w.jsxs)("details",{className:"cmd-tool-backups",children:[(0,w.jsxs)("summary",{children:["\u914D\u7F6E\u5907\u4EFD ",(0,w.jsx)("small",{children:be.length})]}),be.map(h=>(0,w.jsxs)("div",{children:[(0,w.jsx)("span",{children:h.createdAt?new Date(h.createdAt).toLocaleString("zh-CN"):h.id||h.backupId}),(0,w.jsx)("button",{type:"button",className:"cmd-tool-button",disabled:p,onClick:()=>G({kind:"restore",backupId:h.id||h.backupId}),children:"\u6062\u590D"})]},h.id||h.backupId))]})]})}):(0,w.jsx)("p",{className:"cmd-tool-empty",children:"\u6B64\u5DE5\u5177\u6682\u4E0D\u652F\u6301\u914D\u7F6E\u3002"})]})]})}):(0,w.jsx)("button",{type:"button",className:"cmd-tool-button",onClick:()=>g(h=>h+1),children:"\u91CD\u65B0\u52A0\u8F7D"}),(0,w.jsx)(_t.Modal,{open:!!j,onClose:()=>{p||J(null)},title:"\u786E\u8BA4\u540C\u6B65\u5230\u672C\u673A CLI",closeLabel:"\u5173\u95ED",className:"cmd-tool-modal",description:"\u6B64\u64CD\u4F5C\u4F1A\u4FEE\u6539\u4E0B\u9762\u5217\u51FA\u7684\u672C\u673A\u5DE5\u5177\u914D\u7F6E\u5E76\u521B\u5EFA\u5907\u4EFD\uFF0C\u4E0D\u4FEE\u6539\u5386\u53F2\u8BB0\u5F55\u3002\u53EA\u8BBE\u7F6E\u65B0\u4F1A\u8BDD\u9ED8\u8BA4\u65E0\u9700\u6267\u884C\u6B64\u64CD\u4F5C\u3002",footer:(0,w.jsxs)(w.Fragment,{children:[(0,w.jsx)("button",{type:"button",className:"cmd-tool-button",disabled:p,onClick:()=>J(null),children:"\u8FD4\u56DE\u7F16\u8F91"}),(0,w.jsx)("button",{type:"button",className:"cmd-tool-button cmd-tool-primary",disabled:p||!j?.files?.length,onClick:()=>void S(async()=>{await xt("apply",{tool:a,confirmNativeWrite:!0,revision:j.revision,checksums:Qi(j)}),J(null),l("\u914D\u7F6E\u5DF2\u5907\u4EFD\u5E76\u5E94\u7528"),g(h=>h+1)}),children:p?"\u5E94\u7528\u4E2D\u2026":"\u5907\u4EFD\u5E76\u5E94\u7528"})]}),children:(0,w.jsxs)("div",{className:"cmd-tool-preview",children:[j?.files?.map(h=>(0,w.jsxs)("div",{children:[(0,w.jsx)("code",{children:h.path}),(0,w.jsx)("span",{children:h.exists?h.changed?"\u66F4\u65B0":"\u65E0\u53D8\u5316":"\u65B0\u5EFA"})]},h.path)),!j?.files?.length&&(0,w.jsx)("p",{children:"\u6CA1\u6709\u9700\u8981\u5199\u5165\u7684\u914D\u7F6E\u6587\u4EF6\u3002"}),j?.warnings?.map((h,ne)=>(0,w.jsx)("p",{children:h},ne)),c&&(0,w.jsx)("p",{className:"cmd-tool-error",role:"alert",children:c})]})}),(0,w.jsxs)(_t.Modal,{className:"cmd-tool-modal",open:!!P,onClose:()=>{p||G(null)},title:P?.kind==="restore"?"\u6062\u590D\u8FD9\u4E2A\u5907\u4EFD\uFF1F":(P?.kind==="reinstall"?"\u91CD\u88C5 ":"\u5378\u8F7D ")+(T?.name||"")+"\uFF1F",closeLabel:"\u5173\u95ED",description:P?.kind==="restore"?"\u5C06\u5907\u4EFD\u5199\u56DE\u5DE5\u5177\u914D\u7F6E\u6587\u4EF6\u3002\u8BF7\u5148\u7ED3\u675F\u6B63\u5728\u8FD0\u884C\u7684\u5DE5\u5177\u3002":P?.kind==="reinstall"?"\u6309\u5DF2\u63A2\u6D4B\u7684\u5B89\u88C5\u6765\u6E90\u66F4\u65B0\u7CFB\u7EDF\u5DE5\u5177\uFF0C\u4FDD\u7559\u672C\u673A\u767B\u5F55\u3001\u914D\u7F6E\u4E0E\u5386\u53F2\u8BB0\u5F55\u3002":"\u4EC5\u79FB\u9664\u5DF2\u786E\u8BA4\u5F52\u5C5E\u7684\u7CFB\u7EDF\u5DE5\u5177\uFF0C\u914D\u7F6E\u548C\u5386\u53F2\u8BB0\u5F55\u4FDD\u7559\u3002",footer:(0,w.jsxs)(w.Fragment,{children:[(0,w.jsx)("button",{type:"button",className:"cmd-tool-button",disabled:p,onClick:()=>G(null),children:"\u53D6\u6D88"}),(0,w.jsx)("button",{type:"button",className:"cmd-tool-button",disabled:p||P?.kind==="uninstall"&&!P?.preview?.available,onClick:()=>P.kind==="uninstall"||P.kind==="reinstall"?void H(P.kind):void S(async()=>{await xt("restore",{backupId:P.backupId,confirmNativeWrite:!0}),G(null),l("\u914D\u7F6E\u5907\u4EFD\u5DF2\u6062\u590D"),g(h=>h+1)}),children:p?"\u5904\u7406\u4E2D\u2026":"\u786E\u8BA4"})]}),children:[P?.kind==="uninstall"&&P.preview&&(0,w.jsxs)("div",{className:"cmd-tool-preview",children:[(0,w.jsxs)("p",{children:[(0,w.jsx)("strong",{children:"\u5B89\u88C5\u4F4D\u7F6E\uFF1A"}),(0,w.jsx)("code",{children:P.preview.path})]}),(0,w.jsxs)("p",{children:[(0,w.jsx)("strong",{children:"\u6765\u6E90\uFF1A"}),P.preview.source,P.preview.version?" \xB7 "+P.preview.version:""]}),(0,w.jsx)("p",{children:P.preview.description})]}),c&&(0,w.jsx)("p",{className:"cmd-tool-error",role:"alert",children:c})]})]})}function Zo(e,t,n){return{title:e.title||"",tool:t?.provider||e.provider,model:t?.model||e.model||null,harnessSessionId:e.native?t?.ownerSessionId||e.ownerSessionId||null:e.id,commanderSessionId:t?.id||(e.native?e.id:e.nativeId)||null,nativeSessionId:t?.nativeId||(e.native?e.nativeId:null)||null,parentSessionId:t?.parentId||e.parentId||null,projectId:n?.id||e.projectId||null,projectPath:n?.path||t?.cwd||e.cwd||null}}async function Xi(e){await navigator.clipboard.writeText(JSON.stringify(e,null,2))}function qi({refresh:e,onError:t,isActive:n,document:i=globalThis.document,schedule:o=setTimeout,unschedule:a=clearTimeout}){let r=new AbortController,s=!1,d=!1,c=0,f,u=async()=>{if(a(f),!(s||d||i?.hidden)){d=!0;try{await e(r.signal),c=0}catch(p){c++,s||t(p)}finally{if(d=!1,!s&&!i?.hidden){let p=c?Math.min(3e4,1e3*2**Math.min(c-1,4)):n()?2e3:1e4;f=o(u,p)}}}},l=()=>{i?.hidden?a(f):u()};return i?.addEventListener("visibilitychange",l),u(),()=>{s=!0,a(f),r.abort(),i?.removeEventListener("visibilitychange",l)}}var Je=require("react"),on=require("@deepseek-ai/dsh-client-ui-primitives");var $i=`.cmd-update-launcher{display:flex;align-items:center;gap:9px;width:100%;min-height:36px;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#242424);font:inherit;font-size:12px;text-align:left;cursor:pointer}.cmd-update-launcher:hover{background:var(--dsw-alias-interactive-bg-hover,#8881)}.cmd-update-icon{position:relative;display:flex;flex:none}.cmd-update-icon>i{position:absolute;top:-2px;right:-3px;width:6px;height:6px;border-radius:50%;background:#e34d4d;box-shadow:0 0 0 2px var(--dsw-alias-bg-base,#fff)}.cmd-update-launcher>small{margin-left:auto;color:var(--dsw-alias-label-secondary,#777);font-size:10px;white-space:nowrap}.cmd-update-launcher>small[data-ready=true]{font-weight:550}.cmd-update-launcher-rail{flex:none;justify-content:center;width:36px;height:36px;padding:0;color:var(--dsw-alias-label-secondary,#777)}.cmd-update-dialog{width:min(440px,calc(100vw - 32px))!important;max-width:calc(100vw - 32px);padding:0!important;overflow:hidden;color:var(--dsw-alias-label-primary,#242424);font-size:12px}.cmd-update-dialog *{box-sizing:border-box}.cmd-update-dialog button,.cmd-update-dialog input,.cmd-update-dialog select{font:inherit}.cmd-update-dialog button{cursor:pointer}.cmd-update-dialog button:disabled,.cmd-update-dialog select:disabled{cursor:default;opacity:.45}.cmd-update-dialog button:focus-visible,.cmd-update-dialog a:focus-visible,.cmd-update-dialog select:focus-visible,.cmd-update-dialog input:focus-visible,.cmd-update-dialog summary:focus-visible,.cmd-update-launcher:focus-visible{outline:2px solid currentColor;outline-offset:3px}.cmd-update-header{display:flex;align-items:flex-start;justify-content:space-between;padding:20px 20px 0}.cmd-update-header h2{margin:0;font-size:16px;font-weight:600}.cmd-update-header p{margin:5px 0 0;color:var(--dsw-alias-label-secondary,#818181);font-size:11px;overflow-wrap:anywhere}.cmd-update-icon-button{display:grid;place-items:center;border:0;width:28px;height:28px;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#818181)}.cmd-update-icon-button:hover{background:var(--dsw-alias-interactive-bg-hover,#8881)}.cmd-update-content{padding:18px 20px 16px;overflow:auto;max-height:calc(85dvh - 118px)}.cmd-update-plugin{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:12px;padding:16px}.cmd-update-card-heading{display:flex;align-items:center;gap:10px}.cmd-update-plugin-mark{display:grid;place-items:center;flex:none;width:38px;height:38px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover,#8881)}.cmd-update-card-heading h3{margin:0;font-size:14px;font-weight:600}.cmd-update-card-heading h3 small{margin-left:3px;color:var(--dsw-alias-label-secondary,#818181);font-size:10px;font-weight:400}.cmd-update-card-heading p{margin:5px 0 0;color:var(--dsw-alias-label-secondary,#818181);font-size:11px;font-variant-numeric:tabular-nums}.cmd-update-card-heading p strong{color:var(--dsw-alias-label-primary,#242424);font-weight:500}.cmd-update-chip{margin-left:auto;padding:4px 6px;flex:none;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover,#8881);color:var(--dsw-alias-label-secondary,#818181);font-size:10px}.cmd-update-description{margin:14px 0;color:var(--dsw-alias-label-secondary,#818181);font-size:11px;line-height:1.6}.cmd-update-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px}.cmd-update-actions>span{color:var(--dsw-alias-label-secondary,#818181);font-size:11px;line-height:1.5}.cmd-update-button{display:inline-flex;align-items:center;justify-content:center;flex:none;min-height:32px;padding:6px 11px;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:7px;background:transparent;color:inherit;white-space:nowrap}.cmd-update-button:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover,#8881)}.cmd-update-button.cmd-update-primary{border-color:transparent;background:var(--dsw-alias-label-primary,#242424);color:var(--dsw-alias-bg-base,#fff)}.cmd-update-button.cmd-update-primary:not(:disabled):hover{opacity:.85}.cmd-update-notice{display:flex;gap:9px;align-items:flex-start;line-height:1.6;margin-top:14px;padding:10px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,#8881)}.cmd-update-notice>.cmd-ui-icon{margin-top:2px;flex:none}.cmd-update-notice strong{font-size:12px;font-weight:550}.cmd-update-notice p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#818181);font-size:11px}.cmd-update-warning{margin:10px 0 0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#818181)}.cmd-update-notes{margin-top:14px;padding-top:12px;border-top:1px solid color-mix(in srgb,currentColor 9%,transparent)}.cmd-update-notes summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#818181);font-size:11px}.cmd-update-notes p{margin:9px 0 0;max-height:160px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.7}.cmd-update-app{display:flex;align-items:center;gap:9px;margin-top:16px}.cmd-update-app>.cmd-ui-icon{flex:none;color:var(--dsw-alias-label-secondary,#818181)}.cmd-update-app>div{min-width:0;flex:1}.cmd-update-app h3{margin:0;font-size:12px;font-weight:500}.cmd-update-app h3 span{font-size:10px;color:var(--dsw-alias-label-secondary,#818181)}.cmd-update-app p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#818181);font-size:10px;line-height:1.5}.cmd-update-text-button{display:inline-flex;align-items:center;gap:4px;flex:none;border:0;background:transparent;padding:4px 0;color:inherit;font-size:11px;text-decoration:none}.cmd-update-text-button:not(:disabled):hover{text-decoration:underline}.cmd-update-app-version{margin:12px 0 0;color:var(--dsw-alias-label-secondary,#818181);font-size:10px}.cmd-update-error{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-top:14px;padding:10px;border-radius:8px;background:color-mix(in srgb,#df5c51 7%,transparent);color:var(--dsw-alias-status-error,#b33d34);font-size:11px;line-height:1.6;overflow-wrap:anywhere}.cmd-update-error>span{min-width:0}.cmd-update-source{margin-top:18px;padding-top:16px;border-top:1px solid color-mix(in srgb,currentColor 9%,transparent)}.cmd-update-source-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.cmd-update-source-row label{display:flex;gap:7px;align-items:center}.cmd-update-source select{max-width:65%;min-height:30px;padding:4px 23px 4px 8px;border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font-size:11px}.cmd-update-source>p{margin:8px 0 0;color:var(--dsw-alias-label-secondary,#818181);font-size:10px;line-height:1.6}.cmd-update-custom{display:flex;gap:7px;margin-top:10px}.cmd-update-custom input{width:0;min-width:0;flex:1;padding:7px 9px;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:7px;background:transparent;color:inherit;font-size:11px}.cmd-update-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 20px;border-top:1px solid color-mix(in srgb,currentColor 9%,transparent);color:var(--dsw-alias-label-secondary,#818181);font-size:10px}.cmd-update-subtle{font-size:10px;color:var(--dsw-alias-label-secondary,#818181)}@media(max-width:380px){.cmd-update-header{padding:16px 16px 0}.cmd-update-content{padding:16px}.cmd-update-plugin{padding:13px}.cmd-update-chip{display:none}.cmd-update-app{flex-wrap:wrap}.cmd-update-app>a{margin-left:26px}.cmd-update-footer{padding:10px 16px}}@media(prefers-reduced-motion:reduce){.cmd-update-dialog *,.cmd-update-launcher{animation:none!important;transition:none!important}}

.cmd-update-app-actions{display:flex;flex:none;flex-direction:column;align-items:flex-end;gap:3px}.cmd-update-app-actions .cmd-update-text-button{font-size:10px}.cmd-update-app-actions button:disabled{opacity:.45}

.cmd-update-actions{flex-wrap:wrap}.cmd-update-action-buttons{display:inline-flex;align-items:center;justify-content:flex-end;gap:10px;flex:none;margin-left:auto}.cmd-update-actions>.cmd-update-action-buttons{font-size:12px}.cmd-update-action-buttons button:disabled{cursor:not-allowed}.cmd-update-launcher,.cmd-update-dialog{touch-action:manipulation}.cmd-update-launcher>.cmd-update-icon{pointer-events:none}
`;var zp=require("react");var er=`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="BenchGo">
  <g transform="translate(122,274.4) scale(1.3)">

  <!-- Corner rule (master construction, geometry.json): the cut is a 45-degree
       diagonal from (410,380) to (600,190); the corner piece keeps the body's
       R95 rounded bottom-right corner - never a sharp point. Glyph must stay
       fully inside the piece: clear of the diagonal (line x+y=790) and of the
       R95 arc (center 505,285). Current glyph: mini window at (543,324),
       scale 0.9, max radius ~32. If the corner changes, recompute from the
       master geometry, not from absolute pixels. -->
  <defs>
    <clipPath id="bodyClip">
      <path d="M95,0 H505 A95,95 0 0 1 600,95 V190 L410,380 H95 A95,95 0 0 1 0,285 V95 A95,95 0 0 1 95,0 Z"/>
    </clipPath>
    <pattern id="winprint" width="150" height="118" patternUnits="userSpaceOnUse">
      <g fill="none" stroke="#D9CCAF" stroke-width="2.5" opacity="0.6">
        <rect x="12" y="14" width="32" height="22" rx="5"/>
        <rect x="84" y="66" width="32" height="22" rx="5"/>
      </g>
      <g fill="#D9CCAF" opacity="0.6">
        <circle cx="21" cy="22" r="2.8"/><circle cx="31" cy="22" r="2.8"/>
        <circle cx="93" cy="74" r="2.8"/><circle cx="103" cy="74" r="2.8"/>
      </g>
    </pattern>
  </defs>

  <!-- body -->
  <path d="M95,0 H505 A95,95 0 0 1 600,95 V190 L410,380 H95 A95,95 0 0 1 0,285 V95 A95,95 0 0 1 95,0 Z" fill="#F1E8DB"/>
  <rect x="0" y="0" width="600" height="380" fill="url(#winprint)" clip-path="url(#bodyClip)"/>

  <!-- terminal motif >_ -->
  <g stroke="#EE5A33" stroke-width="17" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <polyline points="472,50 512,79 472,108"/>
  </g>
  <rect x="528" y="93" width="42" height="17" rx="8.5" fill="#EE5A33"/>

  <!-- eyes: bean + < (right eye at 88% scale, user-approved 2026-10-26, baked coords) -->
  <rect x="123" y="125" width="90" height="130" rx="45" fill="#222321"/>
  <polyline points="342.6,150.1 293.4,195 342.6,239.9" stroke="#222321" stroke-width="30" stroke-linecap="round" stroke-linejoin="round" fill="none"/>

  <!-- orange cut corner -->
  <path d="M410,380 H505 A95,95 0 0 0 600,285 V190 Z" fill="#EE5A33"/>
  <!-- mini window glyph: centered on corner incenter, max radius ~36 < inradius 51 -->
  <g transform="translate(543 324) scale(0.9)">
    <rect x="-26" y="-18" width="52" height="36" rx="9" fill="none" stroke="#F7F1E5" stroke-width="8"/>
    <circle cx="-9" cy="0" r="4" fill="#F7F1E5"/>
    <circle cx="9" cy="0" r="4" fill="#F7F1E5"/>
  </g>

  </g>
</svg>
`;var tr=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 380" role="img" aria-label="BenchGo">
  <!-- Corner rule (master construction, geometry.json): the cut is a 45-degree
       diagonal from (410,380) to (600,190); the corner piece keeps the body's
       R95 rounded bottom-right corner - never a sharp point. Glyph must stay
       fully inside the piece: clear of the diagonal (line x+y=790) and of the
       R95 arc (center 505,285). Current glyph: mini window at (543,324),
       scale 0.9, max radius ~32. If the corner changes, recompute from the
       master geometry, not from absolute pixels. -->
  <defs>
    <clipPath id="bodyClip">
      <path d="M95,0 H505 A95,95 0 0 1 600,95 V190 L410,380 H95 A95,95 0 0 1 0,285 V95 A95,95 0 0 1 95,0 Z"/>
    </clipPath>
    <pattern id="winprint" width="150" height="118" patternUnits="userSpaceOnUse">
      <g fill="none" stroke="#D9CCAF" stroke-width="2.5" opacity="0.6">
        <rect x="12" y="14" width="32" height="22" rx="5"/>
        <rect x="84" y="66" width="32" height="22" rx="5"/>
      </g>
      <g fill="#D9CCAF" opacity="0.6">
        <circle cx="21" cy="22" r="2.8"/><circle cx="31" cy="22" r="2.8"/>
        <circle cx="93" cy="74" r="2.8"/><circle cx="103" cy="74" r="2.8"/>
      </g>
    </pattern>
  </defs>

  <!-- body -->
  <path d="M95,0 H505 A95,95 0 0 1 600,95 V190 L410,380 H95 A95,95 0 0 1 0,285 V95 A95,95 0 0 1 95,0 Z" fill="#F1E8DB"/>
  <rect x="0" y="0" width="600" height="380" fill="url(#winprint)" clip-path="url(#bodyClip)"/>

  <!-- terminal motif >_ -->
  <g stroke="#EE5A33" stroke-width="17" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <polyline points="472,50 512,79 472,108"/>
  </g>
  <rect x="528" y="93" width="42" height="17" rx="8.5" fill="#EE5A33"/>

  <!-- eyes: bean + < (right eye at 88% scale, user-approved 2026-10-26, baked coords) -->
  <rect x="123" y="125" width="90" height="130" rx="45" fill="#222321"/>
  <polyline points="342.6,150.1 293.4,195 342.6,239.9" stroke="#222321" stroke-width="30" stroke-linecap="round" stroke-linejoin="round" fill="none"/>

  <!-- orange cut corner -->
  <path d="M410,380 H505 A95,95 0 0 0 600,285 V190 Z" fill="#EE5A33"/>
  <!-- mini window glyph: centered on corner incenter, max radius ~36 < inradius 51 -->
  <g transform="translate(543 324) scale(0.9)">
    <rect x="-26" y="-18" width="52" height="36" rx="9" fill="none" stroke="#F7F1E5" stroke-width="8"/>
    <circle cx="-9" cy="0" r="4" fill="#F7F1E5"/>
    <circle cx="9" cy="0" r="4" fill="#F7F1E5"/>
  </g>
</svg>
`;var jd=require("react/jsx-runtime"),nr=`data:image/svg+xml,${encodeURIComponent(er)}`,Ad=`data:image/svg+xml,${encodeURIComponent(tr)}`;function or(e){e.effect(()=>{let t=[...document.querySelectorAll('link[rel~="icon"]')],n=t.map(o=>[o,o.getAttribute("href"),o.getAttribute("type")]),i=!t.length;if(i){let o=document.createElement("link");o.rel="icon",document.head.append(o),t.push(o)}for(let o of t)o.href=Ad,o.type="image/svg+xml";return()=>{i&&t[0].remove();for(let[o,a,r]of n)a===null?o.removeAttribute("href"):o.setAttribute("href",a),r===null?o.removeAttribute("type"):o.setAttribute("type",r)}})}var K=require("react/jsx-runtime"),uo=new Set(["checking","downloading"]),Cd={mirror:"\u56FD\u5185\u52A0\u901F",github:"GitHub \u76F4\u8FDE",custom:"\u81EA\u5B9A\u4E49\u955C\u50CF"},ar=e=>{try{let t=new URL(e);return t.protocol==="https:"&&!t.username&&!t.password?t.href:null}catch{return null}};function ir(e){let t=document.createElement("style");t.textContent=$i,document.head.append(t),e.effect(()=>()=>t.remove())}function rr({host:e,wide:t=!0}){let[n,i]=(0,Je.useState)(!1),[o,a]=(0,Je.useState)(null),[r,s]=(0,Je.useState)(""),[d,c]=(0,Je.useState)(""),[f,u]=(0,Je.useState)("mirror"),[l,p]=(0,Je.useState)(""),M=(0,Je.useRef)(!1),D=(0,Je.useRef)(null),g=(0,Je.useRef)(new Set),y=(0,Je.useRef)({action:"check"}),I=(0,Je.useId)(),L=(0,Je.useCallback)(async(ee,X={})=>{if(D.current){if(ee==="status"||D.current.action!=="status")return null;D.current.abort()}let B=new AbortController;B.action=ee,g.current.add(B),D.current=B,M.current&&ee!=="status"&&(c(ee),s(""));try{let S=await fetch(new URL("api/commander/updates",document.baseURI),{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({action:ee,...X}),signal:AbortSignal.any([B.signal,AbortSignal.timeout(12e4)])}),H=await Xe(S,new URL("api/commander/updates",document.baseURI));return M.current&&!B.signal.aborted&&(a(H),H.config&&(u(H.config.source),p(H.config.mirrorUrl||""))),B.signal.aborted?null:H}catch(S){return M.current&&!B.signal.aborted&&(y.current={action:ee,args:X},s(S.name==="TimeoutError"?"\u66F4\u65B0\u8BF7\u6C42\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5\u3002":S.message)),null}finally{g.current.delete(B),D.current===B&&(D.current=null,M.current&&ee!=="status"&&c(""))}},[]);(0,Je.useEffect)(()=>{M.current=!0,(async()=>{let X=await L("status");M.current&&X&&!X.restartRequired&&!uo.has(X.phase)&&await L("check")})();let ee=()=>i(!0);return document.addEventListener("commander:updates",ee),()=>{M.current=!1;for(let X of g.current)X.abort();D.current=null,document.removeEventListener("commander:updates",ee)}},[L]),(0,Je.useEffect)(()=>{n&&L("status")},[n,L]),(0,Je.useEffect)(()=>{let ee=n&&o?.release?.plugin?.compatible&&o.release.plugin.available===!0&&o?.managed&&!o?.canInstall&&!o?.restartRequired;if(!uo.has(o?.phase)&&!ee||r)return;let X=setInterval(()=>void L("status"),2e3);return()=>clearInterval(X)},[o?.phase,o?.canInstall,o?.managed,o?.release?.plugin?.version,o?.release?.plugin?.available,o?.release?.plugin?.compatible,o?.current?.plugin,o?.restartRequired,n,r,L]);let b=!!d||uo.has(o?.phase),x=!!o?.restartRequired||o?.phase==="ready",F=o?.phase==="unpublished",_=o?.installation==="server",Z=_&&o?.managed===!1,Q=o?.release?.plugin,v=!!o?.current?.plugin&&Q?.available===!0&&!x,E=v&&!Z,O=E?o?.managed===!1?"\u5F53\u524D\u5B89\u88C5\u65B9\u5F0F\u9700\u5148\u5347\u7EA7\u5E94\u7528\u3002":o?.busy?"\u6709\u4EFB\u52A1\u6B63\u5728\u8FD0\u884C\uFF0C\u7ED3\u675F\u540E\u5373\u53EF\u66F4\u65B0\u3002":Q.compatible?!o?.canInstall&&!b?o?.installBlockReason||"\u66F4\u65B0\u72B6\u6001\u5C1A\u672A\u5C31\u7EEA\uFF0C\u8BF7\u91CD\u65B0\u68C0\u67E5\u3002":"":Q.reason||"\u8BF7\u5148\u5347\u7EA7\u5E94\u7528\u3002":"",P=o?.release?.app,G=ar(P?.url),j=!_&&!!o?.current?.app&&P?.available===!0,J=globalThis.dshDesktop?.updates,oe=typeof J?.open=="function",R=v||j,T=x?"\u5F85\u91CD\u542F":b?o?.phase==="downloading"||d==="install"?"\u4E0B\u8F7D\u4E2D":"\u68C0\u67E5\u4E2D":v?"\u6709\u66F4\u65B0":j?"\u5E94\u7528\u6709\u66F4\u65B0":"",V=b?o?.phase==="downloading"||d==="install"?"\u6B63\u5728\u4E0B\u8F7D\u5E76\u6821\u9A8C\u2026":"\u6B63\u5728\u68C0\u67E5\u2026":o?F?o.notice||"\u66F4\u65B0\u901A\u9053\u5C1A\u672A\u5C31\u7EEA":o.phase==="error"?"\u6682\u65F6\u65E0\u6CD5\u68C0\u67E5\u66F4\u65B0":o.current?.plugin?Q?v?"\u53D1\u73B0\u65B0\u7248\u672C":"\u63D2\u4EF6\u5DF2\u662F\u6700\u65B0\u7248\u672C":"\u5C1A\u672A\u68C0\u67E5\u63D2\u4EF6\u66F4\u65B0":"\u6682\u65E0\u6CD5\u8BC6\u522B\u63D2\u4EF6\u7248\u672C":"\u5C1A\u672A\u8BFB\u53D6\u66F4\u65B0\u4FE1\u606F",de=async(ee,X=l)=>{if(ee==="custom"&&!ar(X)){s("\u8BF7\u8F93\u5165\u6709\u6548\u7684 HTTPS \u955C\u50CF\u5730\u5740\u3002");return}let B=await L("configure",{source:ee,mirrorUrl:X.trim()});B&&!B.restartRequired&&await L("check")},$=async()=>{if(!oe||D.current&&D.current.action!=="status"||uo.has(o?.phase))return;D.current?.abort();let ee={};D.current=ee,c("app"),s("");try{await J.open()}catch(X){M.current&&(y.current={action:"app"},s(X?.message||"\u65E0\u6CD5\u6253\u5F00\u5E94\u7528\u66F4\u65B0\uFF0C\u8BF7\u91CD\u8BD5\u3002"))}finally{D.current===ee&&(D.current=null,M.current&&c(""))}},se=()=>{let{action:ee,args:X}=r?y.current:{action:["install","rollback"].includes(o?.lastAction)?o.lastAction:"check"};return ee==="status"&&s(""),ee==="app"?$():L(ee,X)},re=()=>i(!1);return(0,K.jsxs)(K.Fragment,{children:[(0,K.jsx)(on.Tooltip,{label:T?`\u66F4\u65B0 \xB7 ${T}`:"\u66F4\u65B0",side:"top",gap:10,delayMs:450,portal:!0,children:(0,K.jsxs)("button",{type:"button",className:`cmd-update-launcher ${t?"":"cmd-update-launcher-rail"}`,"aria-label":T?`\u66F4\u65B0\uFF0C${T}`:"\u66F4\u65B0","aria-haspopup":"dialog","aria-expanded":n,onClick:()=>i(!0),children:[(0,K.jsxs)("span",{className:"cmd-update-icon",children:[(0,K.jsx)(te,{name:"refresh",size:16}),(R||x)&&(0,K.jsx)("i",{"aria-hidden":"true"})]}),t&&(0,K.jsxs)(K.Fragment,{children:[(0,K.jsx)("span",{children:"\u66F4\u65B0"}),T&&(0,K.jsx)("small",{"data-ready":x,children:T})]})]})}),(0,K.jsxs)(on.Modal,{open:n,headless:!0,onClose:re,title:"\u66F4\u65B0",className:"cmd-update-dialog",children:[(0,K.jsxs)("header",{className:"cmd-update-header",children:[(0,K.jsxs)("div",{children:[(0,K.jsx)("h2",{children:"\u66F4\u65B0"}),(0,K.jsxs)("p",{children:["\u5F53\u524D\u8FDE\u63A5\u4E3B\u673A \xB7 ",globalThis.location?.hostname||"\u672C\u673A"]})]}),(0,K.jsx)("button",{type:"button",className:"cmd-update-icon-button","aria-label":"\u5173\u95ED\u66F4\u65B0",onClick:re,children:(0,K.jsx)(te,{name:"close",size:16})})]}),(0,K.jsxs)("div",{className:"cmd-update-content",children:[(0,K.jsxs)("section",{className:"cmd-update-plugin","aria-labelledby":`${I}-plugin`,children:[(0,K.jsxs)("div",{className:"cmd-update-card-heading",children:[(0,K.jsx)("span",{className:"cmd-update-plugin-mark",children:(0,K.jsx)("img",{src:nr,width:"38",height:"38",alt:"BenchGo"})}),(0,K.jsxs)("div",{children:[(0,K.jsxs)("h3",{id:`${I}-plugin`,children:["BenchGo ",(0,K.jsx)("small",{children:"\u63D2\u4EF6"})]}),(0,K.jsxs)("p",{children:[o?.current?.plugin?`v${o.current.plugin}`:"\u8BFB\u53D6\u7248\u672C\u4E2D\u2026",v&&!x&&(0,K.jsxs)(K.Fragment,{children:[(0,K.jsx)("span",{"aria-hidden":"true",children:" \u2192 "}),(0,K.jsxs)("strong",{children:["v",Q.version]})]})]})]}),(0,K.jsx)("span",{className:"cmd-update-chip",children:"\u754C\u9762\u4E0E\u529F\u80FD"})]}),(0,K.jsx)("p",{className:"cmd-update-description",children:_?"\u4E3B\u673A\u66F4\u65B0\u540E\uFF0C\u5237\u65B0\u5DE5\u4F5C\u53F0\u5373\u53EF\u4F7F\u7528\u65B0\u7248\u3002":"\u65E5\u5E38\u66F4\u65B0\u53EA\u9700\u5347\u7EA7\u63D2\u4EF6\uFF0C\u624B\u673A\u540C\u6B65\u751F\u6548\u3002"}),x?(0,K.jsxs)("div",{className:"cmd-update-notice",role:"status",children:[(0,K.jsx)(te,{name:"check",size:16}),(0,K.jsxs)("div",{children:[(0,K.jsx)("strong",{children:"\u5DF2\u51C6\u5907\u597D\uFF0C\u91CD\u542F\u4E3B\u673A\u5E94\u7528\u540E\u751F\u6548"}),(0,K.jsx)("p",{children:"\u5148\u7ED3\u675F\u4EFB\u52A1\uFF0C\u518D\u9000\u51FA\u5E76\u91CD\u65B0\u6253\u5F00\u4E3B\u673A\u4E0A\u7684BenchGo\u3002"})]})]}):(0,K.jsxs)(K.Fragment,{children:[v&&!Q.compatible&&(0,K.jsx)("p",{className:"cmd-update-warning",children:Q.reason||(Z?"\u6B64\u63D2\u4EF6\u4E0E\u5F53\u524D\u5F15\u64CE\u4E0D\u517C\u5BB9\uFF0C\u8BF7\u7531\u670D\u52A1\u5668\u90E8\u7F72\u66F4\u65B0\u3002":"\u6B64\u63D2\u4EF6\u9700\u8981\u65B0\u7248\u5E94\u7528\uFF0C\u8BF7\u5148\u5347\u7EA7\u5E94\u7528\u3002")}),o?.managed===!1&&(0,K.jsx)("p",{className:"cmd-update-warning",children:Z?"\u6B64\u4E3B\u673A\u7531\u670D\u52A1\u5668\u90E8\u7F72\u7BA1\u7406":"\u5F53\u524D\u5B89\u88C5\u65B9\u5F0F\u4E0D\u652F\u6301\u72EC\u7ACB\u66F4\u65B0\uFF0C\u8BF7\u5148\u5B89\u88C5\u65B0\u7248\u5E94\u7528\u3002"}),o?.busy&&(0,K.jsx)("p",{className:"cmd-update-warning",role:"status",children:"\u6709\u4EFB\u52A1\u6B63\u5728\u8FD0\u884C\uFF0C\u7ED3\u675F\u540E\u5373\u53EF\u66F4\u65B0\u3002"}),O&&!o?.busy&&o?.managed!==!1&&Q.compatible&&(0,K.jsx)("p",{className:"cmd-update-warning",role:"status",children:O}),(0,K.jsxs)("div",{className:"cmd-update-actions",children:[(0,K.jsx)("span",{role:"status",children:V}),(0,K.jsxs)("span",{className:"cmd-update-action-buttons",children:[E&&(0,K.jsx)("button",{type:"button",className:"cmd-update-text-button",disabled:b,onClick:()=>void L("check"),children:"\u91CD\u65B0\u68C0\u67E5"}),(0,K.jsx)("button",{type:"button",className:`cmd-update-button ${E?"cmd-update-primary":""}`,title:O||void 0,disabled:b||!!E&&!!O,onClick:()=>void L(E?"install":"check"),children:d==="install"||o?.phase==="downloading"?"\u4E0B\u8F7D\u4E2D\u2026":E?"\u66F4\u65B0\u63D2\u4EF6":"\u68C0\u67E5\u66F4\u65B0"})]})]})]}),o?.release?.notes&&(0,K.jsxs)("details",{className:"cmd-update-notes",children:[(0,K.jsx)("summary",{children:"\u66F4\u65B0\u5185\u5BB9"}),(0,K.jsx)("p",{children:o.release.notes})]})]}),oe?(0,K.jsxs)("section",{className:"cmd-update-app",children:[(0,K.jsx)(te,{name:"external",size:17}),(0,K.jsxs)("div",{children:[(0,K.jsxs)("h3",{children:[j?"\u5E94\u7528\u6709\u65B0\u7248\u672C":"\u684C\u9762\u5E94\u7528"," ",(0,K.jsx)("span",{children:j?`v${P.version}`:o?.current?.app?`v${o.current.app}`:""})]}),(0,K.jsx)("p",{children:o?.current?.app?"\u5F15\u64CE\u6216\u684C\u9762\u80FD\u529B\u5347\u7EA7\u65F6\uFF0C\u624D\u9700\u66F4\u65B0\u5E94\u7528\u3002":"\u5E94\u7528\u7248\u672C\u6682\u65E0\u6CD5\u8BC6\u522B\uFF0C\u53EF\u624B\u52A8\u68C0\u67E5\u66F4\u65B0\u3002"})]}),(0,K.jsxs)("span",{className:"cmd-update-app-actions",children:[(0,K.jsx)("button",{type:"button",className:"cmd-update-text-button",disabled:b,onClick:()=>void $(),children:d==="app"?"\u6B63\u5728\u6253\u5F00\u2026":"\u68C0\u67E5\u5E94\u7528\u66F4\u65B0"}),j&&G&&(0,K.jsxs)("a",{className:"cmd-update-text-button",href:G,target:"_blank",rel:"noopener noreferrer",children:["\u4E0B\u8F7D\u5B89\u88C5\u5305",(0,K.jsx)(te,{name:"external",size:12})]})]})]}):o?.current?.app?(0,K.jsxs)("p",{className:"cmd-update-app-version",children:["\u4E3B\u673A\u5E94\u7528 v",o.current.app,j&&` \u2192 v${P.version}\uFF0C\u8BF7\u5728\u4E3B\u673A\u4E0A\u66F4\u65B0`,o.current.engine&&` \xB7 \u5F15\u64CE ${o.current.engine}`]}):null,(r||!F&&o?.error)&&(0,K.jsxs)("div",{className:"cmd-update-error",role:"alert",children:[(0,K.jsx)("span",{children:r||o.error}),(0,K.jsx)("button",{type:"button",className:"cmd-update-text-button",disabled:!!d||b&&y.current.action!=="status",onClick:()=>void se(),children:"\u91CD\u8BD5"})]}),(0,K.jsxs)("section",{className:"cmd-update-source","aria-labelledby":`${I}-source`,children:[(0,K.jsxs)("div",{className:"cmd-update-source-row",children:[(0,K.jsxs)("label",{htmlFor:`${I}-source-select`,id:`${I}-source`,children:[(0,K.jsx)(on.LinkIconMedium,{kind:"url",href:"https://github.com",size:16}),"\u66F4\u65B0\u6765\u6E90"]}),(0,K.jsx)($n,{id:`${I}-source-select`,value:f,disabled:b||x,onChange:ee=>{let X=ee.target.value;u(X),s(""),X!=="custom"&&de(X)},children:Object.entries(Cd).map(([ee,X])=>(0,K.jsxs)("option",{value:ee,children:[X,ee==="mirror"?"\uFF08\u9ED8\u8BA4\uFF09":""]},ee))})]}),f==="custom"&&(0,K.jsxs)("form",{className:"cmd-update-custom",onSubmit:ee=>{ee.preventDefault(),de("custom",ee.currentTarget.elements.namedItem("mirrorUrl").value)},children:[(0,K.jsx)("input",{name:"mirrorUrl",type:"url",required:!0,"aria-label":"\u81EA\u5B9A\u4E49 HTTPS \u955C\u50CF\u5730\u5740",placeholder:"https://mirror.example.com/",value:l,disabled:b||x,onChange:ee=>p(ee.target.value)}),(0,K.jsx)("button",{type:"submit",className:"cmd-update-button",disabled:b||x,children:"\u4FDD\u5B58"})]}),(0,K.jsx)("p",{children:"\u4ECE GitHub \u53D1\u5E03\u9875\u83B7\u53D6\uFF1B\u52A0\u901F\u955C\u50CF\u4EC5\u7528\u4E8E\u4E0B\u8F7D\u3002"})]})]}),(0,K.jsxs)("footer",{className:"cmd-update-footer",children:[(0,K.jsx)("span",{children:"\u66F4\u65B0\u6B64\u4E3B\u673A\uFF0C\u624B\u673A\u65E0\u9700\u91CD\u88C5"}),o?.canRollback&&!x&&(0,K.jsx)("button",{type:"button",className:"cmd-update-text-button",disabled:b||!!o?.busy,onClick:()=>void L("rollback"),children:"\u56DE\u9000\u4E0A\u7248"})]})]})]})}var rt=require("react"),Go=require("react-dom");var Id={online:"\u53EF\u8FDE\u63A5",connected:"\u5DF2\u8FDE\u63A5",offline:"\u79BB\u7EBF",connecting:"\u8FDE\u63A5\u4E2D",failed:"\u8FDE\u63A5\u5931\u8D25",disconnected:"\u672A\u8FDE\u63A5",unknown:"\u672A\u68C0\u6D4B"};function sr(e){return Id[e?.status]||"\u672A\u68C0\u6D4B"}function po(e){let t=e?.deviceType||e?.kind;return["mobile","phone","android","ios","tablet"].includes(t)?"mobile":["ssh","server"].includes(t)?"server":["local","computer","desktop","laptop"].includes(t)?"computer":"devices"}function dr(e){return e?.kind==="local"?"\u672C\u673A":{computer:"\u7535\u8111",mobile:"\u79FB\u52A8\u8BBE\u5907",server:"\u670D\u52A1\u5668",devices:"\u8BBE\u5907"}[po(e)]}function lr(e,t){let n=new URL(e,t);if(n.username||n.password||n.protocol!=="https:"&&!(n.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(n.hostname)))throw new Error("\u5DE5\u4F5C\u53F0\u5730\u5740\u65E0\u6548");return n.href}var Ho=e=>typeof e=="string"?e.replace(/\s+/g," ").trim().slice(0,100):"";function Ed(e){let t=Array.isArray(e)?e.filter(o=>o&&typeof o.id=="string"&&o.id&&Ho(o.name)):[],n=t.find(o=>o.kind==="local")||{id:"local",name:"\u672C\u673A",kind:"local",status:"online"},i=t.filter(o=>o.kind!=="local");return[{...n,name:Ho(n.name)||"\u672C\u673A"},...i.map(o=>({...o,name:Ho(o.name)}))]}function cr({devices:e=[],activeId:t=null,open:n=!1,busy:i="",error:o=""}={}){let a=Ed(e),r=a.find(s=>s.id===t)||a[0];return{items:a,active:r,open:!!(n&&a.length>1&&!i),busy:typeof i=="string"?i:"",error:typeof o=="string"?o:"",multiple:a.length>1}}var Ke=require("react/jsx-runtime"),kd=`.dsh-device-switch{position:fixed;z-index:1200;top:0;right:148px;display:flex;align-items:center;justify-content:flex-end;height:var(--dsh-windows-titlebar-height,40px);max-width:min(240px,calc(100vw - var(--dsh-windows-menu-start,48px) - 168px));-webkit-app-region:no-drag;font:13px/1.4 var(--dsw-font-family,system-ui);color:var(--dsw-alias-label-secondary,#666)}
.dsh-device-switch-trigger{display:inline-flex;align-items:center;gap:6px;max-width:100%;height:28px;padding:0 8px 0 9px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;cursor:default}
.dsh-device-switch-trigger:hover,.dsh-device-switch-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,#8882);color:var(--dsw-alias-label-primary,#202020)}
.dsh-device-switch-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2c6ee8);outline-offset:-2px}
html[data-input-modality=pointer] .dsh-device-switch-trigger:focus-visible{outline-color:transparent}
.dsh-device-switch-trigger>span:first-of-type{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-device-switch-menu{position:fixed;z-index:1201;display:grid;gap:2px;min-width:220px;max-width:min(320px,calc(100vw - 24px));max-height:min(360px,calc(100dvh - 56px));margin:0;padding:5px;overflow:auto;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#202020);box-shadow:0 12px 36px #0002;font:13px/1.4 var(--dsw-font-family,system-ui)}
.dsh-device-switch-menu button{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 8px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:default}
.dsh-device-switch-menu button:hover,.dsh-device-switch-menu button[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,#8882)}
.dsh-device-switch-menu button[aria-current=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2c6ee8) 12%,transparent)}
.dsh-device-switch-menu button:disabled{opacity:.55;cursor:default}
.dsh-device-switch-copy{display:grid;min-width:0;flex:1}.dsh-device-switch-copy strong,.dsh-device-switch-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-device-switch-copy small{color:var(--dsw-alias-label-secondary,#777);font-size:11px;font-weight:400}
.dsh-device-switch-error{margin:2px 4px 0;color:#b34845;font-size:11px;line-height:1.5}
.dsh-device-switch-stage{position:fixed;z-index:30;inset:var(--dsh-windows-titlebar-height,40px) 0 0;display:none;background:var(--dsw-alias-bg-base,#fff)}
html[data-dsh-remote-workbench] .dsh-device-switch-stage{display:block}
.dsh-device-switch-stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:inherit}
.dsh-device-switch-stage[hidden],.dsh-device-switch-stage iframe[hidden]{display:none!important}`;function ur(e,t={}){let n=new URL("/api/commander-devices",location.origin);return fetch(n,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({action:e,...t})}).then(i=>Xe(i,n))}async function Ld(){let e=await ur("launch",{parentOrigin:location.origin});if(e.error)throw new Error(typeof e.error=="string"?e.error:e.error.message||"\u8BBE\u5907\u6682\u65F6\u65E0\u6CD5\u6253\u5F00");let t=new URL(e.url,location.origin);if(!(t.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(t.hostname))||!t.pathname.endsWith("/enter"))throw new Error("\u8BBE\u5907\u4E2D\u5FC3\u5730\u5740\u65E0\u6548");let o=(await fetch(t,{credentials:"same-origin",redirect:"manual"})).headers.get("location");if(!o)throw new Error("\u8BBE\u5907\u6682\u65F6\u65E0\u6CD5\u6253\u5F00");let a=new URL(o,t);if(a.origin!==t.origin||!/^\/s\/[A-Za-z0-9_-]{43}\/$/.test(a.pathname))throw new Error("\u8BBE\u5907\u4E2D\u5FC3\u5730\u5740\u65E0\u6548");return async(r,s={})=>{let d=new URL("api/devices",a),c=await fetch(d,{method:"POST",credentials:"same-origin",headers:{origin:a.origin,"content-type":"application/json"},body:JSON.stringify({action:r,...s})}),f=await Xe(c,d);if(f.error)throw new Error(typeof f.error=="string"?f.error:f.error.message||"\u8BBE\u5907\u6682\u65F6\u65E0\u6CD5\u6253\u5F00");return f}}function pr(){let e=(0,rt.useRef)(null),t=(0,rt.useRef)(null),n=(0,rt.useRef)(new Map),[i,o]=(0,rt.useState)([]),[a,r]=(0,rt.useState)(null),[s,d]=(0,rt.useState)(!1),[c,f]=(0,rt.useState)(""),[u,l]=(0,rt.useState)(""),[p,M]=(0,rt.useState)({}),D=(0,rt.useRef)(null),g=typeof document<"u"&&document.documentElement?.hasAttribute("data-windows-titlebar"),y=cr({devices:i,activeId:a,open:s,busy:c,error:u}),I=()=>ur("devices").then(x=>{!x.error&&Array.isArray(x.devices)&&o(x.devices)}).catch(()=>{});if((0,rt.useEffect)(()=>{g&&I()},[g]),(0,rt.useEffect)(()=>{if(!y.open)return;let x=_=>{!e.current?.contains(_.target)&&!t.current?.contains(_.target)&&d(!1)},F=_=>{_.key==="Escape"&&d(!1)};return document.addEventListener("pointerdown",x),document.addEventListener("keydown",F),()=>{document.removeEventListener("pointerdown",x),document.removeEventListener("keydown",F)}},[y.open]),(0,rt.useEffect)(()=>(document.documentElement.toggleAttribute("data-dsh-remote-workbench",!!(a&&a!=="local")),()=>document.documentElement.removeAttribute("data-dsh-remote-workbench")),[a]),!g||!y.multiple)return null;let L=async x=>{if(!(!x?.id||c)){if(x.id==="local"||x.kind==="local"){r(null),d(!1),l("");return}f(x.id),l(""),d(!1);try{if(!p[x.id]){D.current??=await Ld();let F=await D.current("select",{deviceId:x.id}),_=lr(F.url,location.origin);M(Z=>({...Z,[x.id]:_}))}r(x.id),I()}catch(F){l(F.message),d(!0)}finally{f("")}}},b=e.current?.getBoundingClientRect();return(0,Ke.jsxs)(Ke.Fragment,{children:[(0,Ke.jsx)("style",{children:kd}),(0,Ke.jsx)("div",{className:"dsh-device-switch",ref:e,children:(0,Ke.jsxs)("button",{type:"button",className:"dsh-device-switch-trigger","aria-haspopup":"menu","aria-expanded":y.open,"aria-label":"\u5F53\u524D\u5DE5\u4F5C\u53F0\uFF1A"+y.active.name,title:y.active.name,disabled:!!c,onClick:()=>{d(x=>!x),s||I()},children:[(0,Ke.jsx)(te,{name:po(y.active),size:15}),(0,Ke.jsx)("span",{children:c?"\u6B63\u5728\u6253\u5F00\u2026":y.active.name}),(0,Ke.jsx)(te,{name:"chevronDown",size:12})]})}),y.open&&(0,Go.createPortal)((0,Ke.jsxs)("div",{ref:t,className:"dsh-device-switch-menu",role:"menu","aria-label":"\u5207\u6362\u8BBE\u5907",style:b?{top:b.bottom+4,left:Math.max(8,Math.min(b.left,window.innerWidth-236))}:{top:40,left:148},children:[y.items.map(x=>(0,Ke.jsxs)("button",{type:"button",role:"menuitemradio","aria-checked":y.active.id===x.id,"aria-current":y.active.id===x.id,disabled:!!c,onClick:()=>void L(x),children:[(0,Ke.jsx)(te,{name:po(x),size:16,selected:y.active.id===x.id}),(0,Ke.jsxs)("span",{className:"dsh-device-switch-copy",children:[(0,Ke.jsx)("strong",{children:x.name}),(0,Ke.jsxs)("small",{children:[dr(x)," \xB7 ",c===x.id?"\u6B63\u5728\u6253\u5F00\u2026":y.active.id===x.id?"\u5F53\u524D\u5DE5\u4F5C\u53F0":sr(x)]})]})]},x.id)),u&&(0,Ke.jsx)("p",{className:"dsh-device-switch-error",role:"alert",children:u})]}),document.body),(0,Go.createPortal)((0,Ke.jsx)("div",{className:"dsh-device-switch-stage",hidden:!a,children:Object.entries(p).map(([x,F])=>(0,Ke.jsx)("iframe",{ref:_=>{_?n.current.set(x,_):n.current.delete(x)},src:F,title:(i.find(_=>_.id===x)?.name||"\u8BBE\u5907")+"\u5DE5\u4F5C\u53F0",hidden:a!==x,allow:"clipboard-read; clipboard-write; microphone",referrerPolicy:"no-referrer"},x))}),document.body)]})}var N=require("react/jsx-runtime"),hn={codex:"Codex",claude:"Claude Code",pi:"Pi",opencode:"OpenCode",gemini:"Gemini CLI",hermes:"Hermes",grok:"Grok Build",mcode:"MiniMax Code",deepseek:"DeepSeek"},Mn=new Set(["running","connecting","waiting"]),Wo={idle:"\u5C31\u7EEA",completed:"\u5DF2\u5B8C\u6210 \xB7 \u672A\u8BFB",running:"\u8FD0\u884C\u4E2D",connecting:"\u8FDE\u63A5\u4E2D",disconnected:"\u672A\u8FDE\u63A5",waiting:"\u7B49\u5F85\u56DE\u590D\u6216\u6388\u6743",failed:"\u5931\u8D25",closed:"\u5DF2\u5173\u95ED"},mo=new Set,go,Ut={projects:[],sessions:[],selected:null,projectId:null,error:"",loaded:!1},Sd={getSnapshot:()=>!1,subscribe:()=>()=>{}},Td=45e3,zd=e=>{let t=String(e?.message||e||"");return e?.name==="TimeoutError"||/timed out|timeout|failed to fetch|network error|load failed/i.test(t)?"\u5DE5\u4F5C\u53F0\u54CD\u5E94\u8F83\u6162\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u8BD5\u2026":t};function Ct(e){e.projects&&(e={...e,projects:e.projects.map(t=>({...t,isDefault:t.id===go}))}),Ut={...Ut,...e};for(let t of mo)t()}function mr(){return(0,Ie.useSyncExternalStore)(e=>(mo.add(e),()=>mo.delete(e)),()=>Ut)}async function Bt(e,t={},n){let i=await fetch(new URL("api/commander",document.baseURI),{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({action:e,...t}),signal:n});return Xe(i,new URL("api/commander",document.baseURI))}var Vo;async function Zt(e){let t=await Bt("state",{},AbortSignal.any([...e?[e]:[],AbortSignal.timeout(Td)])),n=JSON.stringify(t);n===Vo&&Ut.loaded&&!Ut.error||(Vo=n,Ct({...t,loaded:!0,error:""}))}function gr({provider:e,size:t=18}){return(0,N.jsx)("span",{className:`cmd-icon cmd-${e}`,"aria-label":hn[e],style:{width:t,height:t},children:e==="deepseek"?(0,N.jsx)(Oe.FishLogo,{size:t}):qt[e]?(0,N.jsx)("img",{width:t,height:t,src:`data:image/svg+xml,${encodeURIComponent(qt[e])}`,alt:""}):"\u03C0"})}function Jo({status:e,className:t=""}){return!Mn.has(e)&&e!=="failed"&&e!=="completed"?null:(0,N.jsx)("span",{className:`cmd-activity cmd-status-${e} ${t}`,role:"img","aria-label":Wo[e],title:Wo[e],children:(0,N.jsx)("i",{"aria-hidden":"true"})})}function Fd({provider:e,status:t}){return Mn.has(t)||t==="failed"||t==="completed"?(0,N.jsx)(Jo,{status:t}):(0,N.jsx)(gr,{provider:e,size:16})}function Bd({host:e,wide:t,settingsOpen:n,openSettings:i,settingsShortcut:o,theme:a}){let r=mr();return(0,N.jsxs)("div",{className:`cmd-settings-row ${t?"":"cmd-settings-row-rail"}`,children:[(0,N.jsx)(Oe.Tooltip,{label:"\u8BBE\u7F6E",side:"top",gap:10,delayMs:450,portal:!0,children:(0,N.jsx)("button",{type:"button",className:"cmd-settings","aria-label":"\u8BBE\u7F6E","aria-haspopup":"dialog","aria-expanded":n,"aria-keyshortcuts":o?.aria,onClick:()=>i(),children:(0,N.jsx)(te,{name:"settings",size:16,selected:n})})}),(0,N.jsx)(ti,{theme:a}),(0,N.jsx)(rr,{host:e,wide:!1}),(0,N.jsx)(Ka,{}),(0,N.jsx)(qa,{}),(0,N.jsx)(Ft,{side:"top",gap:10,label:r.showArchived?"\u8FD4\u56DE\u6700\u8FD1\u5BF9\u8BDD":"\u5DF2\u5F52\u6863\u5BF9\u8BDD",children:(0,N.jsx)("button",{type:"button",className:"cmd-archive-launcher","aria-label":"\u67E5\u770B\u5F52\u6863","aria-pressed":!!r.showArchived,disabled:!!r.archiveTransitioning,onClick:()=>document.dispatchEvent(new Event("commander:toggle-archive")),children:(0,N.jsx)(te,{name:"archive",size:16,selected:!!r.showArchived})})}),(0,N.jsx)(Oe.Tooltip,{label:"GitHub",side:"top",gap:10,delayMs:450,portal:!0,children:(0,N.jsx)("button",{type:"button",className:"cmd-archive-launcher","aria-label":"\u5728\u6D4F\u89C8\u5668\u4E2D\u6253\u5F00 GitHub \u9879\u76EE",onClick:()=>window.open("https://github.com/zhuogo/BenchGo","_blank","noopener,noreferrer"),children:(0,N.jsx)(Oe.LinkIconMedium,{kind:"url",href:"https://github.com/zhuogo/BenchGo",size:16})})})]})}function Ft({label:e,children:t,side:n,gap:i}){return(0,N.jsx)(Oe.Tooltip,{label:e,side:n,gap:i,delayMs:450,portal:!0,children:t})}function bn({message:e}){return e?(0,N.jsx)("div",{className:"cmd-error",role:"alert",children:e}):null}var Od=["slots","layout","uiWorkspace","uiSession","sessions","locale","remote","remote.session","workspaces","modelDirectories","conversation","theme","connection"];function Rd(e){or(e),Aa(e),ma(e),Pa(e),Xa(e),ir(e),ui(e),Ti(e),Ji(e),e.slots.inject("settings.section",()=>e.slots.register({name:"settings.section",id:"harness-tools",order:32,label:()=>"Harness \u5DE5\u5177",inject:()=>({ctx:e})},Ki));let t=document.createElement("style");t.textContent=oi+ni,document.head.append(t),e.effect(()=>()=>t.remove());let n,i=()=>n||(n=(async()=>{let c=await ba(e,f=>Bt("ensureRecent",f));return go=c.workspaceId,Ct({projects:Ut.projects}),c})().finally(()=>{n=void 0}),n);i().catch(c=>Ct({error:c.message}));let o=qi({refresh:Zt,onError:c=>Ct({error:zd(c)}),isActive:()=>Ut.sessions.some(c=>Mn.has(c.status))});e.effect(()=>()=>{o(),Vo=void 0,mo.clear()});let a=new Map,r=c=>{if(a.has(c))return a.get(c);let f=(async()=>{let u=Ut.sessions.find(p=>p.id===c);if(!u)throw new Error("\u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5");if(!u.ownerSessionId?.startsWith("commander-web:")&&(!u.parentId||u.harnessAdopted)){Ct({selected:c,projectId:u.projectId}),e.uiWorkspace.openSession(u.ownerSessionId);return}if(["running","connecting","waiting"].includes(u.status))throw new Error("\u65E7\u7248\u4F1A\u8BDD\u4ECD\u5728\u8FD0\u884C\uFF0C\u8BF7\u5148\u5B8C\u6210\u6216\u4E2D\u65AD\u540E\u8FC1\u79FB\u5230\u5B98\u65B9\u754C\u9762");let l=await e.sessions.create({workspaceId:u.projectId});await e.sessions.using(l,{source:"workspaceOperation"},async p=>{await p.ready;let M=await e.remote.session.selectModel({sessionId:l,provider:`commander-${u.provider}`,model:u.model||"native-default"});if(!M.ok)throw new Error(M.error.message);await Bt("adopt",{id:c,harnessSessionId:l}),Ct({selected:c,projectId:u.projectId}),e.uiWorkspace.openSession(l)}),await Zt()})();return a.set(c,f),f.finally(()=>a.delete(c)).catch(()=>{}),f},s=c=>{Ma(e,Ut.projects,c,go,i).then(f=>Ct({projectId:f,selected:null,error:""})).catch(f=>Ct({error:f.message}))};e.slots.inject("sidebar.brand.mark",()=>e.slots.register({name:"sidebar.brand.mark",priority:-10},()=>null)),e.slots.inject("sidebar.brand.name",()=>e.slots.register({name:"sidebar.brand.name",priority:-10},()=>null));for(let c of["conversation.hero.brand.mark"])e.slots.inject(c,()=>e.slots.register({name:c,priority:-10},()=>null));e.slots.inject("shell.overlay",()=>e.slots.register({name:"shell.overlay",id:"desktop-onboarding",priority:-10},()=>null));for(let[c,f]of[["plugins","plugins"],["schedules","schedules"]])e.slots.inject("sidebar.panellist",()=>e.slots.register({name:"sidebar.panellist",id:c,priority:-10,order:c==="plugins"?0:10,label:()=>c==="plugins"?"\u63D2\u4EF6":"\u81EA\u52A8\u5316\u4EFB\u52A1"},({active:u})=>(0,N.jsx)(te,{name:f,size:16,selected:u})));let d=ei(e);e.slots.inject("settings.launcher",()=>e.slots.register({name:"settings.launcher",priority:-10,inject:()=>({host:e,theme:d})},Bd)),e.slots.inject("sidebar.workspaces",()=>e.slots.register({name:"sidebar.workspaces",priority:-10,inject:()=>({host:e,open:r,newSession:s})},Yd))}function Yd({host:e,open:t,newSession:n,expandSidebar:i,wide:o=!0}){let a=(0,Ie.useSyncExternalStore)(m=>e.sessions.list.subscribe(m),()=>e.sessions.list.getSnapshot()),r=(0,Ie.useSyncExternalStore)(m=>e.workspaces.list.subscribe(m),()=>e.workspaces.list.getSnapshot()),s=(0,Ie.useSyncExternalStore)(m=>e.uiSession.sessionStatus.subscribe(m),()=>e.uiSession.sessionStatus.getSnapshot()),d=new Set(r.archivedSessionIds??[]),c=mr(),f=Uo(r,c.projects,go),u=r.phase==="ready"||f.length>0||c.loaded,[l,p]=(0,Ie.useState)(null),[M,D]=(0,Ie.useState)(null),[g,y]=(0,Ie.useState)(null),I=(0,Ie.useRef)(null),[L,b]=(0,Ie.useState)(!1),[x,F]=(0,Ie.useState)(""),[_,Z]=(0,Ie.useState)(()=>{try{return{projects:!0,recent:!0,...JSON.parse(localStorage.getItem("commander.sidebar.sections")||"{}")}}catch{return{projects:!0,recent:!0}}}),Q=m=>Z(q=>{let fe={...q,[m]:!q[m]};try{localStorage.setItem("commander.sidebar.sections",JSON.stringify(fe))}catch{}return fe}),[v,E]=(0,Ie.useState)(!1),[O,P]=(0,Ie.useState)(""),[G,j]=(0,Ie.useState)(null),[J,oe]=(0,Ie.useState)(""),[R,T]=(0,Ie.useState)(!1),[V,de]=(0,Ie.useState)(!1),[$,se]=(0,Ie.useState)({}),[re,ee]=(0,Ie.useState)("idle"),X=(0,Ie.useRef)([]),B=(0,Ie.useRef)(!1);(0,Ie.useEffect)(()=>()=>X.current.forEach(clearTimeout),[]);let S=()=>{if(!B.current){if(Z(m=>({...m,recent:!0})),window.matchMedia("(prefers-reduced-motion: reduce)").matches){de(m=>!m);return}B.current=!0,ee("out"),X.current=[setTimeout(()=>{de(m=>!m),ee("in"),X.current.push(setTimeout(()=>{ee("idle"),B.current=!1},190))},110)]}};(0,Ie.useEffect)(()=>{Ct({showArchived:V,archiveTransitioning:re!=="idle"})},[V,re]),(0,Ie.useEffect)(()=>{let m=()=>{o||i?.(),S()};return document.addEventListener("commander:toggle-archive",m),()=>document.removeEventListener("commander:toggle-archive",m)});let H=Object.keys(a.byId).find(m=>(a.byId[m].retainedBy?.mainView??0)>0),ae=m=>c.sessions.filter(q=>q.ownerSessionId===m&&(!q.parentId||q.harnessAdopted)).sort((q,fe)=>Number(fe.updatedAt)-Number(q.updatedAt))[0],he=m=>!J||`${m.title} ${m.provider} ${m.model||""}`.toLowerCase().includes(J.toLowerCase()),ge=[...c.sessions.filter(m=>(!a.byId[m.ownerSessionId]||m.parentId&&!m.harnessAdopted)&&(m.title||["running","waiting","connecting","failed"].includes(m.status))&&(V?m.archived:!m.archived)).map(m=>({...m,status:yo(void 0,s.get(m.id),m),native:!0})),...f.flatMap(m=>m.sessionIds.filter(q=>a.byId[q]&&!a.byId[q].blank&&!(c.deletedHarnessIds??[]).includes(q)&&d.has(q)===V).map(q=>({id:q,archived:d.has(q),nativeId:ae(q)?.id,projectId:m.id,title:a.byId[q].displayTitle||a.byId[q].title||"\u65B0\u5BF9\u8BDD",provider:ae(q)?.provider??"deepseek",model:ae(q)?.model,status:yo(a.byId[q],s.get(q),ae(q)),updatedAt:a.byId[q].updatedAt})))].filter(he).sort((m,q)=>Number(r.pinnedSessionIds?.includes(q.id)??!1)-Number(r.pinnedSessionIds?.includes(m.id)??!1)||(Number(q.updatedAt)||Date.parse(q.updatedAt)||0)-(Number(m.updatedAt)||Date.parse(m.updatedAt)||0)),Re=[...c.sessions.filter(m=>!m.archived&&Mn.has(m.status)).map(m=>({...m,native:!0})),...Object.values(a.byId).filter(m=>!d.has(m.id)&&!(c.deletedHarnessIds??[]).includes(m.id)&&(s.get(m.id)?.pendingInteraction||(s.get(m.id)?.running??m.running))&&!ae(m.id)).map(m=>({...m,provider:"deepseek",status:s.get(m.id)?.pendingInteraction?"waiting":"running"}))],Ye=fa(f),je=ha(ge,f),Ze=xo(f.find(m=>m.isDefault),Re),pe=l&&(ge.find(m=>m.id===l.id)||l),Y=e.get?.("remoteAccess")?.source("session",pe?.id||"","session/fork")||Sd,le=(0,Ie.useSyncExternalStore)(Y.subscribe,Y.getSnapshot,Y.getSnapshot),be=async(m,q)=>{b(!0),P("");try{q==="delete"?(m.native||(await e.workspaces.archiveSession(m.id),await Bt("dismiss",{harnessSessionId:m.id})),(m.native||m.nativeId)&&await Bt("delete",{id:m.native?m.id:m.nativeId}),vo(m,H)&&n(m.projectId),D(null)):m.native?await Bt("archive",{id:m.id,archived:!V}):(await(V?e.workspaces.unarchiveSession(m.id):e.workspaces.archiveSession(m.id)),m.nativeId&&await Bt("archive",{id:m.nativeId,archived:!V})),p(null),await Zt()}catch(fe){P(fe.message)}finally{b(!1)}},h=async m=>{if(!(m.native||L)){b(!0),P("");try{r.pinnedSessionIds?.includes(m.id)?await e.uiWorkspace.unpinSession(m.id):await e.uiWorkspace.pinSession(m.id),await Zt()}catch(q){P(q.message)}finally{b(!1)}}},ne=async m=>{if(!(!m||m.isDefault||L)){b(!0),P("");try{await e.workspaces.delete(m.id),Ut.projectId===m.id&&n(),y(null),await Zt()}catch(q){P(q.message)}finally{b(!1)}}},C=m=>{let q=vo(m,H);return(0,N.jsxs)("div",{className:`cmd-session-row ${q?"is-selected":""}`,children:[(0,N.jsxs)("button",{type:"button","aria-label":o?void 0:`${hn[m.provider]} \xB7 ${m.title||"\u5BF9\u8BDD"}`,className:`cmd-session ${Mn.has(m.status)?"cmd-is-active":""} ${q?"cmd-selected":""}`,"aria-current":q?"page":void 0,onClick:()=>{p(null),m.native?t(m.id).catch(fe=>P(fe.message)):(Ct({selected:null,projectId:m.projectId}),e.uiWorkspace.openSession(m.id))},children:[(0,N.jsx)(Fd,{provider:m.provider,status:m.status}),o&&(0,N.jsx)("span",{onDoubleClick:fe=>{fe.stopPropagation(),m.native||j(m)},children:m.title||hn[m.provider]})]}),o&&(0,N.jsxs)("div",{className:"cmd-session-quick-actions",children:[(0,N.jsx)(Ft,{label:r.pinnedSessionIds?.includes(m.id)?"\u53D6\u6D88\u7F6E\u9876":"\u7F6E\u9876",children:(0,N.jsx)("button",{type:"button",className:"cmd-session-quick","aria-label":r.pinnedSessionIds?.includes(m.id)?"\u53D6\u6D88\u7F6E\u9876":"\u7F6E\u9876\u4F1A\u8BDD",onClick:fe=>{fe.stopPropagation(),h(m)},children:r.pinnedSessionIds?.includes(m.id)?(0,N.jsx)(Oe.IconPinFillRegular,{size:14}):(0,N.jsx)(Oe.IconPinOutlineRegular,{size:14})})}),(0,N.jsx)(Ft,{label:V?"\u53D6\u6D88\u5F52\u6863":"\u5F52\u6863",children:(0,N.jsx)("button",{type:"button",className:"cmd-session-quick","aria-label":V?"\u53D6\u6D88\u5F52\u6863\u5BF9\u8BDD":"\u5F52\u6863\u5BF9\u8BDD",onClick:fe=>{fe.stopPropagation(),be(m,"archive")},children:(0,N.jsx)(te,{name:"archive",size:14})})})]}),o&&(0,N.jsx)(Oe.Tooltip,{label:"\u5BF9\u8BDD\u64CD\u4F5C",delayMs:450,portal:!0,children:(0,N.jsx)("button",{type:"button",className:"cmd-session-more","aria-label":"\u5BF9\u8BDD\u64CD\u4F5C\uFF1A"+(m.title||hn[m.provider]),"aria-expanded":l?.id===m.id,"aria-haspopup":"menu",onClick:fe=>{I.current=fe.currentTarget,p(l?.id===m.id?null:m),F(""),P("")},children:(0,N.jsx)(te,{name:"more",size:16})})})]},m.id)};return(0,N.jsxs)("section",{className:`cmd-projects ${o?"":"cmd-narrow"}`,"aria-label":"\u9879\u76EE\u4E0E\u5BF9\u8BDD",children:[(0,N.jsxs)("nav",{className:"cmd-sidebar-nav","aria-label":"\u5FEB\u6377\u5DE5\u5177\u680F",children:[(0,N.jsx)(pr,{}),(0,N.jsx)(Fn,{}),(0,N.jsx)(Oe.Tooltip,{label:"\u65B0\u804A\u5929",delayMs:450,portal:!0,children:(0,N.jsx)("button",{type:"button",className:"cmd-new-chat",onClick:()=>n(),"aria-label":"\u521B\u5EFA\u65B0\u804A\u5929",children:(0,N.jsx)(te,{name:"edit",size:16})})}),(0,N.jsx)(Oe.Tooltip,{label:"\u641C\u7D22\u5BF9\u8BDD",delayMs:450,portal:!0,children:(0,N.jsx)("button",{type:"button",className:"cmd-search-toggle",onClick:()=>{o||i?.(),o&&R&&oe(""),T(!o||!R)},"aria-label":"\u641C\u7D22\u5BF9\u8BDD","aria-expanded":R,"aria-pressed":R,children:(0,N.jsx)(te,{name:"search",size:16})})})]}),o&&R&&(0,N.jsx)("div",{className:"cmd-search-panel",children:(0,N.jsxs)("label",{className:"cmd-search-field",children:[(0,N.jsx)(te,{name:"search",size:16}),(0,N.jsx)("input",{autoFocus:!0,className:"cmd-search",placeholder:"\u641C\u7D22\u5BF9\u8BDD\u2026","aria-label":"\u641C\u7D22\u5BF9\u8BDD\u5185\u5BB9",value:J,onChange:m=>oe(m.target.value),onKeyDown:m=>{m.key==="Escape"&&(T(!1),oe(""))}}),(0,N.jsx)(Ft,{label:"\u5173\u95ED\u641C\u7D22",children:(0,N.jsx)("button",{type:"button","aria-label":"\u5173\u95ED\u641C\u7D22",onClick:()=>{T(!1),oe("")},children:(0,N.jsx)(te,{name:"plus",size:14,className:"cmd-search-close"})})})]})}),o&&(0,N.jsxs)("div",{className:"cmd-sidebar-content",children:[(0,N.jsxs)("div",{className:"cmd-section-title",children:[o&&(0,N.jsxs)("button",{type:"button",className:"cmd-section-toggle","aria-expanded":_.projects,"aria-controls":"cmd-project-section",onClick:()=>Q("projects"),children:[(0,N.jsx)("span",{children:"\u9879\u76EE"}),(0,N.jsx)(te,{name:"chevronDown",size:12})]}),(0,N.jsx)(Ft,{label:"\u6DFB\u52A0\u9879\u76EE",children:(0,N.jsx)("button",{"aria-label":"\u6DFB\u52A0\u9879\u76EE\u76EE\u5F55",onClick:()=>{o||i?.(),E(!o||!v)},children:(0,N.jsx)(te,{name:"plus",size:16})})})]}),v&&(0,N.jsx)(zi,{host:e,api:Bt,onClose:()=>E(!1),onSelected:async m=>{await Zt(),E(!1),n(m.id)}}),(0,N.jsx)(bn,{message:c.error||O||wa(c.capabilities)}),(0,N.jsx)("div",{id:"cmd-project-section",className:"cmd-section-body","data-open":!o||_.projects,inert:o&&!_.projects?"":void 0,children:(0,N.jsxs)("div",{className:"cmd-section-inner",children:[!u&&o&&(0,N.jsx)("p",{className:"cmd-sidebar-empty",children:"\u6B63\u5728\u8BFB\u53D6\u9879\u76EE\u2026"}),Ye.map(m=>{let q=xo(m,Re);return(0,N.jsxs)("div",{className:"cmd-project",children:[(0,N.jsxs)("div",{className:"cmd-project-name",children:[(0,N.jsxs)("button",{"aria-label":o?void 0:q?`${m.title}\uFF0C${Wo[q]}`:m.title,"aria-expanded":!!$[m.id],onClick:()=>{o||i?.(),se(fe=>({...fe,[m.id]:!o||!fe[m.id]}))},children:[(0,N.jsx)(te,{name:"folder",size:16,selected:!!$[m.id]}),o&&(0,N.jsx)("span",{children:m.title}),q&&(0,N.jsx)(Jo,{status:q,className:"cmd-project-activity"}),o&&(0,N.jsx)(te,{name:"chevronDown",className:$[m.id]?"cmd-project-chevron cmd-rotated":"cmd-project-chevron",size:12})]}),(0,N.jsx)(Ft,{label:"\u65B0\u804A\u5929",children:(0,N.jsx)("button",{className:"cmd-project-new",onClick:()=>n(m.id),"aria-label":`\u5728 ${m.title} \u65B0\u804A\u5929`,children:(0,N.jsx)(te,{name:"plus",size:16})})}),o&&!m.isDefault&&(0,N.jsx)(Ft,{label:"\u5220\u9664\u9879\u76EE",children:(0,N.jsx)("button",{type:"button",className:"cmd-project-delete","aria-label":`\u5220\u9664\u9879\u76EE ${m.title}`,onClick:()=>y(m),children:(0,N.jsx)(te,{name:"trash",size:14})})})]}),o&&$[m.id]&&(0,N.jsxs)("div",{className:"cmd-project-children",children:[ge.filter(fe=>fe.projectId===m.id||fe.cwd===m.path).map(C),!ge.some(fe=>fe.projectId===m.id||fe.cwd===m.path)&&(0,N.jsx)("p",{className:"cmd-sidebar-empty",children:"\u8FD8\u6CA1\u6709\u5BF9\u8BDD"})]})]},m.id)}),o&&u&&!Ye.length&&(0,N.jsx)("p",{className:"cmd-sidebar-empty",children:"\u6682\u65E0\u9879\u76EE"})]})}),(0,N.jsxs)("div",{className:"cmd-section-title cmd-recent-title",children:[o&&(0,N.jsxs)("button",{type:"button",className:"cmd-section-toggle","aria-expanded":_.recent,"aria-controls":"cmd-recent-section",onClick:()=>Q("recent"),children:[(0,N.jsxs)("span",{className:"cmd-section-label",children:[V?"\u5DF2\u5F52\u6863":"\u6700\u8FD1",!V&&Ze&&(0,N.jsx)(Jo,{status:Ze})]}),(0,N.jsx)(te,{name:"chevronDown",size:12})]}),(0,N.jsx)(Ft,{label:"\u65B0\u804A\u5929",children:(0,N.jsx)("button",{type:"button","aria-label":"\u6700\u8FD1\u65B0\u804A\u5929",onClick:()=>n(),children:(0,N.jsx)(te,{name:"plus",size:16})})})]}),(0,N.jsx)("div",{id:"cmd-recent-section",className:"cmd-section-body","data-open":!o||_.recent,inert:o&&!_.recent?"":void 0,children:(0,N.jsx)("div",{className:"cmd-section-inner",children:(0,N.jsxs)("div",{className:"cmd-recents","data-transition":re,children:[o&&je.map(C),o&&c.loaded&&!je.length&&(J||V)&&(0,N.jsx)("p",{className:"cmd-sidebar-empty",children:J?"\u6CA1\u6709\u627E\u5230\u5BF9\u8BDD":"\u6682\u65E0\u5F52\u6863\u5BF9\u8BDD"})]})})})]}),(0,N.jsx)(Oe.Menu,{open:!!l,onClose:()=>{L||p(null)},anchor:null,getAnchorRect:()=>I.current?.getBoundingClientRect()??null,side:"right",align:"end",portal:!0,autoFocus:!0,compact:!0,listClassName:"cmd-actions-popover",children:pe&&(0,N.jsxs)(N.Fragment,{children:[(0,N.jsxs)("div",{className:"cmd-session-details",children:[(0,N.jsx)(gr,{provider:pe.provider,size:16}),(0,N.jsxs)("span",{children:[hn[pe.provider]||pe.provider,pe.model?" \xB7 "+pe.model:""]})]}),(0,N.jsxs)("div",{className:"cmd-session-actions",children:[!pe.native&&!V&&(0,N.jsxs)("button",{type:"button",role:"menuitem",disabled:L,onClick:async()=>{b(!0),P("");try{r.pinnedSessionIds?.includes(pe.id)?await e.uiWorkspace.unpinSession(pe.id):await e.uiWorkspace.pinSession(pe.id),p(null)}catch(m){P(m.message)}finally{b(!1)}},children:[r.pinnedSessionIds?.includes(pe.id)?(0,N.jsx)(Oe.IconPinFillRegular,{size:16}):(0,N.jsx)(Oe.IconPinOutlineRegular,{size:16}),(0,N.jsx)("span",{children:r.pinnedSessionIds?.includes(pe.id)?"\u53D6\u6D88\u7F6E\u9876":"\u7F6E\u9876\u4F1A\u8BDD"})]}),!pe.native&&(0,N.jsxs)("button",{type:"button",role:"menuitem",disabled:L,onClick:()=>{j(pe),p(null),P("")},children:[(0,N.jsx)(te,{name:"edit",size:16}),(0,N.jsx)("span",{children:"\u91CD\u547D\u540D"})]}),!pe.native&&le&&(0,N.jsxs)("button",{type:"button",role:"menuitem",disabled:L||["running","waiting","connecting","stopping"].includes(pe.status),onClick:async()=>{b(!0),P("");try{await e.uiWorkspace.forkSession(pe.id,void 0,{allowMigration:!1}),p(null)}catch(m){P(m.message)}finally{b(!1)}},children:[(0,N.jsx)(Oe.IconBranchOutlineRegular,{size:16}),(0,N.jsx)("span",{children:"\u5206\u53C9\u4F1A\u8BDD"})]}),(0,N.jsx)("div",{className:"cmd-session-action-divider",role:"separator"}),(0,N.jsxs)("button",{type:"button",role:"menuitem",disabled:L,onClick:()=>void be(pe,"archive"),children:[(0,N.jsx)(te,{name:"archive",size:16}),(0,N.jsx)("span",{children:V?"\u53D6\u6D88\u5F52\u6863":"\u5F52\u6863\u5BF9\u8BDD"})]}),(0,N.jsx)("div",{className:"cmd-session-action-divider",role:"separator"}),(0,N.jsxs)("button",{type:"button",role:"menuitem",disabled:L,onClick:async()=>{b(!0),F("");try{let m=Ut.sessions.find(fe=>fe.id===(pe.native?pe.id:pe.nativeId)),q=f.find(fe=>fe.id===pe.projectId);await Xi(Zo(pe,m,q)),F("\u5DF2\u590D\u5236\u5B8C\u6574\u4F1A\u8BDD\u4FE1\u606F")}catch{F("\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u590D\u5236\u4E0B\u65B9\u4FE1\u606F")}finally{b(!1)}},children:[(0,N.jsx)(te,{name:"link",size:16}),(0,N.jsx)("span",{children:"\u590D\u5236\u5BF9\u8BDD ID"})]}),(0,N.jsxs)("button",{type:"button",role:"menuitem",className:"cmd-danger",disabled:L,onClick:()=>{D(l),p(null)},children:[(0,N.jsx)(te,{name:"trash",size:16}),(0,N.jsx)("span",{children:"\u5220\u9664\u5BF9\u8BDD"})]})]}),x&&(0,N.jsx)("p",{className:"cmd-copy-status",role:"status",children:x}),x.startsWith("\u590D\u5236\u5931\u8D25")&&(0,N.jsx)("textarea",{className:"cmd-copy-fallback","aria-label":"\u5B8C\u6574\u4F1A\u8BDD\u4FE1\u606F",readOnly:!0,value:JSON.stringify(Zo(pe,Ut.sessions.find(m=>m.id===(pe.native?pe.id:pe.nativeId)),f.find(m=>m.id===pe.projectId)),null,2),onFocus:m=>m.target.select()}),(0,N.jsx)(bn,{message:O})]})}),(0,N.jsx)(Pd,{target:G,host:e,onClose:()=>j(null),onRenamed:Zt}),(0,N.jsx)(Oe.Modal,{open:!!g,onClose:()=>{L||y(null)},title:"\u5220\u9664\u8FD9\u4E2A\u9879\u76EE\uFF1F",closeLabel:"\u5173\u95ED",description:"\u9879\u76EE\u4F1A\u4ECE\u4FA7\u680F\u79FB\u9664\uFF0C\u9879\u76EE\u6587\u4EF6\u5939\u548C\u5176\u4E2D\u7684\u6587\u4EF6\u4E0D\u4F1A\u88AB\u5220\u9664\u3002",footer:(0,N.jsxs)(N.Fragment,{children:[(0,N.jsx)("button",{className:"cmd-dialog-button",disabled:L,onClick:()=>y(null),children:"\u53D6\u6D88"}),(0,N.jsx)("button",{className:"cmd-dialog-button cmd-danger",disabled:L,onClick:()=>void ne(g),children:L?"\u5220\u9664\u4E2D\u2026":"\u5220\u9664\u9879\u76EE"})]}),children:(0,N.jsx)(bn,{message:O})}),(0,N.jsx)(Oe.Modal,{open:!!M,onClose:()=>{L||D(null)},title:"\u5220\u9664\u8FD9\u6761\u5BF9\u8BDD\uFF1F",closeLabel:"\u5173\u95ED",description:"\u4ECE\u5BF9\u8BDD\u5217\u8868\u79FB\u9664\uFF0C\u5E76\u91CA\u653E BenchGo \u7BA1\u7406\u8BB0\u5F55\u3002\u670D\u52A1\u5668\u65E5\u5FD7\u3001\u539F\u751F\u5DE5\u5177\u5386\u53F2\u548C\u9879\u76EE\u6587\u4EF6\u4F1A\u4FDD\u7559\u3002",footer:(0,N.jsxs)(N.Fragment,{children:[(0,N.jsx)("button",{className:"cmd-dialog-button",disabled:L,onClick:()=>D(null),children:"\u53D6\u6D88"}),(0,N.jsx)("button",{className:"cmd-dialog-button cmd-danger",disabled:L,onClick:()=>void be(M,"delete"),children:L?"\u5220\u9664\u4E2D\u2026":"\u5220\u9664\u5BF9\u8BDD"})]}),children:(0,N.jsx)(bn,{message:O})})]})}function Pd({target:e,host:t,onClose:n,onRenamed:i}){let[o,a]=(0,Ie.useState)(e?.title||""),[r,s]=(0,Ie.useState)(!1),[d,c]=(0,Ie.useState)("");(0,Ie.useEffect)(()=>{a(e?.title||""),c("")},[e?.id]);let f=async u=>{u?.preventDefault();let l=o.trim();if(!(!e||!l||r)){s(!0),c("");try{let p=await t.sessions.using(e.id,{source:"workspaceOperation"},M=>M.binding.session.rename(l));if(!p.ok)throw new Error(p.error.message);await i(),n()}catch(p){c(p instanceof Error?p.message:String(p))}finally{s(!1)}}};return(0,N.jsx)(Oe.Modal,{open:!!e,onClose:()=>{r||n()},title:"\u91CD\u547D\u540D\u4F1A\u8BDD",closeLabel:"\u5173\u95ED",footer:(0,N.jsxs)(N.Fragment,{children:[(0,N.jsx)("button",{className:"cmd-dialog-button",disabled:r,onClick:n,children:"\u53D6\u6D88"}),(0,N.jsx)("button",{className:"cmd-dialog-button cmd-dialog-primary",disabled:r||!o.trim(),onClick:f,children:r?"\u4FDD\u5B58\u4E2D\u2026":"\u4FDD\u5B58"})]}),children:(0,N.jsxs)("form",{className:"cmd-rename-form",onSubmit:f,children:[(0,N.jsx)("label",{htmlFor:"cmd-session-rename",children:"\u4F1A\u8BDD\u540D\u79F0"}),(0,N.jsx)("input",{id:"cmd-session-rename",autoFocus:!0,value:o,disabled:r,onChange:u=>a(u.target.value)}),(0,N.jsx)(bn,{message:d})]})})}

return module.exports; }});
