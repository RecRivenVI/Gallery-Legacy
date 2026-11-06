import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import {
  config,
  url,
  output,
  tap,
  ready,
  wait,
  report,
  nativePage,
  driver,
} from "./support.mjs";

const executable = path.resolve(process.env.GALLERY_TEST_SCANNER || "");
assert(process.env.GALLERY_TEST_SCANNER && fs.statSync(executable).isFile());
const browser = await chromium.launch({ headless: true, channel: "chromium" });
const changed = [];
let child;
try {
  for (const author of fs.readdirSync(config.sources.pixiv, {
    withFileTypes: true,
  })) {
    if (!author.isDirectory()) continue;
    const directory = path.join(config.sources.pixiv, author.name);
    for (const work of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!work.isDirectory()) continue;
      const file = path.join(directory, work.name, "metadata.json");
      if (!fs.existsSync(file)) continue;
      const original = fs.readFileSync(file);
      const document = JSON.parse(original);
      document.title = (document.title || "Synthetic") + " · live";
      changed.push({ file, original });
      fs.writeFileSync(file, JSON.stringify(document));
    }
  }
  assert(changed.length >= 24, "Use the complete synthetic fixture");
  const scannerFile = path.join(config.instanceRoot, "live-validation.json");
  const scanner = JSON.parse(
    fs.readFileSync(path.join(config.instanceRoot, "state", "scanner.json")),
  );
  fs.writeFileSync(
    scannerFile,
    JSON.stringify({
      ...scanner,
      batchSize: 1,
      allowNative: true,
      listingSource: "filesystem",
    }),
  );
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const errors = [];
  const revisions = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => {
      const message = JSON.parse(frame.payload.toString());
      revisions.push(message.data.live.platformRevisions.pixiv);
    }),
  );
  await page.goto(url + "/#/@all/pixiv?sort=name_asc&pageSize=24");
  await page.evaluate(() => {
    localStorage.setItem("gallery_theme", "dark");
    localStorage.setItem(
      "gallery_canvas_preferences",
      JSON.stringify({ autoRefresh: true }),
    );
  });
  await page.reload();
  await ready(page);
  await page
    .getByRole("button", { name: /Abstract Study/ })
    .first()
    .waitFor();
  await page.waitForLoadState("networkidle");
  await wait(() => revisions.length > 0, "initial live status");
  let lists = 0,
    navigations = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/works") lists++;
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  const startFrames = async (p) =>
    p.evaluate(() => {
      window.__scanFrames = [];
      window.__scanFrameStop = false;
      let last = performance.now();
      function tick(now) {
        if (window.__scanFrameStop) return;
        window.__scanFrames.push(now - last);
        last = now;
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  await startFrames(page);
  if (nativePage) await startFrames(nativePage);
  const snapshots = [];
  let pending = "",
    stderr = "";
  child = spawn(
    executable,
    [
      "-config",
      scannerFile,
      "-platforms",
      "pixiv",
      "-mode",
      "full",
      "-synthetic-delay-ms",
      "1800",
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  child.stdout.on("data", (bytes) => {
    pending += bytes;
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) if (line.trim()) snapshots.push(JSON.parse(line));
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const ended = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  await wait(
    () => snapshots.some((s) => s.running && s.counts.worksCommitted > 0),
    "early live commit",
    30000,
  );
  await tap(page.getByRole("button", { name: "设置", exact: true }));
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await wait(
    async () => (await page.getByRole("dialog").count()) === 0,
    "settings closes during scan",
  );
  await wait(() => lists > 0, "fixed frequency refresh", 15000);
  await tap(page.getByRole("button", { name: "设置", exact: true }));
  await page.getByRole("dialog").waitFor();
  await tap(page.getByRole("switch", { name: "自动刷新", exact: true }));
  await page.keyboard.press("Escape");
  const whenDisabled = lists;
  const exit = await ended;
  assert.equal(exit, 0, stderr);
  await page.waitForTimeout(5500);
  assert.equal(
    lists,
    whenDisabled,
    "Disabled automatic refresh must stop collection requests",
  );
  const frameStats = async (p) => {
    const frames = await p.evaluate(() => {
      window.__scanFrameStop = true;
      return window.__scanFrames;
    });
    const ordered = frames.slice(1).sort((a, b) => a - b);
    return {
      samples: ordered.length,
      p95Ms: ordered[Math.floor(ordered.length * 0.95)],
      maxMs: ordered.at(-1),
      above250ms: ordered.filter((x) => x > 250).length,
    };
  };
  const browserFrames = await frameStats(page),
    managerFrames = nativePage ? await frameStats(nativePage) : null;
  assert.equal(navigations, 0, "Live commits must not reload the page");
  assert.deepEqual(errors, []);
  const final = snapshots.at(-1);
  assert.equal(final.counts.worksCommitted, changed.length);
  assert(final.counts.batches >= 24);
  assert(
    revisions.at(-1) > revisions[0],
    "Real live revisions must reach the browser",
  );
  await page
    .getByRole("button", { name: "有新内容 · 刷新", exact: true })
    .waitFor();
  await page.screenshot({
    path: path.join(output, "web-live-updates-dark-desktop.png"),
  });
  report("live-updates-results.json", {
    conclusion: "consistent",
    changedWorks: changed.length,
    committed: final.counts.worksCommitted,
    batches: final.counts.batches,
    earlyCommit: true,
    automaticCollectionRequests: lists,
    pageNavigations: navigations,
    browserFrames,
    managerFrames,
    automaticRefreshDisabled: true,
    settingsResponsive: true,
    revisionSamples: revisions,
    newContentBanner: true,
    pageErrors: errors,
    scope:
      "synthetic local streaming scan; browser and own Tauri WebView rAF; no real-library or HDD performance claim",
  });
} finally {
  if (child && child.exitCode === null) {
    child.stdin.write("cancel\n");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  for (const { file, original } of changed) fs.writeFileSync(file, original);
  await browser.close();
  if (driver) await driver.close();
}
