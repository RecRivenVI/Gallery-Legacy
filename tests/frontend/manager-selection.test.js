"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { PLATFORM_REGISTRY } = require("../../internal/library/platforms.js");

test("Manager uses the selected platform set for normal updates and gates advanced scans", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const root = path.resolve(__dirname, "../..");
    const ids = PLATFORM_REGISTRY.map((platform) => platform.id);
    await page.route("http://manager-selection.test/**", (route) => {
      const relative = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, "");
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ body: fs.readFileSync(file), contentType: ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html" })[path.extname(file)] || "application/octet-stream" });
    });
    await page.addInitScript(({ ids, selected }) => {
      localStorage.setItem("gallery_manager_selected_platforms", JSON.stringify(selected));
      window.testCalls = [];
      window.testStatus = { state: "READY", deployment: "staging", libraryReady: true, counts: { works: 5, media: 8 }, loadedGenerationId: "synthetic-baseline", activeGenerationId: "synthetic-baseline", scan: { running: false, state: "IDLE" } };
      window.galleryHost = {
        status: async () => structuredClone(window.testStatus),
        openGallery: async () => {},
        admin: async (operation, input = {}) => {
          window.testCalls.push({ operation, input });
          if (operation === "config.read") return { revision: "synthetic", platforms: ids, value: { instanceRoot: "C:/synthetic/instance", port: 19000, sources: Object.fromEntries(ids.map((id) => [id, `C:/synthetic/${id}`])), fileBrowserRoots: [] } };
          if (operation === "reports.list") return { items: [] };
          if (operation === "scan.status") return structuredClone(window.testStatus.scan);
          if (operation === "scan.start") {
            window.testStatus.scan = { running: true, state: "SCANNING", activePlatforms: input.platformIds, observedWorks: 12, indexedWorks: 10, actualMedia: 20 };
            return { started: true };
          }
          if (operation === "scan.cancel") return { requested: true };
          return {};
        },
      };
    }, { ids, selected: [ids[0], "removed-platform"] });
    await page.goto("http://manager-selection.test/frontend/manager/index.html");
    await page.waitForSelector("#scan");
    await page.locator("#scan").click();
    await page.waitForSelector("#scan-platform-picker");
    assert.equal(await page.locator("input[data-platform-id]:checked").count(), 1);
    assert.equal(await page.locator("input[data-platform-id]:checked").first().getAttribute("data-platform-id"), ids[0]);
    assert.equal(await page.locator("#scan-advanced").getAttribute("open"), null);
    await page.locator("#scan-start").click();
    await page.waitForFunction(() => window.testCalls.some((call) => call.operation === "scan.start"));
    const normalCall = await page.evaluate(() => window.testCalls.find((call) => call.operation === "scan.start"));
    assert.deepEqual(normalCall.input, { platformIds: [ids[0]], mode: "incremental", confirmReadOnly: true });
    assert.equal(await page.locator("#scan-confirmation").count(), 0);
    await page.evaluate(() => { window.testStatus.scan = { running: false, state: "IDLE" }; });
    await page.waitForFunction(() => !document.querySelector("#scan-advanced-start")?.disabled);

    await page.locator("#scan-platform-clear").click();
    assert.equal(await page.locator("#scan-start").isDisabled(), true);
    await page.locator("#scan-platform-all").click();
    assert.equal(await page.locator("input[data-platform-id]:checked").count(), ids.length);
    await page.locator("#scan-advanced").click();
    await page.locator("#scan-mode").selectOption("full");
    await page.locator("#scan-scope").selectOption("author");
    await page.locator("#scan-advanced-platform").selectOption(ids[0]);
    await page.locator("#scan-advanced-author").fill("synthetic-author");
    await page.evaluate((platformId) => { window.testStatus.scan = { running: true, state: "SCANNING", observedWorks: 4567, activePlatforms: [platformId] }; }, ids[0]);
    await page.waitForFunction(() => document.querySelector(".scan-status-card")?.textContent.includes("4,567"));
    assert.equal(await page.locator("#scan-advanced-author").inputValue(), "synthetic-author");
    await page.evaluate(() => { window.testStatus.scan = { running: false, state: "IDLE" }; });
    await page.waitForFunction(() => !document.querySelector("#scan-advanced-start")?.disabled);
    await page.locator("#scan-advanced-start").click();
    await page.waitForSelector("#scan-confirmation");
    assert.equal(await page.evaluate(() => window.testCalls.filter((call) => call.operation === "scan.start").length), 1);
    await page.locator("#scan-confirm-readonly").check();
    await page.locator("#scan-confirm-start").click();
    await page.waitForFunction(() => window.testCalls.filter((call) => call.operation === "scan.start").length === 2);
    const advancedCall = await page.evaluate(() => window.testCalls.filter((call) => call.operation === "scan.start").at(-1));
    assert.equal(advancedCall.input.mode, "full");
    assert.deepEqual(advancedCall.input.platformIds, [ids[0]]);
    assert.equal(Object.hasOwn(advancedCall.input, "platformId"), false);
    assert.equal(advancedCall.input.authorDirectoryName, "synthetic-author");

    await page.locator('[data-tab="overview"]').click();
    await page.evaluate(() => {
      window.testStatus.libraryReady = false;
      window.testStatus.loadedGenerationId = null;
      window.testStatus.activeGenerationId = null;
    });
    await page.locator('[data-tab="scan"]').click();
    await page.waitForSelector("#scan-platform-picker");
    assert.match(await page.locator("#manager-panel").textContent(), /首次建库需全选九个平台/);
  } finally {
    await browser.close();
  }
});
