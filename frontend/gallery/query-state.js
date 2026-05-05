// Pure query representation shared by navigation and preference restoration.
export function encodeQuery(route, values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== null && value !== undefined && value !== "")
      params.set(key, String(value));
  return route + (params.size ? "?" + params : "");
}
export function querySettings(params, defaults, contract, authors) {
  const options = authors ? contract?.authorSorts : contract?.workSorts;
  const candidate = params.get("sort") || defaults.sort;
  const sort =
    !options || options.includes(candidate)
      ? candidate
      : authors
        ? "name_asc"
        : "date_desc";
  const media = params.get("mediaType") || defaults.mediaType;
  const raw = params.has("pageSize")
    ? params.get("pageSize")
    : defaults.pageSize;
  const size = Number(raw);
  return {
    sort,
    mediaType: ["all", "image", "video"].includes(media) ? media : "all",
    pageSize: Number.isInteger(size) && size >= 1 && size <= 200 ? size : 48,
  };
}
