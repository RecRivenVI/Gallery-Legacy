import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright";
import { url, output, ready, tap, wait, report } from "./support.mjs";

const data = async (route) =>
  (await fetch(url + "/api/v1/" + route).then((r) => r.json())).data;
const works = await data("works?platform=pixiv&pageSize=48&sort=name_asc");
const work = works.items.find((w) => w.counts.media === 48);
assert(work?.cover?.thumbnailUrl);
const cover = work.cover;
const illustration = works.items.find(
  (w) => w.counts.media === 1 && w.details?.workType !== "manga",
);
assert(illustration?.cover?.thumbnailUrl);
const detail = await data("works/" + work.id);
const strip = detail.media.filter((m) => m.defaultVisible).at(-2);
assert.equal(
  new URL(strip.thumbnailUrl, url).searchParams.get("purpose"),
  "strip",
);
const stripStarted = performance.now();
const stripResponse = await fetch(url + strip.thumbnailUrl);
assert(stripResponse.ok);
const stripBytes = await stripResponse.arrayBuffer();
const stripMs = performance.now() - stripStarted;
const stripHitStarted = performance.now();
const stripHit = await fetch(url + strip.thumbnailUrl);
assert.equal(stripHit.headers.get("X-Gallery-Thumbnail"), "hit");
assert.deepEqual(await stripHit.arrayBuffer(), stripBytes);
const stripHitMs = performance.now() - stripHitStarted;
const started = performance.now();
const response = await fetch(url + cover.thumbnailUrl);
assert(response.ok);
assert.match(
  response.headers.get("cache-control"),
  /max-age=31536000.*immutable/,
);
assert.match(response.headers.get("content-type"), /image\/webp/);
const first = Buffer.from(await response.arrayBuffer());
const firstMs = performance.now() - started;
assert.equal(first.subarray(0, 4).toString(), "RIFF");
const again = performance.now();
const hit = await fetch(url + cover.thumbnailUrl);
assert.equal(hit.headers.get("X-Gallery-Thumbnail"), "hit");
assert.deepEqual(Buffer.from(await hit.arrayBuffer()), first);
const hitMs = performance.now() - again;

const browser = await chromium.launch({ headless: true });
const errors = [],
  shots = [];
try {
  for (const theme of ["dark", "light"]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    await context.addInitScript((theme) => {
      localStorage.setItem("gallery_theme", theme);
      localStorage.setItem(
        "gallery_canvas_preferences",
        JSON.stringify({ size: 5 }),
      );
    }, theme);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const requested = [];
    page.on("request", (r) => requested.push(new URL(r.url())));
    await page.goto(url + "/#/@all/pixiv?sort=name_asc&pageSize=24");
    await ready(page);
    const manga = theme === "dark";
    const selected = manga ? work : illustration;
    const card = page.getByRole("button", {
      name: selected.title,
      exact: true,
    });
    await card.waitFor();
    await wait(
      () =>
        requested.some(
          (r) =>
            r.pathname.includes("/thumbnails/") &&
            r.searchParams.get("purpose") === "display",
        ),
      "high-DPI display thumbnail",
    );
    let releaseOriginal;
    const allowOriginal = new Promise((resolve) => {
      releaseOriginal = resolve;
    });
    await page.route("**/api/v1/media/**", async (route) => {
      await allowOriginal;
      await route.continue().catch(() => {});
    });
    await tap(card);
    await wait(
      () => requested.some((r) => r.pathname.includes("/api/v1/media/")),
      "original before zoom",
    );
    await page.waitForTimeout(300);
    const loading = "original-loading-" + theme + ".png";
    await page.screenshot({ path: path.join(output, loading) });
    shots.push(loading);
    const original = page.waitForResponse((r) =>
      new URL(r.url()).pathname.includes("/api/v1/media/"),
    );
    releaseOriginal();
    const originalResponse = await original;
    assert(originalResponse.ok());
    await originalResponse.finished();
    if (!manga)
      await wait(
        () =>
          page
            .locator("[data-gallery-media] img")
            .evaluateAll((images) =>
              images.some(
                (i) =>
                  i.complete &&
                  i.naturalWidth > 0 &&
                  new URL(i.src).pathname.includes("/api/v1/media/"),
              ),
            ),
        "original visible",
      );
    await page.waitForTimeout(450);
    assert(!(await page.locator("body").ariaSnapshot()).includes("加载失败"));
    const displayed = "original-loaded-" + theme + ".png";
    await page.screenshot({ path: path.join(output, displayed) });
    shots.push(displayed);
    assert(
      !requested.some((r) => r.searchParams.has("tier")),
      "obsolete size tier requested",
    );
    await context.close();
  }
  assert.deepEqual(errors, []);
  report("thumbnail-results.json", {
    conclusion: "consistent",
    scope: "synthetic library only",
    firstState: response.headers.get("X-Gallery-Thumbnail"),
    firstMs,
    hitMs,
    webpBytes: first.length,
    stripState: stripResponse.headers.get("X-Gallery-Thumbnail"),
    stripMs,
    stripHitMs,
    stripBytes: stripBytes.byteLength,
    checks: [
      "single display thumbnail",
      "original requested before zoom",
      "verified identical cached bytes",
    ],
    pageErrors: errors,
    screenshots: shots,
  });
} finally {
  await browser.close();
}
