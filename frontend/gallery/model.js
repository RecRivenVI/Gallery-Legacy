import { apiUrl } from "./view-data.js";
import { makeQueryHash } from "./query.js";
import { renderMetaText } from "./components/results.js";
import { LB } from "./viewer/player.js";
const PAGE_SIZE = 48;
const PAGE_SIZE_CHOICES = [24, 48, 72, 96, 120];
const CONTENT_WIDTH_MODES = ["standard", "wide"];
const PAGE_SIZE_LAYOUT_RESTRICTED = [96, 120];

// 移动端布局断点：与 CSS（design-system.css 的 ≤768px）保持一致。
// 移动端下「紧凑」布局与「全屏」宽度无实际意义（网格已按宽度自适应、内容已占满），
// 因此在移动端禁用这两个选项，并把它们归一到「默认网格 / 默认宽度」。
const LAYOUT_MOBILE_QUERY = "(max-width: 768px)";

function isMobileLayoutViewport() {
  return !!(
    window.matchMedia && window.matchMedia(LAYOUT_MOBILE_QUERY).matches
  );
}

// 布局配置（viewMode / contentWidth）按断点分别存储：桌面沿用原 key，移动端加 _mobile 后缀。
// 这样两个断点各自记住自己的布局，跨断点切换时能在两套配置之间平滑过渡。
function layoutStorageKey(base, mobile) {
  return mobile ? base + "_mobile" : base;
}

function coerceViewModeForViewport(mode, mobile) {
  mode = ["grid", "compact", "list"].indexOf(mode) >= 0 ? mode : "grid";
  if (mobile && mode === "compact") return "grid";
  return mode;
}

function coerceContentWidthForViewport(mode, mobile) {
  mode = mode === "wide" ? "wide" : "standard";
  if (mobile) return "standard";
  return mode;
}

// 设计图工具栏：数据库视图（最新作品 / 全部作者 / 作者作品 / 数据库搜索）的
// 每页数量、多规则排序、媒体类型筛选状态。持久化在 localStorage，跨路由保持一致。
// 每页数量只接受 PAGE_SIZE_CHOICES 内的预设值，非法 / 历史值回退默认 48。
function canUseRestrictedPageSize(viewMode, contentWidth) {
  return viewMode === "compact" && contentWidth === "wide";
}

function isRestrictedPageSize(n) {
  return PAGE_SIZE_LAYOUT_RESTRICTED.indexOf(n) >= 0;
}

function galleryLayoutKey(viewMode, contentWidth) {
  viewMode =
    ["grid", "compact", "list"].indexOf(viewMode) >= 0 ? viewMode : "grid";
  contentWidth = contentWidth === "wide" ? "wide" : "standard";
  return viewMode + "@" + contentWidth;
}

function readPersistedPageSize(viewMode, contentWidth) {
  var n = parseInt(localStorage.getItem("gallery_page_size"), 10);
  if (PAGE_SIZE_CHOICES.indexOf(n) < 0) return PAGE_SIZE;
  if (
    isRestrictedPageSize(n) &&
    !canUseRestrictedPageSize(viewMode, contentWidth)
  ) {
    localStorage.setItem("gallery_page_size", String(PAGE_SIZE));
    return PAGE_SIZE;
  }
  return n;
}

function readPersistedContentWidth(mobile) {
  var mode =
    localStorage.getItem(layoutStorageKey("gallery_content_width", mobile)) ||
    "standard";
  mode = CONTENT_WIDTH_MODES.indexOf(mode) >= 0 ? mode : "standard";
  return coerceContentWidthForViewport(mode, mobile);
}

function readPersistedViewMode(mobile) {
  var mode =
    localStorage.getItem(layoutStorageKey("gallery_view_mode", mobile)) ||
    "grid";
  return coerceViewModeForViewport(mode, mobile);
}

const initialMobileLayout = isMobileLayoutViewport();
const persistedViewMode = readPersistedViewMode(initialMobileLayout);
const persistedContentWidth = readPersistedContentWidth(initialMobileLayout);

const initialState = {
  cursor: null,
  path: "/",
  page: 1,
  order: "asc",
  items: [],
  allMedia: [],
  mediaOffset: 0,
  dbLightbox: null,
  totalMedia: 0,
  totalPages: 1,
  breadcrumbs: [],
  searchQuery: "",
  searchTag: "",
  searchMeta: true,
  miscMode: false,
  view: "browse",
  pageSize: readPersistedPageSize(persistedViewMode, persistedContentWidth),
  mediaType: localStorage.getItem("gallery_media_type") || "all",
  worksSort: localStorage.getItem("gallery_works_sort") || "date_desc",
  authorSort: localStorage.getItem("gallery_author_sort") || "name_asc",
  viewMode: persistedViewMode,
  contentWidth: persistedContentWidth,
  mobileLayout: initialMobileLayout,
};
const queryState = {},
  resultState = {},
  preferences = {},
  ephemeral = {};
const state = {};

var pendingRouteScrollTop = false;
var routeScrollFrame = 0;

function isDatabaseView(view) {
  view = view || state.view;
  return (
    view === "allWorks" ||
    view === "authors" ||
    view === "authorWorks" ||
    view === "dbSearch"
  );
}

function isDbFolderLightboxView(view) {
  view = view || state.view;
  return view === "allWorks" || view === "authorWorks" || view === "dbSearch";
}

function isDbFolderLightboxEligible() {
  return isDbFolderLightboxView(state.view);
}

function isDatabaseRoutePath(urlPath) {
  urlPath = String(urlPath || "");
  return (
    urlPath.indexOf("/@all/") === 0 ||
    urlPath.indexOf("/@authors/") === 0 ||
    urlPath.indexOf("/@author/") === 0
  );
}

function normalizeSearchSource(source) {
  if (source === true) return "db";
  if (source === false) return "fs";
  source = String(source || "").toLowerCase();
  return source === "db" || source === "fs" ? source : "";
}

function searchSourceForView() {
  return "db";
}

function resolveSearchSource() {
  return "db";
}

function cancelRouteScrollAnimation() {
  if (routeScrollFrame) {
    cancelAnimationFrame(routeScrollFrame);
    routeScrollFrame = 0;
  }
}

function requestRouteScrollTop() {
  cancelRouteScrollAnimation();
  pendingRouteScrollTop = true;
}

function consumeRouteScrollTop() {
  var value = pendingRouteScrollTop;
  pendingRouteScrollTop = false;
  return value;
}

function routeScrollEase(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function animateRouteScrollToTop(duration) {
  cancelRouteScrollAnimation();

  if (
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    window.scrollTo(window.scrollX || 0, 0);
    return;
  }

  var startY = window.scrollY || document.documentElement.scrollTop || 0;
  var startX = window.scrollX || 0;
  if (startY <= 1) {
    window.scrollTo(startX, 0);
    return;
  }

  var startTime = 0;
  var ms = duration || 220;

  function step(ts) {
    if (!startTime) startTime = ts;
    var t = Math.min(1, (ts - startTime) / ms);
    var eased = routeScrollEase(t);
    window.scrollTo(startX, startY * (1 - eased));

    if (t < 1) {
      routeScrollFrame = requestAnimationFrame(step);
    } else {
      routeScrollFrame = 0;
      window.scrollTo(startX, 0);
    }
  }

  routeScrollFrame = requestAnimationFrame(step);
}

function animateRouteScrollToElement(el, opts) {
  opts = opts || {};
  if (!el) return;

  cancelRouteScrollAnimation();

  var block = opts.block || "center";
  var duration = opts.duration || 240;

  if (
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    el.scrollIntoView({ block: block, inline: "nearest" });
    return;
  }

  var rect = el.getBoundingClientRect();
  var startY = window.scrollY || document.documentElement.scrollTop || 0;
  var startX = window.scrollX || 0;
  var targetY;

  if (block === "start") {
    targetY = startY + rect.top;
  } else if (block === "end") {
    targetY = startY + rect.bottom - window.innerHeight;
  } else {
    targetY = startY + rect.top + rect.height / 2 - window.innerHeight / 2;
  }

  var doc = document.documentElement;
  var body = document.body;
  var maxY = Math.max(
    0,
    Math.max(doc.scrollHeight, body.scrollHeight) - window.innerHeight,
  );
  targetY = Math.max(0, Math.min(maxY, targetY));

  var deltaY = targetY - startY;
  if (Math.abs(deltaY) < 1) {
    window.scrollTo(startX, targetY);
    return;
  }

  var startTime = 0;

  function step(ts) {
    if (!startTime) startTime = ts;
    var t = Math.min(1, (ts - startTime) / duration);
    var eased = routeScrollEase(t);
    window.scrollTo(startX, startY + deltaY * eased);

    if (t < 1) {
      routeScrollFrame = requestAnimationFrame(step);
    } else {
      routeScrollFrame = 0;
      window.scrollTo(startX, targetY);
    }
  }

  routeScrollFrame = requestAnimationFrame(step);
}

function scheduleRouteScrollToTop(duration) {
  cancelRouteScrollAnimation();
  routeScrollFrame = requestAnimationFrame(function () {
    routeScrollFrame = 0;
    animateRouteScrollToTop(duration);
  });
}

function scheduleRouteScrollToElement(el, opts) {
  cancelRouteScrollAnimation();
  routeScrollFrame = requestAnimationFrame(function () {
    routeScrollFrame = 0;
    animateRouteScrollToElement(el, opts);
  });
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

var RouteAnchor = (function () {
  var PREFIX = "gallery_route_anchor:";

  function routeKey(view, path, page, searchQuery) {
    return [
      view || state.view || "browse",
      path || state.path || "/",
      page || state.page || 1,
      searchQuery || state.searchQuery || "",
    ].join("|");
  }

  function currentRouteKey() {
    return routeKey(state.view, state.path, state.page, state.searchQuery);
  }

  function saveForRoute(view, path, page, searchQuery, anchor) {
    try {
      sessionStorage.setItem(
        PREFIX + routeKey(view, path, page, searchQuery),
        JSON.stringify(anchor),
      );
    } catch (e) {}
  }

  function saveForCurrentRoute(anchor) {
    saveForRoute(state.view, state.path, state.page, state.searchQuery, anchor);
  }

  function consumeForCurrentRoute() {
    var key = PREFIX + currentRouteKey();
    try {
      var raw = sessionStorage.getItem(key);
      if (!raw) return null;
      sessionStorage.removeItem(key);
      return JSON.parse(raw);
    } catch (e) {
      try {
        sessionStorage.removeItem(key);
      } catch (err) {}
      return null;
    }
  }

  function findDirCard(anchorPath) {
    var selector = '.card.dir[data-path="' + cssEscape(anchorPath) + '"]';
    var card = document.querySelector(selector);
    if (card) return card;

    var cards = document.querySelectorAll(".card.dir[data-path]");
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute("data-path") === anchorPath) return cards[i];
    }
    return null;
  }

  function restoreAfterRender() {
    var anchor = consumeForCurrentRoute();
    if (!anchor || anchor.anchorType !== "dir" || !anchor.anchorPath)
      return false;

    var card = findDirCard(anchor.anchorPath);
    if (!card) return false;

    scheduleRouteScrollToElement(card, {
      block: "center",
      duration: 240,
    });

    card.classList.add("route-return-highlight");
    setTimeout(function () {
      card.classList.remove("route-return-highlight");
    }, 3000);

    return true;
  }

  return {
    saveForCurrentRoute: saveForCurrentRoute,
    saveForRoute: saveForRoute,
    restoreAfterRender: restoreAfterRender,
  };
})();

function escHtml(s) {
  var d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function downloadUrl(url, filename) {
  var a = document.createElement("a");
  a.href = url;
  a.download = filename || "";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function copyText(text, onSuccess) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(function () {
        if (onSuccess) onSuccess();
      })
      .catch(function () {
        fallbackCopy(text);
      });
  } else {
    fallbackCopy(text);
  }
  function fallbackCopy(t) {
    var ta = document.createElement("textarea");
    ta.value = t;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      if (onSuccess) onSuccess();
    } catch (e) {}
    document.body.removeChild(ta);
  }
}

function absoluteUrl(url) {
  if (/^https?:\/\//i.test(url)) return url;
  return new URL(url, window.location.href).href;
}

function copyMediaLink(parentPath, mediaName, page, onSuccess) {
  copyText(
    location.origin +
      location.pathname +
      "#" +
      makeQueryHash(parentPath, { page, q: "", tag: "", media: mediaName }),
    onSuccess,
  );
}

function buildSearchHash(urlPath, query, source, page, tag) {
  return makeQueryHash(urlPath, { q: query, tag: tag, page: page });
}

function buildDbRouteHash(ctx = state.dbLightbox || {}) {
  return (
    "#" +
    makeQueryHash(ctx.routePath || state.path, {
      q: ctx.query ?? state.searchQuery,
      tag: ctx.tag ?? state.searchTag,
      page: ctx.page || state.page || 1,
    })
  );
}

function buildDbLightboxHash(ctx, mediaName) {
  var hash = buildDbRouteHash(ctx);
  var join = hash.indexOf("?") >= 0 ? "&" : "?";
  return (
    hash +
    join +
    "folder=" +
    encodeURIComponent(ctx.folderPath || "") +
    "&media=" +
    encodeURIComponent(mediaName || "")
  );
}

var CARD_ICONS = {
  link:
    '<svg class="default-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>' +
    '<svg class="check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>' +
    '<svg class="x-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  dl:
    '<svg class="default-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
    '<svg class="check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>' +
    '<svg class="x-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  source:
    '<svg class="default-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>' +
    '<svg class="check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>' +
    '<svg class="x-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

// 只标记空状态 / 错误信息等非卡片元素退场；卡片离场由 GridMotion 的 ghost 统一处理（不要用于 .card）。
// 本函数不等待动画结束，避免空态 / 错误态恢复到卡片列表时额外阻塞渲染。
function fadeOutEmptyOrErrorContent() {
  var els = document.querySelectorAll("#content .empty, #content .error-msg");
  // 卡片网格（无空状态/错误）时无需处理：立即返回，把 200ms 的“慢半拍”让位给即时重渲染，
  // 离场交给 GridMotion ghost 与新内容的进入并发播放。
  if (!els.length) return Promise.resolve();
  for (var i = 0; i < els.length; i++) {
    els[i].classList.remove("entrance");
    var anim = els[i].classList.contains("pg-disabled")
      ? "fadeOutDim"
      : "fadeOut";
    els[i].style.animation = anim + " .2s ease forwards";
  }
  return Promise.resolve();
}

function showError(msg) {
  document.getElementById("content").innerHTML =
    '<div class="error-msg entrance" style="animation-delay:.04s">Error: ' +
    escHtml(msg) +
    "</div>";
  var toolbar = document.getElementById("globalToolbar");
  if (toolbar) toolbar.innerHTML = "";
  if (typeof renderMetaText === "function") {
    renderMetaText("");
  } else {
    document.getElementById("meta").textContent = "";
  }
}

function updateLightbox(basePath, context) {
  var prefix =
    basePath != null ? basePath : state.path === "/" ? "" : state.path;
  var urls = [];
  var types = [];
  var names = [];
  for (var i = 0; i < state.allMedia.length; i++) {
    var m = state.allMedia[i];
    urls.push(apiUrl("media", prefix + "/" + m.name));
    types.push(m.type);
    names.push(m.name);
  }
  LB.setMedia(urls, types, names, context || null);
}

export {
  readPersistedPageSize,
  PAGE_SIZE_CHOICES,
  LAYOUT_MOBILE_QUERY,
  layoutStorageKey,
  coerceViewModeForViewport,
  coerceContentWidthForViewport,
  canUseRestrictedPageSize,
  isRestrictedPageSize,
  galleryLayoutKey,
  readPersistedContentWidth,
  readPersistedViewMode,
  state,
  isDatabaseView,
  isDbFolderLightboxEligible,
  isDatabaseRoutePath,
  normalizeSearchSource,
  searchSourceForView,
  resolveSearchSource,
  requestRouteScrollTop,
  consumeRouteScrollTop,
  animateRouteScrollToTop,
  scheduleRouteScrollToTop,
  cssEscape,
  RouteAnchor,
  escHtml,
  downloadUrl,
  copyText,
  copyMediaLink,
  buildSearchHash,
  buildDbRouteHash,
  buildDbLightboxHash,
  CARD_ICONS,
  fadeOutEmptyOrErrorContent,
  showError,
  updateLightbox,
};

export function init() {
  for (const [key, value] of Object.entries(initialState)) {
    const target = [
      "items",
      "allMedia",
      "totalMedia",
      "totalPages",
      "breadcrumbs",
      "mediaOffset",
    ].includes(key)
      ? resultState
      : ["viewMode", "contentWidth", "mobileLayout"].includes(key)
        ? preferences
        : [
              "path",
              "page",
              "order",
              "searchQuery",
              "searchTag",
              "mediaType",
              "worksSort",
              "authorSort",
              "pageSize",
              "cursor",
            ].includes(key)
          ? queryState
          : ephemeral;
    target[key] = value;
    Object.defineProperty(state, key, {
      enumerable: true,
      get() {
        return target[key];
      },
      set(v) {
        target[key] = v;
      },
    });
  }
  state.suppressRoute = false;
}
