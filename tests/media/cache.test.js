"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs");
const { fixture } = require("../support/runtime.js");
const {
  thumbnailCacheKey,
  createThumbnailCache,
} = require("../../internal/media/thumbnails.js");
test("thumbnail identity includes the physical file, not only recycled generation IDs", async (t) => {
  const f = await fixture(t, { empty: true });
  const base = {
    platformId: "pixiv",
    work: { work_id: 1n },
    media: {
      media_id: 1n,
      relative_path_key: "1.jpg",
      filesystem_media_type: "image",
    },
    stat: { size: 1n, mtimeNs: 1n },
  };
  assert.notEqual(
    thumbnailCacheKey({
      ...base,
      candidateReal: path.join(f.bindings.pixiv, "a/1.jpg"),
    }),
    thumbnailCacheKey({
      ...base,
      candidateReal: path.join(f.bindings.pixiv, "b/1.jpg"),
    }),
  );
  const input = path.join(f.bindings.pixiv, "input.png");
  fs.writeFileSync(input, "a");
  let count = 0;
  const cache = createThumbnailCache({
    root: f.config.instanceRoot,
    cacheRoot: f.config.cacheRoot,
    tempRoot: f.config.tempRoot,
    generator: async ({ destinationPath }) => {
      count++;
      fs.writeFileSync(destinationPath, "synthetic thumbnail");
    },
  });
  const resolved = {
    ...base,
    candidateReal: input,
    stat: fs.statSync(input, { bigint: true }),
  };
  const [a, b] = await Promise.all([
    cache.thumbnailFor(resolved),
    cache.thumbnailFor(resolved),
  ]);
  assert.equal(count, 1);
  assert.equal(a.path, b.path);
  assert.equal((await cache.thumbnailFor(resolved)).cacheStatus, "hit");
  await cache.close();
  assert.equal(
    fs.readdirSync(path.dirname(a.path)).filter((x) => x.endsWith(".tmp"))
      .length,
    0,
  );
});
