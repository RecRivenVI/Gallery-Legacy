@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package gallery

import kotlin.js.*

@JsFun(
    """(box,update,ended)=>{
 const v=box.firstChild;
 const observer=new AbortController(), options={signal:observer.signal};
 const ranges=r=>Array.from({length:r.length},(_,i)=>[r.start(i),r.end(i)]);
 const level=v.volume;
 v.volume=.5;
 const volumeAvailable=v.volume===.5;
 v.volume=level;
 let lastValue;
 const emit=()=>{
  const value=JSON.stringify({
  time:Number.isFinite(v.currentTime)?v.currentTime:0, duration:Number.isFinite(v.duration)?v.duration:0,
  buffered:ranges(v.buffered), seekable:ranges(v.seekable), paused:v.paused,hasFrame:v.readyState>=2,
  waiting:!v.paused&&!v.ended&&(v.seeking||v.readyState<3), ended:v.ended,error:v.error?.code||0,
  fullscreen:!!document.fullscreenElement||!!v.webkitDisplayingFullscreen,
  canFullscreen:(document.fullscreenEnabled&&!!document.documentElement.requestFullscreen)||!!v.webkitEnterFullscreen,
  pip:document.pictureInPictureElement===v,
  canPip:!!(document.pictureInPictureEnabled&&v.requestPictureInPicture),
  canVolume:volumeAvailable, visible:!document.hidden
  });
  if(value!==lastValue){lastValue=value;update(value)}
 };
 for(const name of ['emptied','loadedmetadata','durationchange','timeupdate','progress','playing','play','pause','waiting','seeking','seeked','canplay','error','enterpictureinpicture','leavepictureinpicture','webkitbeginfullscreen','webkitendfullscreen'])
  v.addEventListener(name,emit,options);
 v.addEventListener('ended',()=>{emit();ended()},options);
 v.addEventListener('webkitendfullscreen',()=>{v.controls=false},options);
 document.addEventListener('fullscreenchange',emit,options);
 document.addEventListener('visibilitychange',emit,options);
 emit();
 return observer;
}"""
)
external fun observeVideo(
    box: JsAny,
    update: (String) -> Unit,
    ended: () -> Unit,
): JsAny

@JsFun("observer=>observer.abort()") external fun unobserveVideo(observer: JsAny)

@JsFun(
    """(box,volume,muted,rate,loop)=>{
 const v=box.firstChild;
 if(v.volume!==volume)v.volume=volume;
 const effectiveMute=muted||box.gallerySilentVideo===true;
 if(v.muted!==effectiveMute)v.muted=effectiveMute;
 if(v.defaultPlaybackRate!==rate)v.defaultPlaybackRate=rate;
 if(v.playbackRate!==rate)v.playbackRate=rate;
 v.loop=loop;
}"""
)
external fun setVideoOptions(
    box: JsAny,
    volume: Double,
    muted: Boolean,
    rate: Double,
    loop: Boolean,
)

@JsFun(
    """(box,source,language)=>{
 const v=box.firstChild;
 const sources=JSON.parse(source);
 for(const t of v.querySelectorAll('track')){
  if(!sources.some(s=>t.getAttribute('src')===s.url&&t.srclang===s.language))t.remove();
 }
 for(const s of sources){
  let t=Array.from(v.querySelectorAll('track')).find(t=>t.srclang===s.language&&t.getAttribute('src')===s.url);
  if(!t){t=document.createElement('track');t.kind='subtitles';t.src=s.url;t.label=s.label;t.srclang=s.language;v.append(t)}
  const moveCues=()=>{for(const cue of t.track.cues||[])if(cue.line==='auto')cue.line=-5};
  if(!t.dataset.galleryPosition){t.dataset.galleryPosition='1';t.addEventListener('load',moveCues)}
  moveCues();
  const mode=s.language===language?'showing':'disabled';
  if(t.track.mode!==mode)t.track.mode=mode;
 }
}"""
)
external fun setVideoCaptions(box: JsAny, source: String, language: String)

@JsFun(
    """(box,rejected)=>{
 box.firstChild.play().catch(error=>{if(error.name!=='AbortError')rejected(error.name)});
}"""
)
external fun playVideo(box: JsAny, rejected: (String) -> Unit)

@JsFun(
    """(box,exitModes)=>{
 const v=box.firstChild;
 v.pause();
 if(exitModes){
  if(document.pictureInPictureElement===v)document.exitPictureInPicture().catch(()=>{});
  if(v.webkitDisplayingFullscreen)v.webkitExitFullscreen();
  if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});
 }
}"""
)
external fun pauseVideo(box: JsAny, exitModes: Boolean)

@JsFun(
    "(box,seconds)=>{const v=box.firstChild;v.currentTime=seconds;box.galleryManualSeek=v.seeking}"
)
external fun seekVideo(box: JsAny, seconds: Double)

@JsFun(
    """(box,changed,rejected)=>{
 const v=box.firstChild;
 if(document.fullscreenElement){document.exitFullscreen().then(()=>changed(false),()=>rejected());return}
 if(v.webkitDisplayingFullscreen){v.webkitExitFullscreen();return}
 const element=document.documentElement;
 if(document.fullscreenEnabled&&element.requestFullscreen){element.requestFullscreen().then(()=>changed(true),()=>rejected());return}
 if(v.webkitEnterFullscreen){
  v.controls=true;
  try{v.webkitEnterFullscreen()}catch{v.controls=false;rejected()}
 }
}"""
)
external fun toggleVideoFullscreen(box: JsAny, changed: (Boolean) -> Unit, rejected: () -> Unit)

@JsFun(
    """(box,rejected)=>{
 const v=box.firstChild;
 const change=document.pictureInPictureElement===v?document.exitPictureInPicture():v.requestPictureInPicture();
 change.catch(()=>rejected());
}"""
)
external fun toggleVideoPip(box: JsAny, rejected: () -> Unit)

@JsFun("url=>({url,frames:new Map()})") external fun videoPreviewSource(url: String): JsAny

@JsFun(
    """async (preview,seconds)=>{
 if(preview.frames.has(seconds))return preview.frames.get(seconds);
 preview.abort?.abort();
 const abort=new AbortController();
 preview.abort=abort;
 let video=preview.video;
 if(!video){
  video=document.createElement('video');
  video.preload='metadata';video.muted=true;video.playsInline=true;video.src=preview.url;
  preview.video=video;
 }
 const on=name=>new Promise((yes,no)=>{
  const events=new AbortController();
  const finish=action=>{events.abort();action()};
  video.addEventListener(name,()=>finish(yes),{signal:events.signal});
  video.addEventListener('error',()=>finish(no),{signal:events.signal});
  abort.signal.addEventListener('abort',()=>finish(no),{signal:events.signal});
 });
 if(video.error)throw Error('VIDEO_PREVIEW_UNAVAILABLE');
 if(video.readyState<1)await on('loadedmetadata');
 if(!Number.isFinite(video.duration)||video.duration<=0)throw Error('VIDEO_PREVIEW_UNAVAILABLE');
 const time=Math.min(video.duration*.99,Math.max(.01,seconds));
 if(video.seeking||Math.abs(video.currentTime-time)>.005){
  const done=on('seeked');video.currentTime=time;await done;
 }
 if(video.readyState<2)await on('loadeddata');
 const canvas=document.createElement('canvas'), ratio=Math.min(144/video.videoWidth,81/video.videoHeight);
 canvas.width=Math.max(1,Math.round(video.videoWidth*ratio));canvas.height=Math.max(1,Math.round(video.videoHeight*ratio));
 canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
 const image=canvas.toDataURL('image/jpeg',.75).split(',')[1];
 if(preview.frames.size>=12)preview.frames.delete(preview.frames.keys().next().value);
 preview.frames.set(seconds,image);
 return image;
}"""
)
external fun sampleVideoPreview(preview: JsAny, seconds: Double): Promise<JsString>

@JsFun(
    """preview=>{
 preview.abort?.abort();
 if(preview.video){preview.video.removeAttribute('src');preview.video.load();preview.video=null}
}"""
)
external fun releaseVideoPreview(preview: JsAny)

@JsFun(
    """()=>{
 const image=document.createElement('img');
 image.alt='进度预览';
 Object.assign(image.style,{position:'fixed',pointerEvents:'none',zIndex:'6',objectFit:'contain',borderRadius:'12px 12px 0 0'});
 document.body.append(image);
 return image;
}"""
)
external fun createVideoPreviewImage(): JsAny

@JsFun(
    """(image,frame,x,y,w,h)=>{
 if(image.dataset.frame!==frame){image.dataset.frame=frame;image.src='data:image/jpeg;base64,'+frame}
 Object.assign(image.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});
}"""
)
external fun placeVideoPreviewImage(
    image: JsAny,
    frame: String,
    x: Double,
    y: Double,
    width: Double,
    height: Double,
)

@JsFun("image=>image.remove()") external fun releaseVideoPreviewImage(image: JsAny)
