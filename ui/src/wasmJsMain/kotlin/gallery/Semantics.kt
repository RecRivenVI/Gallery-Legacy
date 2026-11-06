@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package gallery

import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*

private var semanticSequence = 0

// Compose Web currently replaces interactive roles with button and omits their ARIA states.
// This bridge projects the same Kotlin state; it owns no interaction or product state.
@JsFun(
    """(id,attributes)=>{
 let s=globalThis.gallerySemantics;
 if(!s){
  const roots=new Set([document]);
  s=globalThis.gallerySemantics={values:new Map(),scheduled:false};
  const apply=()=>{s.scheduled=false;
   let removed=false;for(const root of roots)if(root.host&&!root.host.isConnected){roots.delete(root);removed=true}if(removed){s.observer.disconnect();for(const root of roots)s.observer.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['role','id']})}
   for(const root of [...roots])for(const node of root.querySelectorAll('*'))if(node.shadowRoot&&!roots.has(node.shadowRoot)){roots.add(node.shadowRoot);s.observer.observe(node.shadowRoot,{childList:true,subtree:true,attributes:true,attributeFilter:['role','id']})}
   for(const [key,value]of s.values){let node;for(const root of roots){node=root.getElementById(key);if(node)break}if(!node)continue;
    for(const [name,content]of Object.entries(value)){if(content===null){if(node.hasAttribute(name))node.removeAttribute(name)}else if(node.getAttribute(name)!==content)node.setAttribute(name,content)}
    if(!node.galleryDisableHandler){node.galleryDisableHandler=e=>{if(node.getAttribute('aria-disabled')==='true'){e.preventDefault();e.stopImmediatePropagation()}};node.addEventListener('click',node.galleryDisableHandler,true)}
   }
  };
  s.schedule=()=>{if(!s.scheduled){s.scheduled=true;queueMicrotask(apply)}};
  s.observer=new MutationObserver(s.schedule);s.observer.observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['role','id']});
 }
 s.values.set(id,JSON.parse(attributes));s.schedule();
}"""
)
private external fun projectSemantic(id: String, attributes: String)

@JsFun("id=>globalThis.gallerySemantics?.values.delete(id)")
private external fun releaseSemantic(id: String)

@Composable
fun semanticControl(
    role: String,
    name: String = "",
    enabled: Boolean = true,
    checked: Boolean? = null,
    pressed: Boolean? = null,
    min: Float? = null,
    max: Float? = null,
    value: Float? = null,
    hidden: Boolean = false,
): Modifier {
    val id = remember { "gallery-control-" + (++semanticSequence) }
    val attrs =
        document(
                "role" to role,
                "aria-hidden" to if (hidden) "true" else null,
                "aria-modal" to if (role == "dialog") "true" else null,
                "aria-label" to name.ifEmpty { null },
                "aria-disabled" to (!enabled).toString(),
                "aria-checked" to checked?.toString(),
                "aria-pressed" to pressed?.toString(),
                "aria-valuemin" to min?.toString(),
                "aria-valuemax" to max?.toString(),
                "aria-valuenow" to value?.toString(),
            )
            .toString()
    SideEffect { projectSemantic(id, attrs) }
    DisposableEffect(id) { onDispose { releaseSemantic(id) } }
    return Modifier.semantics { testTag = id }
}
