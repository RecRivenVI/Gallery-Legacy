import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
const repo = path.resolve(import.meta.dirname, "../..");
const goldenFile = process.env.GALLERY_HTTP_GOLDEN,
  exe = process.env.GALLERY_READ_EXE,
  out = process.env.GALLERY_HTTP_EVIDENCE;
if (!goldenFile || !exe || !out)
  throw Error("explicit golden, read binary and evidence directory required");
const golden = JSON.parse(fs.readFileSync(goldenFile));
const fixture = golden.cases.find((c) => c.name === "Live"),
  config = JSON.parse(fs.readFileSync(fixture.configFile));
const url = `http://127.0.0.1:${config.port}`;
const expectedInstance = fixture.requests.find(
  (r) => r.path === "/api/v1/health",
).expected.json.data.instanceId;
const scratch = fs.mkdtempSync(path.join(path.dirname(goldenFile), "Browser-"));
process.env.TEMP = scratch;
process.env.TMP = scratch;
fs.mkdirSync(out, { recursive: true });
const child = spawn(
  exe,
  [
    "-config",
    fixture.configFile,
    "-frontend",
    path.join(repo, "public"),
    "-assets",
    golden.assets,
  ],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let log = "";
child.stdout.on("data", (b) => (log += b));
child.stderr.on("data", (b) => (log += b));
const exited = new Promise((resolve) =>
  child.once("exit", (code, signal) => resolve({ code, signal })),
);
let browser, page;
const failures = [],
  requests = [];
try {
  let ready = false;
  for (let n = 0; n < 40; n++) {
    if (child.exitCode !== null) throw Error(log);
    if (!log.includes("INFO public read listener url=" + url)) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    try {
      const r = await fetch(url + "/api/v1/health");
      if (r.ok && (await r.json()).data.instanceId === expectedInstance) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(ready, "own Go read listener readiness");
  browser = await chromium.launchPersistentContext(
    path.join(scratch, "profile"),
    {
      headless: true,
      args: ["--mute-audio"],
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    },
  );
  const context = browser;
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === url
      ? route.continue()
      : route.abort(),
  );
  await context.addInitScript(() =>
    localStorage.setItem("gallery_theme", "dark"),
  );
  page = await context.newPage();
  page.on("pageerror", (e) => failures.push(e.message));
  page.on("response", (r) => {
    if (r.url().startsWith(url + "/api/"))
      requests.push({ path: new URL(r.url()).pathname, status: r.status() });
  });
  await page.goto(url + "/#/@all/pixiv", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      window.__galleryCanvas?.ready &&
      window.__galleryCanvas.state.status === "populated" &&
      [...window.__galleryCanvas.tiles.values()].some((t) => t.appear.x > 0.99),
  );
  assert(
    (await page.locator('[data-control^="cover:"]').count()) > 0,
    "real rendered catalog cards",
  );
  await page.screenshot({ path: path.join(out, "go-gallery-dark.png") });
  await page.locator('[data-control^="cover:"]').first().click();
  await page.waitForFunction(
    () =>
      window.__galleryCanvas.viewer.opened &&
      window.__galleryCanvas.viewer.status === "ready",
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !window.__galleryCanvas.viewer.opened);
  await page.locator("#search").fill("不存在的合成结果");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () =>
      window.__galleryCanvas.state.query.q === "不存在的合成结果" &&
      window.__galleryCanvas.state.result?.total === 0,
  );
  await page.locator("#search").fill("");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () =>
      !window.__galleryCanvas.state.query.q &&
      window.__galleryCanvas.state.result?.total > 0,
  );
  await page.evaluate(() => window.__galleryCanvas.setTheme("light"));
  await page.waitForFunction(
    () =>
      window.__galleryCanvas.state.theme === "light" &&
      window.__galleryCanvas.state.themeFade.x === 1,
  );
  await page.screenshot({ path: path.join(out, "go-gallery-light.png") });
  await page.goto(url + "/#/f/files", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      window.__galleryCanvas?.ready &&
      window.__galleryCanvas.state.query.kind === "files" &&
      window.__galleryCanvas.state.status === "populated",
  );
  const video = await page.evaluate(async () => {
    const v = document.createElement("video");
    v.muted = true;
    v.src = "/api/v1/file-media?root=files&path=clip.mp4";
    document.body.append(v);
    try {
      return await new Promise((resolve, reject) => {
        v.onloadedmetadata = () =>
          resolve({
            width: v.videoWidth,
            height: v.videoHeight,
            duration: v.duration,
          });
        v.onerror = () => reject(Error("synthetic video metadata failed"));
        v.load();
      });
    } finally {
      v.remove();
    }
  });
  assert(
    video.width === 64 && video.height === 48,
    "Go video Range browser decode",
  );
  assert.equal(failures.length, 0, failures.join("\n"));
  fs.writeFileSync(
    path.join(out, "browser.json"),
    JSON.stringify(
      {
        conclusion: "一致",
        scope:
          "Go public read with unchanged current frontend; no management IPC",
        video,
        requests,
        pageErrors: failures,
        manualIME: false,
        ownedTemporaryRoot: scratch,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const state = await page
    ?.evaluate(() => ({
      debug: window.__galleryCanvas?.debug(),
      boot: document.querySelector("#boot")?.textContent,
    }))
    .catch(() => null);
  if (page)
    await page
      .screenshot({ path: path.join(out, "browser-failure.png") })
      .catch(() => {});
  fs.writeFileSync(
    path.join(out, "browser-failure.json"),
    JSON.stringify({ error: error.stack, state, failures, requests }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  // This handle was created above and is never resolved by process name/PID.
  if (child.exitCode === null) child.kill();
  const exit = await exited;
  fs.writeFileSync(
    path.join(out, "browser-host.log"),
    log + "\n" + JSON.stringify(exit),
  );
}
