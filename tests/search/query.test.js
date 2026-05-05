"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture } = require("../support/runtime.js");
const { QueryIndex } = require("../../internal/search/query.js");
const { buildSearchIndex } = require("../../internal/search/build.js");
test("short body queries are complete, tag is independent, combined filters intersect", async (t) => {
  const f = await fixture(t);
  const g = f.build();
  const q = new QueryIndex(g.searchIndexPath, {
    workCount: g.catalogFacts.workCount,
    catalogSize: g.catalogFacts.sizeBytes,
    catalogMtimeMs: g.catalogFacts.mtimeMs,
    catalogSha256: g.catalogFacts.sha256,
  });
  f.cleanup.push(() => q.close());
  assert.equal(q.workPage({ query: "鱼" }).total, 1);
  assert.equal(q.workPage({ query: "鱼猫" }).total, 1);
  assert.equal(q.workPage({ query: "猫鱼" }).total, 0);
  assert.equal(q.workPage({ query: "🧪" }).total, 1);
  assert.equal(q.workPage({ tag: "R-18" }).total, 1);
  assert.equal(q.workPage({ query: "R-18" }).total, 2);
  assert.equal(q.workPage({ query: "Beta", tag: "R-18" }).total, 0);
  assert.equal(q.workPage({ query: "Alpha", tag: "R-18" }).total, 1);
  assert.equal(q.workPage({ tag: "r-18" }).total, 0);
  assert.equal(q.workPage({ mediaType: "image" }).total, 4);
  assert.equal(q.workPage({ mediaType: "video" }).total, 2);
  const first = q.workPage({ sort: "title_asc", limit: 2 });
  const second = q.workPage({
    sort: "title_asc",
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(
    new Set([...first.rows, ...second.rows].map((r) => r.work_id)).size,
    4,
  );
  assert.throws(
    () =>
      buildSearchIndex({
        catalogPath: g.catalogPath,
        searchIndexPath: g.searchIndexPath,
      }),
    { code: "SEARCH_OUTPUT_EXISTS" },
  );
});
