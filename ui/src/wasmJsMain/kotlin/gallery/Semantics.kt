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
  const roots=new Map(),pending=new Set();
  s=globalThis.gallerySemantics={values:new Map(),scheduled:false};
  const apply=()=>{s.scheduled=false;
   for(const key of pending){const value=s.values.get(key);if(!value)continue;let node;for(const root of roots.keys()){node=root.getElementById(key);if(node)break}if(!node)continue;
    for(const [name,content]of Object.entries(value)){if(content===null){if(node.hasAttribute(name))node.removeAttribute(name)}else if(node.getAttribute(name)!==content)node.setAttribute(name,content)}
    if(!node.galleryDisableHandler){node.galleryDisableHandler=e=>{if(node.getAttribute('aria-disabled')==='true'){e.preventDefault();e.stopImmediatePropagation()}};node.addEventListener('click',node.galleryDisableHandler,true)}
   }
   pending.clear();
  };
  s.mark=key=>{if(!s.values.has(key))return;pending.add(key);if(!s.scheduled){s.scheduled=true;queueMicrotask(apply)}};
  const find=node=>{
   if(node.nodeType===1)check(node);
   for(const child of node.querySelectorAll?.('*')||[])check(child);
  };
  const check=node=>{s.mark(node.id);if(node.shadowRoot)observe(node.shadowRoot)};
  const observe=root=>{
   if(roots.has(root))return;
   const observer=new MutationObserver(records=>{
    for(const r of records){
     if(r.type==='attributes'){const node=r.target,attrs=s.values.get(node.id);if(attrs&&(r.attributeName==='id'||node.getAttribute('role')!==attrs.role))s.mark(node.id)}
     else for(const node of r.addedNodes)find(node);
    }
    for(const [known,watch]of roots)if(known.host&&!known.host.isConnected){watch.disconnect();roots.delete(known)}
   });
   roots.set(root,observer);
   observer.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['role','id']});
   find(root);
  };
  observe(document);
 }
 const previous=s.values.get(id);
 if(previous?.source===attributes)return;
 const value=JSON.parse(attributes);
 Object.defineProperty(value,'source',{value:attributes});
 s.values.set(id,value);s.mark(id);
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
