import {
  clearPaginationFadeState,
  getGlobalToolbarEl,
  paginationToolbarKey,
  paginationWrapHtml,
  renderBottomPagination,
  renderBreadcrumbs,
  renderDbFilterbar,
  renderMetaText,
  renderToolbar,
  replacePaginationWrapWithFade,
  runPaginationWrapEntrance,
  syncPaginationExtra,
  syncPaginationWrapState,
} from "./components/results.js";
import { escHtml, state } from "./model.js";
import { syncSearchInputs, syncSearchMeta } from "./components/search.js";
import { initLabelScroll } from "./components/scroll.js";
import {
  cardCoverHtml,
  cardThumbHtml,
  escAttr,
  formatCardDate,
  gridViewClass,
  mediaAuthorHtml,
  mediaCoverHtml,
  mediaTagsHtml,
  mediaTimeHtml,
  mediaTitleHtml,
  motionIdentityAttrs,
  replaceContentWithMotion,
  workCardDataAttrs,
} from "./components/cards.js";
import {
  buildPagination,
  syncPagerSlider,
  updatePagerSliderInWrap,
} from "./components/pagination.js";
import { authorRoutePath } from "./routes.js";

function renderSearchMeta(data) {
  var text =
    (data.query ? '搜索 "' + data.query + '" ' : "") +
    (data.tag ? '标签 "' + data.tag + '" ' : "") +
    data.totalItems +
    "个结果";
  renderMetaText(text);
}

function dbWorkCardKey(item, fullPath) {
  var platform = item.platform || state.platformId || "";
  var authorId = item.authorId || "";
  var unique =
    item.postId ||
    item.post_id ||
    item.workId ||
    item.id ||
    item.sourceUrl ||
    fullPath ||
    item.path ||
    item.name ||
    item.displayName ||
    "";
  return "work:" + platform + ":" + authorId + ":" + unique;
}

function renderSearchResult(data) {
  syncSearchInputs(data.query);
  syncSearchMeta();
  renderBreadcrumbs(state.breadcrumbs);
  renderSearchMeta(data);
  renderDbFilterbar(data.db ? "works" : "none");
  if (data.db) renderAllWorksToolbar(data);
  else renderToolbar(data);
  renderSearchGrid(data);
  initLabelScroll();
}

function renderSearchGrid(data) {
  var el = document.getElementById("content");
  if (data.items.length === 0) {
    replaceContentWithMotion(
      el,
      '<div class="empty entrance" style="animation-delay:.14s">未找到匹配的结果</div>',
      "search-empty",
    );
    return;
  }
  var html = '<div class="grid' + gridViewClass() + '">';
  for (var i = 0; i < data.items.length; i++) {
    var item = data.items[i];
    if (item.kind === "dir") {
      html += renderSearchDirCard(item, !!data.db);
    } else {
      html += renderSearchMediaCard(item);
    }
  }
  html += "</div>";
  replaceContentWithMotion(el, html, "search-grid");
}

function renderSearchDirCard(item, isDb) {
  var dirPath =
    item.parentPath === "/"
      ? "/" + item.name
      : item.parentPath + "/" + item.name;
  var key = isDb ? dbWorkCardKey(item, dirPath) : "dir:" + dirPath;
  var cover = mediaCoverHtml(
    cardCoverHtml(dirPath, item.cover, item.coverType),
    { badges: item.badges },
  );
  var author = mediaAuthorHtml(item.subtitle, "", false);
  var time = mediaTimeHtml(item.date ? formatCardDate(item.date) : "");
  return (
    workCardDataAttrs(
      '<div class="card dir card--media" data-path="' +
        dirPath +
        '" data-search-path="' +
        dirPath +
        '"' +
        motionIdentityAttrs(key) +
        ' data-badges="' +
        escAttr((item.badges || []).join(",")) +
        '"',
      item,
    ) +
    ">" +
    cover +
    '<div class="media-info">' +
    mediaTitleHtml(item.displayName || item.name, true) +
    author +
    time +
    mediaTagsHtml(item.tags, item.badges) +
    "</div></div>"
  );
}

function renderSearchMediaCard(item) {
  var fullPath =
    item.parentPath === "/"
      ? "/" + item.name
      : item.parentPath + "/" + item.name;
  var isVid = item.kind === "vid";
  var thumbHtml = cardThumbHtml(fullPath, item.name);
  if (isVid) thumbHtml += '<span class="vid-placeholder"></span>';
  var cover = mediaCoverHtml(thumbHtml, { badges: item.badges });
  return (
    '<div class="card img card--media' +
    (isVid ? " card-video" : "") +
    '" data-search-parent="' +
    item.parentPath +
    '" data-search-media="' +
    escHtml(item.name) +
    '"' +
    motionIdentityAttrs("media:" + fullPath) +
    ">" +
    cover +
    '<div class="media-info">' +
    mediaTitleHtml(item.name, false) +
    mediaTagsHtml([], item.badges) +
    "</div></div>"
  );
}

function renderAuthorWorks(data) {
  syncSearchInputs(data.query || "");
  syncSearchMeta();
  renderBreadcrumbs(data.breadcrumbs);
  renderAuthorWorksMeta(data);
  renderDbFilterbar("works");
  renderAllWorksToolbar(data);
  renderAllWorksGrid(data);
  initLabelScroll();
}

function renderAuthorWorksMeta(data) {
  var text = data.query
    ? '搜索 "' + data.query + '" ' + data.totalItems + "个作品"
    : data.totalItems + "个作品";
  renderMetaText(text);
}

function renderAllWorks(data) {
  syncSearchInputs(data.query || "");
  syncSearchMeta();
  renderBreadcrumbs(state.breadcrumbs);
  renderAllWorksMeta(data);
  renderDbFilterbar("works");
  renderAllWorksToolbar(data);
  renderAllWorksGrid(data);
  initLabelScroll();
}

function renderAllWorksMeta(data) {
  var text = data.query
    ? '搜索 "' + data.query + '" ' + data.totalItems + "个作品"
    : data.totalItems + "个作品";
  renderMetaText(text);
}

function renderAllWorksToolbar(data) {
  var pagHtml = buildPagination(data.page, data.totalPages);

  function addEntrance(wrap) {
    if (!wrap) return;
    clearPaginationFadeState(wrap);
    runPaginationWrapEntrance(wrap);
  }

  function renderPaginationContainer(targetEl) {
    var toolbarKey = paginationToolbarKey(data, !!pagHtml, false);
    var wrap = targetEl.querySelector(".pagination-wrap");
    if (
      wrap &&
      wrap.getAttribute("data-toolbar-key") === toolbarKey &&
      updatePagerSliderInWrap(wrap, data.page, data.totalPages)
    ) {
      syncPaginationExtra(wrap, "");
      clearPaginationFadeState(wrap);
      syncPaginationWrapState(wrap, !!pagHtml, false, toolbarKey);
      return wrap;
    }
    var oldNav = targetEl.querySelector(".pager-slider");
    var oldPage = oldNav
      ? parseInt(oldNav.getAttribute("data-current-page"), 10)
      : NaN;
    var nextHtml = paginationWrapHtml(pagHtml, "");
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
    syncPaginationWrapState(wrap, !!pagHtml, false, toolbarKey);
    if (wrap) addEntrance(wrap);
    if (!isNaN(oldPage) && oldPage !== data.page) {
      var newNav = wrap ? wrap.querySelector(".pager-slider") : null;
      if (newNav) newNav.setAttribute("data-scroll-from-page", String(oldPage));
    }
    return wrap;
  }

  renderPaginationContainer(getGlobalToolbarEl());
  renderBottomPagination(data);
  syncPagerSlider(data.page, data.totalPages);
}

function renderAllWorksGrid(data) {
  var el = document.getElementById("content");
  if (!data.items || data.items.length === 0) {
    replaceContentWithMotion(
      el,
      '<div class="empty entrance" style="animation-delay:.14s">暂无作品</div>',
      "works-empty",
    );
    return;
  }
  var html = '<div class="grid' + gridViewClass() + '">';
  for (var i = 0; i < data.items.length; i++) {
    var item = data.items[i];
    var fullPath = (item.parentPath || "") + "/" + item.name;
    html += renderAllWorksCard(item, fullPath);
  }
  html += "</div>";
  replaceContentWithMotion(el, html, "works-grid");
}

function renderAllWorksCard(item, fullPath) {
  var cover = mediaCoverHtml(cardCoverHtml(fullPath, item.cover, "img"), {
    badges: item.badges,
  });
  var title = item.displayName || item.name;
  // 作者作为信息入口（设计 §12）。在作者作品页隐藏（指向自身）。
  var author = "";
  if (item.subtitle) {
    if (item.authorId && item.platform && state.view !== "authorWorks") {
      author = mediaAuthorHtml(
        item.subtitle,
        authorRoutePath(item.platform, item.authorId),
        false,
      );
    } else {
      author = mediaAuthorHtml(item.subtitle, "", true);
    }
  }
  var time = mediaTimeHtml(item.date ? formatCardDate(item.date) : "");
  var openTag =
    '<div class="card dir card--media" data-path="' +
    fullPath +
    '"' +
    motionIdentityAttrs(dbWorkCardKey(item, fullPath));
  return (
    workCardDataAttrs(openTag, item) +
    ">" +
    cover +
    '<div class="media-info">' +
    mediaTitleHtml(title, true) +
    author +
    time +
    mediaTagsHtml(item.tags, item.badges) +
    "</div></div>"
  );
}

export {
  renderSearchMeta,
  dbWorkCardKey,
  renderSearchResult,
  renderSearchGrid,
  renderSearchDirCard,
  renderSearchMediaCard,
  renderAuthorWorks,
  renderAuthorWorksMeta,
  renderAllWorks,
  renderAllWorksMeta,
  renderAllWorksToolbar,
  renderAllWorksGrid,
  renderAllWorksCard,
};
