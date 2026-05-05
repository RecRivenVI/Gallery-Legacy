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
  return items.map((p, i) => ({
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
  if (work.cover) remember(`/work/${work.id}/${work.cover.id}`, work.cover);
  return {
    name: work.id,
    parentPath: "/work",
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
      cursor,
    },
    { signal: pageSignal() },
  );
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
      cursor,
    },
    { signal: pageSignal() },
  );
  const items = data.items.map((a) => {
    if (a.cover) remember(`/p/${platform}/${a.id}/${a.cover.id}`, a.cover);
    return {
      name: a.id,
      kind: "dir",
      authorId: a.id,
      authorPath: `/@author/${platform}/${a.id}`,
      routePath: `/@author/${platform}/${a.id}`,
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
  return {
    ...data,
    items,
    totalItems: data.total,
    platformId: platform,
    platformPath: "/p/" + platform,
  };
}
export async function workDetailView(route) {
  const id = String(route).split("/").at(-1);
  const work = await request("works/" + encodeURIComponent(id), {
    g: currentGeneration(),
  });
  const items = work.media.map((m) => {
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
