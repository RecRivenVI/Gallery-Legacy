"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { adapterForPlatform } = require("../../internal/metadata/index.js");
const {
  metadataShapeForPlatform,
  SHAPE_POLICIES,
} = require("../../internal/metadata/shape/index.js");
const corpus = require("../../fixtures/metadata/corpus.json");
const snapshots = require("../../fixtures/metadata/shapes.json");
function freeze(v) {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
function reorder(v) {
  if (Array.isArray(v)) return v.map(reorder);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .reverse()
        .map((k) => [k, reorder(v[k])]),
    );
  return v;
}
for (const item of corpus.cases)
  test(`${item.platformId}/${item.name}: public structural corpus deterministic enrichment and frozen shape`, () => {
    assert.equal(item.synthetic, true);
    const raw = freeze(
      JSON.parse(
        fs.readFileSync(
          path.resolve(__dirname, "../../fixtures/metadata", item.fixture),
          "utf8",
        ),
      ),
    );
    const context = {
      platformId: item.platformId,
      metadata: raw,
      authorDirectoryName: "100",
      workDirectoryName: "2026-01-01_00-00-00_200",
      metadataRelativePath: "100/work/metadata.json",
    };
    const adapter = adapterForPlatform(item.platformId),
      before = JSON.stringify(raw),
      a = adapter.adapt(context),
      b = adapter.adapt(context);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(raw), before);
    assert.equal(typeof a.valid, "boolean");
    for (const id of [a.work.sourceWorkId, a.authorProfile.sourceAuthorId])
      assert.ok(id === null || typeof id === "string");
    assert.ok(
      a.richText.primary === null ||
        ["plain", "html", "markdown"].includes(a.richText.primary.sourceFormat),
    );
    for (const s of a.structuredSources)
      assert.ok(["json_text", "opaque_text"].includes(s.encoding));
    const shape = metadataShapeForPlatform(item.platformId, raw);
    assert.equal(
      shape.hash,
      snapshots.hashes.find((x) => x.fixture === item.fixture).hash,
    );
    assert.deepEqual(
      shape,
      metadataShapeForPlatform(item.platformId, reorder(raw)),
    );
  });
test("shape describes type, not primitive values; policies are explicit and no allowlist gates adaptation", () => {
  assert.equal(SHAPE_POLICIES.length, 8);
  assert.equal(corpus.cases.length, 35);
  const hash = (v) => metadataShapeForPlatform("微博", v).hash;
  assert.equal(
    hash({ pic_infos: { one: { url: "a" } } }),
    hash({ pic_infos: { another: { url: "b" } } }),
  );
  assert.notEqual(hash({ id: "1" }), hash({ id: 1 }));
  assert.notEqual(hash({ annotations: {} }), hash({ annotations: [] }));
  assert.notEqual(hash({ optional: null }), hash({}));
  assert.equal(hash({ list: ["a"] }), hash({ list: ["b", "c"] }));
  assert.equal(
    adapterForPlatform("微博").adapt({
      platformId: "微博",
      metadata: { future_field: { strange: [] } },
    }).valid,
    true,
  );
});
