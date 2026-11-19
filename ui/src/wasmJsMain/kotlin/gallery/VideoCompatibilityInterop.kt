@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package gallery

import kotlin.js.JsAny

@JsFun(
    """(box,recover)=>{
 const v=box.firstChild, observer=new AbortController(), options={signal:observer.signal};
 const original=()=>!box.galleryVideoRequest&&!box.galleryVideoBlob;
 let start=0, from=0, rate=1, rapidLoops=0, timer=0;
 const clear=()=>{clearTimeout(timer);timer=0};
 const mark=()=>{start=performance.now();from=v.currentTime;rate=v.playbackRate};
 const premature=()=>{
  const remaining=v.duration-from;
  return start>0&&Number.isFinite(remaining)&&remaining>=.12&&
   (performance.now()-start)*rate/1000+Math.min(.12,remaining*.2)<remaining*.55;
 };
 const fullyBuffered=()=>Number.isFinite(v.duration)&&v.networkState===1&&
  Array.from({length:v.buffered.length},(_,i)=>i).some(i=>v.buffered.start(i)<=v.currentTime+.04&&v.buffered.end(i)>=v.duration-.04);
 const waiting=()=>original()&&!v.paused&&!v.ended&&(v.seeking||v.readyState<3)&&fullyBuffered();
 const watchStall=()=>{
  if(timer||!waiting())return;
  const time=v.currentTime;
  timer=setTimeout(()=>{timer=0;if(waiting()&&Math.abs(v.currentTime-time)<.03)recover()},1600);
 };
 v.addEventListener('playing',()=>{if(v.readyState>=3)clear();mark()},options);
 v.addEventListener('ratechange',mark,options);
 v.addEventListener('seeking',()=>{
  if(original()&&v.loop&&!v.paused&&!box.galleryManualSeek&&v.currentTime<.04&&premature()){
   rapidLoops++;
   if(rapidLoops>=2){recover();return}
  }else rapidLoops=0;
  mark();
  watchStall();
 },options);
 v.addEventListener('seeked',()=>{box.galleryManualSeek=false;if(v.readyState>=3)clear()},options);
 v.addEventListener('ended',()=>{clear();if(original()&&premature())recover()},options);
 for(const name of ['waiting','suspend','progress'])v.addEventListener(name,watchStall,options);
 for(const name of ['pause','error','emptied'])v.addEventListener(name,clear,options);
 observer.signal.addEventListener('abort',clear,{once:true});
 return observer;
}"""
)
internal external fun watchVideoCompatibility(box: JsAny, recover: () -> Unit): JsAny

@JsFun(
    """async (box,source,ready,failed)=>{
 const v=box.firstChild, request=new AbortController();
 box.galleryVideoRequest=request;
 // Leave the outgoing frame visible across the native element's source reset.
 if(v.readyState>=2&&v.videoWidth>0){
  try{
   const canvas=document.createElement('canvas'), scale=Math.min(1,960/Math.max(v.videoWidth,v.videoHeight));
   canvas.width=Math.round(v.videoWidth*scale);canvas.height=Math.round(v.videoHeight*scale);
   canvas.getContext('2d').drawImage(v,0,0,canvas.width,canvas.height);
   v.poster=canvas.toDataURL('image/webp',.92);
  }catch{}
 }
 const timeout=setTimeout(()=>{request.abort();failed('VIDEO_COMPAT_TIMEOUT')},28000);
 try{
  const url=new URL(source,location.href);
  url.searchParams.set('playback','compatible');
  const response=await fetch(url,{signal:request.signal});
  if(!response.ok){
   const error=await response.json().catch(()=>({}));
   if(!request.signal.aborted)failed(error.error?.code||'VIDEO_COMPAT_FAILED');
   return;
  }
  if(response.headers.get('Content-Type')!=='video/mp4'){failed('VIDEO_COMPAT_FAILED');return}
  const blob=await response.blob();
  if(request.signal.aborted)return;
  const uri=URL.createObjectURL(blob);
  box.galleryVideoBlob=uri;
  // The fresh blob source is eligible for muted autoplay only when its audio track is absent.
  box.gallerySilentVideo=response.headers.get('X-Gallery-Video-Silent')==='true';
  v.addEventListener('loadeddata',()=>v.removeAttribute('poster'),{once:true});
  v.src=uri;
  v.load();
  ready(uri);
 }catch{
  if(!request.signal.aborted)failed('VIDEO_COMPAT_FAILED');
 }finally{clearTimeout(timeout)}
}"""
)
internal external fun loadCompatibleVideo(
    box: JsAny,
    source: String,
    ready: (String) -> Unit,
    failed: (String) -> Unit,
)
