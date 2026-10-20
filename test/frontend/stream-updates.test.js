"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  { pathToFileURL } = require("node:url");
const load = () =>
  import(pathToFileURL(path.resolve("public/gallery/stream-updates.js")));
const status = (revision, results = [], run = 10) => ({
  live: { epoch: "a", revision },
  scan: { startedAtMs: run, platformResults: results },
});
test("stream commits never reload or notify before a platform completes", async () => {
  const { createStreamUpdates } = await load(),
    updates = createStreamUpdates();
  assert.deepEqual(updates.receive(status(0), "pixiv"), {
    changed: false,
    added: 0,
  });
  for (let i = 1; i <= 100; i++)
    assert.deepEqual(updates.receive(status(i), "pixiv"), {
      changed: false,
      added: 0,
    });
  const done = {
    platformId: "pixiv",
    status: "COMPLETE",
    changes: { worksAdded: 5 },
  };
  assert.deepEqual(updates.receive(status(101, [done]), "pixiv"), {
    changed: true,
    added: 5,
  });
  assert.deepEqual(updates.receive(status(101, [done]), "pixiv"), {
    changed: false,
    added: 0,
  });
});
test("completion notifications are scoped, deduplicated and renew on later runs", async () => {
  const { createStreamUpdates } = await load(),
    updates = createStreamUpdates();
  updates.receive(status(0), "pixiv");
  const other = {
    platformId: "X",
    status: "COMPLETE",
    platformChanges: { worksAdded: 2 },
  };
  assert.equal(updates.receive(status(1, [other]), "pixiv").changed, false);
  const done = {
    platformId: "pixiv",
    status: "COMPLETE",
    platformChanges: { worksAdded: 4 },
  };
  assert.deepEqual(updates.receive(status(2, [other, done]), "pixiv"), {
    changed: true,
    added: 4,
  });
  assert.deepEqual(updates.receive(status(3, [done], 20), "pixiv"), {
    changed: true,
    added: 4,
  });
  assert.equal(
    updates.receive(
      { ...status(4), live: { epoch: "b", revision: 0 } },
      "pixiv",
    ).changed,
    true,
  );
  const all = createStreamUpdates();
  all.receive(status(0), "@all");
  assert.deepEqual(all.receive(status(1, [other, done]), "@all"), {
    changed: true,
    added: 6,
  });
});
