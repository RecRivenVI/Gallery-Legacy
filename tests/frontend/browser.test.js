"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { fixture } = require("../support/runtime.js");
const {
  createRuntimeBootstrap,
} = require("../../internal/runtime/bootstrap.js");
test("ES-module Gallery and browser Manager use the public protocol", async (t) => {
  const f = await fixture(t);
  f.build();
  f.publish();
  const runtime = createRuntimeBootstrap({ config: f.config });
  f.cleanup.push(() => runtime.close());
  await runtime.start();
  const browser = await chromium.launch({ headless: true });
  f.cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.config.url);
  await page.waitForTimeout(2000);
  assert.deepEqual(errors, []);
  assert.ok(
    (await page.locator("#content .card").count()) > 0,
    (await page.locator("body").innerText()).slice(-900),
  );
  await page.goto(f.config.url + "/manage");
  await page.waitForTimeout(1800);
  assert.deepEqual(errors, []);
  assert.match(await page.locator("body").innerText(), /真实图库 · 严格只读/);
  assert.match(await page.locator("body").innerText(), /first/);
  assert.equal(await page.locator("#scan").isDisabled(), true);
});
