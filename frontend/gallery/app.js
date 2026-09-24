import { isDatabaseRoutePath, showError, state } from "./model.js";
import { LB } from "./viewer/player.js";
import {
  getPlatformRoot,
  miscNavigate,
  parseAuthorRoute,
  parseHash,
  isLegacyIntegerRoutePath,
} from "./routes.js";
import { Sidebar } from "./components/sidebar.js";
import {
  loadAllWorks,
  loadAuthorWorks,
  loadAuthors,
  loadDirectory,
  loadStableRoute,
  loadSearchRoute,
  openDbFolderLightboxFromHash,
} from "./controller.js";
import { initSearchInputs } from "./components/search.js";
import { checkRunningScan, initScanWS } from "./status.js";

function syncViewport() {
  document.documentElement.style.setProperty(
    "--real-vw",
    window.innerWidth + "px",
  );
  document.documentElement.style.setProperty(
    "--real-vh",
    window.innerHeight + "px",
  );
  syncGlobalHeaderHeight();
}

function syncGlobalHeaderHeight() {
  var header = document.querySelector(".global-header");
  var height = header ? Math.ceil(header.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty(
    "--global-header-height",
    height + "px",
  );
}

function handleTargetMedia(data) {
  if (data && data.targetMedia) {
    var cleanHash =
      "#" + state.path.split("/").map(encodeURIComponent).join("/") + (state.page > 1 ? "?page=" + state.page : "");
    history.replaceState(null, "", cleanHash);
    for (var i = 0; i < state.allMedia.length; i++) {
      if (state.allMedia[i].name === data.targetMedia) {
        LB.openAt(i);
        break;
      }
    }
  }
}

function showLibraryWaiting(status) {
  var hash = (window.location.hash || "").slice(1);
  if (hash.indexOf("/f/") === 0 || status.libraryReady !== false) return;
  if (LB.isOpen && LB.isOpen()) return;
  var content = document.getElementById("content");
  if (!content || content.querySelector(".card")) return;
  var scan = status.scan || {};
  var phase = scan.running
    ? "正在" + (scan.phase || scan.state || "扫描")
    : "等待首次完整扫描";
  phase = String(phase).replace(/[&<>\"]/g, function (value) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[value];
  });
  content.innerHTML =
    '<div class="empty entrance" role="status">' +
    phase +
    "；数据库就绪后会自动显示作品。" +
    "</div>";
}

function loadCurrentGalleryRoute(refreshSidebar) {
  var h = parseHash();
  var sidebarReady = Promise.resolve();
  if (refreshSidebar && typeof Sidebar !== "undefined") {
    if (Sidebar.refresh) sidebarReady = Sidebar.refresh();
    else if (Sidebar.init) sidebarReady = Sidebar.init();
  }

  return sidebarReady
    .then(function () {
      state.cursor = h.cursor;
      // Integer IDs are allocated inside one Catalog generation.  Refuse old
      // addresses explicitly; never reinterpret them against a replacement.
      if (
        isLegacyIntegerRoutePath(h.path) ||
        (h.folder && isLegacyIntegerRoutePath(h.folder))
      ) {
        showError("旧作品/作者链接没有稳定地址，请从平台列表重新选择");
        return;
      }
      if (h.path.indexOf("/p/") === 0) {
        return loadStableRoute(
          h.path,
          h.page,
          h.order,
          h.offset,
          h.media,
          h.search,
          h.tag,
        ).then(function (data) {
          handleTargetMedia(data);
          openDbFolderLightboxFromHash(h);
        });
      } else if (h.search || h.tag) {
        state.order = h.order;
        state.miscMode = h.path === "/";
        return loadSearchRoute(
          h.path,
          h.search,
          h.page,
          h.source || (isDatabaseRoutePath(h.path) ? "db" : "fs"),
          h.tag,
        ).then(function () {
          openDbFolderLightboxFromHash(h);
        });
      } else if (h.path.indexOf("/@all/") === 0) {
        var root = getPlatformRoot(h.path.replace("/@all/", ""));
        if (root) {
          return loadAllWorks(root, h.page).then(function () {
            openDbFolderLightboxFromHash(h);
          });
        }
      } else if (h.path.indexOf("/@authors/") === 0) {
        var authorListPlatformId = h.path.replace("/@authors/", "");
        var authorListRoot = getPlatformRoot(authorListPlatformId);
        if (authorListRoot) {
          return loadAuthors(authorListRoot, authorListPlatformId, h.page);
        }
      } else if (h.path.indexOf("/@author/") === 0) {
        var authorRoute = parseAuthorRoute(h.path);
        if (authorRoute) {
          var authorRoot = getPlatformRoot(authorRoute.platformId);
          if (authorRoot)
            return loadAuthorWorks(
              authorRoot,
              authorRoute.platformId,
              authorRoute.authorId,
              h.page,
            ).then(function () {
              openDbFolderLightboxFromHash(h);
            });
        }
      } else if (h.path === "/" && !h.search && !h.media && !h.offset) {
        return miscNavigate(h.page);
      } else {
        state.miscMode = false;
        return loadDirectory(h.path, h.page, h.order, h.offset, h.media).then(
          function (data) {
            handleTargetMedia(data);
          },
        );
      }
    })
    .catch(function (error) {
      showError(error.code || "加载失败");
    });
}

var refreshCurrentGalleryRoute = function () {
  return loadCurrentGalleryRoute(true);
};

export function init() {
  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }
  window.addEventListener("resize", syncViewport);
  syncViewport();
  if (window.ResizeObserver) {
    var globalHeader = document.querySelector(".global-header");
    if (globalHeader) {
      new ResizeObserver(syncGlobalHeaderHeight).observe(globalHeader);
    }
  }
  document.querySelectorAll(".global-header h1").forEach(function (el) {
    el.addEventListener("click", function () {
      miscNavigate();
    });
  });
  window.addEventListener("hashchange", function () {
    if (state.suppressRoute) {
      state.suppressRoute = false;
      return;
    }
    loadCurrentGalleryRoute(false);
  });
  window.addEventListener("gallery-refresh-requested", function () {
    if (LB.isOpen && LB.isOpen()) {
      return;
    }
    state.queryEpoch = null;
    state.queryRevision = null;
    state.cursor = null;
    loadCurrentGalleryRoute(false);
  });
  window.addEventListener("gallery-library-status", function (event) {
    showLibraryWaiting((event && event.detail) || {});
  });
  (function boot() {
    LB.init();
    initSearchInputs();
    initScanWS();
    function initSidebar() {
      if (typeof Sidebar !== "undefined") return Sidebar.init();
      return Promise.resolve();
    }
    initSidebar().then(function () {
      checkRunningScan();
      return loadCurrentGalleryRoute(false);
    });
  })();
}
