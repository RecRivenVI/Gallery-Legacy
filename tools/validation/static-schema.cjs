"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const reference = process.env.GALLERY_NODE_REFERENCE_ROOT,
  output = process.env.GALLERY_LIFECYCLE_EVIDENCE;
if (!reference || !output)
  throw Error("Explicit frozen reference and evidence required");
const prior = JSON.parse(
  fs.readFileSync(path.join(output, "static-lifecycle.json")),
).results.find((x) => x.kind === "Node");
const generations = require(
  path.join(reference, "src/publication/generations.js"),
);
const c = require(
  path.join(reference, "src/instance/config.js"),
).readRuntimeConfig(path.join(prior.instance, "config.json"));
const g = generations.resolveActiveGeneration(prior.instance, {
  generationsRoot: c.generationsRoot,
  activePointerPath: c.activeGenerationPath,
});
const target = path.join(c.tempRoot, "current-search.sqlite");
require("../../src/search/build.js").buildSearchIndex({
  catalogPath: g.catalogPath,
  searchIndexPath: target,
});
const { QueryIndex } = require(path.join(reference, "src/search/query.js"));
const options = {
  workCount: g.catalogFacts.workCount,
  catalogSize: g.catalogFacts.sizeBytes,
  catalogMtimeMs: g.catalogFacts.mtimeMs,
  catalogSha256: g.catalogFacts.sha256,
};
const oldIndex = new QueryIndex(g.searchIndexPath, options),
  newIndex = new QueryIndex(target, options);
const queries = [
  {},
  { query: "鱼" },
  { query: "MP" },
  { query: "🧪" },
  { tag: "R-18" },
  { mediaType: "image" },
  { mediaType: "video" },
  { sort: "title_asc", limit: 3 },
];
try {
  for (const query of queries)
    assert.deepEqual(newIndex.workPage(query), oldIndex.workPage(query));
} finally {
  oldIndex.close();
  newIndex.close();
}
fs.writeFileSync(
  path.join(output, "static-schema.json"),
  JSON.stringify(
    {
      conclusion: "一致",
      scope:
        "shared DDL current Node Search vs frozen Node on the same immutable Catalog",
      queries,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ conclusion: "一致", scope: "shared Search DDL" }));
