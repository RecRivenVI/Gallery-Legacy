import { state, readPersistedPageSize } from "./model.js";
import { protocolDefinition, currentGeneration } from "../shared/api.js";
import { encodeQuery, querySettings } from "./query-state.js";
export function makeQueryHash(route, changes = {}) {
  return encodeQuery(route, {
    g: currentGeneration(),
    q: state.searchQuery,
    tag: state.searchTag,
    page: state.page,
    sort: route.startsWith("/@authors/") ? state.authorSort : state.worksSort,
    mediaType: state.mediaType,
    pageSize: state.pageSize,
    ...changes,
  });
}
export function applyQuerySettings(params) {
  const authors = (location.hash || "").includes("/@authors/");
  const settings = querySettings(
    params,
    {
      sort:
        localStorage.getItem(
          authors ? "gallery_author_sort" : "gallery_works_sort",
        ) || (authors ? "name_asc" : "date_desc"),
      mediaType: localStorage.getItem("gallery_media_type") || "all",
      pageSize: readPersistedPageSize(state.viewMode, state.contentWidth),
    },
    protocolDefinition,
    authors,
  );
  if (authors) state.authorSort = settings.sort;
  else state.worksSort = settings.sort;
  state.mediaType = settings.mediaType;
  state.pageSize = settings.pageSize;
}
