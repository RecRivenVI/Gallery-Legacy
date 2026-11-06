@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package gallery

import kotlin.js.*
import kotlinx.coroutines.await
import kotlinx.serialization.json.*

@JsFun(
    "(url,id)=>{globalThis.galleryRequests??=new Map();const c=new AbortController();galleryRequests.set(id,c);return fetch(url,{signal:c.signal}).then(async r=>JSON.stringify({status:r.status,text:await r.text()})).finally(()=>galleryRequests.delete(id));}"
)
private external fun fetchRaw(url: String, id: Int): Promise<JsString>

@JsFun(
    "(url,input,id)=>{globalThis.galleryRequests??=new Map();const c=new AbortController();galleryRequests.set(id,c);return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:input,signal:c.signal}).then(async r=>JSON.stringify({status:r.status,text:await r.text()})).finally(()=>galleryRequests.delete(id));}"
)
private external fun postRaw(url: String, input: String, id: Int): Promise<JsString>

@JsFun("id=>globalThis.galleryRequests?.get(id)?.abort()") external fun abortRequest(id: Int)

@JsFun(
    "url=>fetch(url).then(async r=>{if(!r.ok)throw Error('MEDIA_UNREADABLE');const a=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<a.length;i+=32768)s+=String.fromCharCode(...a.subarray(i,i+32768));return btoa(s)})"
)
external fun fetchBase64(url: String): Promise<JsString>

@JsFun(
    "(url,id)=>{globalThis.galleryRequests??=new Map();const c=new AbortController();galleryRequests.set(id,c);return fetch(url,{signal:c.signal}).then(async r=>{if(!r.ok)throw Error('MEDIA_UNREADABLE');const a=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<a.length;i+=32768)s+=String.fromCharCode(...a.subarray(i,i+32768));return JSON.stringify({encoded:btoa(s),width:Number(r.headers.get('X-Gallery-Width'))||0,height:Number(r.headers.get('X-Gallery-Height'))||0,animated:r.headers.get('X-Gallery-Animated')==='true',durationMs:Number(r.headers.get('X-Gallery-Duration'))||0})}).finally(()=>galleryRequests.delete(id))}"
)
private external fun fetchImageBase64(url: String, id: Int): Promise<JsString>

suspend fun imagePayload(url: String): ImagePayloadWire {
    val id = ++requestSerial
    return try {
        json.decodeFromString<ImagePayloadWire>(
            fetchImageBase64(url, id).await<JsString>().toString()
        )
    } finally {
        abortRequest(id)
    }
}

@JsFun(
    "(method,input)=>globalThis.__TAURI_INTERNALS__.invoke('host_call',{method,input:JSON.parse(input)}).then(v=>JSON.stringify({ok:true,value:v}),e=>JSON.stringify({ok:false,error:String(e?.message||e)}))"
)
private external fun nativeCall(method: String, input: String): Promise<JsString>

@JsFun("()=>!!globalThis.__TAURI_INTERNALS__") external fun isDesktop(): Boolean

@JsFun("()=>location.hash") external fun currentHash(): String

@JsFun("s=>encodeURIComponent(s)") external fun encode(s: String): String

@JsFun("s=>{try{return decodeURIComponent(s)}catch{return s}}")
external fun decode(s: String): String

@JsFun("s=>JSON.stringify(Object.fromEntries(new URLSearchParams(s)))")
external fun parseParameters(s: String): String

@JsFun(
    "(hash,replace)=>{const url=location.pathname+location.search+hash;if(replace)history.replaceState(null,'',url);else history.pushState(null,'',url);}"
)
external fun writeHash(hash: String, replace: Boolean)

@JsFun(
    "(callback)=>{const f=()=>callback(location.hash);addEventListener('popstate',f);addEventListener('hashchange',f);return ()=>{removeEventListener('popstate',f);removeEventListener('hashchange',f)}}"
)
external fun listenHistory(callback: (String) -> Unit): () -> Unit

@JsFun(
    "callback=>{const f=e=>{if(e.key!=='/'||e.ctrlKey||e.metaKey||e.altKey)return;if(e.composedPath().some(n=>n?.tagName==='INPUT'||n?.tagName==='TEXTAREA'||n?.isContentEditable))return;e.preventDefault();callback()};addEventListener('keydown',f);return()=>removeEventListener('keydown',f)}"
)
external fun listenSearchShortcut(callback: () -> Unit): () -> Unit

@JsFun(
    "()=>{let e=document.activeElement;while(e?.shadowRoot?.activeElement)e=e.shadowRoot.activeElement;return !!e&&(e.tagName==='INPUT'||e.tagName==='TEXTAREA'||e.isContentEditable)}"
)
external fun editingText(): Boolean

@JsFun("()=>innerWidth") external fun browserWidth(): Int

@JsFun("()=>innerHeight") external fun browserHeight(): Int

@JsFun("()=>matchMedia('(prefers-color-scheme:dark)').matches") external fun systemDark(): Boolean

@JsFun("()=>matchMedia('(prefers-reduced-motion:reduce)').matches")
external fun reducedMotion(): Boolean

@JsFun("()=>matchMedia('(pointer:coarse)').matches") external fun coarsePointer(): Boolean

@JsFun(
    "callback=>{const m=matchMedia('(prefers-color-scheme:dark)');m.addEventListener('change',callback);return()=>m.removeEventListener('change',callback)}"
)
external fun listenSystemTheme(callback: () -> Unit): () -> Unit

@JsFun(
    "callback=>{const f=()=>callback();addEventListener('resize',f);return ()=>removeEventListener('resize',f)}"
)
external fun listenResize(callback: () -> Unit): () -> Unit

@JsFun(
    "callback=>{const k=e=>{if(e.key==='Tab'||e.key.startsWith('Arrow')||['Home','End','PageUp','PageDown'].includes(e.key))callback(true)},p=()=>callback(false);addEventListener('keydown',k,true);addEventListener('pointerdown',p,true);return()=>{removeEventListener('keydown',k,true);removeEventListener('pointerdown',p,true)}}"
)
external fun listenModality(callback: (Boolean) -> Unit): () -> Unit

@JsFun("key=>localStorage.getItem(key)||''") external fun stored(key: String): String

@JsFun("(key,value)=>localStorage.setItem(key,value)")
external fun saveStored(key: String, value: String)

@JsFun("()=>Date.now()") external fun now(): Double

@JsFun("ms=>new Date(ms).toISOString().slice(0,10)") external fun isoDate(ms: Double): String

@JsFun(
    "ms=>new Date(ms).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})"
)
external fun clock(ms: Double): String

@JsFun(
    "ms=>{const d=new Date(ms),n=new Date(),day=new Date(n.getFullYear(),n.getMonth(),n.getDate());if(d>=day)return '今天';if(d>=new Date(day.getTime()-86400000))return '昨天';const week=new Date(day.getTime()-((day.getDay()+6)%7)*86400000);if(d>=week)return '本周';return d.getFullYear()+' 年 '+(d.getMonth()+1)+' 月'}"
)
private external fun historyGroupRaw(time: Double): String

fun historyGroup(time: Long): String = historyGroupRaw(time.toDouble())

@JsFun(
    "s=>navigator.clipboard?.writeText(s).then(()=>true).catch(()=>false)||Promise.resolve(false)"
)
external fun copyText(s: String): Promise<JsBoolean>

@JsFun("(url,name)=>{const a=document.createElement('a');a.href=url;a.download=name;a.click()}")
external fun download(url: String, name: String)

@JsFun("url=>{if(/^https?:/.test(url))window.open(url,'_blank','noopener,noreferrer')}")
external fun openLink(url: String)

@JsFun(
    "s=>{const d=new DOMParser().parseFromString(s,'text/html');d.querySelectorAll('script,style').forEach(n=>n.remove());d.querySelectorAll('br').forEach(n=>n.replaceWith('\\n'));d.querySelectorAll('p,div,li').forEach(n=>n.append('\\n'));return (d.body.textContent||'').trim()}"
)
external fun plainHtml(s: String): String

@JsFun(
    "(url,callback,closed)=>{const w=new WebSocket(new URL(url,location.href).href.replace(/^http/,'ws'));w.onmessage=e=>callback(e.data);w.onclose=closed;return()=>{w.onclose=null;w.close()}}"
)
external fun listenStatus(url: String, callback: (String) -> Unit, closed: () -> Unit): () -> Unit

@JsFun("(name)=>document.documentElement.style.colorScheme=name")
external fun browserTheme(name: String)

private var requestSerial = 0

suspend inline fun <reified T> readApi(
    endpoint: String,
    parameters: Map<String, Any?> = emptyMap(),
): T = json.decodeFromJsonElement(api(endpoint, parameters))

suspend fun resolveWork(path: String): WorkSummaryWire =
    readApi<ResolvedWire<WorkSummaryWire>>("resolve", mapOf("path" to path)).item
        ?: throw IllegalStateException("WORK_NOT_FOUND")

suspend fun resolveAuthor(path: String): AuthorSummaryWire =
    readApi<ResolvedWire<AuthorSummaryWire>>("resolve", mapOf("path" to path)).item
        ?: throw IllegalStateException("NOT_FOUND")

suspend fun api(endpoint: String, parameters: Map<String, Any?> = emptyMap()): JsonElement {
    val query =
        parameters
            .filterValues { it != null && it.toString().isNotEmpty() }
            .map { encode(it.key) + "=" + encode(it.value.toString()) }
            .joinToString("&")
    val id = ++requestSerial
    val raw =
        try {
            fetchRaw("/api/v1/$endpoint" + if (query.isEmpty()) "" else "?$query", id)
                .await<JsString>()
                .toString()
        } finally {
            abortRequest(id)
        }
    return responseData(raw)
}

private fun responseData(raw: String): JsonElement {
    val result = json.decodeFromString<FetchResponseWire>(raw)
    val envelope = json.decodeFromString<ApiEnvelopeWire<JsonElement>>(result.text)
    if (result.status !in 200..299)
        throw IllegalStateException(envelope.error?.code ?: "SERVICE_UNAVAILABLE")
    if (envelope.protocolVersion != 1 || envelope.data == null)
        throw IllegalStateException("PROTOCOL_MISMATCH")
    return envelope.data
}

suspend inline fun <reified T> sendApi(endpoint: String, input: JsonObject): T =
    json.decodeFromJsonElement(postApi(endpoint, input))

suspend fun postApi(endpoint: String, input: JsonObject): JsonElement {
    val id = ++requestSerial
    val raw =
        try {
            postRaw("/api/v1/$endpoint", input.toString(), id).await<JsString>().toString()
        } finally {
            abortRequest(id)
        }
    return responseData(raw)
}

suspend fun host(method: String, input: JsonObject = emptyDocument): JsonElement {
    if (!isDesktop()) throw IllegalStateException("LOCAL_CONTROL_REQUIRED")
    // Tauri rejects with plain strings. Keep native failures in the Kotlin
    // exception domain rather than throwing foreign values through Wasm.
    val response =
        json
            .parseToJsonElement(nativeCall(method, input.toString()).await<JsString>().toString())
            .jsonObject
    if (response["ok"]?.jsonPrimitive?.booleanOrNull != true)
        throw IllegalStateException(response["error"].text())
    return response["value"] ?: JsonNull
}

@JsFun("url=>fetch(url).then(r=>{if(!r.ok)throw Error('RESOURCE_UNAVAILABLE');return r.text()})")
external fun resourceText(url: String): Promise<JsString>

suspend inline fun <reified T> readAdmin(operation: String, input: JsonObject = emptyDocument): T =
    json.decodeFromJsonElement(admin(operation, input))

suspend fun admin(operation: String, input: JsonObject = emptyDocument) =
    host("admin", document("operation" to operation, "input" to input))

fun routeFromBrowser(hash: String = currentHash()): Route {
    val raw = hash.removePrefix("#").ifEmpty { "/@all/pixiv" }
    val parts = raw.split('?', limit = 2)
    val path =
        if (parts[0].startsWith("/@author/")) {
            val segments = parts[0].split('/')
            val stable = decode(segments.getOrElse(3) { "" })
            if (
                stable.startsWith("/p/" + segments.getOrElse(2) { "" } + "/") &&
                    stable.count { it == '/' } == 3
            )
                stable
            else parts[0]
        } else parts[0]
    return parseRoute(
        path,
        json.parseToJsonElement(parseParameters(parts.getOrElse(1) { "" })).jsonObject.mapValues {
            it.value.text()
        },
    )
}

fun routeHash(route: Route): String =
    "#" +
        route.path +
        "?" +
        route
            .parameters()
            .filterValues { it.isNotEmpty() }
            .map { encode(it.key) + "=" + encode(it.value) }
            .joinToString("&")

@JsFun("()=>location.assign('/')") external fun browserGallery()
