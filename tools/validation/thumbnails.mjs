import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright";
import { url, output, ready, tap, wait, report } from "./support.mjs";

const data = async (route) =>
  (await fetch(url + "/api/v1/" + route).then((r) => r.json())).data;
const works = await data("works?platform=pixiv&pageSize=48&sort=name_asc");
const work = works.items.find((w) => w.counts.media === 48);
assert(work?.cover?.thumbnails);
const cover = work.cover;
assert(cover.width > 0 && cover.height > 0 && cover.thumbHash.length > 10);
assert.equal(new Set(Object.values(cover.thumbnails)).size, 3);
const response = await fetch(url + cover.thumbnails.s);
assert(response.ok);
assert.match(
  response.headers.get("cache-control"),
  /max-age=31536000.*immutable/,
);
assert.match(response.headers.get("content-type"), /image\/webp/);
assert.equal(
  Buffer.from(await response.arrayBuffer())
    .subarray(0, 4)
    .toString(),
  "RIFF",
);

const browser = await chromium.launch({ headless: true });
const errors = [],
  requests = [],
  canceled = [],
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
    page.on("request", (r) => requests.push(r.url()));
    await page.goto(url + "/#/@all/pixiv?sort=name_asc&pageSize=24");
    await ready(page);
    await page.getByRole("button", { name: work.title, exact: true }).waitFor();
    await wait(
      () => requests.some((r) => /tier=m/.test(r)),
      "high-DPI medium tier",
    );
    await page.waitForLoadState("networkidle");
    const shot = `thumbnails-${theme}-desktop.png`;
    await page.screenshot({ path: path.join(output, shot) });
    shots.push(shot);
    const start = requests.length;
    await tap(page.getByRole("button", { name: work.title, exact: true }));
    await wait(
      () =>
        page
          .locator("[data-gallery-media] img")
          .evaluateAll((images) =>
            images.some(
              (i) =>
                i.complete && i.naturalWidth > 0 && i.src.includes("tier=l"),
            ),
          ),
      "large viewer preview",
    );
    assert(
      !requests.slice(start).some((r) => /\/api\/v1\/media\//.test(r)),
      "Unzoomed still image must not request original media",
    );
    for (let i = 0; i < 4; i++)
      await tap(page.getByRole("button", { name: "+", exact: true }));
    await wait(
      () => requests.slice(start).some((r) => /\/api\/v1\/media\//.test(r)),
      "original requested on magnification",
    );
    await context.close();
  }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() =>
    localStorage.setItem(
      "gallery_canvas_preferences",
      JSON.stringify({ size: 2 }),
    ),
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("requestfailed", (r) => {
    if (r.url().includes("/thumbnails/")) canceled.push(r.url());
  });
  await page.route("**/api/v1/thumbnails/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue().catch(() => {});
  });
  await page.goto(url + "/#/@all/pixiv?pageSize=120");
  await ready(page);
  await page
    .getByRole("button", { name: /Abstract Study/ })
    .first()
    .waitFor();
  await tap(page.getByRole("button", { name: /作者 1/, exact: true }));
  await wait(() => canceled.length > 0, "unmounted card requests canceled");
  await context.close();
  assert.deepEqual(errors, []);
  report("thumbnail-results.json", {
    conclusion: "consistent",
    scope: "synthetic library only",
    cache: {
      immutable: true,
      firstTier: "webp",
      dimensions: [cover.width, cover.height],
      thumbHashBytes: Buffer.from(cover.thumbHash, "base64").length,
    },
    checks: [
      "DPR-based M selection",
      "S to L before original",
      "original only on zoom",
      "disposed card requests canceled",
    ],
    canceledRequests: canceled.length,
    pageErrors: errors,
    screenshots: shots,
  });
} finally {
  await browser.close();
}
