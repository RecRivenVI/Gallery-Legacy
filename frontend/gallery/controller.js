import {
  apiUrl,
  authorPageView,
  workDetailView,
  workPageView,
} from "./view-data.js";
import {
  RouteAnchor,
  animateRouteScrollToTop,
  buildDbRouteHash,
  consumeRouteScrollTop,
  fadeOutEmptyOrErrorContent,
  isDbFolderLightboxEligible,
  resolveSearchSource,
  scheduleRouteScrollToTop,
  showError,
  state,
  updateLightbox,
} from "./model.js";
import {
  authorListPath,
  authorRoutePath,
  buildBreadcrumbsFromPath,
  decodeRoutePart,
  getPlatformName,
  getPlatformRoot,
  isAuthorListRoute,
  isAuthorWorksRoute,
  parseAuthorRoute,
} from "./routes.js";
import { makeQueryHash } from "./query.js";
import { LB } from "./viewer/player.js";
import { prepareBreadcrumbFade, render } from "./components/results.js";
import {
  renderAllWorks,
  renderAuthorWorks,
  renderSearchResult,
} from "./works.js";
import { renderAuthors } from "./authors.js";
import { Sidebar } from "./components/sidebar.js";
import { checkScanMode } from "./status.js";
import { syncSearchInputs, syncSearchMeta } from "./components/search.js";

function apiList(path) {
  return workDetailView(path);
}

// 工具栏筛选改变后重载当前数据库视图，回到第 1 页。优先改 hash（与翻页一致地经
// hashchange 触发加载）；若已在第 1 页（hash 不变）则直接派发对应 loader。
function dispatchDbLoaderPage1() {
  var view = state.view,
    path = state.path,
    q = state.searchQuery || "",
    tag = state.searchTag || "";
  if (view === "allWorks") {
    var pid = decodeRoutePart(path.replace("/@all/", ""));
    var r = getPlatformRoot(pid);
    if (r) return loadAllWorks(r, 1, q, tag);
  } else if (view === "authors") {
    var pid2 = path.replace("/@authors/", "");
    var r2 = getPlatformRoot(pid2);
    if (r2) return loadAuthors(r2, decodeRoutePart(pid2), 1, q);
  } else if (view === "authorWorks") {
    var ar = parseAuthorRoute(path);
    if (ar) {
      var r3 = getPlatformRoot(ar.platformId);
      if (r3) return loadAuthorWorks(r3, ar.platformId, ar.authorId, 1, q, tag);
    }
  } else if (view === "dbSearch") {
    return performSearch(path, q, 1, "db", tag);
  }
}

function reloadCurrentDbView() {
  const hash = makeQueryHash(state.path, {
    q: state.searchQuery,
    tag: state.searchTag,
    page: 1,
  });
  if (location.hash !== "#" + hash) location.hash = hash;
  else dispatchDbLoaderPage1();
}

var loadingLock = false;
var routeLoadSeq = 0;
var activeRouteLoadToken = 0;
var dbLightboxSwitching = false;

function beginRouteLoad() {
  activeRouteLoadToken = ++routeLoadSeq;
  loadingLock = true;
  return activeRouteLoadToken;
}

function isCurrentRouteLoad(token) {
  return token === activeRouteLoadToken;
}

function finishRouteLoad(token) {
  if (isCurrentRouteLoad(token)) {
    activeRouteLoadToken = 0;
    loadingLock = false;
  }
}

function resetLightboxForRouteLoad(keepReturnAnchor) {
  state.dbLightbox = null;
  if (LB.isOpen()) {
    LB.close({
      skipAnim: true,
      restoreScroll: false,
      clearReturnAnchor: true,
    });
  } else if (!keepReturnAnchor && LB.clearReturnAnchor) {
    LB.clearReturnAnchor();
  }
}

function dbFolderPathFromItem(item) {
  if (!item || !item.name) return "";
  var parentPath = item.parentPath || "";
  return parentPath ? parentPath + "/" + item.name : "/" + item.name;
}

function currentDbFolderList() {
  if (!isDbFolderLightboxEligible()) return [];
  var list = [];
  for (var i = 0; i < (state.items || []).length; i++) {
    var item = state.items[i];
    if (!item || (item.kind && item.kind !== "dir")) continue;
    var folderPath = dbFolderPathFromItem(item);
    if (!folderPath) continue;
    list.push({
      name: item.name,
      parentPath: item.parentPath || "",
      displayName: item.displayName || item.name,
      folderPath: folderPath,
    });
  }
  return list;
}

function parseDbRouteContext(routePath) {
  routePath = routePath || state.path || "";
  if (routePath.indexOf("/@all/") === 0) {
    var platformId = decodeRoutePart(routePath.replace("/@all/", ""));
    return {
      platformId: platformId,
      platformPath: getPlatformRoot(platformId),
      view: "allWorks",
    };
  }
  if (isAuthorWorksRoute(routePath)) {
    var authorRoute = parseAuthorRoute(routePath);
    if (!authorRoute) return null;
    return {
      platformId: authorRoute.platformId,
      authorId: authorRoute.authorId,
      platformPath: getPlatformRoot(authorRoute.platformId),
      view: "authorWorks",
    };
  }
  return { view: state.view };
}

function saveDbFolderRouteAnchor(ctx) {
  if (
    !ctx ||
    !ctx.folderPath ||
    typeof RouteAnchor === "undefined" ||
    !RouteAnchor.saveForRoute
  )
    return;
  RouteAnchor.saveForRoute(ctx.view, ctx.routePath, ctx.page, ctx.query || "", {
    anchorType: "dir",
    anchorPath: ctx.folderPath,
    scrollY: window.scrollY || document.documentElement.scrollTop || 0,
  });
}

function buildDbFolderLightboxContext(folderPath) {
  var folderList = currentDbFolderList();
  var folderIndex = -1;
  for (var i = 0; i < folderList.length; i++) {
    if (folderList[i].folderPath === folderPath) {
      folderIndex = i;
      break;
    }
  }
  if (folderIndex < 0) return null;
  var routeCtx = parseDbRouteContext(state.path) || {};
  return {
    source: "db-folder",
    view: state.view,
    routePath: state.path,
    platformId: routeCtx.platformId || "",
    authorId: routeCtx.authorId || "",
    platformPath: routeCtx.platformPath || "",
    query: state.searchQuery || "",
    tag: state.searchTag || "",
    page: state.page || 1,
    totalPages: state.totalPages || 1,
    folderPath: folderPath,
    folderIndex: folderIndex,
    folderList: folderList,
  };
}

function apiDbFolderMedia(folderPath) {
  return apiList(folderPath, 1, "asc").then(function (data) {
    var media = data && data.allMedia ? data.allMedia : [];
    return media.map(function (m) {
      return {
        name: m.name,
        type:
          m.type ||
          m.kind ||
          (/\.(mp4|webm|mkv|mov)$/i.test(m.name) ? "vid" : "img"),
      };
    });
  });
}

function setDbLightboxMedia(folderPath, mediaList, ctx) {
  state.dbLightbox = ctx;
  var urls = [];
  var types = [];
  var names = [];
  for (var i = 0; i < mediaList.length; i++) {
    var m = mediaList[i];
    urls.push(apiUrl("media", folderPath + "/" + m.name));
    types.push(m.type);
    names.push(m.name);
  }
  LB.setMedia(urls, types, names, ctx);
}

async function openDbFolderLightbox(folderPath, opts) {
  opts = opts || {};
  var ctx = opts.context || buildDbFolderLightboxContext(folderPath);
  if (!ctx) return false;
  var mediaList;
  try {
    mediaList = await apiDbFolderMedia(folderPath);
  } catch (err) {
    return false;
  }
  if (!mediaList || mediaList.length === 0) return false;
  if (opts.requireOpen && !LB.isOpen()) return false;

  var startIdx = opts.position === "last" ? mediaList.length - 1 : 0;
  if (opts.mediaName) {
    for (var i = 0; i < mediaList.length; i++) {
      if (mediaList[i].name === opts.mediaName) {
        startIdx = i;
        break;
      }
    }
  }

  ctx.folderPath = folderPath;
  ctx.mediaList = mediaList;
  ctx.mediaIndex = startIdx;
  saveDbFolderRouteAnchor(ctx);
  setDbLightboxMedia(folderPath, mediaList, ctx);
  if (opts.pushPageHistory && LB.isOpen()) {
    history.replaceState(null, "", buildDbRouteHash(ctx));
  }
  LB.openAt(startIdx, {
    replaceHistory: !!opts.replaceHistory,
    pushHistory: !!opts.pushPageHistory,
    animateSwitch: !!opts.animateSwitch,
  });
  return true;
}

async function fetchDbLightboxPage(ctx, page) {
  if (ctx.view === "allWorks")
    return apiAllWorks(ctx.platformPath, page, ctx.query, ctx.tag);
  if (ctx.view === "authorWorks")
    return apiAuthorWorks(
      ctx.platformPath,
      ctx.platformId,
      ctx.authorId,
      page,
      ctx.query,
      ctx.tag,
    );
  return workPageView(ctx.routePath, page, ctx.query, ctx.tag);
}

function applyDbLightboxPage(ctx, data, page) {
  if (!ctx || !data) return;
  state.path = ctx.routePath || state.path;
  state.miscMode = false;
  state.view = ctx.view;
  state.page = data.page || page;
  state.totalPages = data.totalPages || 1;
  state.items = data.items || [];
  state.allMedia = [];
  state.totalMedia = 0;
  state.searchQuery = ctx.query || "";
  state.searchTag = ctx.tag || "";
  state.searchMeta = true;
  if (ctx.view === "allWorks") {
    state.breadcrumbs = [
      { name: "首页", path: "/" },
      {
        name: ctx.platformId,
        displayName: ctx.platformId + " 最新作品",
        path: ctx.routePath,
      },
    ];
    renderAllWorks(data);
  } else if (ctx.view === "authorWorks") {
    state.breadcrumbs = data.breadcrumbs || [
      { name: "首页", path: "/" },
      {
        name: getPlatformName(ctx.platformId),
        displayName: getPlatformName(ctx.platformId) + " 全部作者",
        path: authorListPath(ctx.platformId),
      },
      { name: ctx.authorId, path: ctx.routePath },
    ];
    renderAuthorWorks(data);
  } else {
    state.breadcrumbs =
      data.breadcrumbs || buildBreadcrumbsFromPath(ctx.routePath);
    renderSearchResult(data);
  }
  if (typeof Sidebar !== "undefined") Sidebar.setActiveByPath(state.path);
}

async function switchDbFolderLightbox(direction) {
  if (dbLightboxSwitching) return false;
  var ctx = state.dbLightbox;
  if (!ctx || ctx.source !== "db-folder") return false;
  dbLightboxSwitching = true;
  direction = direction < 0 ? -1 : 1;
  var opened = false;
  if (LB.beginMediaSwitch) LB.beginMediaSwitch(direction);
  try {
    var page = state.page || ctx.page || 1;
    var totalPages = state.totalPages || ctx.totalPages || 1;
    var searchIndex = ctx.folderIndex + direction;

    while (page >= 1 && page <= totalPages) {
      var folderList = currentDbFolderList();
      if (searchIndex < 0 || searchIndex >= folderList.length) {
        page += direction;
        if (page < 1 || page > totalPages) return false;
        var data = await fetchDbLightboxPage(ctx, page);
        applyDbLightboxPage(ctx, data, page);
        totalPages = state.totalPages || totalPages;
        folderList = currentDbFolderList();
        searchIndex = direction > 0 ? 0 : folderList.length - 1;
      }

      while (searchIndex >= 0 && searchIndex < folderList.length) {
        var folder = folderList[searchIndex];
        var nextCtx = buildDbFolderLightboxContext(folder.folderPath);
        if (nextCtx) {
          opened = await openDbFolderLightbox(folder.folderPath, {
            context: nextCtx,
            position: direction < 0 ? "last" : "first",
            pushPageHistory:
              nextCtx.page !== ctx.page ||
              nextCtx.routePath !== ctx.routePath ||
              (nextCtx.query || "") !== (ctx.query || ""),
            requireOpen: true,
            animateSwitch: true,
          });
          if (opened) return true;
        }
        searchIndex += direction;
      }
    }
    return false;
  } finally {
    if (!opened && LB.finishMediaSwitch) LB.finishMediaSwitch(false);
    dbLightboxSwitching = false;
  }
}

function openDbFolderLightboxFromHash(hashInfo) {
  if (!hashInfo || !hashInfo.folder || !hashInfo.media) return;
  openDbFolderLightbox(hashInfo.folder, {
    mediaName: hashInfo.media,
    replaceHistory: true,
  });
}

function scrollRouteToTopIfRequested() {
  if (typeof consumeRouteScrollTop === "function" && consumeRouteScrollTop()) {
    if (typeof scheduleRouteScrollToTop === "function") {
      scheduleRouteScrollToTop(220);
    } else {
      requestAnimationFrame(function () {
        if (typeof animateRouteScrollToTop === "function") {
          animateRouteScrollToTop(220);
        } else {
          window.scrollTo(window.scrollX || 0, 0);
        }
      });
    }
  }
}

function restoreGridRouteScroll(skipAnchorRestore) {
  if (skipAnchorRestore) return;

  var restoredRouteAnchor = false;
  if (typeof RouteAnchor !== "undefined" && RouteAnchor.restoreAfterRender) {
    restoredRouteAnchor = RouteAnchor.restoreAfterRender();
  }

  if (restoredRouteAnchor) {
    if (typeof consumeRouteScrollTop === "function") consumeRouteScrollTop();
    return;
  }

  scrollRouteToTopIfRequested();
}

async function loadDirectory(path, page, order, offset, media) {
  var routeToken = beginRouteLoad();
  try {
    resetLightboxForRouteLoad(!!media);
    if (typeof Sidebar !== "undefined") Sidebar.setActiveByPath(path);
    prepareBreadcrumbFade(path);
    var [data] = await Promise.all([
      apiList(path, page, order, offset, media),
      fadeOutEmptyOrErrorContent(),
    ]);
    if (!isCurrentRouteLoad(routeToken)) return null;
    if (!data) return null;

    var canAutoEnterSingleDir =
      !media &&
      data.page === 1 &&
      data.totalPages === 1 &&
      data.totalItems === 1 &&
      data.items.length === 1 &&
      data.items[0].kind === "dir";
    if (canAutoEnterSingleDir) {
      var nextPath =
        data.path === "/"
          ? "/" + data.items[0].name
          : data.path + "/" + data.items[0].name;
      var hash = nextPath + "?page=1";
      state.suppressRoute = true;
      history.replaceState(null, "", "#" + hash);
      if (Sidebar) Sidebar.setActiveByPath(nextPath);
      return loadDirectory(nextPath, 1, order);
    }

    state.suppressRoute = false;

    state.path = data.path;
    state.miscMode = false;
    state.view = "browse";
    state.page = data.page;
    state.order = data.order || "asc";
    state.items = data.items;
    state.allMedia = data.allMedia;
    state.totalMedia = data.totalMedia;
    state.totalPages = data.totalPages;
    state.mediaOffset = data.mediaOffset || 0;
    state.breadcrumbs = data.breadcrumbs;
    render(data);
    updateLightbox();

    restoreGridRouteScroll(!!media);
    if (typeof checkScanMode === "function") checkScanMode();
    return data;
  } catch (err) {
    if (isCurrentRouteLoad(routeToken)) showError(err.message);
  } finally {
    finishRouteLoad(routeToken);
  }
}

// 灯箱翻到当前页之外的媒体时，把底层页面同步翻过去。
// 文件根（miscMode）以前在第一行就被挡掉了，于是在「所有文件」里翻到下一页的图，
// 底层还停在上一页——现在两种路由都走同一条同步路径，只是各自问各自的端点。
async function syncFsLightboxPage(mediaName) {
  if (
    !mediaName ||
    (state.view !== "browse" && state.view !== "misc") ||
    state.searchQuery ||
    state.dbLightbox
  )
    return null;
  var isMisc = state.miscMode;
  var view = state.view;
  var routeToken = beginRouteLoad();
  try {
    var [data] = await Promise.all([
      apiList(state.path),
      fadeOutEmptyOrErrorContent(),
    ]);
    if (!isCurrentRouteLoad(routeToken) || !data) return null;
    if (data.path !== state.path) return null;

    state.path = data.path;
    state.miscMode = isMisc;
    state.view = view;
    state.page = data.page;
    state.order = data.order || "asc";
    state.items = data.items;
    state.allMedia = data.allMedia;
    state.totalMedia = data.totalMedia;
    state.totalPages = data.totalPages;
    state.mediaOffset = data.mediaOffset || 0;
    state.breadcrumbs = data.breadcrumbs;
    render(data);
    updateLightbox();

    if (typeof checkScanMode === "function") checkScanMode();
    return data;
  } catch (err) {
    if (isCurrentRouteLoad(routeToken) && window.console && console.warn) {
      console.warn("Gallery operation failed");
    }
    return null;
  } finally {
    finishRouteLoad(routeToken);
  }
}

async function performSearch(path, query, page, source, tag) {
  var routeToken = beginRouteLoad();
  resetLightboxForRouteLoad(false);
  var searchSource = resolveSearchSource(source, path);
  state.path = path;
  state.view = searchSource === "db" ? "dbSearch" : "search";
  state.searchQuery = query;
  state.searchTag = tag || "";
  state.searchMeta = searchSource === "db";
  try {
    var [data] = await Promise.all([
      workPageView(path, page, query, tag),
      fadeOutEmptyOrErrorContent(),
    ]);
    if (!isCurrentRouteLoad(routeToken)) return null;
    state.view = data.db ? "dbSearch" : "search";
    state.page = data.page;
    state.totalPages = data.totalPages;
    state.order = data.order || state.order;
    state.items = data.items || [];
    state.allMedia = [];
    state.totalMedia = 0;
    state.breadcrumbs = data.breadcrumbs || buildBreadcrumbsFromPath(path);
    renderSearchResult(data);
    if (typeof Sidebar !== "undefined") Sidebar.setActiveByPath(path);
    restoreGridRouteScroll(false);
    return data;
  } catch (err) {
    if (isCurrentRouteLoad(routeToken)) showError(err.message);
  } finally {
    finishRouteLoad(routeToken);
  }
}

function loadSearchRoute(path, query, page, source, tag) {
  if (isAuthorListRoute(path)) {
    var authorListPlatformId = path.replace("/@authors/", "");
    var authorListRoot = getPlatformRoot(authorListPlatformId);
    if (authorListRoot)
      return loadAuthors(
        authorListRoot,
        decodeRoutePart(authorListPlatformId),
        page,
        query,
      );
  }

  if (isAuthorWorksRoute(path)) {
    var authorRoute = parseAuthorRoute(path);
    if (authorRoute) {
      var authorRoot = getPlatformRoot(authorRoute.platformId);
      if (authorRoot)
        return loadAuthorWorks(
          authorRoot,
          authorRoute.platformId,
          authorRoute.authorId,
          page,
          query,
          tag,
        );
    }
  }

  var searchPath = path;
  if (searchPath.indexOf("/@all/") === 0) {
    var allPlatformId = decodeRoutePart(searchPath.replace("/@all/", ""));
    var allRoot = getPlatformRoot(allPlatformId);
    if (allRoot) return loadAllWorks(allRoot, page, query, tag);
    searchPath = "/";
  }
  return performSearch(searchPath, query, page, source, tag);
}

async function apiAllWorks(platformPath, page, query, tag) {
  return workPageView(platformPath, page, query, tag);
}

async function loadAllWorks(platformPath, page, query, tag) {
  var routeToken = beginRouteLoad();
  query = query || "";
  tag = tag || "";
  try {
    resetLightboxForRouteLoad(false);
    var platformName = platformPath.split("/").pop();
    if (typeof Sidebar !== "undefined") Sidebar.setActive(platformName, "all");
    prepareBreadcrumbFade("/@all/" + platformName);
    var [data] = await Promise.all([
      apiAllWorks(platformPath, page, query, tag),
      fadeOutEmptyOrErrorContent(),
    ]);
    if (!isCurrentRouteLoad(routeToken)) return null;
    state.path = "/@all/" + platformName;
    state.miscMode = false;
    state.view = "allWorks";
    if (typeof Sidebar !== "undefined") Sidebar.setActiveByPath(state.path);
    state.page = data.page;
    state.totalPages = data.totalPages;
    state.items = data.items || [];
    state.allMedia = [];
    state.totalMedia = 0;
    state.breadcrumbs = [
      { name: "首页", path: "/" },
      {
        name: platformName,
        displayName: platformName + " 最新作品",
        path: "/@all/" + platformName,
      },
    ];
    state.searchQuery = query;
    state.searchTag = tag;
    state.searchMeta = true;
    syncSearchInputs(query);
    syncSearchMeta();
    renderAllWorks(data);
    restoreGridRouteScroll(false);
    if (typeof checkScanMode === "function") checkScanMode();
    return data;
  } catch (err) {
    if (isCurrentRouteLoad(routeToken)) showError(err.message);
  } finally {
    finishRouteLoad(routeToken);
  }
}

async function apiAuthors(platformPath, platformId, page, query) {
  return authorPageView(platformId, page, query);
}

async function loadAuthors(platformPath, platformId, page, query) {
  var routeToken = beginRouteLoad();
  query = query || "";
  try {
    resetLightboxForRouteLoad(false);
    if (typeof Sidebar !== "undefined") Sidebar.setActive(platformId, "list");
    var routePath = authorListPath(platformId);
    prepareBreadcrumbFade(routePath);
    var [data] = await Promise.all([
      apiAuthors(platformPath, platformId, page, query),
      fadeOutEmptyOrErrorContent(),
    ]);
    if (!isCurrentRouteLoad(routeToken)) return null;
    state.path = routePath;
    state.miscMode = false;
    state.view = "authors";
    if (typeof Sidebar !== "undefined") Sidebar.setActiveByPath(state.path);
    state.page = data.page;
    state.totalPages = data.totalPages;
    state.items = data.items || [];
    state.allMedia = [];
    state.totalMedia = 0;
    state.breadcrumbs = data.breadcrumbs || [
      { name: "首页", path: "/" },
      {
        name: getPlatformName(platformId),
        displayName: getPlatformName(platformId) + " 全部作者",
        path: routePath,
      },
    ];
    state.searchQuery = query;
    state.searchMeta = true;
    syncSearchInputs(query);
    syncSearchMeta();
    renderAuthors(data);
    restoreGridRouteScroll(false);
    if (typeof checkScanMode === "function") checkScanMode();
    return data;
  } catch (err) {
    if (isCurrentRouteLoad(routeToken)) showError(err.message);
  } finally {
    finishRouteLoad(routeToken);
  }
}

async function apiAuthorWorks(
  platformPath,
  platformId,
  authorId,
  page,
  query,
  tag,
) {
  const data = await workPageView(platformPath, page, query, tag, authorId);
  return { ...data, authorId, authorName: data.items[0]?.subtitle || "作者" };
}

async function loadAuthorWorks(
  platformPath,
  platformId,
  authorId,
  page,
  query,
  tag,
) {
  var routeToken = beginRouteLoad();
  query = query || "";
  tag = tag || "";
  try {
    resetLightboxForRouteLoad(false);
    if (typeof Sidebar !== "undefined") Sidebar.setActive(platformId, "list");
    var routePath = authorRoutePath(platformId, authorId);
    prepareBreadcrumbFade(routePath);
    var [data] = await Promise.all([
      apiAuthorWorks(platformPath, platformId, authorId, page, query, tag),
      fadeOutEmptyOrErrorContent(),
    ]);
    if (!isCurrentRouteLoad(routeToken)) return null;
    state.path = routePath;
    state.miscMode = false;
    state.view = "authorWorks";
    if (typeof Sidebar !== "undefined") Sidebar.setActiveByPath(state.path);
    state.page = data.page;
    state.totalPages = data.totalPages;
    state.items = data.items || [];
    state.allMedia = [];
    state.totalMedia = 0;
    state.breadcrumbs = data.breadcrumbs || [
      { name: "首页", path: "/" },
      {
        name: getPlatformName(platformId),
        displayName: getPlatformName(platformId) + " 全部作者",
        path: authorListPath(platformId),
      },
      { name: authorId, path: routePath },
    ];
    state.searchQuery = query;
    state.searchTag = tag;
    state.searchMeta = true;
    syncSearchInputs(query);
    syncSearchMeta();
    renderAuthorWorks(data);
    restoreGridRouteScroll(false);
    if (typeof checkScanMode === "function") checkScanMode();
    return data;
  } catch (err) {
    if (isCurrentRouteLoad(routeToken)) showError(err.message);
  } finally {
    finishRouteLoad(routeToken);
  }
}

export {
  reloadCurrentDbView,
  openDbFolderLightbox,
  switchDbFolderLightbox,
  openDbFolderLightboxFromHash,
  loadDirectory,
  syncFsLightboxPage,
  performSearch,
  loadSearchRoute,
  loadAllWorks,
  loadAuthors,
  loadAuthorWorks,
};
