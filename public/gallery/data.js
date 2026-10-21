import { request, list } from "../platform/api.js";
import { t, labels } from "./tokens.js";
export const pageDefaults = {
  platform: "pixiv",
  kind: "works",
  q: "",
  tag: "",
  mediaType: "all",
  sort: "date_desc",
  page: 1,
  pageSize: 48,
};
export function locationState(location) {
  const raw = location.hash.slice(1) || "/@all/pixiv",
    i = raw.indexOf("?"),
    path = i < 0 ? raw : raw.slice(0, i),
    q = new URLSearchParams(i < 0 ? "" : raw.slice(i + 1));
  let platform;
  try {
    platform = decodeURIComponent(path.split("/")[2] || "pixiv");
  } catch {
    platform = "";
  }
  const integer = (value, fallback, max) =>
    /^\d+$/.test(value || "")
      ? Math.min(max, Math.max(1, Number(value)))
      : fallback;
  return {
    ...pageDefaults,
    platform,
    kind: path.startsWith("/p/")
      ? path.split("/").length > 4
        ? "pages"
        : "author"
      : path.startsWith("/@authors")
        ? "authors"
        : path.startsWith("/f/")
          ? "files"
          : "works",
    path,
    q: q.get("q") || "",
    tag: q.get("tag") || "",
    mediaType: ["all", "image", "video"].includes(q.get("mediaType"))
      ? q.get("mediaType")
      : "all",
    sort: q.get("sort") || "date_desc",
    page: integer(q.get("page"), 1, 1000000),
    pageSize: [24, 48, 72, 96, 120].includes(Number(q.get("pageSize")))
      ? Number(q.get("pageSize"))
      : 48,
    invalid:
      !/^\/(?:@all|@authors)\/[^/]+$|^\/(?:f|p)\/[^/]+(?:\/[^/]+)*$/.test(path),
    invalidFilter:
      (q.has("mediaType") &&
        !["all", "image", "video"].includes(q.get("mediaType"))) ||
      (q.has("sort") &&
        !Object.hasOwn(
          path.startsWith("/@authors") ? labels.authorSorts : labels.workSorts,
          q.get("sort"),
        )),
  };
}
export function hashFor(s) {
  const p = ["files", "author", "pages"].includes(s.kind)
      ? s.path
      : `/${s.kind === "authors" ? "@authors" : "@all"}/${encodeURIComponent(s.platform)}`,
    q = new URLSearchParams();
  for (const k of ["q", "tag", "mediaType", "sort", "page", "pageSize"])
    if (s[k] !== "" && s[k] !== undefined) q.set(k, String(s[k]));
  return "#" + p + "?" + q;
}
export async function sources() {
  const [p, f, status] = await Promise.all([
    request("platforms"),
    request("file-roots"),
    request("status"),
  ]);
  // An empty Catalog has no aggregate row for a platform. Normalize that
  // public API shape here, rather than printing missing fields in the view.
  return {
    platforms: normalizePlatforms(p.items),
    files: f.items,
    updatedAt:
      status.scan?.state === "READY" &&
      (status.liveUpdates ||
        status.scan.generationId === status.loadedGenerationId)
        ? status.scan.finishedAtMs
        : (status.generations.find((g) => g.id === status.loadedGenerationId)
            ?.createdAtMs ?? null),
  };
}
export async function rows(s, prefs, signal) {
  if (s.kind === "pages") {
    const detail = await request("resolve", { path: s.path }, { signal }),
      work = detail.item,
      media = work.media.filter((m) => m.defaultVisible !== false),
      items = media
        .slice((s.page - 1) * s.pageSize, s.page * s.pageSize)
        .map((m, i) => ({
          ...work,
          key: work.stableId + ":" + m.relativePath,
          title: m.fileName,
          cover: m,
          tags: [],
          author: "",
          counts: { media: 1 },
          pageIndex: (s.page - 1) * s.pageSize + i,
        }));
    return {
      items,
      total: media.length,
      page: s.page,
      pageSize: s.pageSize,
      totalPages: Math.ceil(media.length / s.pageSize),
      heading: work,
    };
  }
  if (s.kind === "author") {
    const { item: author } = await request(
      "resolve",
      { path: s.path },
      { signal },
    );
    const data = await list(
      "works",
      { ...listParameters(s, prefs, "works"), author: author.id },
      { signal },
    );
    return { ...data, heading: author, items: data.items.map(normalizeWork) };
  }
  if (s.kind === "files") {
    const parts = s.path.split("/"),
      data = await request(
        s.q ? "file-search" : "files",
        {
          root: parts[2],
          q: s.q,
          path: parts.slice(3).map(decodeURIComponent).join("/"),
          page: s.page,
          pageSize: s.pageSize,
          mediaType: s.mediaType,
          order: s.sort === "name_desc" ? "desc" : "asc",
        },
        { signal },
      );
    return {
      ...data,
      incomplete: data.complete === false || !!data.truncated,
      items: data.items.map((m) => ({
        key: s.path + "/" + m.name,
        title: m.name,
        author: "",
        tags: [],
        cover:
          m.type === "directory"
            ? null
            : { ...m, fileName: m.name, type: m.mediaType || m.type },
        counts: { media: m.type === "directory" ? 0 : 1 },
        isFolder: m.type === "directory",
        isFile: m.type !== "directory",
        stableId:
          "/f/" +
          parts[2] +
          "/" +
          (m.relativePath || m.name)
            .split("/")
            .map(encodeURIComponent)
            .join("/"),
      })),
    };
  }
  const data = await list(s.kind, listParameters(s, prefs), { signal });
  if (s.kind === "authors")
    await Promise.all(
      data.items.map(async (author) => {
        const recent = await list(
          "works",
          {
            platform: s.platform,
            author: author.id,
            pageSize: 3,
            sort: "date_desc",
          },
          { signal },
        );
        author.collage = recent.items.map((w) => w.cover).filter(Boolean);
      }),
    );
  return {
    ...data,
    items: data.items.map((m) => ({
      ...normalizeWork(m),
      ...(s.kind === "authors"
        ? {
            author: [
              m.sourceAuthorId,
              formatCount(m.workCount) + " 个作品",
              formatDate(m.latestUpdateMs || m.latestAtMs),
            ]
              .filter(Boolean)
              .join(" · "),
          }
        : {}),
      isAuthor: s.kind === "authors",
    })),
  };
}
export function normalizeWork(m) {
  return {
    ...m,
    key: m.stableId || m.id,
    title: m.title || m.name,
    author: m.authorName || m.sourceAuthorId || "",
    tags: m.tags || [],
    counts: m.counts || { media: m.workCount },
  };
}
export function listParameters(s, prefs, kind = s.kind) {
  return {
    platform: s.platform,
    q: s.q,
    sort:
      kind === "authors"
        ? s.sort === "date_desc"
          ? "latest_desc"
          : s.sort
        : s.sort,
    page: s.page,
    pageSize: s.pageSize,
    ...(kind === "works"
      ? {
          tag: s.tag,
          mediaType: s.mediaType,
          hideEmpty: prefs.hideEmpty ? 1 : 0,
        }
      : {}),
  };
}
export async function pages(work) {
  const r = await request("resolve", { path: work.stableId });
  return r.item.media.filter((m) => m.defaultVisible !== false);
}
export async function backgroundMedia(selection) {
  const response = await request("resolve", { path: selection.work });
  const item = response.item,
    media = [item.cover, ...item.media]
      .filter(Boolean)
      .find((m) => m.relativePath === selection.media);
  if (!media) throw Error("背景图片已不存在");
  return media.thumbnailUrl;
}
export async function resultCount(s, prefs, kind) {
  return (
    await list(
      kind,
      listParameters(
        {
          ...s,
          sort: kind === "authors" ? "name_asc" : "date_desc",
          page: 1,
          pageSize: 1,
        },
        prefs,
        kind,
      ),
    )
  ).total;
}

const countFormat = new Intl.NumberFormat("en-US");
export const formatCount = (n) => countFormat.format(n);
export const normalizePlatforms = (items) =>
  items.map((item) => ({ ...item, works: item.works ?? 0 }));
export function pageGeometry(total, digit, available) {
  const step = digit + t.groupPad;
  return {
    step,
    width: Math.min(t.band, available, total * step - t.groupPad),
  };
}
export const formatDate = (ms) =>
  ms ? new Date(ms).toISOString().slice(0, 10) : "";
export function connectionTime(updatedAt, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60000));
  if (minutes < 1) return "刚刚更新";
  if (minutes < 60) return minutes + " 分钟前更新";
  if (minutes < 1440) return Math.floor(minutes / 60) + " 小时前更新";
  const date = new Date(updatedAt);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日更新`;
}
export async function tagOptions(platform, q = "", cursor = null) {
  return list("tags", { platform, q, page: 1, pageSize: 40, cursor });
}
