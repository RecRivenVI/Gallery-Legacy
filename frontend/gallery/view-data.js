import {
  request,
  list,
  currentGeneration,
  loadProtocol,
} from "../shared/api.js";
import { state } from "./model.js";

const mediaRoutes = new Map();
let pageRequest = null;
function pageSignal() {
  pageRequest?.abort();
  pageRequest = new AbortController();
  return pageRequest.signal;
}
function remember(route, media) {
  mediaRoutes.set(route, media);
  if (mediaRoutes.size > 4000)
    mediaRoutes.delete(mediaRoutes.keys().next().value);
}

function stableAuthorRoutePath(platformId, stableId) {
  return (
    "/@author/" +
    encodeURIComponent(String(platformId || "")) +
    "/" +
    encodeURIComponent(String(stableId || ""))
  );
}

function stableAuthorPathFromWork(stableId) {
  var value = String(stableId || "");
  if (!value.startsWith("/p/")) return null;
  var slash = value.lastIndexOf("/");
  return slash > 3 ? value.slice(0, slash) : null;
}

function stableWorkRoute(work) {
  return typeof work?.stableId === "string" && work.stableId.startsWith("/p/")
    ? work.stableId
    : "/work/" + String(work?.id || "");
}
export function apiUrl(kind, route) {
  const media = mediaRoutes.get(route);
  if (media) return kind === "thumbnail" ? media.thumbnailUrl : media.url;
  const id = String(route).split("/").at(-1);
  return `/api/v1/${kind === "thumbnail" ? "thumbnails" : "media"}/${encodeURIComponent(id)}?g=${encodeURIComponent(currentGeneration() || "")}`;
}
export async function fetchPlatformsView() {
  const { items } = await request("platforms");
  const protocol = await loadProtocol();
  if (!protocol.workSorts.includes(state.worksSort))
    state.worksSort = "date_desc";
  if (!protocol.authorSorts.includes(state.authorSort))
    state.authorSort = "name_asc";
  if (!protocol.mediaFilters.includes(state.mediaType)) state.mediaType = "all";
  const platforms = items.map((p, i) => ({
    ...p,
    name: p.id,
    routePath: "/p/" + p.id,
    fileRoot: false,
    order: i,
    scanOrder: i,
    capabilities: { works: true, authors: true },
    sort: {
      workDefault: "date_desc",
      authorDefault: "name_asc",
      workOptions: protocol.workSorts,
      authorOptions: protocol.authorSorts,
    },
    icon: {
      kind: "builtin",
      glyph: [...p.id][0],
      background: "var(--bg-control-active)",
      color: "var(--text-primary)",
    },
  }));
  const files = await request("file-roots");
  return [...platforms, ...files.items.map((r, i) => ({ id: r.id, name: r.name, routePath: "/f/" + r.id,
    fileRoot: true, order: platforms.length + i, capabilities: { works: false, authors: false },
    icon: { kind: "builtin", glyph: "文" } }))];
}
function scope(route) {
  const parts = String(route || "").split("/");
  return {
    platform: ["p", "@all", "@authors", "@author"].includes(parts[1])
      ? decodeURIComponent(parts[2])
      : null,
    author: parts[1] === "@author" ? decodeURIComponent(parts[3]) : null,
  };
}
function card(work) {
  const routePath = stableWorkRoute(work);
  const authorStablePath = stableAuthorPathFromWork(work.stableId);
  if (work.cover) remember(routePath + "/" + work.cover.id, work.cover);
  return {
    name: work.id,
    parentPath: "/work",
    routePath,
    authorRoute: authorStablePath
      ? stableAuthorRoutePath(work.platformId, authorStablePath)
      : null,
    displayName: work.title,
    subtitle: work.authorName,
    authorId: work.authorId,
    platform: work.platformId,
    kind: "dir",
    tags: work.tags.map((t) => t.label),
    date:
      work.publishedAtMs === null
        ? null
        : new Date(work.publishedAtMs).toISOString(),
    cover: work.cover?.id || null,
    coverType: work.cover?.type || null,
    indexedMediaRows: work.counts.media,
    metadataState: work.metadataState,
    sourceUrl: work.sourceUrl || null,
    stableId: work.stableId,
    badges: [
      work.flags?.adult ? "adult" : null,
      work.flags?.aiGenerated ? "ai" : null,
    ].filter(Boolean),
  };
}
export async function workPageView(
  route,
  page = 1,
  query = "",
  tag = "",
  author = null,
) {
  const s = scope(route);
  const cursor = state.cursor;
  state.cursor = null;
  const data = await list(
    "works",
    {
      ...s,
      author: author || s.author,
      q: query,
      tag,
      page,
      pageSize: state.pageSize,
      sort: state.worksSort,
      mediaType: state.mediaType,
      hideEmpty: state.hideEmpty ? "1" : "0",
      rev: state.queryRevision,
      g: state.queryEpoch,
      cursor,
    },
    { signal: pageSignal() },
  );
  state.queryRevision=data.revision ?? null;state.queryEpoch=data.epoch || currentGeneration();
  if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent("gallery-query-loaded",{detail:{epoch:state.queryEpoch,revision:state.queryRevision}}));
  return {
    ...data,
    path: route,
    platformPath: s.platform ? "/p/" + s.platform : null,
    platformId: s.platform,
    items: data.items.map(card),
    totalItems: data.total,
    nextCursor: data.cursor,
    query,
    tag,
    db: true,
    source: "db",
    leaf: true,
    order: "desc",
    mediaType: state.mediaType,
    sort: state.worksSort,
  };
}
export async function fileSearchView(route, page, query) {
  const [, , root, ...parts] = route.split("/");
  const data = await request("file-search", { root, path: parts.join("/"), q: query, page, pageSize: state.pageSize, mediaType: state.mediaType, order: state.order }, { signal: pageSignal() });
  return { ...data, path: route, query, db: false, source: "fs", totalItems: data.total, order: state.order,
    items: data.items.map(m => {
      const split = m.relativePath.lastIndexOf("/"), parentPath = "/f/" + root + (split < 0 ? "" : "/" + m.relativePath.slice(0,split));
      if (m.type !== "directory") remember(parentPath + "/" + m.name, m);
      return { name: m.name, parentPath, displayName: m.name, kind: m.type === "directory" ? "dir" : m.type === "video" ? "vid" : "img", size: m.size };
    }) };
}
export async function authorPageView(platform, page = 1, query = "") {
  const cursor = state.cursor;
  state.cursor = null;
  const data = await list(
    "authors",
    {
      platform,
      q: query,
      page,
      pageSize: state.pageSize,
      sort: state.authorSort,
      rev: state.queryRevision,
      g: state.queryEpoch,
      cursor,
    },
    { signal: pageSignal() },
  );
  const items = data.items.map((a) => {
    const stableId = a.stableId || `/p/${platform}/${a.id}`;
    if (a.cover) remember(stableId + "/" + a.cover.id, a.cover);
    return {
      name: a.id,
      kind: "dir",
      authorId: a.id,
      authorPath: stableId,
      routePath: stableAuthorRoutePath(platform, stableId),
      stableId,
      displayName: a.name,
      subtitle: a.sourceAuthorId,
      badge: `${a.workCount}件作品`,
      totalPosts: a.workCount,
      latestDate:
        a.latestAtMs === null ? null : new Date(a.latestAtMs).toISOString(),
      cover: a.cover?.id || null,
      coverType: a.cover?.type || null,
    };
  });
  state.queryRevision=data.revision ?? null;state.queryEpoch=data.epoch || currentGeneration();
  if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent("gallery-query-loaded",{detail:{epoch:state.queryEpoch,revision:state.queryRevision}}));
  return {
    ...data,
    items,
    totalItems: data.total,
    platformId: platform,
    platformPath: "/p/" + platform,
  };
}
export async function resolvePublicRoute(route) {
  return request("resolve", { path: route });
}
export async function workDetailView(route, selectedMedia = null) {
  const id = String(route).split("/").at(-1);
  const resolved = route.startsWith("/p/")
    ? await resolvePublicRoute(route)
    : { kind: "work", item: await request("works/" + encodeURIComponent(id), {
      g: state.queryEpoch || currentGeneration(),
    }) };
  if (!resolved || resolved.kind !== "work" || !resolved.item)
    throw Object.assign(new Error("AUTHOR_ROUTE_REQUIRES_AUTHOR_VIEW"), {
      code: "AUTHOR_ROUTE_REQUIRES_AUTHOR_VIEW",
    });
  const work = resolved.item;
  const items = work.media.filter((m) => m.relativePath === selectedMedia || (m.defaultVisible !== false && (state.mediaType === "all" || m.type === state.mediaType))).map((m) => {
    remember(route + "/" + m.relativePath, m);
    return {
      name: m.relativePath,
      displayName: m.fileName,
      kind: m.type === "video" ? "vid" : "img",
      type: m.type === "video" ? "vid" : "img",
      size: m.size,
    };
  });
  return {
    path: route,
    page: 1,
    targetMedia: selectedMedia,
    totalPages: 1,
    order: "asc",
    items,
    allMedia: items,
    totalMedia: items.length,
    totalItems: items.length,
    totalDirs: 0,
    totalImages: work.counts.images,
    totalVideos: work.counts.videos,
    mediaOffset: 0,
    leaf: true,
    breadcrumbs: [
      { name: "首页", path: "/" },
      { name: work.platformId, path: "/@all/" + work.platformId },
      { name: work.title, path: route },
    ],
  };
}
export async function fileDirectoryView(route, page = 1, order = "asc", _offset, selectedMedia) {
  const parts = route.split("/"), root = parts[2], relative = parts.slice(3).join("/");
  let data = await request("files", { root, path: relative, page, order, pageSize: state.pageSize, mediaType: state.mediaType }, { signal: pageSignal() });
  if (selectedMedia) {
    const index = data.media.findIndex((m) => m.name === selectedMedia);
    const wanted = Math.floor((data.totalDirectories + Math.max(0, index)) / data.pageSize) + 1;
    if (index >= 0 && wanted !== data.page) data = await request("files", { root, path: relative, page: wanted, order, pageSize: state.pageSize, mediaType: state.mediaType });
  }
  const item = (m) => {
    if (m.type === "directory") return { name: m.name, displayName: m.name, kind: "dir" };
    remember(route + "/" + m.name, m);
    return { name: m.name, displayName: m.name, kind: m.type === "video" ? "vid" : "img", type: m.type === "video" ? "vid" : "img", size: m.size };
  };
  const crumbs = [{ name: "首页", path: "/" }, { name: "文件浏览", path: "/f/" + root }];
  for (let i = 3; i < parts.length; i++) crumbs.push({ name: parts[i], path: parts.slice(0, i + 1).join("/") });
  return { ...data, path: route, order, targetMedia: selectedMedia, items: data.items.map(item), allMedia: data.media.map(item), totalItems: data.total,
    totalMedia: data.media.length, totalDirs: data.totalDirectories, mediaOffset: Math.max(0, (data.page - 1) * data.pageSize - data.totalDirectories), leaf: !data.totalDirectories, breadcrumbs: crumbs };
}
