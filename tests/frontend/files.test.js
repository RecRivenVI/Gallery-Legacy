"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { chromium } = require("playwright");
const { fixture } = require("../support/runtime.js");
const { normalizeRuntimeConfig } = require("../../internal/instance/config.js");
const { createRuntimeBootstrap } = require("../../internal/runtime/bootstrap.js");
test("file browser and legacy physical shortlink routes render through the existing viewer", async (t) => {
  const f = await fixture(t); await f.build(); f.publish();
  const files = path.join(f.root, "files"); fs.mkdirSync(files);
  const second = path.join(f.root, "second"); fs.mkdirSync(second);
  fs.writeFileSync(path.join(second, "a.png"), f.PNG);
  fs.writeFileSync(path.join(second, "b.png"), f.PNG);
  for (const name of ["1.png", "2.png", "10.png"]) fs.writeFileSync(path.join(files, name), f.PNG);
  const config = normalizeRuntimeConfig({ ...f.config, fileBrowserRoots: [{ id: "files", name: "文件浏览", path: files }, { id: "second", name: "第二文件根", path: second }], shortLinks: { sample: "/#/p/pixiv/100/2026-01-01_00-00-00_1?media=1.png" } });
  const r = createRuntimeBootstrap({ config }); f.cleanup.push(() => r.close()); await r.start();
  const browser = await chromium.launch({ headless: true }); f.cleanup.push(() => browser.close());
  const page = await browser.newPage(), errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(config.url + "/#/@all/pixiv");
  await page.waitForSelector('.platform-sub[data-action="files"][data-platform-id="files"]');
  assert.equal(await page.locator('#sidebarPlatformList .platform-row').count(), 9);
  await page.locator('.platform-sub[data-action="files"][data-platform-id="files"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#content .card").length === 3);
  const data = await page.evaluate(async () => (await import("/frontend/gallery/model.js")).state.allMedia.map((m) => m.name));
  assert.deepEqual(data, ["1.png", "2.png", "10.png"]);
  assert.equal(new URL(page.url()).hash.split("?")[0], "#/f/files");
  assert.equal(await page.locator('.platform-sub[data-platform-id="files"]').evaluate(el => el.classList.contains("active")), true);
  assert.equal(await page.locator('.platform-row.active').count(), 0);
  // A second configured file root must navigate to itself, not the first root
  // or the first platform; refreshing must not duplicate navigation entries.
  await page.evaluate(async () => {
    const { Sidebar } = await import("/frontend/gallery/components/sidebar.js");
    await Sidebar.refresh();
  });
  assert.equal(await page.locator('.platform-sub[data-action="files"]').count(), 2);
  await page.locator('.platform-sub[data-platform-id="second"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#content .card").length === 2);
  assert.equal(new URL(page.url()).hash.split("?")[0], "#/f/second");
  await page.goto(config.url + "/s/sample");
  await page.waitForFunction(() => [...document.querySelectorAll(".lb-slide img")].some((i) => i.complete && i.naturalWidth > 0));
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
});
