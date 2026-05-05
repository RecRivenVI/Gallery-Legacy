import { escHtml, state } from "../model.js";
import { fetchPlatformsView } from "../view-data.js";
import {
  decodeRoutePart,
  miscNavigate,
  navigate,
  parseAuthorRoute,
  parseHash,
} from "../routes.js";
var Sidebar = (function () {
  var platforms = [];
  var activePlatformId = null;
  var mobileSidebarController = null;

  function sidebarAttr(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function platformClassKey(platform) {
    return platform && platform.icon && platform.icon.kind
      ? String(platform.icon.kind)
      : "generic";
  }

  function platformIconText(platform) {
    return platform && platform.icon && platform.icon.glyph
      ? String(platform.icon.glyph)
      : "?";
  }

  function platformIconHtml(platform, extraClass) {
    var key = platformClassKey(platform);
    var icon = platform.icon || {};
    var iconStyle =
      "--platform-icon-bg:" +
      sidebarAttr(icon.background || "var(--bg-control-active)") +
      ";--platform-icon-color:" +
      sidebarAttr(icon.color || "var(--text-primary)") +
      ";--platform-icon-border:" +
      sidebarAttr(icon.border || "transparent");
    var content =
      icon.kind === "asset" && icon.url
        ? '<img src="' + sidebarAttr(icon.url) + '" alt="" loading="lazy">'
        : '<span class="platform-icon-glyph">' +
          escHtml(platformIconText(platform)) +
          "</span>";
    return (
      '<span class="platform-icon platform-icon-placeholder' +
      (extraClass ? " " + extraClass : "") +
      '" data-platform-icon="' +
      sidebarAttr(key) +
      '" style="' +
      iconStyle +
      '">' +
      content +
      "</span>"
    );
  }

  function browseActionIconHtml(name) {
    var icons = {
      all: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2 7.5 14 3 9.6l6.2-.9L12 3z"/></svg>',
      list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
      files:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    };
    return (
      '<span class="platform-icon sidebar-action-icon">' +
      (icons[name] || icons.files) +
      "</span>"
    );
  }

  function firstContentPlatformId() {
    for (var i = 0; i < platforms.length; i++) {
      if (!platforms[i].fileRoot) return platforms[i].id;
    }
    return "";
  }

  function activeContentPlatformId() {
    if (
      activePlatformId &&
      !platforms.some(function (platform) {
        return platform.fileRoot && platform.id === activePlatformId;
      })
    )
      return activePlatformId;
    return firstContentPlatformId();
  }

  function fetchPlatforms() {
    return fetchPlatformsView()
      .then(function (data) {
        platforms.length = 0;
        for (var i = 0; i < data.length; i++) {
          platforms.push(data[i]);
        }
        render();
        return data;
      })
      .catch(function (err) {
        console.warn("Gallery operation failed");
      });
  }

  function getConfiguredVersion() {
    return "";
  }

  function renderVersion() {
    var el = document.getElementById("appVersion");
    if (!el) return;
    var version = getConfiguredVersion();
    el.textContent = version ? "v" + version : "";
    el.hidden = !version;
  }

  function render() {
    var el = document.getElementById("sidebarPlatformList");
    if (!el) return;
    var html =
      '<div class="galleries-title entrance" style="opacity:0;animation-delay:.10s">平台</div>';
    var baseDelay = 0.14;
    var visibleIndex = 0;
    for (var i = 0; i < platforms.length; i++) {
      var p = platforms[i];
      if (p.fileRoot) continue;

      var isAct = p.id === activePlatformId;
      var rowCls = "platform-row entrance";
      if (isAct) rowCls += " active";
      var delay = (baseDelay + visibleIndex * 0.04).toFixed(2);
      html +=
        '<div class="' +
        rowCls +
        '" data-platform-id="' +
        sidebarAttr(p.id) +
        '" data-platform-misc="0" style="opacity:0;animation-delay:' +
        delay +
        's">';
      html += platformIconHtml(p);
      html += '<span class="platform-label">' + escHtml(p.name) + "</span>";
      html += "</div>";
      visibleIndex++;
    }
    el.style.opacity = "0";
    el.innerHTML = html;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.style.transition = "opacity .2s ease";
        el.style.opacity = "1";
      });
    });
  }

  function updateActiveDOM() {
    var rows = document.querySelectorAll(".platform-row");
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.getAttribute("data-platform-id") === activePlatformId) {
        r.classList.add("active");
      } else {
        r.classList.remove("active");
      }
    }
    // 浏览区仅剩「所有文件」(data-action="files")：仅当处于杂项 / 所有文件视图时高亮；
    // 激活「所有文件」时平台行与顶栏浏览段控均不高亮（misc 不匹配任何平台 id）。
    var subs = document.querySelectorAll(".platform-sub");
    for (var j = 0; j < subs.length; j++) {
      var s = subs[j];
      var action = s.getAttribute("data-action");
      if (
        action === "files" &&
        s.getAttribute("data-platform-id") === activePlatformId
      ) {
        s.classList.add("active");
      } else {
        s.classList.remove("active");
      }
    }
  }

  function setActive(platformId) {
    activePlatformId = platformId;
    updateActiveDOM();
  }

  function setScanStatus(status) {
    var rows = document.querySelectorAll(".platform-row[data-platform-id]");
    var running = !!(status && status.running);
    var failed = !!(
      status &&
      status.progress &&
      status.progress.state === "error"
    );
    var target = status && (status.currentPlatform || status.platform);
    var progress = (status && status.progress) || {};
    var workMetric = progress.works || {
      current: progress.current,
      total: progress.total,
    };
    var authorMetric = progress.authors || {};
    var workCurrent = Number(workMetric.current || 0);
    var workTotal = Number(workMetric.total || 0);
    var authorCurrent = Number(authorMetric.current || 0);
    var authorTotal = Number(authorMetric.total || 0);
    var workPercent =
      workTotal > 0
        ? Math.max(0, Math.min(100, (workCurrent / workTotal) * 100))
        : 0;
    var authorPercent =
      authorTotal > 0
        ? Math.max(0, Math.min(100, (authorCurrent / authorTotal) * 100))
        : 0;
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].getAttribute("data-platform-id");
      var affected = target === "all" || id === target;
      rows[i].classList.toggle("scan-running", running && affected);
      rows[i].classList.toggle("scan-failed", !running && failed && affected);
      rows[i].style.setProperty(
        "--scan-progress",
        affected ? workPercent + "%" : "0%",
      );
      rows[i].style.setProperty(
        "--scan-work-progress",
        affected ? workPercent + "%" : "0%",
      );
      rows[i].style.setProperty(
        "--scan-author-progress",
        affected ? authorPercent + "%" : "0%",
      );
      if (running && affected) {
        var workText = workTotal
          ? "作品 " + workCurrent + "/" + workTotal
          : "作品扫描中";
        var authorText = authorTotal
          ? "作者 " + authorCurrent + "/" + authorTotal
          : "作者扫描中";
        rows[i].title = "扫描中 · " + workText + " · " + authorText;
      } else if (failed && affected) rows[i].title = "扫描失败";
      else rows[i].removeAttribute("title");
    }
  }

  function decodeSidebarRoutePart(value) {
    if (typeof decodeRoutePart === "function") return decodeRoutePart(value);
    try {
      return decodeURIComponent(value);
    } catch (e) {
      return value;
    }
  }

  function getCurrentRoutePath() {
    if (typeof parseHash === "function") {
      var h = parseHash();
      if (h && h.path) return h.path;
    }
    return state.path || "/";
  }

  function setActiveByPath(urlPath) {
    if (!urlPath || urlPath === "/") {
      var firstRoot = platforms.find(function (platform) {
        return platform.fileRoot;
      });
      setActive(firstRoot ? firstRoot.id : null);
      return;
    }
    if (urlPath.indexOf("/@all/") === 0) {
      var pid = decodeSidebarRoutePart(urlPath.replace("/@all/", ""));
      setActive(pid, "all");
      return;
    }
    if (urlPath.indexOf("/@authors/") === 0) {
      var authorListPid = decodeSidebarRoutePart(
        urlPath.replace("/@authors/", ""),
      );
      setActive(authorListPid, "list");
      return;
    }
    if (urlPath.indexOf("/@author/") === 0) {
      var authorRoute = parseAuthorRoute(urlPath);
      if (authorRoute) setActive(authorRoute.platformId, "list");
      return;
    }
    if (urlPath.indexOf("/f/") === 0) {
      setActive(decodeSidebarRoutePart(urlPath.split("/")[2] || ""));
      return;
    }
    setActive(null);
  }

  function initEvents() {
    var list = document.getElementById("sidebarPlatformList");
    if (!list) return;
    list.addEventListener("click", function (e) {
      // 浏览区仅剩「所有文件」入口：点击进入杂项 / 所有文件视图。
      var sub = e.target.closest(".platform-sub");
      if (sub) {
        var rootId = sub.getAttribute("data-platform-id");
        setActive(rootId);
        miscNavigate(1, rootId);
        closeMobileSidebarIfNeeded();
        return;
      }

      var row = e.target.closest(".platform-row");
      if (row) {
        var pid2 = row.getAttribute("data-platform-id");
        setActive(pid2, "all");
        navigate("/@all/" + pid2);
        closeMobileSidebarIfNeeded();
        return;
      }
    });
  }

  function init() {
    renderVersion();
    initEvents();
    initSidebarToggle();
    initPlatformScrollbar();
    return fetchPlatforms().then(function () {
      setActiveByPath(getCurrentRoutePath());
    });
  }

  function refresh() {
    return fetchPlatforms().then(function () {
      setActiveByPath(getCurrentRoutePath());
    });
  }

  var STORAGE_KEY = "gallery_sidebar_collapsed";

  function initSidebarToggle() {
    var toggleBtn = document.getElementById("sidebarToggleBtn");
    var dim = document.getElementById("sidebarDim");
    var sidebarEl = document.getElementById("sidebar");
    var mobileContentScrim = document.getElementById("mobileContentScrim");
    if (!toggleBtn || !dim || !sidebarEl) return;

    function isMobileLayout() {
      return (
        window.matchMedia && window.matchMedia("(max-width: 1024px)").matches
      );
    }

    function applyStoredDesktopCollapsedState() {
      // 移动端为抽屉式，每次进入都是收起（不读取持久化折叠状态）；
      // 桌面断点读取 localStorage 恢复上次的折叠 / 展开状态。
      if (isMobileLayout()) {
        sidebarEl.classList.remove("collapsed");
        return;
      }
      var collapsed = localStorage.getItem(STORAGE_KEY) === "true";
      sidebarEl.classList.toggle("collapsed", collapsed);
    }

    if (!isMobileLayout()) {
      sidebarEl.classList.add("sidebar-no-anim");
      applyStoredDesktopCollapsedState();
      sidebarEl.offsetHeight;
      sidebarEl.classList.remove("sidebar-no-anim");
    } else {
      sidebarEl.classList.remove("collapsed");
    }

    function collapseSidebar() {
      sidebarEl.classList.add("collapsed");
      localStorage.setItem(STORAGE_KEY, "true");
    }

    function expandSidebar() {
      sidebarEl.classList.remove("collapsed");
      localStorage.setItem(STORAGE_KEY, "false");
    }

    function toggle() {
      if (isMobileLayout()) {
        if (sidebarEl.classList.contains("mobile-open")) closeMobileSidebar();
        else openMobileSidebar();
        return;
      }
      if (sidebarEl.classList.contains("collapsed")) {
        expandSidebar();
      } else {
        collapseSidebar();
      }
    }

    function syncSidebarA11y() {
      var isOpen = sidebarEl.classList.contains("mobile-open");
      var isMobile = isMobileLayout();
      if (isMobile) {
        sidebarEl.classList.remove("collapsed");
      } else {
        applyStoredDesktopCollapsedState();
      }
      if (!isMobile && isOpen) {
        sidebarEl.classList.remove("mobile-open");
        isOpen = false;
      }
      var expanded = isMobile
        ? isOpen
        : !sidebarEl.classList.contains("collapsed");
      toggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
      toggleBtn.setAttribute(
        "aria-label",
        expanded ? "收起侧边栏" : "展开侧边栏",
      );
      document.body.classList.toggle("mobile-sidebar-open", isMobile && isOpen);
      if (isMobile && !isOpen) {
        sidebarEl.setAttribute("aria-hidden", "true");
        sidebarEl.setAttribute("inert", "");
      } else {
        sidebarEl.removeAttribute("aria-hidden");
        sidebarEl.removeAttribute("inert");
      }
    }

    function setMobileSidebarOpen(open) {
      if (!isMobileLayout()) {
        sidebarEl.classList.remove("mobile-open");
        syncSidebarA11y();
        return;
      }
      sidebarEl.classList.toggle("mobile-open", !!open);
      syncSidebarA11y();
    }

    function closeMobileSidebar() {
      var restoreFocus = sidebarEl.contains(document.activeElement);
      setMobileSidebarOpen(false);
      if (restoreFocus && toggleBtn) {
        try {
          toggleBtn.focus({ preventScroll: true });
        } catch (e) {
          toggleBtn.focus();
        }
      }
    }

    function openMobileSidebar() {
      setMobileSidebarOpen(true);
    }

    toggleBtn.addEventListener("click", toggle);
    dim.addEventListener("click", toggle);
    if (mobileContentScrim)
      mobileContentScrim.addEventListener("click", closeMobileSidebar);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && sidebarEl.classList.contains("mobile-open"))
        closeMobileSidebar();
    });
    window.addEventListener("resize", syncSidebarA11y);
    syncSidebarA11y();
    mobileSidebarController = {
      close: closeMobileSidebar,
      isMobile: isMobileLayout,
    };
  }

  function closeMobileSidebarIfNeeded() {
    if (mobileSidebarController && mobileSidebarController.isMobile()) {
      mobileSidebarController.close();
    }
  }

  function initPlatformScrollbar() {
    var list = document.getElementById("sidebarPlatformList");
    if (!list) return;

    var wrap = document.createElement("div");
    wrap.className = "sidebar-list-scroll-wrap";
    list.parentNode.insertBefore(wrap, list);
    wrap.appendChild(list);

    var bar = document.createElement("div");
    bar.className = "sidebar-scrollbar";
    var thumb = document.createElement("div");
    thumb.className = "sidebar-scroll-thumb";
    bar.appendChild(thumb);
    wrap.appendChild(bar);

    var dragging = false,
      dragY = 0,
      dragTop = 0;

    function update() {
      var ch = list.scrollHeight;
      var vh = list.clientHeight;
      if (ch <= vh) {
        bar.style.display = "none";
        return;
      }
      bar.style.display = "block";
      var st = list.scrollTop;
      var thumbH = Math.max(20, (vh / ch) * vh);
      var maxTop = vh - thumbH;
      var top = (st / (ch - vh)) * maxTop;
      thumb.style.height = thumbH + "px";
      thumb.style.top = Math.min(maxTop, Math.max(0, top)) + "px";
    }

    list.addEventListener("scroll", update, { passive: true });

    thumb.addEventListener("mousedown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      dragY = e.clientY;
      dragTop = parseFloat(thumb.style.top) || 0;
      bar.classList.add("dragging");
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var vh = list.clientHeight;
      var ch = list.scrollHeight;
      var h = parseFloat(thumb.style.height) || 20;
      var maxTop = vh - h;
      var t = Math.max(0, Math.min(maxTop, dragTop + (e.clientY - dragY)));
      thumb.style.top = t + "px";
      list.scrollTop = (t / maxTop) * (ch - vh);
    });
    document.addEventListener("mouseup", function () {
      if (dragging) {
        dragging = false;
        bar.classList.remove("dragging");
      }
    });

    bar.addEventListener("click", function (e) {
      if (e.target === thumb) return;
      var vh = list.clientHeight;
      var ch = list.scrollHeight;
      var h = parseFloat(thumb.style.height) || 20;
      var maxTop = vh - h;
      var t = Math.max(
        0,
        Math.min(maxTop, e.clientY - bar.getBoundingClientRect().top - h / 2),
      );
      thumb.style.top = t + "px";
      list.scrollTop = (t / maxTop) * (ch - vh);
    });

    var mo = new MutationObserver(function () {
      requestAnimationFrame(update);
    });
    mo.observe(list, { childList: true, subtree: true });
    list.addEventListener("transitionend", function () {
      requestAnimationFrame(update);
    });
    update();
  }

  return {
    init: init,
    refresh: refresh,
    setActive: setActive,
    setActiveByPath: setActiveByPath,
    setScanStatus: setScanStatus,
    reRender: render,
    closeMobile: closeMobileSidebarIfNeeded,
    platforms: platforms,
  };
})();

export { Sidebar };
