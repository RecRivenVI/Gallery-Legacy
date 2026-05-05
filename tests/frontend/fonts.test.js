"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { fixture } = require("../support/runtime.js");
const { createRuntimeBootstrap } = require("../../internal/runtime/bootstrap.js");

const root = path.resolve(__dirname, "../..");
const fontExtension = /\.(?:woff2?|ttf|otf|ttc|eot)$/i;
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

test("public frontend has no bundled fonts, font loading rules or font whitelist", () => {
  for (const file of files(path.join(root, "frontend"))) {
    assert.equal(fontExtension.test(file), false, path.relative(root, file));
    const bytes = fs.readFileSync(file);
    assert.ok(
      !["wOFF", "wOF2", "OTTO", "ttcf"].includes(bytes.subarray(0, 4).toString("ascii")),
      path.relative(root, file),
    );
    if (/\.(?:css|html|js)$/.test(file)) {
      const text = bytes.toString("utf8");
      assert.doesNotMatch(text, /@font-face|assets\/fonts\/misans|data:(?:font\/|application\/(?:x-font|font))/i);
      assert.doesNotMatch(text, /url\([^)]*\.(?:woff2?|ttf|otf|eot)/i);
    }
  }
  const audit = fs.readFileSync(path.join(root, "tools/audit-tree.js"), "utf8");
  assert.doesNotMatch(audit, /fonts\\?\/misans/);
  const styles = fs.readFileSync(path.join(root, "frontend/styles/main.css"), "utf8");
  assert.doesNotMatch(styles, /base\/fonts\.css/);
  const semantic = fs.readFileSync(path.join(root, "frontend/styles/tokens/semantic.css"), "utf8");
  assert.match(semantic, /--font-ui:.*"MiSans".*"Noto Sans CJK SC".*"Microsoft YaHei".*system-ui.*sans-serif/);
});

test("Gallery and Manager render Chinese, English and digits with platform fonts and no font requests", async (t) => {
  const f = await fixture(t, { empty: true });
  f.work("2026-01-01_00-00-00_1", {
    id: "1",
    title: "中文 Gallery 123",
    user: { id: "100", name: "测试作者" },
    tags: ["测试"],
  });
  f.build();
  f.publish();
  const runtime = createRuntimeBootstrap({ config: f.config });
  f.cleanup.push(() => runtime.close());
  await runtime.start();
  const browser = await chromium.launch({ headless: true });
  f.cleanup.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], failedResources = [], fontRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.resourceType() === "font" || fontExtension.test(new URL(request.url()).pathname))
      fontRequests.push(request.resourceType());
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/frontend/") && response.status() >= 400)
      failedResources.push(response.status());
  });
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname.startsWith("/frontend/")) failedResources.push("network_failure");
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  for (const route of ["/#/@all/pixiv", "/manage"]) {
    await page.goto(f.config.url + route);
    if (route === "/manage") {
      await page.locator("#scan").waitFor({ state: "visible" });
      assert.equal(await page.locator("#scan").isDisabled(), true);
    } else {
      await page.locator('[data-d-title="中文 Gallery 123"]').waitFor({ state: "visible" });
    }
    await page.evaluate(async () => {
      const probe = document.createElement("div");
      probe.id = "font-probe";
      probe.style.cssText = "position:fixed;bottom:0;left:0;pointer-events:none;font-size:16px;z-index:999999";
      for (const [kind, text] of Object.entries({ chinese: "中文", english: "Gallery", digits: "1234567890" })) {
        const span = document.createElement("span");
        span.id = "font-probe-" + kind;
        span.textContent = text;
        span.style.display = "inline-block";
        probe.append(span);
      }
      document.body.append(probe);
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const document = await cdp.send("DOM.getDocument");
    for (const kind of ["chinese", "english", "digits"]) {
      const selector = "#font-probe-" + kind;
      const bounds = await page.locator(selector).boundingBox();
      assert.ok(bounds && bounds.width > 8 && bounds.height > 8, kind);
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: document.root.nodeId, selector });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      assert.ok(fonts.some((font) => font.glyphCount > 0), kind);
      assert.ok(fonts.every((font) => !font.isCustomFont && !/last.?resort/i.test(font.familyName)), kind);
    }
    assert.equal(await page.evaluate(() => document.fonts.status), "loaded");
    await page.locator("#font-probe").evaluate((node) => node.remove());
  }
  assert.deepEqual(fontRequests, []);
  assert.deepEqual(failedResources, []);
  assert.deepEqual(errors, []);
});
