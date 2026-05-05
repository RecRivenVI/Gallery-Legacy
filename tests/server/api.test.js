"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture } = require("../support/runtime.js");
const {
  createRuntimeBootstrap,
} = require("../../internal/runtime/bootstrap.js");
test("API structured filters, cursors, invalid input and origin boundary", async (t) => {
  const f = await fixture(t);
  f.build();
  f.publish();
  const r = createRuntimeBootstrap({ config: f.config });
  f.cleanup.push(() => r.close());
  await r.start();
  async function get(route, options) {
    const response = await fetch(f.config.url + route, options);
    return { response, body: await response.json() };
  }
  const tagged = await get("/api/v1/works?tag=R-18");
  assert.equal(tagged.body.data.total, 1);
  assert.ok(
    tagged.body.data.items.every((w) =>
      w.tags.some((tag) => tag.label === "R-18"),
    ),
  );
  assert.equal((await get("/api/v1/works?q=R-18")).body.data.total, 2);
  assert.equal((await get("/api/v1/works?q=Beta&tag=R-18")).body.data.total, 0);
  assert.equal(
    (await get("/api/v1/works?q=" + encodeURIComponent("鱼猫"))).body.data
      .total,
    1,
  );
  const first = (await get("/api/v1/works?pageSize=2")).body.data;
  const second = (await get("/api/v1/works?pageSize=2&cursor=" + first.cursor))
    .body.data;
  assert.equal(
    new Set([...first.items, ...second.items].map((w) => w.id)).size,
    4,
  );
  for (const query of [
    "q=%00",
    "sort=bogus",
    "mediaType=bogus",
    "cursor=bad",
    "pageSize=-1",
    "q=a&q=b",
    "author=9223372036854775808",
    "cursor=" + first.cursor + "&q=other",
  ]) {
    const bad = await get("/api/v1/works?" + query);
    assert.equal(bad.response.status, 400);
    assert.ok(bad.body.error.code);
    assert.equal(bad.body.error.stack, undefined);
  }
  assert.equal(
    (
      await get("/api/v1/works", {
        headers: { Origin: "https://untrusted.invalid" },
      })
    ).response.status,
    403,
  );
  assert.equal((await get("/api/v1/health")).response.status, 200);
  const videos = (await get("/api/v1/works?mediaType=video")).body.data;
  assert.equal(videos.total, 2);
  assert.ok(
    (await get("/api/v1/works?mediaType=image")).body.data.items.every(
      (w) => w.counts.videos === 0,
    ),
  );
  const detail = (await get("/api/v1/works/" + videos.items[0].id)).body.data;
  const url = detail.media.find((m) => m.type === "video").url;
  const head = await fetch(f.config.url + url, { method: "HEAD" });
  assert.equal(head.status, 200);
  const range = await fetch(f.config.url + url, {
    headers: { Range: "bytes=0-3" },
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 4);
  assert.equal(
    (
      await get("/api/v1/scans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).response.status,
    400,
  );
  assert.equal(
    tagged.response.headers.has("access-control-allow-origin"),
    false,
  );
  assert.equal(JSON.stringify(tagged.body).includes(f.root), false);
  assert.equal((await get("/api/v1/tags?tag=R-18")).response.status, 400);
  assert.equal(
    (await get("/api/v1/authors?mediaType=image")).response.status,
    400,
  );
  assert.equal(
    (await get("/api/v1/scans", { method: "POST", body: "x".repeat(5000) }))
      .response.status,
    413,
  );
});
