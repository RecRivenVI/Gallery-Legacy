import { isDatabaseRoutePath, showError, state } from "./model.js";
import { LB } from "./viewer/player.js";
import {
  getPlatformRoot,
  miscNavigate,
  parseAuthorRoute,
  parseHash,
} from "./routes.js";
import { Sidebar } from "./components/sidebar.js";
import {
  loadAllWorks,
  loadAuthorWorks,
  loadAuthors,
  loadDirectory,
  loadSearchRoute,
  openDbFolderLightboxFromHash,
} from "./controller.js";
import { initSearchInputs } from "./components/search.js";
import { checkRunningScan, initScanWS } from "./status.js";
import { currentGeneration } from "../shared/api.js";

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
      "#" + state.path + (state.page > 1 ? "?page=" + state.page : "");
    history.replaceState(null, "", cleanHash);
    for (var i = 0; i < state.allMedia.length; i++) {
      if (state.allMedia[i].name === data.targetMedia) {
        LB.openAt(i);
        break;
      }
    }
  }
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
      if (
        h.generation &&
        h.generation !== currentGeneration() &&
        (h.folder || /^\/(?:work|@author)\//.test(h.path))
      ) {
        showError("链接属于其他数据版本，请从平台列表重新选择作品或作者");
        return;
      }
      if (h.search || h.tag) {
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
