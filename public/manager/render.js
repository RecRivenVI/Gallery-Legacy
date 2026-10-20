// Preserve live controls, keyboard focus and scroll during status polling.
// Existing actions and state still own values; this only patches changed DOM.
const keyed = (node) =>
  node.nodeType === 1
    ? (node.id && "id:" + node.id) ||
      [
        "page",
        "platform",
        "period",
        "block",
        "pick",
        "rootPick",
        "rootRemove",
        "rootName",
        "level",
        "log",
      ]
        .map((k) =>
          node.dataset[k] === undefined ? "" : k + ":" + node.dataset[k],
        )
        .find(Boolean) ||
      ""
    : "";
function compatible(a, b) {
  return (
    a.nodeType === b.nodeType &&
    (a.nodeType !== 1 ||
      (a.tagName === b.tagName &&
        a.namespaceURI === b.namespaceURI &&
        keyed(a) === keyed(b)))
  );
}
function patch(a, b, preserve) {
  if (a.nodeType !== 1) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  const active = a === a.ownerDocument.activeElement;
  for (const attr of [...a.attributes])
    if (!b.hasAttribute(attr.name)) a.removeAttribute(attr.name);
  for (const attr of b.attributes)
    if (a.getAttribute(attr.name) !== attr.value)
      a.setAttribute(attr.name, attr.value);
  if (a.tagName === "INPUT") {
    a.checked = b.checked;
    a.disabled = b.disabled;
    if (!active && a.value !== b.value) a.value = b.value;
  }
  if (preserve.has(a.id)) return;
  patchChildren(a, b, preserve);
  if (
    ["TEXTAREA", "SELECT"].includes(a.tagName) &&
    !active &&
    a.value !== b.value
  )
    a.value = b.value;
}
function patchChildren(a, b, preserve) {
  let cursor = a.firstChild;
  for (const next of [...b.childNodes]) {
    let current = cursor;
    if (!current || !compatible(current, next)) {
      current = [...a.childNodes].find(
        (n) => n !== cursor && keyed(next) && compatible(n, next),
      );
      if (current) a.insertBefore(current, cursor);
      else {
        current = next.cloneNode(true);
        a.insertBefore(current, cursor);
      }
    }
    patch(current, next, preserve);
    cursor = current.nextSibling;
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}
export function patchHTML(element, html, { preserveChildren = [] } = {}) {
  const template = element.ownerDocument.createElement("template");
  template.innerHTML = html;
  patchChildren(element, template.content, new Set(preserveChildren));
}
// Polling is serial even when a request lasts longer than the poll interval.
export function serialPoll(task) {
  let pending = false;
  return async () => {
    if (pending) return false;
    pending = true;
    try {
      await task();
      return true;
    } finally {
      pending = false;
    }
  };
}
