@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package gallery

import kotlin.js.*

// Browser decoding and native media controls; Kotlin owns layout and selection.
@JsFun(
    """(url,video,tracks,label,loaded,failed)=>{
 const box=document.createElement('div'),e=document.createElement(video?'video':'img');box.dataset.galleryMedia='';
 Object.assign(box.style,{position:'fixed',zIndex:'5',overflow:'hidden',pointerEvents:'auto',touchAction:'none',maskMode:'luminance'});
 Object.assign(e.style,{position:'absolute',objectFit:'contain'});e.src=url;e.setAttribute('aria-label',label);
 if(video){e.controls=true;e.playsInline=true;e.onloadedmetadata=()=>loaded(e.videoWidth,e.videoHeight);
 for(const s of JSON.parse(tracks)){const t=document.createElement('track');t.kind='subtitles';t.src=s.url;t.label=s.label;t.srclang=s.language;e.append(t)}
 }else e.onload=()=>loaded(e.naturalWidth,e.naturalHeight);
 const canvas=[...document.querySelectorAll('*')].flatMap(n=>[...n.shadowRoot?.querySelectorAll('canvas')||[]]).reverse()[0];
 for(const type of ['pointerdown','pointermove','pointerup','pointercancel','wheel'])e.addEventListener(type,event=>{if(event.ctrlKey||event.metaKey)return;const b=e.getBoundingClientRect();if(video&&event.clientY>b.bottom-44)return;if(canvas){let target=document.activeElement;while(target?.shadowRoot?.activeElement)target=target.shadowRoot.activeElement;const recipient=target?.tagName==='CANVAS'?target:canvas;if(type==='pointerdown')recipient.focus();const copy=type==='wheel'?new WheelEvent(type,event):new PointerEvent(type,event);recipient.dispatchEvent(copy);if(type!=='pointermove')event.preventDefault()}});
 e.onerror=failed;box.append(e);document.body.append(box);return box;
}"""
)
external fun createMedia(
    url: String,
    video: Boolean,
    tracks: String,
    label: String,
    loaded: (Int, Int) -> Unit,
    failed: () -> Unit,
): JsAny

@JsFun(
    """(box,x,y,w,h,scale,panX,panY,holes,opacity)=>{
 Object.assign(box.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px',opacity:String(opacity)});
 Object.assign(box.firstChild.style,{left:(panX-w*(scale-1)/2)+'px',top:(panY-h*(scale-1)/2)+'px',width:w*scale+'px',height:h*scale+'px'});
 const pieces=JSON.parse(holes).map(r=>'<rect x="'+r[0]+'" y="'+r[1]+'" width="'+r[2]+'" height="'+r[3]+'" rx="'+r[4]+'" fill="black"/>').join('');
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><rect width="100%" height="100%" fill="white"/>'+pieces+'</svg>';
 box.style.maskImage='url("data:image/svg+xml;base64,'+btoa(svg)+'")';

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
)

@JsFun(
    "e=>{const m=e.firstChild;if(m.pause)m.pause();m.removeAttribute('src');if(m.load)m.load();e.remove()}"
)
external fun releaseMedia(element: JsAny)

@JsFun("url=>fetch(url,{method:'HEAD'}).then(r=>r.ok)")
external fun mediaExists(url: String): Promise<JsBoolean>

@JsFun("()=>history.back()") external fun browserBack()

@JsFun("()=>location.href.split('#')[0]") external fun pageAddress(): String
