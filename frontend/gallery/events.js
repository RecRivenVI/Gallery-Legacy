import {
  RouteAnchor,
  buildSearchHash,
  copyMediaLink,
  downloadUrl,
  isDatabaseView,
  isDbFolderLightboxEligible,
  requestRouteScrollTop,
  searchSourceForView,
  state,
} from "./model.js";
import {
  currentPlatformIdForFilter,
  openFilterPopover,
  openWorkDetail,
  searchForTag,
  setViewMode,
} from "./components/settings.js";
import { authorListPath, navigate } from "./routes.js";
import { apiUrl } from "./view-data.js";
import {
  loadDirectory,
  loadSearchRoute,
  openDbFolderLightbox,
  performSearch,
  reloadCurrentDbView,
} from "./controller.js";

export function init() {
  document.addEventListener("click", function (e) {
    function saveDirRouteAnchor(anchorPath) {
      if (
        typeof RouteAnchor !== "undefined" &&
        RouteAnchor.saveForCurrentRoute
      ) {
        RouteAnchor.saveForCurrentRoute({
          anchorType: "dir",
          anchorPath: anchorPath,
          scrollY: window.scrollY || document.documentElement.scrollTop || 0,
        });
      }
    }

    // 标签点击筛选（设计 §13）：以该标签做数据库搜索
    var mediaTag = e.target.closest(".media-tag[data-tag]");
    if (mediaTag) {
      e.preventDefault();
      e.stopPropagation();
      var tagVal = mediaTag.getAttribute("data-tag");
      if (typeof searchForTag === "function") searchForTag(tagVal);
      return;
    }

    // 作者作为信息入口（设计 §12）
    var mediaAuthor = e.target.closest(".media-author[data-author-route]");
    if (mediaAuthor) {
      e.preventDefault();
      e.stopPropagation();
      navigate(mediaAuthor.getAttribute("data-author-route"));
      return;
    }

    // 作品详情浮层（设计 §11）：点击标题打开
    var detailTrigger = e.target.closest("[data-detail]");
    if (detailTrigger) {
      var detailCard = detailTrigger.closest(".card");
      if (detailCard && typeof openWorkDetail === "function") {
        e.preventDefault();
        e.stopPropagation();
        openWorkDetail(detailCard);
        return;
      }
    }

    // 顶栏筛选开关：切换 #dbFilterbar 抽屉的展开态（仅 UI，不触碰业务筛选逻辑）。
    var filterbarToggle = e.target.closest(".header-filter-toggle");
    if (filterbarToggle) {
      e.preventDefault();
      var filterbar = document.getElementById("dbFilterbar");
      if (filterbar) {
        var fbOpen = filterbar.classList.toggle("expanded");
        filterbarToggle.classList.toggle("expanded", fbOpen);
        filterbarToggle.setAttribute(
          "aria-expanded",
          fbOpen ? "true" : "false",
        );
      }
      return;
    }

    // 筛选工具栏弹出按钮（标签筛选）。
    var filterBtn = e.target.closest(".filter-btn[data-filter-btn]");
    if (filterBtn) {
      e.preventDefault();
      if (typeof openFilterPopover === "function")
        openFilterPopover(filterBtn.getAttribute("data-filter-btn"), filterBtn);
      return;
    }

    var menuBtn = e.target.closest(".filter-menu-btn[data-menu-btn]");
    if (menuBtn) {
      e.preventDefault();
      if (typeof openFilterPopover === "function")
        openFilterPopover(menuBtn.getAttribute("data-menu-btn"), menuBtn);
      return;
    }

    var dl = e.target.closest(".dl-btn");
    if (dl) {
      e.preventDefault();
      var p = dl.getAttribute("data-path");
      downloadUrl(apiUrl("media", p), p.split("/").pop());
      dl.classList.add("success");
      setTimeout(function () {
        dl.classList.remove("success");
      }, 1500);
      return;
    }

    var linkCopy = e.target.closest(".link-copy");
    if (linkCopy) {
      e.preventDefault();
      var card = linkCopy.closest(".card.img");
      if (card) {
        var lbIdx = parseInt(card.getAttribute("data-lb-index"));
        var m = state.allMedia[lbIdx];
        if (m) copyMediaLink(state.path, m.name, state.page);
      }
      linkCopy.classList.add("success");
      setTimeout(function () {
        linkCopy.classList.remove("success");
      }, 1500);
      return;
    }

    var linkBtn = e.target.closest(".link-btn");
    if (linkBtn) {
      e.preventDefault();
      var card = linkBtn.closest(".card.img");
      if (card) {
        var lbIdx = parseInt(card.getAttribute("data-lb-index"));
        var m = state.allMedia[lbIdx];
        if (m) copyMediaLink(state.path, m.name, state.page);
      }
      linkBtn.classList.add("success");
      setTimeout(function () {
        linkBtn.classList.remove("success");
      }, 1500);
      return;
    }

    var searchDir = e.target.closest("[data-search-path]");
    if (searchDir) {
      e.preventDefault();
      var searchDirPath = searchDir.getAttribute("data-search-path");
      if (isDbFolderLightboxEligible()) {
        openDbFolderLightbox(searchDirPath);
        return;
      }
      saveDirRouteAnchor(searchDirPath);
      navigate(searchDirPath);
      return;
    }

    var searchMedia = e.target.closest("[data-search-parent]");
    if (searchMedia) {
      e.preventDefault();
      var parentPath = searchMedia.getAttribute("data-search-parent");
      var mediaName = searchMedia.getAttribute("data-search-media");
      navigate(parentPath, 1, state.order, mediaName);
      return;
    }

    var bc = e.target.closest(".breadcrumb a[data-path]");
    if (bc) {
      e.preventDefault();
      navigate(bc.getAttribute("data-path"));
      return;
    }

    var dir = e.target.closest(".card.dir[data-path]");
    if (dir) {
      e.preventDefault();
      var childPath = dir.getAttribute("data-path");
      if (isDbFolderLightboxEligible()) {
        openDbFolderLightbox(childPath);
        return;
      }
      saveDirRouteAnchor(childPath);
      navigate(childPath);
      return;
    }

    var segBtn = e.target.closest(".db-filterbar .seg-btn[data-value]");
    if (segBtn) {
      e.preventDefault();
      if (segBtn.disabled) return;
      var seg = segBtn.closest(".filter-seg");
      var segFilter = seg ? seg.getAttribute("data-filter") : "";
      var segVal = segBtn.getAttribute("data-value");
      if (segFilter === "mediaType" && segVal !== state.mediaType) {
        state.mediaType = segVal;
        localStorage.setItem("gallery_media_type", segVal);
        if (typeof reloadCurrentDbView === "function") reloadCurrentDbView();
      } else if (segFilter === "viewMode" && segVal !== state.viewMode) {
        if (typeof setViewMode === "function") setViewMode(segVal);
      } else if (segFilter === "browseMode") {
        // 顶栏浏览模式切换：最新作品(/@all/{pid}) <-> 全部作者(/@authors/{pid})。
        var curMode = /^\/@authors?\//.test(state.path || "")
          ? "authors"
          : "works";
        if (segVal !== curMode) {
          var pid =
            typeof currentPlatformIdForFilter === "function"
              ? currentPlatformIdForFilter()
              : "";
          if (pid) {
            if (typeof requestRouteScrollTop === "function")
              requestRouteScrollTop();
            if (segVal === "authors") navigate(authorListPath(pid));
            else navigate("/@all/" + pid);
          }
        }
      }
      return;
    }

    var sortBtn = e.target.closest(".sort-btn");
    if (sortBtn) {
      e.preventDefault();
      if (
        typeof isDatabaseView === "function"
          ? isDatabaseView(state.view)
          : state.view === "allWorks" ||
            state.view === "authors" ||
            state.view === "authorWorks" ||
            state.view === "dbSearch"
      )
        return;
      var newOrder = state.order === "asc" ? "desc" : "asc";
      state.order = newOrder;
      localStorage.setItem("gallery_order", newOrder);
      if (typeof requestRouteScrollTop === "function") requestRouteScrollTop();
      if (state.searchQuery) {
        performSearch(
          state.path,
          state.searchQuery,
          state.page,
          searchSourceForView(state.view),
        );
      } else {
        loadDirectory(state.path, state.page, newOrder);
      }
      return;
    }

    var pg = e.target.closest("[data-page]");
    if (pg && !pg.classList.contains("pg-disabled")) {
      e.preventDefault();
      var page = parseInt(pg.getAttribute("data-page"));
      if (!isNaN(page)) {
        if (state.searchQuery) {
          var source = searchSourceForView(state.view);
          var hash = buildSearchHash(
            state.path,
            state.searchQuery,
            source,
            page,
            state.searchTag,
          );
          if (typeof requestRouteScrollTop === "function")
            requestRouteScrollTop();
          if (window.location.hash !== "#" + hash) {
            window.location.hash = hash;
          } else {
            loadSearchRoute(
              state.path,
              state.searchQuery,
              page,
              source,
              state.searchTag,
            );
          }
        } else {
          navigate(state.path, page);
        }
      }
      return;
    }
  });
}
