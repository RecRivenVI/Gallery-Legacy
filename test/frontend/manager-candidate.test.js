"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { pathToFileURL } = require("node:url");
const { fixture, freePort } = require("../support/runtime.js");
const { createManagerTestHost } = require("../../tools/manager/server.cjs");
const { createRuntimeBootstrap } = require("../../src/runtime/bootstrap.js");
const { chromium } = require("playwright");
test("candidate Manager uses four pages and exactly three confirmations", async () => {
  const m = await import(
    pathToFileURL(path.resolve("public/manager/model.js"))
  );
  assert.equal(m.pages.length, 4);
  assert.equal(m.updateLabel([]), "先选择平台");
  assert.equal(m.updateLabel(m.platformNames), "更新全部平台");
  assert.equal(m.updateLabel(["pixiv"]), "更新所选的 1 个平台");
  assert.equal(m.changes({ a: 1, b: 2 }, { a: 1, b: 3 }), 1);
  assert.equal(
    m.scanProgress({
      scope: { platformIds: ["Fantia"] },
      currentPlatform: "Fantia",
    }).selected.length,
    1,
  );
  assert.equal(
    m.networkDraft({ mode: "lan", publicUrl: "http://192.168.42.2:18221" })
      .listenAddress,
    "192.168.42.2",
  );
  assert.throws(
    () => m.networkDraft({ mode: "lan", publicUrl: "http://127.0.0.1:18221" }),
    { code: "LAN_URL_REQUIRED" },
  );
  assert.equal(m.networkDraft({ mode: "public" }).listenAddress, "0.0.0.0");
  assert.equal(m.networkDraft({}).listenAddress, "127.0.0.1");
  const text = fs.readFileSync("public/manager/main.js", "utf8");
  assert.ok(
    !/generation\.rollback|live\.reset|retention\.apply|generation\.publish/.test(
      text,
    ),
  );
  assert.equal((text.match(/confirm\(/g) || []).length, 4); // Declaration + three approved calls.
});
test("candidate Manager browser opens every page and scans, saves, cancels, filters and manages service", async (t) => {
  const f = await fixture(t);
  await f.build();
  f.publish();
  const file = path.join(f.config.instanceRoot, "config.json"),
    raw = JSON.parse(fs.readFileSync(file));
  raw.deployment = "staging";
  fs.writeFileSync(file, JSON.stringify(raw));
  const runtime = createRuntimeBootstrap({
    config: { ...f.config, deployment: "staging" },
  });
  f.cleanup.push(() => runtime.close());
  await runtime.start();
  const host = await createManagerTestHost(file, {
    port: await freePort(),
    ui: "manager/candidate",
  });
  f.cleanup.push(() => host.close());
  f.cleanup.push(() =>
    require("../../src/runtime/control.js").stopRuntime(
      require("../../src/instance/config.js").readRuntimeConfig(file),
    ),
  );
  const browser = await chromium.launch({
    headless: true,
    args: ["--mute-audio"],
  });
  f.cleanup.push(() => browser.close());
  const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(host.url);
  await page.waitForFunction(() => window.__managerCandidate);
  await page.locator("#select-none").click();
  assert.equal(await page.locator("#update-start").isDisabled(), true);
  await page.locator('input[data-platform="pixiv"]').check();
  await page.locator("#full-start").click();
  assert.equal(await page.locator("#confirmation").isVisible(), true);
  assert.equal(
    await page.locator("#confirmation button:focus").innerText(),
    "取消",
  );
  await page.keyboard.press("Escape");
  await page.locator("#update-start").click();
  await page.waitForFunction(
    () =>
      __managerCandidate.state.scan.state === "READY" &&
      !__managerCandidate.state.scan.running,
    null,
    { timeout: 60000 },
  );
  await page.locator("[data-page=access]").click();
  await page.waitForSelector("#blocking");
  // Focus pauses the polling render; exercise the switch's native keyboard interaction.
  await page.locator("#blocking").focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(
    () =>
      __managerCandidate.state.access.enabled === false &&
      !__managerCandidate.state.busy,
  );
  assert.equal(await page.locator("#blocking").isChecked(), false);
  await page.locator('[data-period="7"]').click();
  await page.waitForFunction(() => __managerCandidate.state.period === 7);
  await page.locator("[data-page=settings]").click();
  await page.locator("#public-url").fill("http://127.0.0.1:" + raw.port);
  await page.locator("#public-url").dispatchEvent("change");
  assert.equal(await page.locator("#save-bar").isVisible(), true);
  await page.locator("[data-page=diagnose]").click();
  await page.waitForSelector("#confirmation[open]");
  await page.getByRole("button", { name: "放弃改动", exact: true }).click();
  await page.waitForSelector("#validation-start");
  await page.locator("#validation-start").click();
  await page.waitForFunction(
    () =>
      ["COMPLETED", "FAILED", "CANCELLED"].includes(
        __managerCandidate.state.validation.state,
      ) || __managerCandidate.state.errors.validation,
    null,
    { timeout: 120000 },
  );
  assert.equal(
    await page.evaluate(() => __managerCandidate.state.validation.state),
    "COMPLETED",
    JSON.stringify(
      await page.evaluate(() => ({
        validation: __managerCandidate.state.validation,
        errors: __managerCandidate.state.errors,
      })),
    ),
  );
  await page.locator("#validation-view").click();
  await page.waitForSelector("#finding-type");
  await page.locator("#finding-type").selectOption("metadata.missing");
  await page.locator("#environment-check").click();
  await page.waitForFunction(() => !!__managerCandidate.state.environment);
  await page.locator("[data-page=settings]").click();
  await page.locator("#network-port").fill("0");
  await page.locator("#save").click();
  await page.waitForFunction(
    () => !!__managerCandidate.state.fieldErrors?.["network-port"],
  );
  assert.match(await page.locator(".network").innerText(), /1–65535/);
  await page.locator("#network-port").fill(String(raw.port));
  await page.locator("#public-url").fill("http://127.0.0.1:" + raw.port);
  await page.locator("#public-url").dispatchEvent("change");
  await page.locator("#save").click();
  await page.waitForFunction(() => !__managerCandidate.state.busy);
  assert.equal(
    await page.evaluate(() => __managerCandidate.state.errors.settings),
    "",
  );
  const stored = JSON.parse(fs.readFileSync(file));
  assert.equal(stored.publicUrl, "http://127.0.0.1:" + raw.port);
  assert.deepEqual(errors, []);
});
