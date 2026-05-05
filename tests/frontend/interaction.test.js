"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs"),
  { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const { fixture } = require("../support/runtime.js");
const {
  createRuntimeBootstrap,
} = require("../../internal/runtime/bootstrap.js");
test("Gallery search, exact tag, authors, sorting, pagination and WebM viewer work through DOM", async (t) => {
  const f = await fixture(t);
  // Cover badges are presentation facts, not tag identities. Exercise both:
  // a real R-18 tag with an adult badge, and an adult badge without that tag.
  for (const folder of ["2026-01-01_00-00-00_1", "2026-01-02_00-00-00_2"]) {
    const file = path.join(f.bindings.pixiv, "100", folder, "metadata.json");
    const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
    metadata.x_restrict = 1;
    fs.writeFileSync(file, JSON.stringify(metadata));
  }
  const clip = path.join(
    f.bindings.pixiv,
    "freeform-author/freeform/only.webm",
  );
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=32x32:rate=10",
      "-t",
      "1",
      "-c:v",
      "libvpx-vp9",
      "-an",
      "-y",
      clip,
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  fs.copyFileSync(
    clip,
    path.join(f.bindings.pixiv, "100/2026-01-02_00-00-00_2/clip.webm"),
  );
  f.build();
  f.publish();
  const runtime = createRuntimeBootstrap({ config: f.config });
  f.cleanup.push(() => runtime.close());
  await runtime.start();
  const browser = await chromium.launch({ headless: true });
  f.cleanup.push(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  async function route(hash, count) {
    await page.goto(f.config.url + "/#" + hash);
    await page.waitForFunction(
      (n) => document.querySelectorAll("#content .card").length === n,
      count,
    );
  }
  await route("/@all/pixiv", 6);
  assert.equal(
    await page
      .locator("#content .media-corner")
      .filter({ hasText: /^R-18$/ })
      .count(),
    2,
  );
  assert.equal(
    await page.locator('#content .media-tag[data-tag="R-18"]').count(),
    1,
  );
  assert.equal(
    await page
      .locator(
        '[data-d-title="Beta R-18 title only"] .media-tag[data-tag="R-18"]',
      )
      .count(),
    0,
  );
  await page.locator('.media-tag[data-tag="R-18"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll("#content .card").length === 1,
  );
  assert.equal(
    new URLSearchParams(page.url().split("?")[1]).get("tag"),
    "R-18",
  );
  assert.equal(new URLSearchParams(page.url().split("?")[1]).get("q"), null);
  await page.locator(".global-header .search-input").fill("Alpha");
  await page.locator(".global-header .search-input").press("Enter");
  await page.waitForFunction(() =>
    document.querySelector("#content")?.textContent.includes("Alpha"),
  );
  assert.equal(await page.locator("#content .card").count(), 1);
  await route("/@authors/pixiv", 2);
  if (await page.locator("#headerFilterToggle").isVisible())
    await page.locator("#headerFilterToggle").click();
  await page.locator('[data-menu-btn="sort"]').click();
  assert.equal(await page.locator("[data-fp-sort]").count(), 6);
  await page.locator('[data-fp-sort="posts_desc"]').click();
  await page.waitForFunction(() => location.hash.includes("sort=posts_desc"));
  await route("/@all/pixiv?pageSize=2&page=2&sort=title_asc", 2);
  await route("/@all/pixiv?mediaType=image", 4);
  await route("/@all/pixiv?mediaType=video", 2);
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll("#content .media-cover img")).every(
      (i) => i.complete && i.naturalWidth > 0,
    ),
  );
  await page.locator("#content .card .media-cover").first().click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".lb-slide video")).some(
      (v) => v.readyState >= 2,
    ),
  );
  const playback = await page
    .locator(".lb-slide video")
    .first()
    .evaluate(async (v) => {
      v.muted = true;
      await v.play();
      await new Promise((r) => setTimeout(r, 200));
      return { time: v.currentTime, error: !!v.error, paused: v.paused };
    });
  assert.equal(playback.error, false);
  assert.equal(playback.paused, false);
  assert.ok(playback.time > 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  assert.deepEqual(errors, []);
});
