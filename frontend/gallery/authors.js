import { syncSearchInputs, syncSearchMeta } from "./components/search.js";
import {
  renderBreadcrumbs,
  renderDbFilterbar,
  renderMetaText,
} from "./components/results.js";
import { renderAllWorksToolbar } from "./works.js";
import { initLabelScroll } from "./components/scroll.js";
import {
  cardCoverHtml,
  formatCardDate,
  gridViewClass,
  mediaCoverHtml,
  mediaTimeHtml,
  mediaTitleHtml,
  motionIdentityAttrs,
  replaceContentWithMotion,
} from "./components/cards.js";
import { authorRoutePath } from "./routes.js";
import { escHtml } from "./model.js";

function authorCardKey(item, platformId) {
  return (
    "author:" +
    (platformId || item.platform || "") +
    ":" +
    (item.authorId || item.name || item.routePath || item.authorPath || "")
  );
}

function renderAuthors(data) {
  syncSearchInputs(data.query || "");
  syncSearchMeta();
  renderBreadcrumbs(data.breadcrumbs);
  renderAuthorsMeta(data);
  renderDbFilterbar("authors");
  renderAllWorksToolbar(data);
  renderAuthorsGrid(data);
  initLabelScroll();
}

function renderAuthorsMeta(data) {
  var text = data.query
    ? '搜索 "' + data.query + '" ' + data.totalItems + "位作者"
    : data.totalItems + "位作者";
  renderMetaText(text);
}

function renderAuthorsGrid(data) {
  var el = document.getElementById("content");
  if (!data.items || data.items.length === 0) {
    replaceContentWithMotion(
      el,
      '<div class="empty entrance" style="animation-delay:.14s">暂无作者</div>',
      "authors-empty",
    );
    return;
  }
  var html = '<div class="grid' + gridViewClass() + '">';
  for (var i = 0; i < data.items.length; i++) {
    html += renderAuthorCard(data.items[i], data.platformId);
  }
  html += "</div>";
  replaceContentWithMotion(el, html, "authors-grid");
}

function renderAuthorCard(item, platformId) {
  var routePath =
    item.routePath || authorRoutePath(platformId, item.authorId || item.name);
  var authorPath = item.authorPath || "";
  var cover = mediaCoverHtml(
    cardCoverHtml(authorPath, item.cover, item.coverType),
    {},
  );
  var sub = mediaTimeHtml(item.badge || "");
  var updated = mediaTimeHtml(
    item.latestDate ? "更新 " + formatCardDate(item.latestDate) : "",
  );
  return (
    '<div class="card dir card--media" data-path="' +
    escHtml(routePath) +
    '" data-author-path="' +
    escHtml(authorPath) +
    '"' +
    motionIdentityAttrs(authorCardKey(item, platformId)) +
    ">" +
    cover +
    '<div class="media-info">' +
    mediaTitleHtml(item.displayName || item.name, false) +
    sub +
    updated +
    "</div></div>"
  );
}

export {
  authorCardKey,
  renderAuthors,
  renderAuthorsMeta,
  renderAuthorsGrid,
  renderAuthorCard,
};
