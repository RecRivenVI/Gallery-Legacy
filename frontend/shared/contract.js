const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v) => typeof v === "string" && /^\d{1,19}$/.test(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const sourceId = (v) => v === null || typeof v === "string";
export function media(v) {
  return (
    object(v) &&
    id(v.id) &&
    typeof v.fileName === "string" &&
    typeof v.relativePath === "string" &&
    ["image", "video"].includes(v.type) &&
    count(v.size) &&
    typeof v.url === "string" &&
    typeof v.thumbnailUrl === "string"
  );
}
export function work(v) {
  return (
    object(v) &&
    id(v.id) &&
    id(v.authorId) &&
    typeof v.platformId === "string" &&
    sourceId(v.sourceWorkId) &&
    typeof v.title === "string" &&
    typeof v.authorName === "string" &&
    object(v.counts) &&
    [v.counts.images, v.counts.videos, v.counts.media].every(count) &&
    Array.isArray(v.tags) &&
    v.tags.every(tag) &&
    (v.cover === null || media(v.cover))
  );
}
export function author(v) {
  return (
    object(v) &&
    id(v.id) &&
    typeof v.name === "string" &&
    sourceId(v.sourceAuthorId) &&
    count(v.workCount) &&
    (v.cover === null || media(v.cover))
  );
}
export function tag(v) {
  return (
    object(v) &&
    id(v.id) &&
    typeof v.label === "string" &&
    (v.workCount === undefined || count(v.workCount))
  );
}
export function validateData(resource, data) {
  if (resource.startsWith("works/"))
    return work(data) && Array.isArray(data.media) && data.media.every(media);
  if (["works", "authors", "tags"].includes(resource)) {
    const predicate = { works: work, authors: author, tags: tag }[resource];
    return (
      object(data) &&
      Array.isArray(data.items) &&
      data.items.every(predicate) &&
      count(data.total) &&
      count(data.page) &&
      count(data.pageSize) &&
      count(data.totalPages) &&
      (data.cursor === null || typeof data.cursor === "string")
    );
  }
  return object(data);
}
