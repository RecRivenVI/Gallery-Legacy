"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { fixture } = require("../support/runtime.js");
const { createRuntimeBootstrap } = require("../../internal/runtime/bootstrap.js");

test("Gallery drops stale URL consistency fields and keeps physical work/author routes across generations", async (t) => {
  const f = await fixture(t, { empty: true });
  f.work(
    "stable-work",
    {
      id: "stable-work",
      title: "Stable Alpha",
      user: { id: "stable-author", name: "Stable Author" },
      tags: ["Keep"],
    },
    undefined,
    "stable-author",
    "pixiv",
  );
  await f.build("first");
  f.publish("first");

  let runtime = createRuntimeBootstrap({ config: f.config });
  f.cleanup.push(() => runtime.close());
  await runtime.start();
  const browser = await chromium.launch({ headless: true });
  f.cleanup.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(f.config.url + "/#/@all/pixiv");
  await page.waitForSelector("#content .card.dir");
  const workPath = await page.locator("#content .card.dir").first().getAttribute("data-path");
  assert.match(workPath, /^\/p\/pixiv\//);

  await page.goto(f.config.url + "/#/@authors/pixiv");
  await page.waitForSelector("#content .card.dir[data-path^='/@author/']");
  const authorPath = await page.locator("#content .card.dir[data-path^='/@author/']").first().getAttribute("data-path");
  assert.match(authorPath, /%2Fp%2Fpixiv%2F/);

  await runtime.close();
  f.work("000-new", { title: "New generation work", user: { id: "new-author", name: "New Author" } }, undefined, "new-author", "pixiv");
  await f.build("second");
  f.publish("second");
  runtime = createRuntimeBootstrap({ config: f.config });
  await runtime.start();

  const stale = "/@all/pixiv?g=first&rev=73&cursor=stale&q=Stable&tag=Keep&sort=title_asc&mediaType=image&hideEmpty=1&pageSize=24";
  await page.goto(f.config.url + "/#" + stale);
  await page.waitForFunction(() => {
    const card = document.querySelector("#content .card.dir");
    return card && card.textContent.includes("Stable Alpha") && !document.querySelector("#content .error-msg");
  });
  const params = new URL(page.url()).hash.split("?")[1] || "";
  const address = new URLSearchParams(params);
  for (const key of ["g", "rev", "cursor"]) assert.equal(address.get(key), null);
  assert.equal(address.get("q"), "Stable");
  assert.equal(address.get("tag"), "Keep");
  assert.equal(address.get("sort"), "title_asc");
  assert.equal(address.get("mediaType"), "image");
  assert.equal(address.get("hideEmpty"), "1");
  assert.equal(address.get("pageSize"), "24");

  await page.goto(f.config.url + "#" + workPath + "?g=first&media=1.png");
  await page.waitForSelector(".lb-slide img");
  assert.equal((await page.locator("body").textContent()).includes("其他数据版本"), false);
  await page.keyboard.press("Escape");

  await page.goto(f.config.url + "#" + authorPath + "?g=first");
  await page.waitForFunction(() => document.querySelectorAll("#content .card.dir").length >= 1);
  assert.equal((await page.locator("#content").textContent()).includes("Stable Alpha"), true);
  assert.equal((await page.locator("body").textContent()).includes("其他数据版本"), false);

  // Static Runtime adoption is surfaced through the regular status polling.
  // With an idle first page the list may refresh; no URL version field is
  // needed for the refresh request.
  await page.goto(f.config.url + "/#/@all/pixiv");
  await page.waitForSelector("#content .card.dir");
  f.work("zzz-newer", { title: "Static refresh work", user: { id: "refresh-author", name: "Refresh Author" } }, undefined, "refresh-author", "pixiv");
  await f.build("third");
  f.publish("third");
  await page.waitForFunction(
    () => document.querySelector("#content")?.textContent.includes("Static refresh work"),
    null,
    { timeout: 20000 },
  );

  await page.goto(f.config.url + "#/work/1?g=first");
  await page.waitForSelector("#content .error-msg");
  assert.equal((await page.locator("#content").textContent()).includes("没有稳定地址"), true);
  assert.deepEqual(errors, []);
});

test("Gallery shows a no-library waiting state while the first generation is absent", async (t) => {
  const f = await fixture(t, { empty: true });
  const runtime = createRuntimeBootstrap({ config: f.config });
  f.cleanup.push(() => runtime.close());
  await runtime.start();
  const browser = await chromium.launch({ headless: true });
  f.cleanup.push(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.config.url + "/#/@all/pixiv");
  await page.waitForFunction(
    () => document.querySelector("#content")?.textContent.includes("首次完整扫描"),
    null,
    { timeout: 10000 },
  );
  assert.equal(await page.locator("#content .error-msg").count(), 0);
  assert.deepEqual(errors, []);
});

test("Gallery keeps stale page/viewer stable and exposes an update button", async (t) => {
  const f = await fixture(t, { empty: true });
  for (let i = 0; i < 24; i++)
    f.work(
      `page-${String(i).padStart(2, "0")}`,
      { title: `Page work ${i}`, user: { id: "page-author", name: "Page Author" } },
    );
  await f.build("first");
  f.publish("first");
  const runtime = createRuntimeBootstrap({ config: f.config });
  f.cleanup.push(() => runtime.close());
  await runtime.start();
  const browser = await chromium.launch({ headless: true });
  f.cleanup.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(f.config.url + "/#/@all/pixiv?page=2&pageSize=12");
  await page.waitForSelector("#content .card.dir");
  await page.locator(".search-input").first().focus();
  const activeBefore = await page.evaluate(() => document.activeElement?.className || "");
  await page.evaluate(() => window.scrollTo(0, 240));

  f.work("page-new", { title: "Page replacement", user: { id: "page-author", name: "Page Author" } });
  await f.build("second");
  f.publish("second");
  await page.waitForSelector("#live-update-notice:not([hidden])");
  assert.equal(await page.locator("#live-update-apply").isDisabled(), false);
  assert.equal(await page.evaluate(() => document.activeElement?.className || ""), activeBefore);
  assert.match(new URL(page.url()).hash, /page=2/);

  await page.locator("#live-update-apply").click();
  await page.waitForFunction(() => document.querySelector("#live-update-notice")?.hidden === true);
  assert.match(new URL(page.url()).hash, /page=2/);

  await page.goto(f.config.url + "/#/@all/pixiv?page=1&pageSize=12");
  await page.waitForSelector("#content .card .media-cover");
  await page.locator("#content .card .media-cover").first().click();
  await page.locator(".lb-slide.active img").first().waitFor({ state: "visible" });
  const mediaBefore = await page.locator(".lb-slide.active img").first().getAttribute("src");

  f.work("page-newer", { title: "Viewer replacement", user: { id: "page-author", name: "Page Author" } });
  await f.build("third");
  f.publish("third");
  await page.waitForSelector("#live-update-notice:not([hidden])");
  await page.waitForFunction(() => document.querySelector("#live-update-apply")?.disabled === true);
  assert.equal(await page.locator(".lb-slide.active img").first().getAttribute("src"), mediaBefore);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#live-update-apply")?.disabled === false);
  await page.locator("#live-update-apply").click();
  await page.waitForFunction(() => document.querySelector("#live-update-notice")?.hidden === true);
  assert.deepEqual(errors, []);
});
