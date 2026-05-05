"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { adapterForPlatform } = require("../../internal/metadata/index.js");
test("source evidence differentiates metadata choice from directory fallback", () => {
  const adapter = adapterForPlatform("pixiv");
  const a = adapter.adapt({
    platformId: "pixiv",
    metadata: {
      id: "9007199254740993",
      user: { id: "100", name: "Synthetic" },
      title: { text: "Example" },
    },
    authorDirectoryName: "100",
    workDirectoryName: "2026-01-01_00-00-00_200",
  });
  assert.equal(a.work.sourceWorkId, "9007199254740993");
  assert.equal(
    a.fieldSources.find((s) => s.field === "work.sourceWorkId").sourceKind,
    "metadata",
  );
  assert.equal(
    a.diagnostics.fallbacksUsed.some((s) => s.field === "work.sourceWorkId"),
    false,
  );
  const b = adapter.adapt({
    platformId: "pixiv",
    metadata: { id: 9007199254740992 },
    authorDirectoryName: "100",
    workDirectoryName: "2026-01-01_00-00-00_200",
  });
  assert.equal(b.work.sourceWorkId, "200");
  assert.ok(b.diagnostics.warnings.length > 0);
  assert.equal(
    b.fieldSources.find((s) => s.field === "work.sourceWorkId").sourceKind,
    "filesystem",
  );
  assert.ok(
    b.diagnostics.fallbacksUsed.some((s) => s.field === "work.sourceWorkId"),
  );
});
test("Pawchive namespace prevents collisions and conflicting service fails closed", () => {
  const adapter = adapterForPlatform("Pawchive");
  const a = adapter.adapt({
    platformId: "Pawchive",
    metadata: { service: "fanbox", id: "2", user: "1" },
  });
  const b = adapter.adapt({
    platformId: "Pawchive",
    metadata: { service: "patreon", id: "2", user: "1" },
  });
  assert.notEqual(a.work.sourceWorkId, b.work.sourceWorkId);
  assert.notEqual(
    a.authorProfile.sourceAuthorId,
    b.authorProfile.sourceAuthorId,
  );
  const conflict = adapter.adapt({
    platformId: "Pawchive",
    metadata: { service: "patreon", id: "2", user: "1" },
    authorDirectoryName: "fanbox_1",
  });
  assert.ok(
    conflict.work.sourceWorkId === null ||
      conflict.diagnostics.warnings.some((w) => /conflict/.test(w.code)),
  );
});
test("Fantia structured JSON string is not sent down textual pipeline", () => {
  const source = '{  "ops" : [ {"insert":"Synthetic 🧪\\n"} ] }';
  const result = adapterForPlatform("Fantia").adapt({
    platformId: "Fantia",
    metadata: { content_comment: source, comment: "plain\r\n\u200b🧪" },
  });
  assert.equal(result.structuredSources[0].sourceText, source);
  assert.equal(result.richText.primary.sourceText, "plain\r\n\u200b🧪");
  assert.notEqual(result.richText.primary.sourceText, source);
});
