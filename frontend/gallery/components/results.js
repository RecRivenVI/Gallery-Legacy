import { syncSearchInputs, syncSearchMeta } from "./search.js";
import { renderGrid } from "./cards.js";
import { initLabelScroll } from "./scroll.js";
import {
  buildPagination,
  initPagerSlider,
  syncPagerSlider,
  updatePagerSliderInWrap,
  updatePagerSliderNav,
} from "./pagination.js";
import { PAGE_SIZE_CHOICES, escHtml, state } from "../model.js";
import { currentPlatformIdForFilter } from "./settings.js";
import { Sidebar } from "./sidebar.js";
import { sortLabels } from "../../shared/labels.js";

function render(data) {
  syncSearchInputs("");
  syncSearchMeta();
  renderBreadcrumbs(data.breadcrumbs);
  renderBrowseMeta(data);
  renderDbFilterbar("none");
  renderToolbar(data);
  renderGrid(data);
  initLabelScroll();
}

var lastCrumbs = [];

var nextBreadcrumbPath = null;

var META_FADE_IN_MS = 350;

var BREADCRUMB_FADE_IN_MS = 350;

var BREADCRUMB_STAGGER_MS = 45;

var breadcrumbRenderToken = 0;

function prepareBreadcrumbFade(nextPath) {
  nextBreadcrumbPath = nextPath;
}

function fadeOldBreadcrumb() {
  nextBreadcrumbPath = null;
}

function seconds(ms) {
  return (ms / 1000).toFixed(2) + "s";
}

function runFade(el, name, durationMs, delayMs) {
  if (!el) return;
  el.classList.remove("entrance", "exit");
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.opacity = name === "fadeIn" ? "0" : "";
  el.style.animation = name + " " + seconds(durationMs) + " ease forwards";
  el.style.animationDelay = seconds(delayMs || 0);
}

function updateMetaElement(el, text) {
  if (!el) return;
  text = text == null ? "" : String(text);
  var currentText = el.getAttribute("data-meta-text");
  if (currentText === text && el.textContent === text) return;

  var version =
    (parseInt(el.getAttribute("data-meta-version") || "0", 10) || 0) + 1;
  el.setAttribute("data-meta-version", String(version));

  el.textContent = text;
  el.setAttribute("data-meta-text", text);
  if (el.getAttribute("data-meta-version") === String(version)) {
    runFade(el, "fadeIn", META_FADE_IN_MS, 0);
  }
}

function renderMetaText(text) {
  updateMetaElement(document.getElementById("meta"), text);
}

function getGlobalToolbarEl() {
  return document.getElementById("globalToolbar");
}

function crumbText(crumb, index) {
  if (index === 0) return "首页";
  return String((crumb && (crumb.displayName || crumb.name)) || "");
}

function crumbPath(crumb, index) {
  if (index === 0) return "/";
  return String((crumb && crumb.path) || "/");
}

function ensureBreadcrumbHome(container) {
  if (!container) return null;
  var home = null;
  for (var i = 0; i < container.children.length; i++) {
    if (container.children[i].classList.contains("breadcrumb-home")) {
      home = container.children[i];
      break;
    }
  }
  if (!home) {
    home = document.createElement("a");
    container.insertBefore(home, container.firstChild);
  }
  home.href = "#";
  home.className = "breadcrumb-home";
  home.textContent = "首页";
  home.setAttribute("data-path", "/");
  home.setAttribute("data-breadcrumb-text", "首页");
  home.setAttribute("data-breadcrumb-path", "/");
  return home;
}

function hasReusableBreadcrumbRoot(container) {
  if (!container || container.getAttribute("data-breadcrumb-ready") !== "1")
    return false;
  var home = null;
  for (var i = 0; i < container.children.length; i++) {
    if (container.children[i].classList.contains("breadcrumb-home")) {
      home = container.children[i];
      break;
    }
  }
  return (
    !!home &&
    home.getAttribute("data-breadcrumb-text") === "首页" &&
    home.getAttribute("data-breadcrumb-path") === "/"
  );
}

function breadcrumbParts(crumbs) {
  var parts = [];
  for (var i = 0; i < crumbs.length; i++) {
    if (i === 0) continue;
    parts.push({
      text: crumbText(crumbs[i], i),
      path: crumbPath(crumbs[i], i),
    });
  }
  return parts;
}

function breadcrumbSegments(container) {
  var segments = [];
  if (!container) return segments;
  for (var i = 0; i < container.children.length; i++) {
    if (container.children[i].classList.contains("breadcrumb-item")) {
      segments.push(container.children[i]);
    }
  }
  return segments;
}

function createBreadcrumbSegment(part) {
  var item = document.createElement("span");
  item.className = "breadcrumb-item";
  item.setAttribute("data-breadcrumb-text", part.text);
  item.setAttribute("data-breadcrumb-path", part.path);

  var sep = document.createElement("span");
  sep.className = "sep";
  sep.textContent = "/";

  var link = document.createElement("a");
  link.href = "#";
  link.setAttribute("data-path", part.path);
  link.textContent = part.text;

  item.appendChild(sep);
  item.appendChild(link);
  return item;
}

function syncBreadcrumbSegment(segment, part) {
  segment.setAttribute("data-breadcrumb-path", part.path);
  var link = segment.querySelector("a[data-path]");
  if (link) link.setAttribute("data-path", part.path);
}

function appendBreadcrumbSegments(container, parts, start, token, delayOffset) {
  delayOffset = delayOffset || 0;
  for (var i = start; i < parts.length; i++) {
    if (token !== breadcrumbRenderToken) return;
    var segment = createBreadcrumbSegment(parts[i]);
    container.appendChild(segment);
    runFade(
      segment,
      "fadeIn",
      BREADCRUMB_FADE_IN_MS,
      (delayOffset + i - start) * BREADCRUMB_STAGGER_MS,
    );
  }
}

function breadcrumbSegmentMatches(segment, part) {
  return (
    segment.getAttribute("data-breadcrumb-text") === part.text &&
    segment.getAttribute("data-breadcrumb-path") === part.path
  );
}

function rebuildBreadcrumbContainer(container, parts, token) {
  var home = ensureBreadcrumbHome(container);
  var current = breadcrumbSegments(container);
  if (token !== breadcrumbRenderToken) return;
  home = ensureBreadcrumbHome(container);
  current = breadcrumbSegments(container);
  for (var r = 0; r < current.length; r++) {
    if (current[r].parentNode === container) container.removeChild(current[r]);
  }
  home.removeAttribute("data-exiting");
  runFade(home, "fadeIn", BREADCRUMB_FADE_IN_MS, 0);
  appendBreadcrumbSegments(container, parts, 0, token, 1);
  container.setAttribute("data-breadcrumb-ready", "1");
}

function updateBreadcrumbContainer(container, parts, token) {
  if (!container) return;
  var canReuseRoot = hasReusableBreadcrumbRoot(container);
  ensureBreadcrumbHome(container);

  if (!canReuseRoot) {
    rebuildBreadcrumbContainer(container, parts, token);
    return;
  }

  var current = breadcrumbSegments(container);
  var keep = 0;
  while (
    keep < current.length &&
    keep < parts.length &&
    breadcrumbSegmentMatches(current[keep], parts[keep])
  ) {
    syncBreadcrumbSegment(current[keep], parts[keep]);
    keep++;
  }

  if (keep === current.length && keep === parts.length) return;

  var exiting = current.slice(keep);
  if (token !== breadcrumbRenderToken) return;
  for (var r = 0; r < exiting.length; r++) {
    if (exiting[r].parentNode === container) container.removeChild(exiting[r]);
  }
  appendBreadcrumbSegments(container, parts, keep, token);
  container.setAttribute("data-breadcrumb-ready", "1");
}

function renderBreadcrumbs(crumbs) {
  crumbs = crumbs && crumbs.length ? crumbs : [{ name: "首页", path: "/" }];
  var parts = breadcrumbParts(crumbs);
  var token = ++breadcrumbRenderToken;
  updateBreadcrumbContainer(
    document.getElementById("breadcrumb"),
    parts,
    token,
  );
  lastCrumbs = crumbs.slice();
  nextBreadcrumbPath = null;
}

function renderBrowseMeta(data) {
  var parts = [];
  if (data.totalDirs > 0) parts.push(data.totalDirs + "个文件夹");
  if (data.totalImages > 0) parts.push(data.totalImages + "张图片");
  if (data.totalVideos > 0) parts.push(data.totalVideos + "个视频");
  var text = parts.length > 0 ? parts.join("、") : "空";
  renderMetaText(text);
}

function renderToolbar(data) {
  var pagHtml = buildPagination(data.page, data.totalPages);
  var sortBtn = buildSortButton(data.order || "asc");

  function addEntrance(wrap) {
    if (!wrap) return;
    clearPaginationFadeState(wrap);
    runPaginationWrapEntrance(wrap);
  }

  function renderPaginationContainer(targetEl, extraHtml) {
    var toolbarKey = paginationToolbarKey(data, !!pagHtml, !!extraHtml);
    var wrap = targetEl.querySelector(".pagination-wrap");
    if (
      wrap &&
      wrap.getAttribute("data-toolbar-key") === toolbarKey &&
      updatePagerSliderInWrap(wrap, data.page, data.totalPages)
    ) {
      syncPaginationExtra(wrap, extraHtml);
      clearPaginationFadeState(wrap);
      syncPaginationWrapState(wrap, !!pagHtml, !!extraHtml, toolbarKey);
      return wrap;
    }
    var oldNav = targetEl.querySelector(".pager-slider");
    var oldPage = oldNav
      ? parseInt(oldNav.getAttribute("data-current-page"), 10)
      : NaN;
    var nextHtml = paginationWrapHtml(pagHtml, extraHtml);
    if (wrap) {
      replacePaginationWrapWithFade(
        targetEl,
        nextHtml,
        data.page,
        data.totalPages,
        oldPage,
        toolbarKey,
      );
      return wrap;
    }
    targetEl.innerHTML = nextHtml;
    wrap = targetEl.querySelector(".pagination-wrap");
    syncPaginationWrapState(wrap, !!pagHtml, !!extraHtml, toolbarKey);
    if (wrap) addEntrance(wrap);
    if (!isNaN(oldPage) && oldPage !== data.page) {
      var newNav = wrap ? wrap.querySelector(".pager-slider") : null;
      if (newNav) newNav.setAttribute("data-scroll-from-page", String(oldPage));
    }
    return wrap;
  }

  renderPaginationContainer(getGlobalToolbarEl(), sortBtn);
  renderBottomPagination(data);
  syncPagerSlider(data.page, data.totalPages);
}

function renderBottomPagination(data) {
  var el = document.getElementById("bottomPagination");
  if (!el) return;
  var pag = buildPagination(data.page, data.totalPages);
  if (!pag) {
    el.innerHTML = "";
    el.classList.remove("has-pager");
    return;
  }
  el.innerHTML = '<div class="pagination-wrap">' + pag + "</div>";
  el.classList.add("has-pager");
}

function syncPaginationExtra(wrap, extraHtml) {
  if (!wrap) return;
  var slot = wrap.querySelector(".pagination-sort-slot");
  if (!slot) {
    slot = document.createElement("div");
    slot.className = "pagination-sort-slot";
    wrap.appendChild(slot);
  }
  var sort = slot.querySelector(".sort-btn");
  if (!extraHtml) {
    slot.innerHTML = "";
    return;
  }
  var holder = document.createElement("div");
  holder.innerHTML = extraHtml;
  var nextSort = holder.querySelector(".sort-btn");
  if (!nextSort) return;
  if (!sort) {
    slot.appendChild(nextSort);
  } else if (
    sort.getAttribute("data-order") !== nextSort.getAttribute("data-order")
  ) {
    var label = sort.querySelector(".sort-btn-label");
    var nextLabel = nextSort.querySelector(".sort-btn-label");
    var nextOrder = nextSort.getAttribute("data-order") || "";
    sort.setAttribute("data-order", nextOrder);
    if (label && nextLabel) {
      if (sort.__sortLabelTimer) clearTimeout(sort.__sortLabelTimer);
      var token = String(Date.now()) + Math.random();
      sort.setAttribute("data-sort-label-token", token);
      label.classList.add("sort-btn-label-switching");
      sort.__sortLabelTimer = setTimeout(function () {
        if (sort.getAttribute("data-sort-label-token") !== token) return;
        label.innerHTML = nextLabel.innerHTML;
        label.classList.remove("sort-btn-label-switching");
        sort.__sortLabelTimer = null;
      }, 130);
    } else {
      sort.innerHTML = nextSort.innerHTML;
    }
  } else {
    var stableLabel = sort.querySelector(".sort-btn-label");
    if (stableLabel) stableLabel.classList.remove("sort-btn-label-switching");
  }
}

function paginationWrapHtml(pagHtml, extraHtml) {
  if (!pagHtml && !extraHtml) return "";
  return (
    '<div class="pagination-wrap">' +
    (pagHtml || "") +
    '<div class="pagination-sort-slot">' +
    (extraHtml || "") +
    "</div></div>"
  );
}

function paginationToolbarKey(data, hasPager, hasSort) {
  var crumbs =
    data && data.breadcrumbs
      ? data.breadcrumbs
          .map(function (crumb) {
            return (
              crumb && (crumb.path || crumb.name || crumb.displayName || "")
            );
          })
          .join(">")
      : "";
  return [
    data && (data.view || state.view || ""),
    data && (data.path || state.path || ""),
    data && (data.query || state.query || ""),
    data && (data.platformId || state.platformId || ""),
    data && (data.authorId || state.authorId || ""),
    crumbs,
    data && data.totalPages,
    hasPager ? "pager" : "single",
    hasSort ? "sort" : "nosort",
  ].join("|");
}

function syncPaginationWrapState(wrap, hasPager, hasSort, toolbarKey) {
  if (!wrap) return;
  wrap.classList.toggle("pagination-no-pager", !hasPager);
  wrap.classList.toggle("pagination-has-sort", hasSort);
  if (toolbarKey) wrap.setAttribute("data-toolbar-key", toolbarKey);
}

function runPaginationWrapEntrance(wrap) {
  if (!wrap) return;
  wrap.classList.remove(
    "pagination-toolbar-exit",
    "pagination-toolbar-entrance",
  );
  void wrap.offsetWidth;
  wrap.classList.add("pagination-toolbar-entrance");
}

function replacePaginationWrapWithFade(
  targetEl,
  nextHtml,
  currentPage,
  totalPages,
  oldPage,
  toolbarKey,
) {
  var wrap = targetEl.querySelector(".pagination-wrap");
  var token = String(Date.now()) + Math.random();
  targetEl.setAttribute("data-pagination-replace-token", token);
  if (targetEl.getAttribute("data-pagination-replace-token") !== token) return;
  if (wrap)
    wrap.classList.remove(
      "pagination-toolbar-entrance",
      "pagination-toolbar-exit",
    );
  targetEl.innerHTML = nextHtml;
  var nextWrap = targetEl.querySelector(".pagination-wrap");
  syncPaginationWrapState(
    nextWrap,
    !!(nextWrap && nextWrap.querySelector(".pager-slider")),
    !!(nextWrap && nextWrap.querySelector(".sort-btn")),
    toolbarKey,
  );
  syncNewPagerAfterToolbarReplace(nextWrap, currentPage, totalPages, oldPage);
  runPaginationWrapEntrance(nextWrap);
}

function syncNewPagerAfterToolbarReplace(
  wrap,
  currentPage,
  totalPages,
  oldPage,
) {
  if (!wrap) return;
  var newNav = wrap.querySelector(".pager-slider");
  if (!newNav) return;
  if (!isNaN(oldPage) && oldPage !== currentPage) {
    newNav.setAttribute("data-scroll-from-page", String(oldPage));
  }
  initPagerSlider(newNav, currentPage, totalPages);
  updatePagerSliderNav(newNav, currentPage, totalPages, "auto");
}

function clearPaginationFadeState(wrap) {
  if (!wrap) return;
  var nodes = wrap.querySelectorAll(".pg-num, .pg-btn, .sort-btn");
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].classList.remove("entrance", "exit");
    nodes[i].style.opacity = "";
    nodes[i].style.animation = "";
    nodes[i].style.animationDelay = "";
  }
}

function buildSortButton(order) {
  var arrowSvg =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width=".85em" height=".85em" style="vertical-align:-.1em">';
  if (order === "asc") {
    arrowSvg +=
      '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5,12 12,5 19,12"/>';
  } else {
    arrowSvg +=
      '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19,12 12,19 5,12"/>';
  }
  arrowSvg += "</svg>";
  return (
    '<button class="sort-btn" data-order="' +
    order +
    '"><span class="sort-btn-label">名称 ' +
    arrowSvg +
    "</span></button>"
  );
}

function configuredSortOptions(isAuthors) {
  var platformId =
    (typeof currentPlatformIdForFilter === "function"
      ? currentPlatformIdForFilter()
      : "") ||
    state.platformId ||
    "";
  var platforms = Sidebar && Sidebar.platforms ? Sidebar.platforms : [];
  var platform = null;
  for (var i = 0; i < platforms.length; i++)
    if (platforms[i].id === platformId) {
      platform = platforms[i];
      break;
    }
  var sort = (platform && platform.sort) || {};
  var values = isAuthors ? sort.authorOptions || [] : sort.workOptions || [];
  var labels = sortLabels;
  return values.map(function (value) {
    return { value: value, label: labels[value] || value };
  });
}

var MEDIA_TYPE_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
];

function filterSegHtml(filterName, options, current) {
  var html =
    '<div class="filter-seg" data-filter="' + filterName + '" role="group">';
  for (var i = 0; i < options.length; i++) {
    var o = options[i];
    var active = o.value === current ? " active" : "";
    html +=
      '<button type="button" class="seg-btn' +
      active +
      '" data-value="' +
      o.value +
      '">' +
      escHtml(o.label) +
      "</button>";
  }
  return html + "</div>";
}

function filterMenuBtnHtml(filterName, options, current) {
  var currentLabel = "";
  for (var i = 0; i < options.length; i++) {
    var o = options[i];
    if (String(o.value) === String(current)) currentLabel = o.label;
  }
  if (!currentLabel && options.length) currentLabel = options[0].label;
  return (
    '<button type="button" class="filter-menu-btn" data-menu-btn="' +
    filterName +
    '" aria-haspopup="menu" aria-expanded="false">' +
    "<span>" +
    escHtml(currentLabel) +
    "</span>" +
    FILTER_CARET +
    "</button>"
  );
}

function pageSizeOptions() {
  var choices =
    typeof PAGE_SIZE_CHOICES !== "undefined"
      ? PAGE_SIZE_CHOICES
      : [24, 48, 72, 96, 120];
  var opts = [];
  for (var i = 0; i < choices.length; i++)
    opts.push({ value: choices[i], label: "每页 " + choices[i] });
  return opts;
}

var VIEW_MODE_OPTIONS = [
  {
    value: "grid",
    label:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    title: "默认布局",
  },
  {
    value: "compact",
    label:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="4" height="4"/><rect x="10" y="3" width="4" height="4"/><rect x="17" y="3" width="4" height="4"/><rect x="3" y="10" width="4" height="4"/><rect x="10" y="10" width="4" height="4"/><rect x="17" y="10" width="4" height="4"/><rect x="3" y="17" width="4" height="4"/><rect x="10" y="17" width="4" height="4"/><rect x="17" y="17" width="4" height="4"/></svg>',
    title: "紧凑网格",
  },
  {
    value: "list",
    label:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    title: "列表视图",
  },
];

var FILTER_CARET =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

function filterBtnHtml(filterName, label) {
  return (
    '<button type="button" class="filter-btn" data-filter-btn="' +
    filterName +
    '">' +
    escHtml(label) +
    FILTER_CARET +
    "</button>"
  );
}

function viewSegHtml() {
  var cur = state.viewMode || "grid";
  var mobile = !!state.mobileLayout;
  var html = '<div class="filter-seg" data-filter="viewMode" role="group">';
  for (var i = 0; i < VIEW_MODE_OPTIONS.length; i++) {
    var o = VIEW_MODE_OPTIONS[i];
    // 移动端「紧凑」无意义：置灰并禁用（与设置面板一致）。
    var disabled = mobile && o.value === "compact";
    var active = o.value === cur ? " active" : "";
    var cls = "seg-btn icon-seg" + active + (disabled ? " disabled" : "");
    html +=
      '<button type="button" class="' +
      cls +
      '" data-value="' +
      o.value +
      '"' +
      (disabled ? ' disabled aria-disabled="true"' : "") +
      ' title="' +
      o.title +
      '">' +
      o.label +
      "</button>";
  }
  return html + "</div>";
}

var BROWSE_MODE_OPTIONS = [
  { value: "works", label: "最新作品" },
  { value: "authors", label: "全部作者" },
];

function browseSegHtml(activeMode) {
  var html =
    '<div class="filter-seg browse-seg" data-filter="browseMode" role="group">';
  for (var i = 0; i < BROWSE_MODE_OPTIONS.length; i++) {
    var o = BROWSE_MODE_OPTIONS[i];
    var active = o.value === activeMode ? " active" : "";
    html +=
      '<button type="button" class="seg-btn' +
      active +
      '" data-value="' +
      o.value +
      '">' +
      escHtml(o.label) +
      "</button>";
  }
  return html + "</div>";
}

function currentBrowseMode() {
  var p = state && state.path ? state.path : "";
  return /^\/@authors?\//.test(p) ? "authors" : "works";
}

function syncHeaderFilterToggle(available, expanded) {
  var btn = document.getElementById("headerFilterToggle");
  if (!btn) return;
  btn.classList.toggle("available", !!available);
  btn.classList.toggle("expanded", !!(available && expanded));
  btn.setAttribute("aria-expanded", available && expanded ? "true" : "false");
}

function renderDbFilterbar(kind) {
  var el = document.getElementById("dbFilterbar");
  if (!el) return;
  if (kind === "none" || !kind) {
    el.innerHTML = "";
    el.classList.remove("db-filterbar-active");
    el.classList.remove("expanded");
    syncHeaderFilterToggle(false, false);
    return;
  }
  var isAuthors = kind === "authors";
  // 抽屉展开态挂在稳定的 #dbFilterbar 元素上，重渲染（换视图 / 切媒体类型）时保留。
  var expanded = el.classList.contains("expanded");

  // 移动端全部折叠进抽屉（含「最新作品 / 全部作者」浏览模式切换），由顶栏筛选开关控制；
  // 桌面端 .filterbar-controls 为 display:contents，仍是原来的横向 flex 顺序。
  var controls = "";
  controls += browseSegHtml(currentBrowseMode());
  if (!isAuthors) {
    controls += filterBtnHtml("tag", state.searchTag || "全部标签");
  }
  controls += '<div class="filter-spacer"></div>';
  if (!isAuthors) {
    controls += filterSegHtml(
      "mediaType",
      MEDIA_TYPE_OPTIONS,
      state.mediaType || "all",
    );
  }
  controls += filterMenuBtnHtml(
    "sort",
    configuredSortOptions(isAuthors),
    isAuthors ? state.authorSort || "name_asc" : state.worksSort || "date_desc",
  );
  controls += viewSegHtml();

  el.innerHTML = '<div class="filterbar-controls">' + controls + "</div>";
  el.classList.add("db-filterbar-active");
  syncHeaderFilterToggle(true, expanded);
}

export {
  render,
  lastCrumbs,
  nextBreadcrumbPath,
  META_FADE_IN_MS,
  BREADCRUMB_FADE_IN_MS,
  BREADCRUMB_STAGGER_MS,
  breadcrumbRenderToken,
  prepareBreadcrumbFade,
  fadeOldBreadcrumb,
  seconds,
  runFade,
  updateMetaElement,
  renderMetaText,
  getGlobalToolbarEl,
  crumbText,
  crumbPath,
  ensureBreadcrumbHome,
  hasReusableBreadcrumbRoot,
  breadcrumbParts,
  breadcrumbSegments,
  createBreadcrumbSegment,
  syncBreadcrumbSegment,
  appendBreadcrumbSegments,
  breadcrumbSegmentMatches,
  rebuildBreadcrumbContainer,
  updateBreadcrumbContainer,
  renderBreadcrumbs,
  renderBrowseMeta,
  renderToolbar,
  renderBottomPagination,
  syncPaginationExtra,
  paginationWrapHtml,
  paginationToolbarKey,
  syncPaginationWrapState,
  runPaginationWrapEntrance,
  replacePaginationWrapWithFade,
  syncNewPagerAfterToolbarReplace,
  clearPaginationFadeState,
  buildSortButton,
  configuredSortOptions,
  MEDIA_TYPE_OPTIONS,
  filterSegHtml,
  filterMenuBtnHtml,
  pageSizeOptions,
  VIEW_MODE_OPTIONS,
  FILTER_CARET,
  filterBtnHtml,
  viewSegHtml,
  BROWSE_MODE_OPTIONS,
  browseSegHtml,
  currentBrowseMode,
  syncHeaderFilterToggle,
  renderDbFilterbar,
};
