import {
  normalizeSearchSource,
  requestRouteScrollTop,
  state,
} from "./model.js";
import { LB } from "./viewer/player.js";
import { applyQuerySettings, makeQueryHash } from "./query.js";
import {
  loadAllWorks,
  loadAuthorWorks,
  loadAuthors,
  loadDirectory,
} from "./controller.js";
import { Sidebar } from "./components/sidebar.js";
function normalizeHash(value) {
  var hash = String(value || "");
  if (hash.charAt(0) === "#") hash = hash.slice(1);
  try {
    return decodeURI(hash);
  } catch (e) {
    return hash;
  }
}

// Generation/revision/cursor belong to a request consistency check, not to a
// durable address.  A copied bookmark may still contain them from an older
// Gallery build; discard only those volatile fields and leave the route and
// all user-facing filters untouched.
const VOLATILE_ROUTE_PARAMS = ["g", "rev", "cursor"];

function stripVolatileRouteParams(value) {
  var hash = String(value || "");
  var hadHash = hash.charAt(0) === "#";
  if (hadHash) hash = hash.slice(1);
  var split = hash.indexOf("?");
  if (split < 0) return (hadHash ? "#" : "") + hash;

  var path = hash.slice(0, split);
  var params = new URLSearchParams(hash.slice(split + 1));
  var changed = false;
  for (var i = 0; i < VOLATILE_ROUTE_PARAMS.length; i++) {
    var key = VOLATILE_ROUTE_PARAMS[i];
    if (params.has(key)) {
      params.delete(key);
      changed = true;
    }
  }
  if (!changed) return (hadHash ? "#" : "") + hash;
  return (hadHash ? "#" : "") + path + (params.size ? "?" + params : "");
}

function canonicalizeRouteHash() {
  if (typeof window === "undefined" || !window.location) return "";
  var current = window.location.hash || "";
  var clean = stripVolatileRouteParams(current);
  if (clean !== current && typeof history !== "undefined")
    history.replaceState(history.state, "", clean);
  return clean || current;
}

function navigate(path, page, order, media) {
  if (page === undefined) page = 1;
  if (order === undefined) order = state.order || "asc";
  if (!media) {
    if (typeof requestRouteScrollTop === "function") requestRouteScrollTop();
    if (typeof LB !== "undefined" && LB.clearReturnAnchor) {
      LB.clearReturnAnchor();
    }
  }
  state.searchQuery = "";
  state.searchTag = "";
  state.searchMeta = true;
  var isRoot = path === "/";
  var isDbRoute =
    path.indexOf("/@all/") === 0 ||
    isAuthorListRoute(path) ||
    isAuthorWorksRoute(path);
  state.miscMode = false;
  if (!isDbRoute) localStorage.setItem("gallery_order", order);
  var params = [];
  if (page > 1) params.push("page=" + page);
  if (media) params.push("media=" + encodeURIComponent(media));
  var hash = makeQueryHash(path, { page: page, q: "", tag: "", media: media });
  if (normalizeHash(window.location.hash) !== normalizeHash(hash)) {
    window.location.hash = hash;
  } else if (path.indexOf("/@all/") === 0) {
    var root = getPlatformRoot(path.replace("/@all/", ""));
    if (root) loadAllWorks(root, page);
  } else if (path.indexOf("/@authors/") === 0) {
    var authorListPlatformId = path.replace("/@authors/", "");
    var authorListRoot = getPlatformRoot(authorListPlatformId);
    if (authorListRoot) loadAuthors(authorListRoot, authorListPlatformId, page);
  } else if (path.indexOf("/@author/") === 0) {
    var authorRoute = parseAuthorRoute(path);
    if (authorRoute) {
      var authorRoot = getPlatformRoot(authorRoute.platformId);
      if (authorRoot)
        loadAuthorWorks(
          authorRoot,
          authorRoute.platformId,
          authorRoute.authorId,
          page,
        );
    }
  } else if (isRoot) {
    miscNavigate(page);
  } else {
    loadDirectory(path, page, order, null, media || null);
  }
}

function buildBreadcrumbsFromPath(urlPath) {
  var crumbs = [{ name: "首页", path: "/" }];
  if (!urlPath || urlPath === "/") return crumbs;
  var parts = urlPath.split("/").filter(Boolean);
  var acc = "";
  for (var i = 0; i < parts.length; i++) {
    acc += "/" + parts[i];
    crumbs.push({ name: parts[i], path: acc });
  }
  return crumbs;
}

function decodeRoutePart(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function getPlatformById(id) {
  id = decodeRoutePart(id || "");
  if (typeof Sidebar !== "undefined" && Sidebar.platforms) {
    for (var i = 0; i < Sidebar.platforms.length; i++) {
      if (Sidebar.platforms[i].id === id) return Sidebar.platforms[i];
    }
  }
  return null;
}

function getPlatformRoot(id) {
  var platform = getPlatformById(id);
  return platform ? platform.routePath : null;
}

function getPlatformName(id) {
  var platform = getPlatformById(id);
  return platform ? platform.name : decodeRoutePart(id || "");
}

function authorListPath(platformId) {
  return "/@authors/" + encodeURIComponent(String(platformId || ""));
}

function authorRoutePath(platformId, authorId) {
  return (
    "/@author/" +
    encodeURIComponent(String(platformId || "")) +
    "/" +
    encodeURIComponent(String(authorId || ""))
  );
}

function parseAuthorRoute(urlPath) {
  var prefix = "/@author/";
  if (urlPath.indexOf(prefix) !== 0) return null;
  var rest = urlPath.slice(prefix.length);
  var slash = rest.indexOf("/");
  if (slash < 0) return null;
  return {
    platformId: decodeRoutePart(rest.slice(0, slash)),
    authorId: decodeRoutePart(rest.slice(slash + 1)),
  };
}

function isAuthorListRoute(urlPath) {
  return urlPath.indexOf("/@authors/") === 0;
}

function isAuthorWorksRoute(urlPath) {
  return urlPath.indexOf("/@author/") === 0;
}

// Integer IDs were allocated inside one Catalog generation.  They are not a
// public identity and must never be resolved against a later generation.
function isLegacyIntegerRoutePath(urlPath) {
  urlPath = String(urlPath || "");
  if (/^\/work\/\d+$/.test(urlPath)) return true;
  if (!isAuthorWorksRoute(urlPath)) return false;
  var route = parseAuthorRoute(urlPath);
  return !!route && /^\d+$/.test(route.authorId);
}

function miscNavigate(page) {
  const p = Sidebar.platforms[0];
  if (p) navigate("/@all/" + p.id, page || 1);
}

function parseHash() {
  var originalHash = window.location.hash || "";
  var canonical = canonicalizeRouteHash();
  if (canonical !== originalHash) {
    state.queryEpoch = null;
    state.queryRevision = null;
    state.cursor = null;
  }
  var hash = (canonical || window.location.hash || "").slice(1) || "/";
  var parts = hash.split("?");
  var params = new URLSearchParams(parts[1] || "");
  applyQuerySettings(params);
  var path = parts[0] || "/";
  try {
    path = decodeURIComponent(path);
  } catch (e) {}
  var order = localStorage.getItem("gallery_order") || "asc";
  return {
    path: path,
    page: parseInt(params.get("page")) || 1,
    order: order,
    offset: params.has("offset") ? parseInt(params.get("offset")) : null,
    media: params.get("media") || null,
    folder: params.get("folder") || null,
    generation: params.get("g") || null,
    cursor: params.get("cursor") || null,
    search: params.get("q") || "",
    tag: params.get("tag") || "",
    meta: params.get("meta") !== "0",
    source: normalizeSearchSource(params.get("source")),
  };
}

export {
  normalizeHash,
  navigate,
  buildBreadcrumbsFromPath,
  decodeRoutePart,
  getPlatformRoot,
  getPlatformName,
  authorListPath,
  authorRoutePath,
  stripVolatileRouteParams,
  canonicalizeRouteHash,
  isLegacyIntegerRoutePath,
  parseAuthorRoute,
  isAuthorListRoute,
  isAuthorWorksRoute,
  miscNavigate,
  parseHash,
};
