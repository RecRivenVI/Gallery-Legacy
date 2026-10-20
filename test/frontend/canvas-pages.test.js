"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
test("Candidate stable author, work and file locations roundtrip independent conditions", async () => {
  const { locationState, hashFor } = await import(
    "../../public/gallery/data.js"
  );
  for (const [path, kind] of [
    ["/p/pixiv/demo", "author"],
    ["/p/pixiv/demo/work", "pages"],
    ["/f/demo/nested", "files"],
  ]) {
    const a = locationState({
      hash: "#" + path + "?q=test&tag=demo&mediaType=image&page=2",
    });
    assert.equal(a.kind, kind);
    assert.equal(a.invalid, false);
    const z = locationState({ hash: hashFor(a) });
    assert.equal(z.path, path);
    assert.equal(z.q, "test");
    assert.equal(z.tag, "demo");
    assert.equal(z.page, 2);
  }
});
test("Candidate normalized authors and works preserve stable IDs as strings", async () => {
  const { normalizeWork } = await import("../../public/gallery/data.js");
  const w = normalizeWork({
    id: "9007199254740999",
    stableId: "/p/pixiv/a/b",
    title: "A",
    authorName: "B",
    counts: { media: 48 },
  });
  assert.equal(w.key, "/p/pixiv/a/b");
  assert.equal(w.id, "9007199254740999");
  assert.equal(w.counts.media, 48);
  assert.deepEqual(w.tags, []);
});
test("Candidate UI retains separate query tags, native input and real update events", () => {
  const fs = require("node:fs"),
    path = require("node:path"),
    source = fs.readFileSync(
      path.join(__dirname, "../../public/gallery/app.js"),
      "utf8",
    );
  for (const marker of [
    "ScanWS.onStatus",
    "ScanWS.connect",
    'input.id = "tag-search"',
    '"condition-" + id',
    "state.drawerProgress",
    "contentTop()",
  ])
    assert.ok(source.includes(marker), marker);
  assert.ok(source.includes("!viewer?.opened"));
});
