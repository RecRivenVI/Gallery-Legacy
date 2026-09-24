"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { _electron: electron } = require("playwright");
const { fixture } = require("../support/runtime.js");
const { stopRuntime } = require("../../internal/runtime/control.js");
test("Electron tray, reconnect and quit leave the independent Runtime usable", async (t) => {
  const f = await fixture(t);
  await f.build();
  f.publish();
  const env = { ...process.env, GALLERY_NODE: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  const host = await electron.launch({
    args: [
      path.resolve(__dirname, "../../desktop/main.js"),
      "--config",
      path.join(f.config.instanceRoot, "config.json"),
    ],
    env,
    timeout: 60000,
  });
  let closed = false;
  f.cleanup.push(() => stopRuntime(f.config));
  f.cleanup.push(async () => {
    if (!closed) await host.close();
  });
  const page = await host.firstWindow();
  await page.waitForSelector("#scan");
  let visible=false;for(let i=0;i<20&&!visible;i++){visible=await host.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible()));if(!visible)await new Promise(r=>setTimeout(r,100));}
  assert.equal(visible,true);
  assert.ok(page.url().endsWith("/frontend/manager/index.html"));
  assert.equal(
    await page.evaluate(() => typeof window.galleryHost.restart),
    "function",
  );
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  await page.waitForFunction(() => !document.querySelector("#stop").disabled, { timeout: 60000 });
  for (let i = 0; i < 40 && !JSON.parse(fs.readFileSync(f.config.statusPath)).managerPid; i++) await new Promise((r) => setTimeout(r, 250));
  const state = JSON.parse(fs.readFileSync(f.config.statusPath));
  assert.equal(state.state, "READY");
  assert.equal(state.managerPid, await host.evaluate(() => process.pid));
  const hidden = await host.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.close();
    return !window.isDestroyed() && !window.isVisible();
  });
  assert.equal(hidden, true);
  assert.equal((await fetch(f.config.url + "/api/v1/health")).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(f.config.statusPath)).pid, state.pid);
  await host.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  // Assert actual Manager process exit first. Playwright's close additionally
  // waits for inherited Windows process handles; the detached Runtime remains
  // deliberately alive until this test explicitly stops it below.
  const exited = new Promise((resolve) => host.process().once("exit", resolve));
  await host.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  await exited;
  for (
    let i = 0;
    i < 40 &&
    JSON.parse(fs.readFileSync(f.config.statusPath)).managerPid !== null;
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  const stopped = JSON.parse(fs.readFileSync(f.config.statusPath));
  assert.equal(stopped.state, "READY");
  assert.equal(stopped.managerPid, null);
  assert.equal(
    fs.existsSync(path.join(f.config.stateRoot, "runtime.lock")),
    true,
  );
  assert.equal((await fetch(f.config.url + "/api/v1/health")).status, 200);
  const reconnected = await electron.launch({ args: [path.resolve(__dirname, "../../desktop/main.js"), "--config", path.join(f.config.instanceRoot, "config.json")], env, timeout: 60000 });
  const nextPage = await reconnected.firstWindow();
  await nextPage.waitForFunction(() => document.querySelector("#stop") && !document.querySelector("#stop").disabled);
  assert.equal(JSON.parse(fs.readFileSync(f.config.statusPath)).pid, state.pid);
  await nextPage.locator("#restart").click();
  await nextPage.waitForFunction(() => document.querySelector("#stop") && !document.querySelector("#stop").disabled);
  assert.notEqual(JSON.parse(fs.readFileSync(f.config.statusPath)).pid, state.pid);
  const nextExit = new Promise((resolve) => reconnected.process().once("exit", resolve));
  await reconnected.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  await nextExit;
  await stopRuntime(f.config);
  await reconnected.close();
  await host.close();
  closed = true;
});

test("Manager keeps an invalid active pointer failure visible with diagnostics and retry controls", async (t) => {
  const f = await fixture(t, { empty: true });
  fs.writeFileSync(f.config.activeGenerationPath, JSON.stringify({ pointerVersion: 999, generationId: "missing", manifestPath: "generations/missing/manifest.json" }));
  const env = { ...process.env, GALLERY_NODE: process.execPath }; delete env.ELECTRON_RUN_AS_NODE;
  const host = await electron.launch({ args: [path.resolve(__dirname, "../../desktop/main.js"), "--config", path.join(f.config.instanceRoot, "config.json")], env, timeout: 60000 });
  f.cleanup.push(() => host.close());
  const page = await host.firstWindow();
  await page.waitForFunction(() => document.body.textContent.includes("ACTIVE_POINTER_VERSION_UNSUPPORTED"));
  assert.equal(await page.locator("#start").isEnabled(), true);
  assert.equal(await host.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
});
