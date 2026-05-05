import { isDatabaseView, state } from "../model.js";
import { renderAllWorksToolbar } from "../works.js";
import { renderToolbar } from "./results.js";
// 页码条：≤ PAGER_VIRTUAL_THRESHOLD 页时把所有页码渲染进 flex 轨道（原行为）；
// 超过阈值改用「虚拟化滑块」——固定槽宽的绝对定位轨道，只保留视口内 ~一屏按钮，
// 滚动时按 scrollLeft 复用节点。这样任意页数下 DOM 节点数恒定、几何量由 index×槽宽
// 直接算出（无需逐按钮读 offsetLeft），且整条 render-key 只依赖总页数、翻页永不重建，
// 因此任意页码切换都能连续滑动衔接（不再有跨窗口边界的整块重建跳变）。
var PAGER_VIRTUAL_THRESHOLD = 800;

function pagerIsVirtual(totalPages) {
  return totalPages > PAGER_VIRTUAL_THRESHOLD;
}

// 虚拟模式的几何计算必须与 CSS 中页码轨道的 34px 内部边长一致，
// 不再根据页码位数拉宽按钮。外层 36px 控件减去上下各 1px 边框后即为 34px。
function pagerVirtualSlotWidth() {
  return 34;
}

function buildPagination(currentPage, totalPages) {
  if (totalPages <= 1) return "";
  currentPage = Math.max(
    1,
    Math.min(totalPages, parseInt(currentPage, 10) || 1),
  );
  var virtual = pagerIsVirtual(totalPages);
  var slotW = virtual ? pagerVirtualSlotWidth(totalPages) : 0;
  var rangeKey = pagerSliderRangeKey(currentPage, totalPages);
  var html =
    '<nav class="pagination pager-slider' +
    (virtual ? " pager-slider-virtual" : "") +
    '" aria-label="分页" data-current-page="' +
    currentPage +
    '" data-total-pages="' +
    totalPages +
    '" data-render-key="' +
    rangeKey +
    '"' +
    (virtual ? ' data-pager-virtual="1" data-slot-w="' + slotW + '"' : "") +
    ">";
  if (currentPage > 1) {
    html +=
      '<button type="button" class="pg-btn pg-prev pager-edge-btn" data-page="1" aria-label="回到第一页"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><line x1="6" y1="5" x2="6" y2="19"/><polyline points="18,18 12,12 18,6"/></svg></button>';
  } else {
    html +=
      '<button type="button" class="pg-btn pg-prev pager-edge-btn pg-disabled" aria-label="回到第一页" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><line x1="6" y1="5" x2="6" y2="19"/><polyline points="18,18 12,12 18,6"/></svg></button>';
  }
  if (currentPage > 1) {
    html +=
      '<button type="button" class="pg-btn pager-step-btn pager-step-prev" data-page="' +
      (currentPage - 1) +
      '" aria-label="上一页"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="15,18 9,12 15,6"/></svg></button>';
  } else {
    html +=
      '<button type="button" class="pg-btn pager-step-btn pager-step-prev pg-disabled" aria-label="上一页" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="15,18 9,12 15,6"/></svg></button>';
  }

  html += '<div class="pager-slider-wrap">';
  html +=
    '<div class="pager-slider-viewport" tabindex="0" aria-label="页码滑块">';
  if (virtual) {
    // 虚拟轨道：初始为空，宽度与按钮由 initPagerVirtual 在挂载后按视口宽度补齐。
    html +=
      '<div class="pager-slider-track pager-virtual" style="--pager-slot-w:' +
      slotW +
      'px"></div>';
  } else {
    html += '<div class="pager-slider-track">';
    var ranges = pagerSliderRanges(currentPage, totalPages);
    for (var r = 0; r < ranges.length; r++) {
      if (r > 0) {
        html +=
          '<span class="pg-ellipsis pager-slider-gap" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></span>';
      }
      for (var p = ranges[r].start; p <= ranges[r].end; p++) {
        var active = p === currentPage;
        html +=
          '<button type="button" class="pg-num pager-slider-page' +
          (active ? " pg-active" : "") +
          '" data-page="' +
          p +
          '"' +
          (active ? ' aria-current="page"' : "") +
          ' aria-label="第 ' +
          p +
          ' 页">' +
          p +
          "</button>";
      }
    }
    html += "</div>";
  }
  html += "</div>";
  html +=
    '<span class="pager-slider-fade pager-slider-fade-left" aria-hidden="true"></span>';
  html +=
    '<span class="pager-slider-fade pager-slider-fade-right" aria-hidden="true"></span>';
  html += "</div>";

  if (currentPage < totalPages) {
    html +=
      '<button type="button" class="pg-btn pager-step-btn pager-step-next" data-page="' +
      (currentPage + 1) +
      '" aria-label="下一页"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="9,18 15,12 9,6"/></svg></button>';
  } else {
    html +=
      '<button type="button" class="pg-btn pager-step-btn pager-step-next pg-disabled" aria-label="下一页" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="9,18 15,12 9,6"/></svg></button>';
  }
  if (currentPage < totalPages) {
    html +=
      '<button type="button" class="pg-btn pg-next pager-edge-btn" data-page="' +
      totalPages +
      '" aria-label="跳到最后一页"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="6,18 12,12 6,6"/><line x1="18" y1="5" x2="18" y2="19"/></svg></button>';
  } else {
    html +=
      '<button type="button" class="pg-btn pg-next pager-edge-btn pg-disabled" aria-label="跳到最后一页" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="6,18 12,12 6,6"/><line x1="18" y1="5" x2="18" y2="19"/></svg></button>';
  }
  html += "</nav>";
  return html;
}

// 非虚拟模式（≤阈值）总是把全部页码渲染为单段范围。
function pagerSliderRanges(currentPage, totalPages) {
  return [{ start: 1, end: totalPages }];
}

function pagerSliderRangeKey(currentPage, totalPages) {
  // 虚拟模式：render-key 只依赖总页数，翻页时保持不变 → 复用同一 nav、连续滑动。
  if (pagerIsVirtual(totalPages)) return "v:" + totalPages;
  var ranges = pagerSliderRanges(currentPage, totalPages);
  var parts = [];
  for (var i = 0; i < ranges.length; i++) {
    parts.push(ranges[i].start + "-" + ranges[i].end);
  }
  return parts.join("|");
}

function updatePagerSliderInWrap(wrap, currentPage, totalPages) {
  if (!wrap) return false;
  var nav = wrap.querySelector(".pager-slider");
  if (!nav) return false;
  currentPage = Math.max(
    1,
    Math.min(totalPages, parseInt(currentPage, 10) || 1),
  );
  if (nav.getAttribute("data-total-pages") !== String(totalPages)) return false;
  if (
    nav.getAttribute("data-render-key") !==
    pagerSliderRangeKey(currentPage, totalPages)
  )
    return false;
  updatePagerSliderNav(nav, currentPage, totalPages, "auto");
  return true;
}

function syncPagerSlider(currentPage, totalPages) {
  var navs = document.querySelectorAll(".pager-slider");
  for (var i = 0; i < navs.length; i++) {
    initPagerSlider(navs[i], currentPage, totalPages);
    updatePagerSliderNav(navs[i], currentPage, totalPages, "auto");
  }
}

// prev / next / step 边按钮状态在虚拟与非虚拟模式下一致（它们始终在 DOM 中）。
function updatePagerEdgeButtons(nav, currentPage, totalPages) {
  var prev = nav.querySelector(".pg-prev");
  if (prev) {
    if (currentPage > 1) {
      prev.setAttribute("data-page", "1");
      prev.classList.remove("pg-disabled");
      prev.disabled = false;
    } else {
      prev.removeAttribute("data-page");
      prev.classList.add("pg-disabled");
      prev.disabled = true;
    }
  }

  var next = nav.querySelector(".pg-next");
  if (next) {
    if (currentPage < totalPages) {
      next.setAttribute("data-page", String(totalPages));
      next.classList.remove("pg-disabled");
      next.disabled = false;
    } else {
      next.removeAttribute("data-page");
      next.classList.add("pg-disabled");
      next.disabled = true;
    }
  }

  var stepPrev = nav.querySelector(".pager-step-prev");
  if (stepPrev) {
    if (currentPage > 1) {
      stepPrev.setAttribute("data-page", String(currentPage - 1));
      stepPrev.classList.remove("pg-disabled");
      stepPrev.disabled = false;
    } else {
      stepPrev.removeAttribute("data-page");
      stepPrev.classList.add("pg-disabled");
      stepPrev.disabled = true;
    }
  }

  var stepNext = nav.querySelector(".pager-step-next");
  if (stepNext) {
    if (currentPage < totalPages) {
      stepNext.setAttribute("data-page", String(currentPage + 1));
      stepNext.classList.remove("pg-disabled");
      stepNext.disabled = false;
    } else {
      stepNext.removeAttribute("data-page");
      stepNext.classList.add("pg-disabled");
      stepNext.disabled = true;
    }
  }
}

function updatePagerSliderNav(nav, currentPage, totalPages, behavior) {
  if (!nav) return;
  currentPage = Math.max(
    1,
    Math.min(totalPages, parseInt(currentPage, 10) || 1),
  );
  var previousPage = parseInt(nav.getAttribute("data-current-page"), 10);
  var pageChanged = !isNaN(previousPage) && previousPage !== currentPage;
  nav.setAttribute("data-current-page", String(currentPage));
  nav.setAttribute("data-total-pages", String(totalPages));

  updatePagerEdgeButtons(nav, currentPage, totalPages);

  if (nav.getAttribute("data-pager-virtual") === "1") {
    var vapi = nav.__pagerVirtualApi;
    if (vapi) {
      var beh = pageChanged ? "smooth" : behavior || "auto";
      vapi.goTo(currentPage, beh, isNaN(previousPage) ? null : previousPage);
    }
    return;
  }

  var pages = nav.querySelectorAll(".pager-slider-page");
  var active = null;
  for (var i = 0; i < pages.length; i++) {
    var match =
      parseInt(pages[i].getAttribute("data-page"), 10) === currentPage;
    pages[i].classList.toggle("pg-active", match);
    if (match) {
      pages[i].setAttribute("aria-current", "page");
      active = pages[i];
    } else {
      pages[i].removeAttribute("aria-current");
    }
  }

  var api = nav.__pagerSliderApi;
  if (api && active) {
    api.refreshPages();
    api.centerPageButton(active, pageChanged ? "smooth" : behavior || "auto");
    api.previewPage(active);
  }
}

function initPagerSlider(nav, currentPage, totalPages) {
  if (!nav) return;
  if (nav.getAttribute("data-pager-slider-ready") === "1") return;
  nav.setAttribute("data-pager-slider-ready", "1");

  var viewport = nav.querySelector(".pager-slider-viewport");
  if (!viewport) return;

  if (nav.getAttribute("data-pager-virtual") === "1") {
    initPagerVirtual(nav, viewport, currentPage, totalPages);
    return;
  }

  var pages = [];
  var centers = [];
  var dragging = false;
  var moved = false;
  var horizontalIntent = false;
  var pointerCaptured = false;
  var startX = 0;
  var startY = 0;
  var startScroll = 0;
  var wheelTimer = null;
  var wheelTargetPage = null;
  var scrollRaf = null;

  function refreshPages() {
    pages = Array.prototype.slice.call(
      nav.querySelectorAll(".pager-slider-page"),
    );
    var track = nav.querySelector(".pager-slider-track");
    if (track && pages.length) {
      var edgePadding = Math.max(
        0,
        (viewport.clientWidth - pages[0].offsetWidth) / 2,
      );
      track.style.paddingLeft = edgePadding + "px";
      track.style.paddingRight = edgePadding + "px";
    }
    centers = [];
    for (var p = 0; p < pages.length; p++) {
      centers.push(pages[p].offsetLeft + pages[p].offsetWidth / 2);
    }
  }

  function nearestPage() {
    if (!pages.length) return null;
    var center = viewport.scrollLeft + viewport.clientWidth / 2;
    var lo = 0;
    var hi = centers.length - 1;
    while (lo < hi) {
      var mid = Math.floor((lo + hi) / 2);
      if (centers[mid] < center) lo = mid + 1;
      else hi = mid;
    }
    var best = lo;
    if (
      lo > 0 &&
      Math.abs(centers[lo - 1] - center) < Math.abs(centers[lo] - center)
    ) {
      best = lo - 1;
    }
    return pages[best];
  }

  function centerPageButton(btn, behavior) {
    if (!btn) return;
    var left = btn.offsetLeft + btn.offsetWidth / 2 - viewport.clientWidth / 2;
    if (behavior === "auto") {
      var previousScrollBehavior = viewport.style.scrollBehavior;
      viewport.style.scrollBehavior = "auto";
      viewport.scrollLeft = left;
      viewport.style.scrollBehavior = previousScrollBehavior;
      return;
    }
    viewport.scrollTo({ left: left, behavior: behavior || "smooth" });
  }

  function previewPage(btn) {
    if (!btn) return;
    for (var p = 0; p < pages.length; p++) {
      var active = pages[p] === btn;
      pages[p].classList.toggle("pg-active", active);
      if (active) pages[p].setAttribute("aria-current", "page");
      else pages[p].removeAttribute("aria-current");
    }
  }

  function fadePagerToolbarOnce() {
    var wrap =
      nav.closest(".pagination-wrap") ||
      nav.querySelector(".pager-slider-wrap");
    if (!wrap) return;
    wrap.classList.remove(
      "pagination-toolbar-entrance",
      "pagination-toolbar-exit",
    );
    void wrap.offsetWidth;
    wrap.classList.add("pagination-toolbar-exit");
    setTimeout(function () {
      wrap.classList.remove("pagination-toolbar-exit");
      wrap.classList.add("pagination-toolbar-entrance");
    }, 160);
  }

  nav.__pagerSliderApi = {
    refreshPages: refreshPages,
    centerPageButton: centerPageButton,
    previewPage: previewPage,
  };

  function schedulePreview() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = null;
      previewPage(nearestPage());
    });
  }

  function commitPage(btn) {
    if (!btn) return;
    var page = parseInt(btn.getAttribute("data-page"), 10);
    var current =
      parseInt(nav.getAttribute("data-current-page"), 10) || currentPage;
    centerPageButton(btn, "smooth");
    previewPage(btn);
    if (!isNaN(page) && page !== current) {
      var restoreMoved = moved;
      moved = false;
      btn.click();
      moved = restoreMoved;
    }
  }

  function snapToNearest(commit) {
    refreshPages();
    var btn = nearestPage();
    centerPageButton(btn, "smooth");
    previewPage(btn);
    if (commit) commitPage(btn);
  }

  viewport.addEventListener("scroll", schedulePreview);
  viewport.addEventListener(
    "wheel",
    function (e) {
      e.preventDefault();
      refreshPages();
      var delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (!delta) return;
      if (wheelTargetPage == null) {
        var current =
          parseInt(nav.getAttribute("data-current-page"), 10) || currentPage;
        wheelTargetPage = Math.max(
          1,
          Math.min(totalPages, current + (delta > 0 ? 1 : -1)),
        );
      }
      var target = nav.querySelector(
        '.pager-slider-page[data-page="' + wheelTargetPage + '"]',
      );
      if (target) {
        centerPageButton(target, "smooth");
        previewPage(target);
      }
      if (wheelTimer) clearTimeout(wheelTimer);
      wheelTimer = setTimeout(function () {
        if (target) commitPage(target);
        wheelTargetPage = null;
      }, 180);
    },
    { passive: false },
  );

  viewport.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    horizontalIntent = e.pointerType === "mouse";
    startX = e.clientX;
    startY = e.clientY;
    startScroll = viewport.scrollLeft;
    refreshPages();
    pointerCaptured = false;
    viewport.classList.add("dragging");
    document.body.style.userSelect = "none";
  });

  viewport.addEventListener(
    "pointermove",
    function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (!horizontalIntent) {
        if (Math.abs(dx) <= 4 || Math.abs(dx) <= Math.abs(dy)) return;
        horizontalIntent = true;
      }
      if (Math.abs(dx) > 2) moved = true;
      if (moved && !pointerCaptured && viewport.setPointerCapture) {
        viewport.setPointerCapture(e.pointerId);
        pointerCaptured = true;
      }
      if (e.cancelable) e.preventDefault();
      viewport.scrollLeft = startScroll - dx;
    },
    { passive: false },
  );

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    if (e && pointerCaptured && viewport.releasePointerCapture)
      viewport.releasePointerCapture(e.pointerId);
    pointerCaptured = false;
    viewport.classList.remove("dragging");
    document.body.style.userSelect = "";
    if (moved) snapToNearest(true);
  }

  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  nav.addEventListener(
    "click",
    function (e) {
      var navBtn = e.target.closest(".pager-edge-btn, .pager-step-btn");
      if (navBtn && !navBtn.disabled) {
        var targetPage = parseInt(navBtn.getAttribute("data-page"), 10);
        var targetBtn = !isNaN(targetPage)
          ? nav.querySelector(
              '.pager-slider-page[data-page="' + targetPage + '"]',
            )
          : null;
        refreshPages();
        if (targetBtn) {
          centerPageButton(targetBtn, "smooth");
          previewPage(targetBtn);
        } else {
          fadePagerToolbarOnce();
        }
        return;
      }

      var pageBtn = e.target.closest(".pager-slider-page");
      if (!pageBtn) return;
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
        return;
      }
      refreshPages();
      centerPageButton(pageBtn, "smooth");
      previewPage(pageBtn);
    },
    true,
  );

  refreshPages();
  requestAnimationFrame(function () {
    refreshPages();
    var active =
      nav.querySelector(
        '.pager-slider-page[data-page="' + currentPage + '"]',
      ) || nearestPage();
    var scrollFromPage = parseInt(
      nav.getAttribute("data-scroll-from-page"),
      10,
    );
    nav.removeAttribute("data-scroll-from-page");
    var fromBtn =
      !isNaN(scrollFromPage) && scrollFromPage !== currentPage
        ? nav.querySelector(
            '.pager-slider-page[data-page="' + scrollFromPage + '"]',
          )
        : null;
    if (fromBtn && active) {
      centerPageButton(fromBtn, "auto");
      requestAnimationFrame(function () {
        refreshPages();
        centerPageButton(active, "smooth");
        previewPage(active);
      });
    } else {
      centerPageButton(active, "auto");
      previewPage(active);
    }
  });
}

// 虚拟化滑块控制器：固定槽宽、绝对定位、按视口回收按钮。
// 几何量由 index×槽宽 直接算出，滚动 / 拖拽 / 点击均为常数开销，可承载数十万页。
function initPagerVirtual(nav, viewport, currentPage, totalPages) {
  var track = nav.querySelector(".pager-slider-track");
  if (!track) return;
  var slotW =
    parseInt(nav.getAttribute("data-slot-w"), 10) ||
    pagerVirtualSlotWidth(totalPages);
  var WINDOW_BUFFER = 6;

  var pool = {}; // page(number) -> button element
  var edgePad = 0; // 轨道两端留白，使首/末页也能滚到视口中央
  var trackW = -1; // 已写入的轨道宽度（避免每次都写样式触发布局）
  var lastVpW = -1; // 上次几何同步时的视口宽度
  var positionedEdgePad = null; // 池中按钮 left 所依据的 edgePad

  var dragging = false;
  var moved = false;
  var horizontalIntent = false;
  var pointerCaptured = false;
  var startX = 0;
  var startY = 0;
  var startScroll = 0;
  var wheelTimer = null;
  var wheelTargetPage = null;
  var scrollRaf = null;

  function clampPage(page) {
    return Math.max(1, Math.min(totalPages, page));
  }

  function currentPageAttr() {
    return parseInt(nav.getAttribute("data-current-page"), 10) || currentPage;
  }

  function syncGeometry() {
    var vpW = viewport.clientWidth;
    edgePad = Math.max(0, (vpW - slotW) / 2);
    var w = Math.round(edgePad * 2 + totalPages * slotW);
    if (w !== trackW) {
      trackW = w;
      track.style.width = w + "px";
    }
    lastVpW = vpW;
  }

  function pageLeft(page) {
    return edgePad + (page - 1) * slotW;
  }

  function pageCenter(page) {
    return edgePad + (page - 1) * slotW + slotW / 2;
  }

  function scrollForPage(page) {
    return pageCenter(page) - viewport.clientWidth / 2;
  }

  function pageAtScroll() {
    var center = viewport.scrollLeft + viewport.clientWidth / 2;
    var page = Math.round((center - edgePad - slotW / 2) / slotW) + 1;
    return clampPage(page);
  }

  function ensureButton(page) {
    var btn = pool[page];
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pg-num pager-slider-page";
      btn.setAttribute("data-page", String(page));
      btn.setAttribute("aria-label", "第 " + page + " 页");
      btn.style.left = pageLeft(page) + "px";
      btn.textContent = page;
      track.appendChild(btn);
      pool[page] = btn;
    }
    return btn;
  }

  // edgePad 变化（视口缩放）后，池中既有按钮的 left 已过期，需整体重定位。
  function repositionPool() {
    for (var k in pool) {
      if (pool.hasOwnProperty(k))
        pool[k].style.left = pageLeft(parseInt(k, 10)) + "px";
    }
    positionedEdgePad = edgePad;
  }

  // 只保留视口内 [first, last]（含缓冲）的按钮，其余回收；activePage 高亮当前/预览页。
  function renderWindow(activePage) {
    if (viewport.clientWidth !== lastVpW) syncGeometry();
    if (positionedEdgePad !== edgePad) repositionPool();
    var cur = activePage != null ? clampPage(activePage) : currentPageAttr();
    var viewStart = viewport.scrollLeft;
    var viewEnd = viewStart + viewport.clientWidth;
    var first = clampPage(
      Math.floor((viewStart - edgePad) / slotW) + 1 - WINDOW_BUFFER,
    );
    var last = clampPage(
      Math.ceil((viewEnd - edgePad) / slotW) + WINDOW_BUFFER,
    );

    for (var key in pool) {
      if (!pool.hasOwnProperty(key)) continue;
      var pn = parseInt(key, 10);
      if (pn < first || pn > last) {
        track.removeChild(pool[key]);
        delete pool[key];
      }
    }

    for (var page = first; page <= last; page++) {
      var btn = ensureButton(page);
      var active = page === cur;
      btn.classList.toggle("pg-active", active);
      if (active) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    }
  }

  function scrollToPage(page, behavior) {
    var left = scrollForPage(page);
    if (behavior === "auto") {
      var prev = viewport.style.scrollBehavior;
      viewport.style.scrollBehavior = "auto";
      viewport.scrollLeft = left;
      viewport.style.scrollBehavior = prev;
      return;
    }
    viewport.scrollTo({ left: left, behavior: behavior || "smooth" });
  }

  // 大跨度跳转用瞬移（'auto'）而非平滑滚动，避免跨越百万像素的漫长动画。
  function goToPage(page, behavior, fromPage) {
    syncGeometry();
    page = clampPage(page);
    var from = fromPage != null && !isNaN(fromPage) ? fromPage : pageAtScroll();
    var beh = behavior || "auto";
    if (beh === "smooth" && Math.abs(page - from) > 40) beh = "auto";
    scrollToPage(page, beh);
    renderWindow(page);
  }

  function fadePagerToolbarOnce() {
    var wrap =
      nav.closest(".pagination-wrap") ||
      nav.querySelector(".pager-slider-wrap");
    if (!wrap) return;
    wrap.classList.remove(
      "pagination-toolbar-entrance",
      "pagination-toolbar-exit",
    );
    void wrap.offsetWidth;
    wrap.classList.add("pagination-toolbar-exit");
    setTimeout(function () {
      wrap.classList.remove("pagination-toolbar-exit");
      wrap.classList.add("pagination-toolbar-entrance");
    }, 160);
  }

  nav.__pagerVirtualApi = {
    goTo: goToPage,
    refresh: function () {
      syncGeometry();
      renderWindow();
    },
  };

  function schedulePreview() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = null;
      if (viewport.clientWidth !== lastVpW) syncGeometry();
      renderWindow(pageAtScroll());
    });
  }

  function commitPage(page) {
    page = clampPage(page);
    var current = currentPageAttr();
    scrollToPage(page, "smooth");
    renderWindow(page);
    if (page !== current) {
      var btn = pool[page];
      if (btn) {
        var restoreMoved = moved;
        moved = false;
        btn.click();
        moved = restoreMoved;
      }
    }
  }

  function snapToNearest(commit) {
    var page = pageAtScroll();
    scrollToPage(page, "smooth");
    renderWindow(page);
    if (commit) commitPage(page);
  }

  viewport.addEventListener("scroll", schedulePreview);
  viewport.addEventListener(
    "wheel",
    function (e) {
      e.preventDefault();
      var delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (!delta) return;
      if (wheelTargetPage == null) {
        wheelTargetPage = clampPage(currentPageAttr() + (delta > 0 ? 1 : -1));
      }
      scrollToPage(wheelTargetPage, "smooth");
      renderWindow(wheelTargetPage);
      if (wheelTimer) clearTimeout(wheelTimer);
      wheelTimer = setTimeout(function () {
        commitPage(wheelTargetPage);
        wheelTargetPage = null;
      }, 180);
    },
    { passive: false },
  );

  viewport.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    horizontalIntent = e.pointerType === "mouse";
    startX = e.clientX;
    startY = e.clientY;
    startScroll = viewport.scrollLeft;
    pointerCaptured = false;
    viewport.classList.add("dragging");
    document.body.style.userSelect = "none";
  });

  viewport.addEventListener(
    "pointermove",
    function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (!horizontalIntent) {
        if (Math.abs(dx) <= 4 || Math.abs(dx) <= Math.abs(dy)) return;
        horizontalIntent = true;
      }
      if (Math.abs(dx) > 2) moved = true;
      if (moved && !pointerCaptured && viewport.setPointerCapture) {
        viewport.setPointerCapture(e.pointerId);
        pointerCaptured = true;
      }
      if (e.cancelable) e.preventDefault();
      viewport.scrollLeft = startScroll - dx;
    },
    { passive: false },
  );

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    if (e && pointerCaptured && viewport.releasePointerCapture)
      viewport.releasePointerCapture(e.pointerId);
    pointerCaptured = false;
    viewport.classList.remove("dragging");
    document.body.style.userSelect = "";
    if (moved) snapToNearest(true);
  }

  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  nav.addEventListener(
    "click",
    function (e) {
      var navBtn = e.target.closest(".pager-edge-btn, .pager-step-btn");
      if (navBtn && !navBtn.disabled) {
        var targetPage = parseInt(navBtn.getAttribute("data-page"), 10);
        if (!isNaN(targetPage)) {
          // 边/步按钮：目标在窗口内则平滑滚动即时反馈；跨大段跳转交给导航完成后的
          // updatePagerSliderNav 统一定位（大跨度会用瞬移），这里只做一次淡入提示。
          if (Math.abs(targetPage - currentPageAttr()) <= 40) {
            scrollToPage(targetPage, "smooth");
            renderWindow(targetPage);
          } else {
            fadePagerToolbarOnce();
          }
        }
        return;
      }

      var pageBtn = e.target.closest(".pager-slider-page");
      if (!pageBtn) return;
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
        return;
      }
      var page = parseInt(pageBtn.getAttribute("data-page"), 10);
      if (!isNaN(page)) {
        scrollToPage(page, "smooth");
        renderWindow(page);
      }
    },
    true,
  );

  requestAnimationFrame(function () {
    syncGeometry();
    var scrollFromPage = parseInt(
      nav.getAttribute("data-scroll-from-page"),
      10,
    );
    nav.removeAttribute("data-scroll-from-page");
    if (
      !isNaN(scrollFromPage) &&
      scrollFromPage !== currentPage &&
      Math.abs(scrollFromPage - currentPage) <= 40
    ) {
      scrollToPage(scrollFromPage, "auto");
      renderWindow(scrollFromPage);
      requestAnimationFrame(function () {
        scrollToPage(currentPage, "smooth");
        renderWindow(currentPage);
      });
    } else {
      scrollToPage(currentPage, "auto");
      renderWindow(currentPage);
    }
  });
}

var paginationResizeTimer;

export {
  buildPagination,
  updatePagerSliderInWrap,
  syncPagerSlider,
  updatePagerSliderNav,
  initPagerSlider,
};

export function init() {
  window.addEventListener("resize", function () {
    clearTimeout(paginationResizeTimer);
    paginationResizeTimer = setTimeout(function () {
      if (state.totalPages > 1) {
        if (
          typeof isDatabaseView === "function"
            ? isDatabaseView(state.view)
            : state.view === "allWorks" ||
              state.view === "authors" ||
              state.view === "authorWorks" ||
              state.view === "dbSearch"
        ) {
          renderAllWorksToolbar(state);
        } else {
          renderToolbar(state);
        }
      }
    }, 150);
  });
}
