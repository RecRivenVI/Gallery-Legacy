import { state } from "./model.js";
import { LB } from "./viewer/player.js";
import { reloadCurrentDbView } from "./controller.js";
export function canAutoRefresh({view,page,scrollTop,viewerOpen,editing,query,tag}) {
  return view==="allWorks" && page===1 && scrollTop<80 && !viewerOpen && !editing && !query && !tag;
}
export function createLiveUpdates({subscribe, subscribeStatus}) {
  let latest=null,timer=null,lastAttempt="",lastRefresh=0,manualRequired=false,stalePage=false;
  const notice=document.createElement("div");notice.id="live-update-notice";notice.hidden=true;notice.setAttribute("role","status");
  notice.style.cssText="position:fixed;bottom:16px;left:16px;z-index:100001;max-width:80vw;padding:10px 16px;border-radius:12px;background:var(--bg-control-active,#333);color:var(--text-primary,#fff);box-shadow:0 2px 16px #0005";
  const text=document.createElement("span"),button=document.createElement("button");button.id="live-update-apply";button.textContent="更新列表";button.style.marginLeft="12px";notice.append(text,button);document.body.append(notice);
  const viewerOpen=()=>!!LB.isOpen?.();
  const epochAhead=()=>!!latest?.epoch&&latest.epoch!==state.queryEpoch;
  const revisionAhead=()=>{
    if(!latest||!Number.isSafeInteger(state.queryRevision)||epochAhead())return false;
    const parts=state.path.split("/");
    const platform=["p","@all","@authors","@author"].includes(parts[1])?decodeURIComponent(parts[2]||""):null;
    const scoped=platform&&latest.platformRevisions?.[platform];
    const revision=stalePage?latest.revision:Number.isSafeInteger(scoped)?scoped:latest.revision;
    return Number.isSafeInteger(revision)&&revision>state.queryRevision;
  };
  const ahead=()=>epochAhead()||revisionAhead();
  function safeAuto(){return !!latest&&canAutoRefresh({view:state.view,page:state.page,scrollTop:window.scrollY,viewerOpen:viewerOpen(),editing:!!document.activeElement?.matches("input,textarea,select,[contenteditable=true]"),query:state.searchQuery,tag:state.searchTag});}
  function apply(){
    if(!ahead()||viewerOpen())return;
    const changedEpoch=epochAhead();
    lastRefresh=Date.now();lastAttempt=latest.epoch+":"+(latest.revision??"");
    if(changedEpoch){
      window.dispatchEvent(new CustomEvent("gallery-refresh-requested",{detail:{epoch:latest.epoch}}));
      return;
    }
    if(!["allWorks","authors","authorWorks","dbSearch"].includes(state.view)){location.reload();return;}
    reloadCurrentDbView();
  }
  function render(){
    const available=!!ahead()&&!state.path.startsWith("/f/");notice.hidden=!available;
    if(!available)return;
    button.disabled=viewerOpen();text.textContent=viewerOpen()?"新内容已安全入库；关闭阅览器后可更新列表。":"有新内容已安全入库；点击更新列表。";
    const attempt=latest.epoch+":"+(latest.revision??"");
    if(safeAuto() && !manualRequired && !timer && lastAttempt!==attempt){timer=setTimeout(()=>{timer=null;if(safeAuto())apply();else manualRequired=true;},Math.max(0,5000-(Date.now()-lastRefresh)));}
  }
  function remember(value){
    if(!value?.epoch)return false;
    if(!latest||value.epoch!==latest.epoch||(
      Number.isSafeInteger(value.revision)&&
      (!Number.isSafeInteger(latest.revision)||value.revision>=latest.revision)
    ))latest=value;
    if(ahead()&&!safeAuto())manualRequired=true;
    render();
    return true;
  }
  const receive=value=>{if(!value?.enabled||!Number.isSafeInteger(value.revision))return;remember(value);};
  const receiveStatus=value=>{
    if(!value)return;
    const epoch=value.libraryReady===false?"empty":value.live?.epoch||value.loadedGenerationId||value.generationId||value.activeGenerationId;
    if(typeof epoch!=="string"||!epoch)return;
    remember({epoch,revision:Number.isSafeInteger(value.live?.revision)?value.live.revision:null,platformRevisions:value.live?.platformRevisions||{}});
  };
  const receiveGeneration=value=>{if(value?.generation)remember({epoch:value.generation,revision:null,platformRevisions:{}});};
  button.onclick=apply;
  subscribe(receive);
  if(subscribeStatus)subscribeStatus(receiveStatus);
  window.addEventListener("gallery-generation-changed",event=>receiveGeneration(event.detail||{}));
  window.addEventListener("gallery-query-loaded",()=>{stalePage=false;if(timer){clearTimeout(timer);timer=null;}if(!ahead())manualRequired=false;render();});
  window.addEventListener("gallery-content-changed",event=>{stalePage=true;const detail=event&&event.detail||{};if(Number.isSafeInteger(detail.revision))receive({...detail,enabled:true});else receiveGeneration({generation:detail.epoch});});
  return {receive,receiveStatus,dispose(){if(timer)clearTimeout(timer);notice.remove();}};
}
