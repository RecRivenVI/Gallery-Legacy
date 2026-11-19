@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package gallery

import kotlin.js.*

// Native media decoding and input forwarding for the canvas viewer.
@JsFun(
    """(url,video,preload,label,loaded,failed)=>{
 const box=document.createElement('div'),e=document.createElement(video?'video':'img');box.dataset.galleryMedia='';
 Object.assign(box.style,{position:'fixed',zIndex:'5',overflow:'hidden',pointerEvents:'none',maskMode:'luminance'});
 Object.assign(e.style,{position:'absolute',objectFit:'contain',pointerEvents:'none',touchAction:'none'});
 e.setAttribute('aria-label',label);
 if(video){
  e.playsInline=true;
  e.preload=preload?'auto':'metadata';
  e.onloadeddata=()=>loaded(e.videoWidth,e.videoHeight);
 }else {
  e.onload=()=>loaded(e.naturalWidth,e.naturalHeight);
  const canvas=[...document.querySelectorAll('*')].flatMap(n=>[...n.shadowRoot?.querySelectorAll('canvas')||[]]).reverse()[0];
  for(const type of ['pointerdown','pointermove','pointerup','pointercancel','wheel'])e.addEventListener(type,event=>{if(event.ctrlKey||event.metaKey)return;if(canvas){let target=document.activeElement;while(target?.shadowRoot?.activeElement)target=target.shadowRoot.activeElement;const recipient=target?.tagName==='CANVAS'?target:canvas;if(type==='pointerdown')recipient.focus();const copy=type==='wheel'?new WheelEvent(type,event):new PointerEvent(type,event);recipient.dispatchEvent(copy);if(type!=='pointermove')event.preventDefault()}});
 }
 e.onerror=()=>failed(video?e.error?.code||0:0);e.src=url;box.append(e);document.body.append(box);return box;
}"""
)
external fun createMedia(
    url: String,
    video: Boolean,
    preload: Boolean,
    label: String,
    loaded: (Int, Int) -> Unit,
    failed: (Int) -> Unit,
): JsAny

@JsFun(
    """(box,x,y,w,h,scale,panX,panY,holes,opacity,active)=>{
 Object.assign(box.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px',opacity:String(opacity)});
 const media=box.firstChild,iw=media.naturalWidth||media.videoWidth,ih=media.naturalHeight||media.videoHeight;
 const fit=iw&&ih?Math.min(w/iw,h/ih)*scale:0,mw=fit?iw*fit:w*scale,mh=fit?ih*fit:h*scale;
 Object.assign(media.style,{left:(panX+(w-mw)/2)+'px',top:(panY+(h-mh)/2)+'px',width:mw+'px',height:mh+'px',pointerEvents:active&&opacity>.01&&media.tagName==='IMG'?'auto':'none'});
 const key=holes==='[]'?'':w+':'+h+':'+holes;
 if(box.dataset.galleryMask!==key){
  box.dataset.galleryMask=key;
  if(!key){box.style.maskImage='none';return}
  const pieces=JSON.parse(holes).map(r=>'<rect x="'+r[0]+'" y="'+r[1]+'" width="'+r[2]+'" height="'+r[3]+'" rx="'+r[4]+'" fill="black"/>').join('');
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><rect width="100%" height="100%" fill="white"/>'+pieces+'</svg>';
  box.style.maskImage='url("data:image/svg+xml;base64,'+btoa(svg)+'")';
 }

}"""
)
external fun placeMedia(
    element: JsAny,
    x: Float,
    y: Float,
    width: Float,
    height: Float,
    scale: Float,
    panX: Float,
    panY: Float,
    holes: String,
    opacity: Float,
    active: Boolean,
)

@JsFun(
    "e=>{e.galleryVideoRequest?.abort();const m=e.firstChild;if(m.pause)m.pause();m.removeAttribute('src');if(m.load)m.load();if(e.galleryVideoBlob)URL.revokeObjectURL(e.galleryVideoBlob);e.remove()}"
)
external fun releaseMedia(element: JsAny)

@JsFun("url=>fetch(url,{method:'HEAD'}).then(r=>r.ok)")
external fun mediaExists(url: String): Promise<JsBoolean>

@JsFun("()=>history.back()") external fun browserBack()

@JsFun("()=>location.href.split('#')[0]") external fun pageAddress(): String
