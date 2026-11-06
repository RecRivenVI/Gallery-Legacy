import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  config,
  url,
  output,
  driver,
  nativePage as manager,
  admin,
  invoke,
  tap,
  ready,
  wait,
  report,
} from "./support.mjs";
const author = path.join(config.sources.pixiv, "StreamAuthor");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2uWQAAAAASUVORK5CYII=",
  "base64",
);
for (let i = 0; i < 2000; i++) {
  const dir = path.join(author, String(990000 + i));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "1.png"), png);
  fs.writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({
      id: String(990000 + i),
      title: "Streaming Fixture " + i,
      user: { id: "990", name: "Streaming Author" },
    }),
  );
}
const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  await manager.evaluate(() => localStorage.setItem("gallery_theme", "dark"));
  await manager.reload();
  await ready(manager);
  await tap(manager.getByRole("button", { name: "更新图库", exact: true }));
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.addInitScript(() => {
    localStorage.setItem("gallery_theme", "dark");
    localStorage.setItem(
      "gallery_canvas_preferences",
      JSON.stringify({ autoRefresh: true }),
    );
  });
  await page.goto(url + "/#/@all/pixiv?pageSize=24");
  await ready(page);
  await page.waitForLoadState("networkidle");
  const frames = async (p) =>
    p.evaluate(() => {
      window.__runFrames = [];
      window.__framesOn = true;
      let last = performance.now();
      function tick(t) {
        if (!window.__framesOn) return;
        window.__runFrames.push(t - last);
        last = t;
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  await frames(page);
  await frames(manager);
  let navigations = 0;
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navigations++;
  });
  const samples = [],
    responseMs = [];
  await admin("scan.start", {
    mode: "full",
    platformIds: ["pixiv"],
    allowNative: true,
    confirmReadOnly: true,
  });
  await wait(
    async () => {
      const at = performance.now(),
        s = (await invoke("status")).scan;
      responseMs.push(performance.now() - at);
      samples.push(s);
      if (
        s.running &&
        s.counts?.worksCommitted > 0 &&
        !samples.some((x) => x.earlyShot)
      ) {
        s.earlyShot = true;
        await page.screenshot({
          path: path.join(output, "web-streaming-progress-dark.png"),
        });
        await manager.screenshot({
          path: path.join(output, "manager-streaming-progress-dark.png"),
        });
      }
      return !s.running;
    },
    "native streaming scan",
    120000,
  );
  const final = samples.at(-1);
  assert.equal(final.state, "READY");
  assert(final.counts.worksCommitted >= 2000);
  assert(
    samples.some((s) => s.running && s.counts?.worksCommitted > 0),
    "no platform-early visibility",
  );
  await tap(page.getByRole("button", { name: "设置", exact: true }));
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(navigations, 0);
  const stats = async (p) => {
    const xs = await p.evaluate(() => {
      window.__framesOn = false;
      return window.__runFrames.slice(1);
    });
    xs.sort((a, b) => a - b);
    return {
      samples: xs.length,
      p95Ms: xs[Math.floor(xs.length * 0.95)],
      maxMs: xs.at(-1),
      above250ms: xs.filter((x) => x > 250).length,
    };
  };
  const webFrames = await stats(page),
    managerFrames = await stats(manager);
  responseMs.sort((a, b) => a - b);
  report("native-streaming-results.json", {
    conclusion: "consistent",
    committed: final.counts.worksCommitted,
    batches: final.counts.batches,
    elapsedMs: final.elapsedMs,
    progressSamples: samples.length,
    earlyCommit: true,
    webFrames,
    managerFrames,
    statusP95Ms: responseMs[Math.floor(responseMs.length * 0.95)],
    pageNavigations: navigations,
    scope:
      "own native manager and SSD synthetic large author; no hardware or real-library claim",
  });
} finally {
  await browser.close();
  await driver.close();
}
