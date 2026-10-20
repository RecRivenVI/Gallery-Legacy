"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
test("Manager patches values without replacing focused controls or scroll regions", async (t) => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--mute-audio"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  await page.setContent('<main id="page"></main>');
  const source = fs.readFileSync("public/manager/render.js", "utf8");
  const value = await page.evaluate(async (source) => {
    const { patchHTML } = await import(
        "data:text/javascript;base64," + btoa(source)
      ),
      root = document.querySelector("main");
    const html = (count) =>
      '<nav><button data-page="update">更新</button><button data-page="access">访问</button></nav><label><input id="blocking" type="checkbox" checked>封禁</label><div id="status">' +
      count +
      '</div><div id="log-lines"></div>';
    patchHTML(root, html(0));
    const control = document.querySelector("#blocking"),
      nav = document.querySelector("[data-page=access]");
    control.focus();
    document.querySelector("#log-lines").textContent = "retained logs";
    for (let i = 1; i <= 10; i++)
      patchHTML(root, html(i), { preserveChildren: ["log-lines"] });
    const stable =
      control === document.querySelector("#blocking") &&
      control === document.activeElement &&
      nav === document.querySelector("[data-page=access]");
    patchHTML(root, html(11).replace(" checked", ""));
    return {
      stable,
      count: document.querySelector("#status").textContent,
      checked: control.checked,
    };
  }, source);
  assert.deepEqual(value, { stable: true, count: "11", checked: false });
});
test("Manager poll has one in-flight request and recovers after errors", async () => {
  const { serialPoll } = await import(
    pathToFileURL(path.resolve("public/manager/render.js"))
  );
  let calls = 0,
    finish;
  const poll = serialPoll(() => {
    calls++;
    return new Promise((r) => (finish = r));
  });
  const first = poll();
  assert.equal(await poll(), false);
  assert.equal(calls, 1);
  finish();
  assert.equal(await first, true);
  const next = poll();
  assert.equal(calls, 2);
  finish();
  await next;
  let failed = true;
  const retry = serialPoll(async () => {
    if (failed) {
      failed = false;
      throw Error("offline");
    }
  });
  await assert.rejects(retry());
  assert.equal(await retry(), true);
});
