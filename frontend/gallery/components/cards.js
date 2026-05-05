import {
  applyCurrentGalleryLayoutShell,
  applyGridColumns,
  applyGridColumnsRaw,
  syncCardTags,
} from "./settings.js";
import { GridMotion } from "./motion.js";
import { CARD_ICONS, escHtml, galleryLayoutKey, state } from "../model.js";
import { apiUrl } from "../view-data.js";
import { badgeDefinitions } from "../../shared/labels.js";

function afterGridContentMutation(root) {
  if (typeof applyGridColumnsRaw === "function") applyGridColumnsRaw(root);
  else if (typeof applyGridColumns === "function") applyGridColumns(root);
  if (typeof syncCardTags === "function") syncCardTags(root);
}

function replaceContentWithMotion(el, html, reason, opts) {
  opts = opts || {};
  var motion = opts.motion || "data";
  if (motion === "data" && GridMotion && GridMotion.replaceGridWithMotion) {
    var mixedLayout = !!(state && state.pendingLayoutDataMotion);
    if (state) state.pendingLayoutDataMotion = false;
    GridMotion.replaceGridWithMotion(el, html, {
      reason: reason || "data",
      motion: "data",
      allowLayoutMorph: mixedLayout,
      beforeMutate: function () {
        if (typeof applyCurrentGalleryLayoutShell === "function")
          applyCurrentGalleryLayoutShell();
      },
      afterMutate: function () {
        afterGridContentMutation(el);
      },
    });
    return;
  }
  el.innerHTML = html;
  afterGridContentMutation(el);
}

function currentLayoutKey() {
  if (typeof galleryLayoutKey === "function") {
    return galleryLayoutKey(
      state.viewMode || "grid",
      state.contentWidth || "standard",
    );
  }
  return (state.viewMode || "grid") + "@" + (state.contentWidth || "standard");
}

function motionIdentityAttrs(contentKey) {
  var content = String(contentKey == null ? "" : contentKey);
  var layout = currentLayoutKey();
  var motion = content + "::" + layout;
  return (
    ' data-content-key="' +
    escAttr(content) +
    '"' +
    ' data-anchor-key="' +
    escAttr(content) +
    '"' +
    ' data-layout-key="' +
    escAttr(layout) +
    '"' +
    ' data-motion-key="' +
    escAttr(motion) +
    '"'
  );
}

function cardThumbHtml(fullPath, altText) {
  return (
    '<span class="thumb-clip"><img src="' +
    apiUrl("thumbnail", fullPath) +
    '" alt="' +
    escHtml(altText) +
    '" loading="lazy"></span>'
  );
}

function cardCoverHtml(dirPath, cover, coverType) {
  if (cover && coverType) {
    var coverPath = dirPath + "/" + cover;
    return (
      '<span class="folder-cover-clip"><img src="' +
      apiUrl("thumbnail", coverPath) +
      '" alt="" loading="lazy"></span>'
    );
  }
  return '<span class="cover-fallback"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>';
}

function gridViewClass() {
  var m = state.viewMode || "grid";
  return m === "compact" ? " view-compact" : m === "list" ? " view-list" : "";
}

function formatCardDate(s) {
  if (!s) return "";
  var m = String(s).match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (m) return m[1] + " " + m[2];
  return String(s).slice(0, 10);
}

var BADGE_CORNER_CLASS = {
  cover_top_left: "pos-tl",
  cover_top_right: "pos-tr",
  cover_bottom_left: "pos-bl",
  cover_bottom_right: "pos-br",
};

function badgeDefs() {
  return badgeDefinitions;
}

function resolveBadges(ids) {
  if (!ids || !ids.length) return [];
  var defs = badgeDefs();
  var out = [];
  for (var i = 0; i < defs.length; i++) {
    if (ids.indexOf(defs[i].id) !== -1) out.push(defs[i]);
  }
  return out;
}

function badgeStyle(badge) {
  var style =
    "--badge-color:" +
    badge.color +
    ";--badge-bg:" +
    badge.background +
    ";--badge-border:" +
    (badge.border || "transparent") +
    ";";
  if (badge.colorLight)
    style += "--badge-color-light:" + badge.colorLight + ";";
  if (badge.backgroundLight)
    style += "--badge-bg-light:" + badge.backgroundLight + ";";
  if (badge.borderLight)
    style += "--badge-border-light:" + badge.borderLight + ";";
  return escAttr(style);
}

function coverBadgesHtml(ids) {
  var badges = resolveBadges(ids);
  var slots = {};
  for (var i = 0; i < badges.length; i++) {
    var cls = BADGE_CORNER_CLASS[badges[i].position];
    if (!cls) continue;
    if (!slots[cls]) slots[cls] = [];
    slots[cls].push(
      '<span class="media-corner" style="' +
        badgeStyle(badges[i]) +
        '">' +
        escHtml(badges[i].label) +
        "</span>",
    );
  }
  var out = "";
  for (var cornerClass in slots) {
    if (!Object.prototype.hasOwnProperty.call(slots, cornerClass)) continue;
    out +=
      '<span class="media-corner-slot ' +
      cornerClass +
      '">' +
      slots[cornerClass].join("") +
      "</span>";
  }
  return out;
}

function mediaTagsHtml(tags) {
  // Only associated tag identities are clickable tags. Presentation badges
  // neither invent tags nor suppress an independently associated tag.
  var out = [];
  tags = tags || [];
  for (var j = 0; j < tags.length; j++) {
    var t = String(tags[j] || "");
    if (!t) continue;
    out.push(
      '<span class="media-tag" data-tag="' +
        escAttr(t) +
        '">' +
        escHtml(t) +
        "</span>",
    );
  }
  return out.length ? '<div class="media-tags">' + out.join("") + "</div>" : "";
}

function mediaFieldHtml(cls, content, extraAttrs) {
  if (!content) return "";
  return (
    '<div class="' + cls + '"' + (extraAttrs || "") + ">" + content + "</div>"
  );
}

function mediaTitleHtml(text, detail) {
  return mediaFieldHtml(
    "media-title",
    escHtml(text),
    detail ? " data-detail" : "",
  );
}

function mediaAuthorHtml(label, route, locked) {
  if (!label) return "";
  var attrs = route
    ? ' data-author-route="' + escAttr(route) + '"'
    : locked
      ? ' style="cursor:default"'
      : "";
  return mediaFieldHtml(
    "media-author",
    '<span class="at">@</span>' + escHtml(label),
    attrs,
  );
}

function mediaTimeHtml(text) {
  return mediaFieldHtml("media-time", escHtml(text), "");
}

function escAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function workCardDataAttrs(openTag, item) {
  var path =
    item.parentPath != null
      ? item.parentPath === "/"
        ? "/" + item.name
        : item.parentPath + "/" + item.name
      : item.path || "";
  return (
    openTag +
    ' data-d-title="' +
    escAttr(item.displayName || item.name) +
    '"' +
    ' data-d-author="' +
    escAttr(item.subtitle || "") +
    '"' +
    ' data-d-author-id="' +
    escAttr(item.authorId || "") +
    '"' +
    ' data-d-platform="' +
    escAttr(item.platform || "") +
    '"' +
    ' data-d-date="' +
    escAttr(item.date || "") +
    '"' +
    ' data-d-source="' +
    escAttr(item.sourceUrl || "") +
    '"' +
    ' data-d-tags="' +
    escAttr(JSON.stringify(item.tags || [])) +
    '"' +
    ' data-d-cover="' +
    escAttr(item.cover || "") +
    '"' +
    ' data-d-path="' +
    escAttr(path) +
    '"'
  );
}

function mediaCoverHtml(coverInner, opts) {
  opts = opts || {};
  var hover = opts.hoverActions || "";
  return (
    '<div class="media-cover">' +
    coverBadgesHtml(opts.badges) +
    coverInner +
    hover +
    "</div>"
  );
}

function renderGrid(data) {
  var el = document.getElementById("content");
  if (data.items.length === 0) {
    replaceContentWithMotion(
      el,
      '<div class="empty entrance" style="animation-delay:.14s">这个文件夹是空的</div>',
      "browse-empty",
    );
    return;
  }
  var html = '<div class="grid' + gridViewClass() + '">';
  var mediaIdx = data.mediaOffset;
  for (var i = 0; i < data.items.length; i++) {
    var item = data.items[i];
    if (item.kind === "dir") {
      html += renderBrowseDirCard(item, data.path);
    } else {
      html += renderBrowseMediaCard(item, mediaIdx, data.path);
      mediaIdx++;
    }
  }
  html += "</div>";
  replaceContentWithMotion(el, html, "browse-grid");
}

function renderBrowseDirCard(dir, parentPath) {
  var dirPath =
    parentPath === "/" ? "/" + dir.name : parentPath + "/" + dir.name;
  var cover = mediaCoverHtml(cardCoverHtml(dirPath, dir.cover, dir.coverType), {
    badges: dir.badges,
  });
  var badge = mediaTimeHtml(dir.badge || "");
  return (
    '<div class="card dir card--media" data-path="' +
    dirPath +
    '"' +
    motionIdentityAttrs("dir:" + dirPath) +
    ' data-badge="' +
    escHtml(dir.badge || "") +
    '" data-badges="' +
    escAttr((dir.badges || []).join(",")) +
    '">' +
    cover +
    '<div class="media-info">' +
    mediaTitleHtml(dir.displayName || dir.name, false) +
    badge +
    mediaTagsHtml([], dir.badges) +
    "</div></div>"
  );
}

function mediaHoverActions(fullPath, isVid) {
  fullPath = escAttr(fullPath);
  var link = isVid
    ? '<button class="mh-btn link-copy" data-path="' +
      fullPath +
      '" title="复制链接">' +
      CARD_ICONS.link +
      "</button>"
    : '<button class="mh-btn link-btn" data-path="' +
      fullPath +
      '" title="复制链接">' +
      CARD_ICONS.link +
      "</button>";
  var dl =
    '<button class="mh-btn dl-btn" data-path="' +
    fullPath +
    '" title="下载">' +
    CARD_ICONS.dl +
    "</button>";
  return '<div class="media-hover-actions">' + link + dl + "</div>";
}

function renderBrowseMediaCard(media, globalIdx, parentPath) {
  var fullPath =
    parentPath === "/" ? "/" + media.name : parentPath + "/" + media.name;
  var isVid = media.kind === "vid";
  var thumbHtml = cardThumbHtml(fullPath, media.name);
  if (isVid) thumbHtml += '<span class="vid-placeholder"></span>';
  var cover = mediaCoverHtml(thumbHtml, {
    badges: media.badges,
    hoverActions: mediaHoverActions(fullPath, isVid),
  });
  return (
    '<div class="card img card--media' +
    (isVid ? " card-video" : "") +
    '" data-lb-index="' +
    globalIdx +
    '"' +
    motionIdentityAttrs("media:" + fullPath) +
    ">" +
    cover +
    '<div class="media-info">' +
    mediaTitleHtml(media.name, false) +
    mediaTagsHtml([], media.badges) +
    "</div></div>"
  );
}

export {
  afterGridContentMutation,
  replaceContentWithMotion,
  currentLayoutKey,
  motionIdentityAttrs,
  cardThumbHtml,
  cardCoverHtml,
  gridViewClass,
  formatCardDate,
  BADGE_CORNER_CLASS,
  badgeDefs,
  resolveBadges,
  badgeStyle,
  coverBadgesHtml,
  mediaTagsHtml,
  mediaFieldHtml,
  mediaTitleHtml,
  mediaAuthorHtml,
  mediaTimeHtml,
  escAttr,
  workCardDataAttrs,
  mediaCoverHtml,
  renderGrid,
  renderBrowseDirCard,
  mediaHoverActions,
  renderBrowseMediaCard,
};
