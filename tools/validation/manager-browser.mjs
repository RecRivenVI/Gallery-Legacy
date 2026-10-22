import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { _electron, chromium } from "playwright";
const require = createRequire(import.meta.url);
const { freePort } = require("../../test/support/runtime.js");
const {
  GALLERY_RUNTIME_EXE: exe,
  GALLERY_NATIVE_LOADER: loader,
  GALLERY_NODE_REFERENCE_ROOT: reference,
  GALLERY_LIFECYCLE_EVIDENCE: out,
} = process.env;
if (!exe || !loader || !reference || !out)
  throw Error("Explicit isolated bindings required");
const repo = path.resolve(import.meta.dirname, "../..");
const fixture = JSON.parse(
  fs.readFileSync(path.join(out, "manager-lifecycle.json")),
);
const file = path.join(fixture.instanceRoot, "config.json"),
  config = JSON.parse(fs.readFileSync(file));
const env = {
  ...process.env,
  GALLERY_RUNTIME: exe,
  GALLERY_REPOSITORY: repo,
  GALLERY_ASSETS_ROOT: path.join(reference, "resources"),
  GALLERY_ICON_PATH: path.join(reference, "resources/app-icon.png"),
};
delete env.ELECTRON_RUN_AS_NODE;
const screenshotRoot = path.join(out, "screenshots");
fs.mkdirSync(screenshotRoot, { recursive: true });
let app, browser;
const failures = [],
  screenshots = [];
try {
  app = await _electron.launch({ args: [loader, "--config", file], env });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => failures.push(e.message));
  await page.waitForFunction(
    () => window.__managerCandidate?.state.status.state === "READY",
    { timeout: 30000 },
  );
  const previousScan = await page.evaluate(
    () => window.__managerCandidate.state.scan.generationId,
  );
  await page.evaluate(() => document.querySelector("#update-start").click());
  await page.waitForFunction(
    (previous) =>
      window.__managerCandidate.state.scan.generationId !== previous,
    previousScan,
  );
  await page.waitForFunction(
    async () => !(await window.galleryHost.admin("scan.status")).running,
  );
  await page.evaluate(async () => {
    await window.__managerCandidate.refreshStatus();
    await window.__managerCandidate.refreshPage();
  });
  await page.waitForFunction(
    () => !window.__managerCandidate.state.status.hostBusy,
  );
  await page.waitForFunction(async () => {
    await window.__managerCandidate.refreshStatus();
    return (
      window.__managerCandidate.state.scan.state === "READY" &&
      !window.__managerCandidate.state.scan.running
    );
  });
  await page.evaluate(() => window.__managerCandidate.render());
  const completed = await page.evaluate(() => ({
    state: window.__managerCandidate.state.scan.state,
    failure: window.__managerCandidate.state.scan.failure,
  }));
  assert.equal(completed.failure, null, JSON.stringify(completed));
  assert.equal(
    (await page.evaluate(() => window.galleryHost.status())).counts.works,
    71,
  );
  // Drive the actual page controls without desktop input or focus changes.
  await page.evaluate(() => window.__managerCandidate.go("access"));
  await page.waitForFunction(() => !!window.__managerCandidate.state.access);
  const beforeBlocking = await page.evaluate(
    () => window.__managerCandidate.state.access.enabled,
  );
  await page.evaluate(() => document.querySelector("#blocking").click());
  await page.waitForFunction(
    (expected) =>
      window.__managerCandidate.state.access.enabled === expected &&
      !window.__managerCandidate.state.busy,
    !beforeBlocking,
  );
  await page.evaluate(() =>
    document.querySelector('[data-period="7"]').click(),
  );
  await page.waitForFunction(
    () =>
      window.__managerCandidate.state.period === 7 &&
      !window.__managerCandidate.state.busy,
  );
  await page.evaluate(() => window.__managerCandidate.go("settings"));
  const nextPort = await freePort();
  await page.evaluate((port) => {
    const input = document.querySelector("#network-port");
    input.value = port;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, String(nextPort));
  await page.evaluate(() => document.querySelector("#save").click());
  await page.waitForFunction(
    () =>
      window.__managerCandidate.state.status.state === "READY" &&
      !window.__managerCandidate.state.status.hostBusy &&
      !window.__managerCandidate.state.busy,
  );
  assert.equal(JSON.parse(fs.readFileSync(file)).port, nextPort);
  config.port = nextPort;
  await page.evaluate(() => window.__managerCandidate.go("update"));
  await page.evaluate(() => document.querySelector("#stop").click());
  await page.waitForFunction(
    () =>
      window.__managerCandidate.state.status.state === "STOPPED" &&
      !window.__managerCandidate.state.busy,
  );
  await page.evaluate(() => document.querySelector("#start").click());
  await page.waitForFunction(
    () =>
      window.__managerCandidate.state.status.state === "READY" &&
      !window.__managerCandidate.state.status.hostBusy &&
      !window.__managerCandidate.state.busy,
  );
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => {
      localStorage.setItem("gallery_theme", t);
      window.__managerCandidate.theme(t);
    }, theme);
    for (const name of ["update", "access", "diagnose", "settings"]) {
      await page.evaluate(async (p) => {
        await window.__managerCandidate.go(p);
      }, name);
      await page.waitForFunction(
        () =>
          document.querySelector("#page")?.getAttribute("aria-busy") !== "true",
      );
      if (name === "diagnose")
        await page.waitForFunction(
          () => !window.__managerCandidate.state.environmentLoading,
        );
      await page.waitForTimeout(250);
      if (name === "update") {
        const observed = await page.evaluate(async () => {
          const compact = (s) => ({
            state: s?.state,
            running: s?.running,
            failure: s?.failure,
            works: s?.counts?.worksCommitted,
            generationId: s?.generationId,
          });
          return {
            ui: compact(window.__managerCandidate.state.scan),
            raw: compact(await window.galleryHost.admin("scan.status")),
            host: compact((await window.galleryHost.status()).scan),
          };
        });
        if (observed.ui.running) {
          fs.writeFileSync(
            path.join(out, "native-status-failure.json"),
            JSON.stringify(observed, null, 2),
          );
          throw Error(JSON.stringify(observed));
        }
      }
      const state = await page.evaluate(() =>
        Object.values(window.__managerCandidate.state.errors).filter(Boolean),
      );
      assert.deepEqual(state, []);
      const filename = `manager-${name}-${theme}.png`;
      const png = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
          .toPNG()
          .toString("base64"),
      );
      fs.writeFileSync(
        path.join(screenshotRoot, filename),
        Buffer.from(png, "base64"),
      );
      screenshots.push(filename);
    }
  }
  // Window close is Hide; it must not cancel the manager-owned service.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    ),
    false,
  );
  assert.equal(
    (await page.evaluate(() => window.galleryHost.status())).state,
    "READY",
  );
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(960, 640);
    w.showInactive();
    w.webContents.setZoomFactor(1.25);
  });
  await page.evaluate(() => window.__managerCandidate.go("settings"));
  const small = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
      .toPNG()
      .toString("base64"),
  );
  fs.writeFileSync(
    path.join(screenshotRoot, "manager-settings-narrow-large-text.png"),
    Buffer.from(small, "base64"),
  );
  screenshots.push("manager-settings-narrow-large-text.png");
  browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  const url = `http://127.0.0.1:${config.port}`;
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === url
      ? route.continue()
      : route.abort(),
  );
  await context.addInitScript(() =>
    localStorage.setItem("gallery_theme", "dark"),
  );
  const web = await context.newPage();
  web.on("pageerror", (e) => failures.push(e.message));
  await web.goto(url + "/#/@all/pixiv");
  await web.waitForFunction(
    () => window.__galleryCanvas?.state.status === "populated",
  );
  for (const theme of ["dark", "light"]) {
    await web.evaluate((t) => window.__galleryCanvas.setTheme(t), theme);
    await web.waitForFunction(
      () => window.__galleryCanvas.state.themeFade.x === 1,
    );
    await web.screenshot({
      path: path.join(screenshotRoot, `gallery-${theme}.png`),
    });
    screenshots.push(`gallery-${theme}.png`);
  }
  await browser.close();
  browser = null;
  assert.deepEqual(failures, []);
  await app.close();
  app = null;
  assert(!fs.existsSync(path.join(fixture.instanceRoot, "state/runtime.lock")));
  const invalidRoot = fs.mkdtempSync(
    path.join(process.env.GALLERY_TEST_ROOT, "InvalidPointer-"),
  );
  const invalidFile = path.join(invalidRoot, "config.json");
  const { normalizeRuntimeConfig, ensureLayout } = require(
    path.join(reference, "src/instance/config.js"),
  );
  const invalidRaw = {
    instanceRoot: invalidRoot,
    sources: config.sources,
    port: await freePort(),
    liveUpdates: false,
  };
  const invalid = normalizeRuntimeConfig(invalidRaw);
  ensureLayout(invalid);
  fs.writeFileSync(invalidFile, JSON.stringify(invalidRaw));
  fs.writeFileSync(
    invalid.activeGenerationPath,
    JSON.stringify({
      pointerVersion: 999,
      generationId: "missing",
      manifestPath: "generations/missing/manifest.json",
    }),
  );
  app = await _electron.launch({
    args: [loader, "--config", invalidFile],
    env,
  });
  const errorPage = await app.firstWindow();
  await errorPage.waitForFunction(
    () => window.__managerCandidate?.state.status.hostFailure,
  );
  assert(await errorPage.locator("#start").isEnabled());
  for (const theme of ["dark", "light"]) {
    await errorPage.evaluate((t) => window.__managerCandidate.theme(t), theme);
    const png = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString("base64"),
    );
    const filename = `manager-invalid-pointer-${theme}.png`;
    fs.writeFileSync(
      path.join(screenshotRoot, filename),
      Buffer.from(png, "base64"),
    );
    screenshots.push(filename);
  }
  await app.close();
  app = null;
  fs.writeFileSync(
    path.join(out, "manager-browser.json"),
    JSON.stringify(
      {
        conclusion: "一致",
        screenshots,
        pageErrors: failures,
        operations: [
          "scan",
          "blocking-immediate",
          "access-period",
          "save-port-restart",
          "stop",
          "start",
          "hide",
          "quit",
        ],
        windowHideRetainedService: true,
        nonActivatingHarness: true,
        manualInput: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ conclusion: "一致", screenshots }));
} finally {
  await browser?.close();
  await app?.close();
}
