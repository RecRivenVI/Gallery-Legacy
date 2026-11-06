import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { url, output, ready, report } from "./support.mjs";
import { recording } from "./recording.mjs";

const magick = process.env.GALLERY_MAGICK || "magick";
const images = {};
for (const [name, color] of [
  ["red", "red"],
  ["blue", "blue"],
]) {
  const file = path.join(output, `motion-${name}.png`);
  const result = spawnSync(
    magick,
    [
      "-size",
      "320x320",
      "xc:white",
      "-fill",
      color,
      "-draw",
      "rectangle 156,10 164,310",
      file,
    ],
    { windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr?.toString());
  images[name] = fs.readFileSync(file);
}
function marker(png, width, color) {
  const result = spawnSync(magick, ["png:-", "-depth", "8", "rgb:-"], {
    input: png,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  const points = [];
  for (let i = 0; i < result.stdout.length; i += 3) {
    const [r, g, b] = result.stdout.subarray(i, i + 3);
    if (color === "red" ? r - b > 35 && r - g > 35 : b - r > 35 && b - g > 35)
      points.push((i / 3) % width);
  }
  return points.length
    ? points.reduce((a, b) => a + b, 0) / points.length
    : null;
}
const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.addInitScript(() => localStorage.setItem("gallery_theme", "dark"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/motion-*.png", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: images[route.request().url().includes("red") ? "red" : "blue"],
    }),
  );
  await page.route("**/api/v1/works?*", async (route) => {
    const response = await route.fetch(),
      document = await response.json();
    const number =
      new URL(route.request().url()).searchParams.get("page") || "1";
    document.data.items = document.data.items.map((item) => ({
      ...item,
      cover: {
        ...item.cover,
        thumbnailUrl: `${url}/motion-${number === "1" ? "blue" : "red"}.png`,
      },
    }));
    await route.fulfill({ response, json: document });
  });
  await page.goto(url + "/#/@all/pixiv?pageSize=24&sort=name_asc");
  await ready(page);
  await page.getByRole("group", { name: "页码条", exact: true }).waitFor();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(600);
  const rows = (
    await (
      await fetch(
        url + "/api/v1/works?platform=pixiv&page=1&pageSize=24&sort=name_asc",
      )
    ).json()
  ).data.items;
  const boxes = await Promise.all(
    [0, 5].map((i) =>
      page
        .getByRole("button", { name: rows[i].title, exact: true })
        .boundingBox(),
    ),
  );
  const clips = boxes.map((b) => ({
    x: Math.round(b.x),
    y: Math.round(b.y + b.width * 0.4),
    width: Math.round(b.width),
    height: 4,
  }));
  const now = Date.now();
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now + 1000));
  const results = [];
  async function flip(number, direction) {
    const control = await page
      .getByRole("button", {
        name: direction > 0 ? "下一页" : "上一页",
        exact: true,
      })
      .boundingBox();
    const response = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/v1/works" &&
        new URL(r.url()).searchParams.get("page") === String(number),
    );
    await page.mouse.click(
      control.x + control.width / 2,
      control.y + control.height / 2,
    );
    await page.clock.runFor(32);
    await response;
    await new Promise((r) => setTimeout(r, 20));
    const color = direction > 0 ? "red" : "blue",
      samples = [];
    for (let at = 0; at <= 640; at += 32) {
      await page.clock.runFor(32);
      await new Promise((r) => setTimeout(r, 12));
      const points = [];
      for (const clip of clips)
        points.push(marker(await page.screenshot({ clip }), clip.width, color));
      samples.push({ at, first: points[0], later: points[1] });
    }
    const end = samples.at(-1);
    assert(
      end.first !== null && end.later !== null,
      "Final synthetic markers missing",
    );
    const first = samples.find((s) => s.first !== null),
      later = samples.find((s) => s.later !== null);
    const displacement = first.first - end.first,
      staggerMs = later.at - first.at;
    assert(
      displacement * direction >= 2,
      `Wrong pixel direction ${direction}: ${displacement}`,
    );
    assert(staggerMs >= 32, `Missing pixel stagger: ${staggerMs}ms`);
    results.push({ page: number, direction, displacement, staggerMs, samples });
  }
  const file = await recording(
    page,
    output,
    "pagination-card-direction-dark",
    async () => {
      await flip(2, 1);
      await flip(1, -1);
    },
  );
  assert.deepEqual(errors, []);
  report("pagination-motion-results.json", {
    conclusion: "consistent",
    method:
      "synthetic colored marker pixels with controlled browser clock; real rAF performance is measured separately",
    results,
    recording: file,
    pageErrors: errors,
  });
} finally {
  await browser.close();
}
