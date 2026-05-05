import {
  LAYOUT_MOBILE_QUERY,
  buildSearchHash,
  canUseRestrictedPageSize,
  coerceContentWidthForViewport,
  coerceViewModeForViewport,
  copyText,
  escHtml,
  galleryLayoutKey,
  isDatabaseView,
  isRestrictedPageSize,
  layoutStorageKey,
  readPersistedContentWidth,
  readPersistedViewMode,
  requestRouteScrollTop,
  state,
} from "../model.js";
import { syncSearchInputs } from "./search.js";
import {
  authorListPath,
  authorRoutePath,
  decodeRoutePart,
  miscNavigate,
  navigate,
  normalizeHash,
  parseAuthorRoute,
} from "../routes.js";
import {
  loadSearchRoute,
  openDbFolderLightbox,
  reloadCurrentDbView,
} from "../controller.js";
import { apiUrl } from "../view-data.js";
import { mountTagBrowser } from "../tags.js";
import { makeQueryHash } from "../query.js";
import { configuredSortOptions } from "./results.js";
import { escAttr, formatCardDate, gridViewClass } from "./cards.js";
import { GalleryMenu } from "./popover.js";
import { GridMotion } from "./motion.js";
import { GalleryTheme } from "../../shared/theme.js";
import { ScanWS } from "../../shared/events.js";
// ============================================================
// 中性重构交互层：顶部弹层（通知/设置/头像）、视图切换、标签筛选、
// 作品详情浮层、工具栏筛选弹层。配合 neutral-redesign.css。
// ============================================================

var toastTimer = null;
var galleryToast = function (text, intent) {
  var toast = document.getElementById("galleryToast");
  if (!toast || !text) return;
  clearTimeout(toastTimer);
  toast.textContent = text;
  toast.className = "gallery-toast show " + (intent || "info");
  toastTimer = setTimeout(function () {
    toast.classList.remove("show");
  }, 3000);
};

// ---- 视图切换（网格 / 紧凑 / 列表）----
function setViewMode(mode) {
  applyGalleryLayoutState({ viewMode: mode });
}

function currentGalleryLayoutKey(viewMode, contentWidth) {
  if (typeof galleryLayoutKey === "function") {
    return galleryLayoutKey(
      viewMode || state.viewMode || "grid",
      contentWidth || state.contentWidth || "standard",
    );
  }
  return (
    (viewMode || state.viewMode || "grid") +
    "@" +
    (contentWidth || state.contentWidth || "standard")
  );
}

function syncCardsForLayoutState(viewMode, contentWidth) {
  var cards = document.querySelectorAll(
    "#content .grid .card[data-content-key]",
  );
  var layout = currentGalleryLayoutKey(viewMode, contentWidth);
  for (var i = 0; i < cards.length; i++) {
    var content = cards[i].getAttribute("data-content-key") || "";
    var motion = content + "::" + layout;
    cards[i].setAttribute("data-layout-key", layout);
    cards[i].setAttribute("data-motion-key", motion);
  }
}

function syncCardsForContentWidthMode(widthMode) {
  syncCardsForLayoutState(
    state.viewMode || "grid",
    widthMode || state.contentWidth || "standard",
  );
}

// 标签按可用空间裁剪：网格/紧凑模式单行横向，超出宽度的标签整体隐藏；
// 列表模式纵向换行填充，超出可用高度的标签整体隐藏。不再做溢出滚动。
function syncCardTags(root) {
  root = root || document;
  var boxes = root.querySelectorAll(".media-tags");
  for (var i = 0; i < boxes.length; i++) {
    var box = boxes[i];
    var vertical = !!(box.closest && box.closest(".grid.view-list"));
    var tags = box.children;
    for (var j = 0; j < tags.length; j++)
      tags[j].classList.remove("tag-hidden");
    var br = box.getBoundingClientRect();
    var hide = false;
    for (var k = 0; k < tags.length; k++) {
      var tag = tags[k];
      if (hide) {
        tag.classList.add("tag-hidden");
        continue;
      }
      var tr = tag.getBoundingClientRect();
      var overflow = vertical
        ? tr.bottom > br.bottom + 0.5
        : tr.right > br.right + 0.5;
      if (overflow) {
        tag.classList.add("tag-hidden");
        hide = true;
      }
    }
  }
}

var GRID_COLUMN_CHOICES = [1, 2, 4, 6, 8, 12];

// 网格列数规则：所有视图均使用固定列数集合（1/2/4/6/8/12），列表不再走固定 1/2。
// 按内容区实际宽度计算并写入 inline 列模板，不依赖媒体查询断点，可随侧栏折叠、
// 窗口缩放和宽度设置精确响应。
function normalizeGridColumnCount(cols) {
  cols = Math.max(1, cols || 1);
  var selected = GRID_COLUMN_CHOICES[0];
  for (var i = 0; i < GRID_COLUMN_CHOICES.length; i++) {
    if (GRID_COLUMN_CHOICES[i] <= cols) selected = GRID_COLUMN_CHOICES[i];
  }
  return selected;
}

function gridMinCardWidth(mode, cs) {
  var fallback = mode === "compact" ? 144 : mode === "list" ? 430 : 192;
  var raw = (cs.getPropertyValue("--gallery-card-min") || "").trim();
  if (!raw || raw.indexOf("%") >= 0) return fallback;
  var value = parseFloat(raw);
  return value > 0 ? value : fallback;
}

function applyGridColumnsRaw(root) {
  root = root || document;
  var grid = root.querySelector ? root.querySelector("#content .grid") : null;
  if (!grid) grid = document.querySelector("#content .grid");
  if (!grid) return;
  var mode = state.viewMode || "grid";
  var cs = getComputedStyle(grid);
  var gap = parseFloat(cs.columnGap) || 0;
  var w = grid.clientWidth;
  var cols;
  var minCard = gridMinCardWidth(mode, cs);
  cols = Math.floor((w + gap) / (minCard + gap));
  cols = normalizeGridColumnCount(cols);
  grid.style.gridTemplateColumns = "repeat(" + cols + ", minmax(0, 1fr))";
}

function applyGridColumns(root) {
  return applyGridColumnsRaw(root);
}

// 纯布局重排：立即更新列数与标签裁剪，不做动画。
function applyGridColumnsImmediate(root) {
  applyGridColumnsRaw(root);
  if (typeof syncCardTags === "function") syncCardTags(root);
}

// ---- 标签点击筛选（设计 §13）----
function searchForTag(tag) {
  tag = String(tag || "");
  if (!tag) return;
  if (typeof requestRouteScrollTop === "function") requestRouteScrollTop();
  var path =
    typeof isDatabaseView === "function" && isDatabaseView(state.view)
      ? state.path || "/"
      : "/";
  var hash = buildSearchHash(path, state.searchQuery || "", "db", 1, tag);
  if (typeof syncSearchInputs === "function")
    syncSearchInputs(state.searchQuery || "");
  if (
    typeof normalizeHash === "function" &&
    normalizeHash(window.location.hash) !== normalizeHash(hash)
  ) {
    window.location.hash = hash;
  } else {
    loadSearchRoute(path, state.searchQuery || "", 1, "db", tag);
  }
}

// ---- 作品详情浮层（设计 §11）----
function openWorkDetail(card) {
  if (!card) return;
  var path =
    card.getAttribute("data-d-path") || card.getAttribute("data-path") || "";
  var d = {
    title: card.getAttribute("data-d-title") || "",
    author: card.getAttribute("data-d-author") || "",
    authorId: card.getAttribute("data-d-author-id") || "",
    platform: card.getAttribute("data-d-platform") || "",
    date: card.getAttribute("data-d-date") || "",
    source: card.getAttribute("data-d-source") || "",
    tags: JSON.parse(card.getAttribute("data-d-tags") || "[]"),
    cover: card.getAttribute("data-d-cover") || "",
    path: path,
  };
  renderWorkDetail(d);
}

function renderWorkDetail(d) {
  var overlay = document.getElementById("detailOverlay");
  var coverEl = document.getElementById("detailCover");
  var metaEl = document.getElementById("detailMeta");
  if (!overlay || !coverEl || !metaEl) return;

  var closeBtn = coverEl.querySelector(".detail-close");
  var imgHtml = "";
  if (d.cover && d.path) {
    var coverFull = d.path + "/" + d.cover;
    imgHtml = '<img src="' + apiUrl("thumbnail", coverFull) + '" alt="">';
  }
  coverEl.innerHTML = "";
  if (closeBtn) coverEl.appendChild(closeBtn);
  if (imgHtml) coverEl.insertAdjacentHTML("beforeend", imgHtml);

  var html = "<h2>" + escHtml(d.title) + "</h2>";
  if (d.author) {
    if (d.authorId && d.platform) {
      html +=
        '<div class="detail-field"><span class="dl">作者</span><a data-detail-author="' +
        escAttr(authorRoutePath(d.platform, d.authorId)) +
        '">@' +
        escHtml(d.author) +
        "</a></div>";
    } else {
      html +=
        '<div class="detail-field"><span class="dl">作者</span>@' +
        escHtml(d.author) +
        "</div>";
    }
  }
  if (d.platform)
    html +=
      '<div class="detail-field"><span class="dl">平台</span>' +
      escHtml(d.platform) +
      "</div>";
  if (d.date)
    html +=
      '<div class="detail-field"><span class="dl">发布</span>' +
      escHtml(formatCardDate(d.date)) +
      "</div>";
  if (d.path)
    html +=
      '<div class="detail-field"><span class="dl">路径</span>' +
      escHtml(d.path) +
      "</div>";
  if (d.source)
    html +=
      '<div class="detail-field"><span class="dl">来源</span><a data-detail-source="' +
      escAttr(d.source) +
      '">' +
      escHtml(d.source) +
      "</a></div>";
  if (d.tags && d.tags.length) {
    html +=
      '<div class="detail-field"><span class="dl">标签</span></div><div class="detail-tags">';
    for (var i = 0; i < d.tags.length; i++) {
      html +=
        '<span class="media-tag" data-tag="' +
        escAttr(d.tags[i]) +
        '">' +
        escHtml(d.tags[i]) +
        "</span>";
    }
    html += "</div>";
  }
  html += '<div class="detail-actions">';
  html +=
    '<button data-detail-open="' + escAttr(d.path) + '">进入图集</button>';
  if (d.authorId && d.platform)
    html +=
      '<button data-detail-author="' +
      escAttr(authorRoutePath(d.platform, d.authorId)) +
      '">作者作品</button>';
  if (d.source)
    html +=
      '<button data-detail-copy-source="' +
      escAttr(d.source) +
      '">复制源链接</button>';
  html +=
    '<button data-detail-copy-path="' + escAttr(d.path) + '">复制路径</button>';
  html += "</div>";
  metaEl.innerHTML = html;

  overlay.classList.add("open");
}

function closeWorkDetail() {
  var overlay = document.getElementById("detailOverlay");
  if (overlay) overlay.classList.remove("open");
}

// ---- 工具栏筛选弹层（全部平台 / 全部作者 / 全部标签 / 更多筛选）----
function getFilterPopover() {
  var el = document.getElementById("galleryFilterPopover");
  if (!el) {
    el = document.createElement("div");
    el.className = "filter-popover";
    el.id = "galleryFilterPopover";
    document.body.appendChild(el);
  }
  return el;
}

function currentPlatformIdForFilter() {
  var p = state.path || "";
  if (p.indexOf("/@all/") === 0)
    return decodeRoutePart(p.replace("/@all/", ""));
  if (p.indexOf("/@authors/") === 0)
    return decodeRoutePart(p.replace("/@authors/", ""));
  if (p.indexOf("/@author/") === 0) {
    var ar = parseAuthorRoute(p);
    return ar ? ar.platformId : "";
  }
  return "";
}

function buildFilterPopoverHtml(name) {
  if (name === "sort") {
    var isAuthors = state.view === "authors";
    var opts = configuredSortOptions(isAuthors);
    var current = isAuthors
      ? state.authorSort || "name_asc"
      : state.worksSort || "date_desc";
    var h = '<div class="fp-section">排序</div>';
    for (var s = 0; s < opts.length; s++) {
      h +=
        '<div class="fp-item' +
        (String(current) === String(opts[s].value) ? " active" : "") +
        '" data-fp-sort="' +
        escAttr(opts[s].value) +
        '">' +
        escHtml(opts[s].label) +
        "</div>";
    }
    return h;
  }
  return "";
}

function openFilterPopover(name, btn) {
  clearTagBrowser?.();
  clearTagBrowser = null;
  var el = getFilterPopover();
  if (
    GalleryMenu &&
    GalleryMenu.isOpen(el) &&
    el.getAttribute("data-fp-name") === name
  ) {
    GalleryMenu.close(el);
    return;
  }
  el.setAttribute("data-fp-name", name);
  if (name === "tag") {
    clearTagBrowser = mountTagBrowser(el, {
      platform: currentPlatformIdForFilter(),
      select(tag) {
        closeFilterPopover();
        if (tag === null) {
          state.searchTag = "";
          location.hash = makeQueryHash(state.path, { tag: null, page: 1 });
        } else searchForTag(tag);
      },
    });
  } else el.innerHTML = buildFilterPopoverHtml(name);
  GalleryMenu.open(el, btn, {
    align: name === "sort" ? "end" : "start",
    offset: 8,
  });
}

function closeFilterPopover() {
  clearTagBrowser?.();
  clearTagBrowser = null;
  var el = document.getElementById("galleryFilterPopover");
  if (el && GalleryMenu) GalleryMenu.close(el);
}
let clearTagBrowser = null;

// ---- 设置面板同步与应用 ----
function setPrivacyMode(on) {
  document.body.classList.toggle("privacy-blur", !!on);
  localStorage.setItem("gallery_privacy_blur", on ? "1" : "0");
  syncSettingsPanel();
}
function applyPageSize(n) {
  applyGalleryLayoutState({ pageSize: n });
}

function canUseCurrentRestrictedPageSize() {
  return (
    typeof canUseRestrictedPageSize === "function" &&
    canUseRestrictedPageSize(
      state.viewMode || "grid",
      state.contentWidth || "standard",
    )
  );
}

function enforcePageSizeForCurrentLayout() {
  if (
    typeof isRestrictedPageSize === "function" &&
    isRestrictedPageSize(state.pageSize) &&
    !canUseCurrentRestrictedPageSize()
  ) {
    state.pageSize = 48;
    localStorage.setItem("gallery_page_size", "48");
    return true;
  }
  return false;
}

function reloadForPageSizeReset(changed) {
  if (
    changed &&
    typeof isDatabaseView === "function" &&
    isDatabaseView(state.view) &&
    typeof reloadCurrentDbView === "function"
  ) {
    state.pendingLayoutDataMotion = true;
    reloadCurrentDbView();
  }
}

function setContentWidthMode(mode) {
  applyGalleryLayoutState({ contentWidth: mode });
}

function applyCurrentGalleryLayoutShell() {
  document.documentElement.setAttribute(
    "data-gallery-width",
    state.contentWidth === "wide" ? "wide" : "standard",
  );
}

function applyGalleryLayoutState(next) {
  next = next || {};
  var mobile = !!state.mobileLayout;
  var nextView =
    ["grid", "compact", "list"].indexOf(next.viewMode) >= 0
      ? next.viewMode
      : state.viewMode || "grid";
  var nextWidth =
    next.contentWidth === "wide"
      ? "wide"
      : next.contentWidth === "standard"
        ? "standard"
        : state.contentWidth || "standard";
  // 移动端禁用紧凑 / 全屏：归一，避免误持久化不可用组合。
  nextView = coerceViewModeForViewport(nextView, mobile);
  nextWidth = coerceContentWidthForViewport(nextWidth, mobile);
  var nextPageSize =
    next.pageSize != null
      ? parseInt(next.pageSize, 10) || 48
      : state.pageSize || 48;
  if (
    typeof isRestrictedPageSize === "function" &&
    isRestrictedPageSize(nextPageSize) &&
    typeof canUseRestrictedPageSize === "function" &&
    !canUseRestrictedPageSize(nextView, nextWidth)
  ) {
    nextPageSize = 48;
  }

  var viewChanged = nextView !== (state.viewMode || "grid");
  var widthChanged = nextWidth !== (state.contentWidth || "standard");
  var pageSizeChanged = nextPageSize !== (state.pageSize || 48);
  var visualChanged = viewChanged || widthChanged;
  if (!viewChanged && !widthChanged && !pageSizeChanged) {
    syncSettingsPanel();
    return;
  }

  state.viewMode = nextView;
  state.contentWidth = nextWidth;
  state.pageSize = nextPageSize;
  // viewMode / contentWidth 按当前断点分开持久化；pageSize 仍为全局键。
  localStorage.setItem(layoutStorageKey("gallery_view_mode", mobile), nextView);
  localStorage.setItem(
    layoutStorageKey("gallery_content_width", mobile),
    nextWidth,
  );
  localStorage.setItem("gallery_page_size", String(nextPageSize));

  var shouldReload =
    pageSizeChanged &&
    typeof isDatabaseView === "function" &&
    isDatabaseView(state.view);
  if (shouldReload) {
    state.pendingLayoutDataMotion = visualChanged;
    syncSettingsPanel();
    if (!visualChanged) applyCurrentGalleryLayoutShell();
    if (typeof reloadCurrentDbView === "function") reloadCurrentDbView();
    return;
  }

  var grid = document.querySelector("#content .grid");
  function applyVisualLayout() {
    applyCurrentGalleryLayoutShell();
    if (grid) grid.className = "grid" + gridViewClass();
    if (typeof applyGridColumnsRaw === "function") applyGridColumnsRaw();
    syncCardsForLayoutState(nextView, nextWidth);
  }
  function afterVisualLayout() {
    syncSettingsPanel();
    if (typeof applyGridColumnsRaw === "function") applyGridColumnsRaw();
    if (typeof syncCardTags === "function") syncCardTags();
  }

  if (!visualChanged || !grid) {
    applyVisualLayout();
    afterVisualLayout();
    return;
  }

  if (GridMotion && GridMotion.animateLayoutMutation) {
    GridMotion.animateLayoutMutation(grid, applyVisualLayout, {
      afterMutate: afterVisualLayout,
      allowEnterLeave: false,
    });
  } else {
    applyVisualLayout();
    afterVisualLayout();
  }
}

// 断点跨越（桌面 <-> 移动）：载入目标断点各自记住的布局配置，并复用统一布局入口，
// 让 GridMotion 在两套配置之间播放布局切换过渡（含必要的 pageSize 约束与数据库视图重载）。
function handleLayoutBreakpointChange(mobile) {
  mobile = !!mobile;
  if (mobile === !!state.mobileLayout) return;
  state.mobileLayout = mobile;
  var nextView = readPersistedViewMode(mobile);
  var nextWidth = readPersistedContentWidth(mobile);
  // applyGalleryLayoutState 的所有分支都会调用 syncSettingsPanel，会一并刷新
  // 「紧凑 / 全屏」在新断点下的置灰状态。
  applyGalleryLayoutState({ viewMode: nextView, contentWidth: nextWidth });
}

function syncSettingsPanel() {
  enforcePageSizeForCurrentLayout();
  var privacy = document.body.classList.contains("privacy-blur") ? "on" : "off";
  var map = {
    privacy: privacy,
    theme: GalleryTheme ? GalleryTheme.current() : "system",
    viewMode: state.viewMode || "grid",
    contentWidth: state.contentWidth || "standard",
    pageSize: String(state.pageSize || 48),
  };
  var mobile = !!state.mobileLayout;
  for (var key in map) {
    var segs = document.querySelectorAll(
      '.setting-seg[data-setting="' + key + '"] button',
    );
    for (var i = 0; i < segs.length; i++) {
      var value = segs[i].getAttribute("data-value");
      var disabled = false;
      if (key === "pageSize") {
        disabled =
          typeof isRestrictedPageSize === "function" &&
          isRestrictedPageSize(parseInt(value, 10)) &&
          !canUseCurrentRestrictedPageSize();
      } else if (key === "viewMode") {
        // 移动端「紧凑」无意义：置灰。
        disabled = mobile && value === "compact";
      } else if (key === "contentWidth") {
        // 移动端「全屏」无意义：置灰。
        disabled = mobile && value === "wide";
      }
      segs[i].disabled = disabled;
      segs[i].setAttribute("aria-disabled", disabled ? "true" : "false");
      segs[i].classList.toggle("disabled", disabled);
      segs[i].classList.toggle("active", value === map[key]);
    }
  }
  // db 筛选栏内的视图切换段控（grid/compact/list 图标）：同步选中态，并在移动端禁用「紧凑」。
  var viewSegs = document.querySelectorAll(
    '.filter-seg[data-filter="viewMode"] .seg-btn',
  );
  for (var v = 0; v < viewSegs.length; v++) {
    var vv = viewSegs[v].getAttribute("data-value");
    var vDisabled = mobile && vv === "compact";
    viewSegs[v].disabled = vDisabled;
    viewSegs[v].setAttribute("aria-disabled", vDisabled ? "true" : "false");
    viewSegs[v].classList.toggle("disabled", vDisabled);
    viewSegs[v].classList.toggle("active", vv === map.viewMode);
  }
}

// ---- 事件绑定 ----

export {
  setViewMode,
  syncCardTags,
  applyGridColumnsRaw,
  applyGridColumns,
  searchForTag,
  openWorkDetail,
  currentPlatformIdForFilter,
  openFilterPopover,
  applyCurrentGalleryLayoutShell,
};

export function init() {
  (function initRedesignUI() {
    function on(id, fn) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("click", fn);
    }

    on("settingsBtn", function () {
      syncSettingsPanel();
      GalleryMenu.open(document.getElementById("settingsPopover"), this, {
        align: "end",
        offset: 8,
      });
    });
    on("avatarBtn", function () {
      GalleryMenu.open(document.getElementById("avatarMenu"), this, {
        align: "end",
        offset: 8,
      });
    });
    on("avatarSettingsEntry", function () {
      GalleryMenu.open(
        document.getElementById("settingsPopover"),
        document.getElementById("settingsBtn"),
        { align: "end", offset: 8 },
      );
      syncSettingsPanel();
    });
    on("avatarHomeEntry", function () {
      GalleryMenu.close();
      miscNavigate();
    });

    // 设置面板段控
    var settingsPop = document.getElementById("settingsPopover");
    if (settingsPop) {
      settingsPop.addEventListener("click", function (e) {
        var b = e.target.closest(".setting-seg button[data-value]");
        if (!b) return;
        if (b.disabled) return;
        var setting = b.closest(".setting-seg").getAttribute("data-setting");
        var v = b.getAttribute("data-value");
        if (setting === "privacy") setPrivacyMode(v === "on");
        else if (setting === "theme" && GalleryTheme) GalleryTheme.apply(v);
        else if (setting === "viewMode") setViewMode(v);
        else if (setting === "contentWidth") setContentWidthMode(v);
        else if (setting === "pageSize") applyPageSize(v);
      });
    }

    // 详情浮层
    on("detailClose", closeWorkDetail);
    var overlay = document.getElementById("detailOverlay");
    if (overlay) {
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) closeWorkDetail();
        var openBtn = e.target.closest("[data-detail-open]");
        if (openBtn) {
          var pth = openBtn.getAttribute("data-detail-open");
          closeWorkDetail();
          if (typeof openDbFolderLightbox === "function" && pth)
            openDbFolderLightbox(pth);
          return;
        }
        var authBtn = e.target.closest("[data-detail-author]");
        if (authBtn) {
          closeWorkDetail();
          navigate(authBtn.getAttribute("data-detail-author"));
          return;
        }
        var srcLink = e.target.closest("[data-detail-source]");
        if (srcLink) {
          window.open(
            srcLink.getAttribute("data-detail-source"),
            "_blank",
            "noopener",
          );
          return;
        }
        var cpSrc = e.target.closest("[data-detail-copy-source]");
        if (cpSrc) {
          copyText(cpSrc.getAttribute("data-detail-copy-source"));
          cpSrc.textContent = "已复制";
          return;
        }
        var cpPath = e.target.closest("[data-detail-copy-path]");
        if (cpPath) {
          copyText(cpPath.getAttribute("data-detail-copy-path"));
          cpPath.textContent = "已复制";
          return;
        }
        var dtag = e.target.closest(".media-tag[data-tag]");
        if (dtag) {
          closeWorkDetail();
          searchForTag(dtag.getAttribute("data-tag"));
          return;
        }
      });
    }

    // 筛选弹层项
    document.addEventListener("click", function (e) {
      var fp = document.getElementById("galleryFilterPopover");
      if (fp && fp.classList.contains("open")) {
        var item = e.target.closest("#galleryFilterPopover .fp-item");
        if (item) {
          if (item.hasAttribute("data-fp-home")) {
            closeFilterPopover();
            miscNavigate();
            return;
          }
          if (item.hasAttribute("data-fp-platform")) {
            closeFilterPopover();
            navigate("/@all/" + item.getAttribute("data-fp-platform"));
            return;
          }
          if (item.hasAttribute("data-fp-authors")) {
            closeFilterPopover();
            navigate(authorListPath(item.getAttribute("data-fp-authors")));
            return;
          }
          if (item.hasAttribute("data-fp-tag")) {
            closeFilterPopover();
            searchForTag(item.getAttribute("data-fp-tag"));
            return;
          }
          if (item.hasAttribute("data-fp-sort")) {
            var sv = item.getAttribute("data-fp-sort");
            closeFilterPopover();
            if (state.view === "authors") {
              if (sv === state.authorSort) return;
              state.authorSort = sv;
              localStorage.setItem("gallery_author_sort", sv);
            } else {
              if (sv === state.worksSort) return;
              state.worksSort = sv;
              localStorage.setItem("gallery_works_sort", sv);
            }
            if (typeof reloadCurrentDbView === "function")
              reloadCurrentDbView();
            return;
          }
          if (item.hasAttribute("data-fp-mediatype")) {
            var mtv = item.getAttribute("data-fp-mediatype");
            closeFilterPopover();
            if (mtv !== state.mediaType) {
              state.mediaType = mtv;
              localStorage.setItem("gallery_media_type", mtv);
              if (typeof reloadCurrentDbView === "function")
                reloadCurrentDbView();
            }
            return;
          }
          if (item.hasAttribute("data-fp-pagesize")) {
            var psv = item.getAttribute("data-fp-pagesize");
            closeFilterPopover();
            applyPageSize(psv);
            return;
          }
          return;
        }
        if (
          !e.target.closest(".filter-btn") &&
          !e.target.closest(".filter-menu-btn")
        )
          closeFilterPopover();
      }
    });
    window.addEventListener("resize", function () {
      // 纯布局：只重排，不动画（rAF 合并高频 resize）。
      if (GridMotion && GridMotion.scheduleGridRelayout)
        GridMotion.scheduleGridRelayout(document);
      else applyGridColumnsImmediate();
    });
    window.addEventListener("resize", closeFilterPopover);
    // 断点跨越监听：只在越过移动端断点时触发一次，切换到对应断点记住的布局配置并平滑过渡。
    if (window.matchMedia && typeof LAYOUT_MOBILE_QUERY !== "undefined") {
      var layoutMq = window.matchMedia(LAYOUT_MOBILE_QUERY);
      var onLayoutMq = function (e) {
        handleLayoutBreakpointChange(e.matches);
      };
      if (layoutMq.addEventListener)
        layoutMq.addEventListener("change", onLayoutMq);
      else if (layoutMq.addListener) layoutMq.addListener(onLayoutMq);
    }
    // 侧栏折叠 / 展开会改变内容区宽度（margin-left 过渡），过渡结束后立即重算列数与标签裁剪，不动画。
    var wrapEl = document.querySelector(".wrap");
    if (wrapEl) {
      wrapEl.addEventListener("transitionend", function (e) {
        if (e.target !== wrapEl || e.propertyName !== "margin-left") return;
        if (GridMotion && GridMotion.scheduleGridRelayout)
          GridMotion.scheduleGridRelayout(document);
        else applyGridColumnsImmediate();
      });
    }

    // 持续连接状态只使用常驻指示器，不写入通知历史。
    if (typeof ScanWS !== "undefined") {
      ScanWS.onState(function (st, detail) {
        var node = document.getElementById("connectionState");
        if (!node) return;
        node.className = "connection-state " + st;
        var label =
          st === "online"
            ? "已连接"
            : st === "connecting"
              ? "连接中"
              : "连接已断开";
        if (st === "offline" && detail && detail.retryIn)
          label += " · " + detail.retryIn + " 秒后重试";
        node.querySelector("span").textContent = label;
        node.title = label;
      });
      on("connectionState", function () {
        if (this.classList.contains("offline")) ScanWS.reconnectNow();
      });
    }
    syncSettingsPanel();
  })();
}
