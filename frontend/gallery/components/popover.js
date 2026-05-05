// 统一弹出菜单：顶部弹层、筛选菜单和下拉菜单共用同一套开关、定位与淡入淡出。
var GalleryMenu = (function () {
  var openEl = null;
  var openTrigger = null;
  var closeTimer = null;
  var CLOSE_MS = 180;

  function clearCloseTimer() {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
  }

  function setTriggerActive(trigger, active) {
    if (!trigger) return;
    trigger.classList.toggle("active", !!active);
    trigger.setAttribute("aria-expanded", active ? "true" : "false");
  }

  function prepare(el) {
    if (!el) return;
    el.classList.add("popup-menu");
    el.setAttribute("role", el.getAttribute("role") || "menu");
  }

  function position(el, trigger, opts) {
    if (!el || !trigger) return;
    opts = opts || {};
    var r = trigger.getBoundingClientRect();
    var offset = opts.offset == null ? 8 : opts.offset;
    var align = opts.align || "end";
    el.style.top = "0px";
    el.style.left = "0px";
    el.style.right = "auto";
    var ew = el.offsetWidth || 260;
    var eh = el.offsetHeight || 200;
    var top = r.bottom + offset;
    if (top + eh > window.innerHeight - 8)
      top = Math.max(8, r.top - eh - offset);
    var left = align === "start" ? r.left : r.right - ew;
    left = Math.max(8, Math.min(left, window.innerWidth - ew - 8));
    el.style.top = top + "px";
    el.style.left = left + "px";
  }

  function close(target, immediate) {
    var el = target || openEl;
    if (!el) return;
    var wasOpen = el === openEl;
    if (wasOpen) {
      setTriggerActive(openTrigger, false);
      openEl = null;
      openTrigger = null;
    }
    el.classList.remove("open");
    if (immediate) {
      el.classList.remove("closing");
      return;
    }
    el.classList.add("closing");
    clearCloseTimer();
    closeTimer = setTimeout(function () {
      el.classList.remove("closing");
      clearCloseTimer();
    }, CLOSE_MS);
  }

  function open(el, trigger, opts) {
    if (!el) return;
    if (openEl === el) {
      close(el);
      return;
    }
    if (openEl) close(openEl, true);
    clearCloseTimer();
    prepare(el);
    el.classList.remove("closing");
    el.classList.add("open");
    openEl = el;
    openTrigger = trigger || null;
    setTriggerActive(openTrigger, true);
    position(el, trigger, opts);
  }

  function isOpen(el) {
    return !!(el && openEl === el && el.classList.contains("open"));
  }

  document.addEventListener("click", function (e) {
    if (!openEl) return;
    if (openEl.contains(e.target)) return;
    if (openTrigger && openTrigger.contains(e.target)) return;
    close(openEl);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close(openEl);
  });

  window.addEventListener("resize", function () {
    if (openEl) close(openEl, true);
  });

  return {
    open: open,
    close: close,
    isOpen: isOpen,
  };
})();

export { GalleryMenu };
