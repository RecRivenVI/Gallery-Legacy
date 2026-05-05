"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PLATFORM_REGISTRY } = require("../../internal/library/platforms.js");
const {
  ADAPTERS,
  adapterForPlatform,
} = require("../../internal/metadata/index.js");
const {
  ADAPTER_CONTRACT_VERSION,
  adaptJsonWithMetadata,
} = require("../../internal/metadata/contract.js");
const {
  metadataShapeForPlatform,
} = require("../../internal/metadata/shape/index.js");
const corpus = require("../../fixtures/metadata/platforms.json");

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("public synthetic corpus covers every registry adapter without a private corpus dependency", () => {
  assert.equal(corpus.synthetic, true);
  assert.deepEqual(
    corpus.cases.map((item) => item.platformId),
    PLATFORM_REGISTRY.map((item) => item.id),
  );
  assert.deepEqual(
    ADAPTERS.map((item) => item.PLATFORM_ID),
    PLATFORM_REGISTRY.map((item) => item.id),
  );
  assert.equal(ADAPTERS.length, 8);
  for (const platform of PLATFORM_REGISTRY)
    assert.equal(
      adapterForPlatform(platform.id).VERSION,
      platform.adapterVersion,
    );
  assert.equal(adapterForPlatform("unsupported"), null);
});

for (const item of corpus.cases) {
  test(`${item.platformId}: deterministic enrichment preserves synthetic source text and input`, () => {
    const metadata = freeze(structuredClone(item.metadata));
    const before = JSON.stringify(metadata);
    const context = {
      platformId: item.platformId,
      metadata,
      authorDirectoryName: item.authorDirectoryName || "synthetic-author",
      workDirectoryName: "2020-01-01_00-00-00_synthetic-work",
      metadataRelativePath: "synthetic-author/synthetic-work/metadata.json",
    };
    const adapter = adapterForPlatform(item.platformId);
    const first = adapter.adapt(context);
    assert.equal(first.valid, true);
    assert.equal(first.contractVersion, ADAPTER_CONTRACT_VERSION);
    assert.equal(typeof first.work.sourceWorkId, "string");
    assert.equal(typeof first.authorProfile.sourceAuthorId, "string");
    assert.equal(first.richText.primary.sourceText, item.body);
    assert.deepEqual(adapter.adapt(context), first);
    assert.equal(JSON.stringify(metadata), before);
    const shape = metadataShapeForPlatform(item.platformId, metadata);
    assert.match(shape.hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      metadataShapeForPlatform(item.platformId, structuredClone(metadata)),
      shape,
    );
    assert.equal(Object.hasOwn(first, "safe_text"), false);
    assert.equal(Object.hasOwn(first, "search_text"), false);
    if (item.platformId === "Pawchive")
      assert.equal(first.work.sourceWorkId, "fanbox:2006");
    if (item.platformId === "X")
      assert.equal(first.work.sourceWorkId, "9007199254740993");
    if (item.platformId === "微博")
      assert.equal(first.work.sourceWorkId, "9223372036854775806");
    if (item.platformId === "Fantia")
      assert.equal(
        first.structuredSources[0].sourceText,
        metadata.content_comment,
      );
  });
}

test("relocated public invalid fixtures preserve invalid JSON and unsafe-ID behavior", () => {
  const adapter = adapterForPlatform("pixiv");
  const read = (name) =>
    fs.readFileSync(
      path.resolve(__dirname, "../../fixtures/metadata/invalid", name),
      "utf8",
    );
  const context = { platformId: "pixiv" };
  assert.equal(
    adaptJsonWithMetadata(adapter, read("malformed.json.txt"), context).result
      .invalidReason,
    "malformed_json",
  );
  assert.equal(
    adaptJsonWithMetadata(adapter, read("non-object.json"), context).result
      .invalidReason,
    "metadata_not_object",
  );
  const missing = adaptJsonWithMetadata(
    adapter,
    read("missing-identity.json"),
    context,
  ).result;
  assert.equal(
    missing.valid,
    true,
    "Missing source IDs do not invalidate parsed enrichment metadata",
  );
  assert.equal(missing.work.sourceWorkId, null);
  assert.equal(missing.authorProfile.sourceAuthorId, null);
  const unsafe = adaptJsonWithMetadata(
    adapter,
    read("unsafe-numeric-id.json"),
    context,
  ).result;
  assert.equal(unsafe.work.sourceWorkId, null);
  assert.ok(unsafe.diagnostics.warnings.length > 0);
});
