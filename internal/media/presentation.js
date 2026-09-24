"use strict";
const { compareNatural } = require("./order.js");
function presentation(fileName, extractedPreviews = false) {
  const cover = /^\.?cover\.[^.]+$/i.test(fileName);
  const preview = extractedPreviews && /^[1-9]\.[^.]+$/.test(fileName);
  return {
    role: cover ? "cover" : preview ? "preview" : "content",
    defaultVisible: !cover && !preview && !fileName.startsWith("."),
  };
}
function coverRank(fileName, extractedPreviews = false) {
  if (extractedPreviews && /^1\.[^.]+$/.test(fileName)) return 0;
  return /^\.?cover\.[^.]+$/i.test(fileName) ? 1 : 2;
}
function filesystemPresentationSources(files) {
  const marker = files.find((f) => f.relativePath.toLowerCase() === ".nocover");
  return marker ? [{ field: "media.coverDisabled", sourceKind: "filesystem", sourcePath: marker.relativePath, priority: 1 }] : [];
}
function sortPages(items) {
  return [...items].sort((a, b) => compareNatural(a.relativePath, b.relativePath));
}
module.exports = { presentation, coverRank, filesystemPresentationSources, sortPages };
