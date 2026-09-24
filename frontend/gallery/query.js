import { state, readPersistedPageSize } from "./model.js";
import { protocolDefinition } from "../shared/api.js";
import { encodeQuery, querySettings } from "./query-state.js";
export function makeQueryHash(route, changes = {}) {
  return encodeQuery(route, {
    q: state.searchQuery,
    tag: state.searchTag,
    page: state.page,
    sort: route.startsWith("/@authors/") ? state.authorSort : state.worksSort,
    mediaType: state.mediaType,
    hideEmpty: state.hideEmpty ? "1" : "0",
    pageSize: state.pageSize,
    ...changes,
  });
}
export function applyQuerySettings(params) {
  if (params.has("rev")) {
    const revision=params.get("rev");
    state.queryRevision=revision!==null && /^\d+$/.test(revision) && Number.isSafeInteger(Number(revision)) ? Number(revision) : null;
  }
  if (params.has("g")) state.queryEpoch=params.get("g")||null;
  const authors = (location.hash || "").includes("/@authors/");
  const settings = querySettings(
    params,
    {
      sort:
        localStorage.getItem(
          authors ? "gallery_author_sort" : "gallery_works_sort",
        ) || (authors ? "name_asc" : "date_desc"),
      mediaType: localStorage.getItem("gallery_media_type") || "all",
      hideEmpty: localStorage.getItem("gallery_hide_empty") !== "0",
      pageSize: readPersistedPageSize(state.viewMode, state.contentWidth),
    },
    protocolDefinition,
    authors,
  );
  if (authors) state.authorSort = settings.sort;
  else state.worksSort = settings.sort;
  state.mediaType = settings.mediaType;
  state.hideEmpty = settings.hideEmpty;
  state.pageSize = settings.pageSize;
}
