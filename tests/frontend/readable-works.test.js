"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { fixture } = require("../support/runtime.js");
const { createRuntimeBootstrap } = require("../../internal/runtime/bootstrap.js");

test("readable-work preference filters before pagination and persists without erasing physical facts", async (t) => {
  const f = await fixture(t, { empty: true });
  f.work("empty", undefined, {});
  f.work("cover", "{", { "cover.png": f.PNG, ".cover.jpg": f.PNG });
  f.work("image", undefined, { "cover.jpg": f.PNG, "nested/中文 10.png": f.PNG, ".nocover": "" });
  f.work("video", "[]", { "only.webm": "synthetic" });
  f.work("preview", { category: "ganknow", content: "https://mega.nz/file/synthetic" },
    { "1.jpg": f.PNG, "2.jpg": f.PNG }, "author", "Gank");
  await f.build(); f.publish();
  const runtime = createRuntimeBootstrap({ config: f.config });
  f.cleanup.push(() => runtime.close());
  await runtime.start();
  const get = async (q) => {
    const r = await fetch(f.config.url + "/api/v1/works?" + q);
    return { status: r.status, ...(await r.json()) };
  };
  assert.equal((await get("")).data.total, 5);
  const first = (await get("hideEmpty=1&pageSize=1&sort=title_asc")).data;
  assert.equal(first.total, 2); assert.equal(first.items.length, 1);
  assert.equal(first.totalPages, 2);
  const second = (await get("hideEmpty=1&pageSize=1&sort=title_asc&cursor=" + first.cursor)).data;
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal((await get("hideEmpty=0&pageSize=1&sort=title_asc&cursor=" + first.cursor)).status, 400);
  assert.equal((await get("hideEmpty=1&pageSize=1&sort=title_asc&page=2")).data.items[0].id, second.items[0].id);
  assert.equal((await get("hideEmpty=1&q=cover")).data.total, 0);
  assert.equal((await get("hideEmpty=0&q=cover")).data.total, 1);
  assert.equal((await get("hideEmpty=1&mediaType=image")).data.total, 1);
  assert.equal((await get("hideEmpty=1&mediaType=video")).data.total, 1);
  assert.equal((await get("hideEmpty=1&platform=Gank")).data.total, 0);
  assert.equal((await get("hideEmpty=true")).status, 400);
  const cover = (await get("q=cover")).data.items[0];
  const detail = await (await fetch(f.config.url + "/api/v1/works/" + cover.id)).json();
  assert.equal(detail.data.media.length, 2);
  assert.ok(detail.data.media.every((m) => m.defaultVisible === false));

  const browser = await chromium.launch({ headless: true });
  f.cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(f.config.url + "/#/@all/pixiv");
  const cards = (n) => page.waitForFunction(n => document.querySelectorAll("#content .card").length === n, n);
  await cards(2);
  // Programmatic DOM only, synthetic data; no screenshots or real sources.
  await page.locator('[data-setting="hideEmpty"] [data-value="off"]').evaluate(b => b.click());
  await cards(4);
  assert.equal(await page.evaluate(() => localStorage.getItem("gallery_hide_empty")), "0");
  await page.goto(f.config.url + "/#/@all/pixiv"); await page.reload(); await cards(4);
  await page.locator('[data-setting="hideEmpty"] [data-value="on"]').evaluate(b => b.click());
  await cards(2); await page.reload(); await cards(2);
  assert.deepEqual(errors, []);
});
