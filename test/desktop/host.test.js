"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { _electron: electron } = require("playwright");
const { fixture } = require("../support/runtime.js");
const { stopRuntime } = require("../../src/runtime/control.js");
test("Electron tray, reconnect and quit leave the independent Runtime usable", async (t) => {
  const f = await fixture(t);
  await f.build();
  f.publish();
  const icon = path.join(f.config.instanceRoot, "test-icon.png");
  fs.writeFileSync(icon, require("../../tools/demo/image.cjs").image(1));
  const env = {
    ...process.env,
    GALLERY_NODE: process.execPath,
    GALLERY_ICON_PATH: icon,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const host = await electron.launch({
    args: [
      path.resolve(__dirname, "../../src/desktop/main.js"),
      "--config",
      path.join(f.config.instanceRoot, "config.json"),
    ],
    env,
    timeout: 60000,
  });
  let closed = false;
  f.cleanup.push(async () => {
    await stopRuntime(f.config);
    if (!closed) await host.close();
  });
  const page = await host.firstWindow();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await host.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.setAudioMuted(true),
    ),
  );
  await page.waitForSelector("#update-start");
  let visible = false;
  for (let i = 0; i < 20 && !visible; i++) {
    visible = await host.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((w) => w.isVisible()),
    );
    if (!visible) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(visible, true);
  assert.ok(page.url().endsWith("/public/manager/index.html"));
  assert.equal(
    await page.evaluate(() => typeof window.galleryHost.restart),
    "function",
  );
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  await page.waitForFunction(
    () =>
      document.querySelector("#stop") &&
      !document.querySelector("#stop").disabled &&
      !window.__managerCandidate.state.status.hostBusy,
    null,
    { polling: 100, timeout: 60000 },
  );
  for (
    let i = 0;
    i < 40 && !JSON.parse(fs.readFileSync(f.config.statusPath)).managerPid;
    i++
  )
    await new Promise((r) => setTimeout(r, 250));
  const state = JSON.parse(fs.readFileSync(f.config.statusPath));
  assert.equal(state.state, "READY");
  assert.equal(state.managerPid, await host.evaluate(() => process.pid));
  for (const name of ["access", "settings", "diagnose", "update"]) {
    await page.evaluate(async (name) => {
      await window.__managerCandidate.go(name);
      await window.__managerCandidate.poll();
    }, name);
    assert.deepEqual(
      await page.evaluate(() =>
        Object.values(window.__managerCandidate.state.errors).filter(Boolean),
      ),
      [],
    );
  }
  const hidden = await host.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.close();
    return !window.isDestroyed() && !window.isVisible();
  });
  assert.equal(hidden, true);
  assert.equal((await fetch(f.config.url + "/api/v1/health")).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(f.config.statusPath)).pid, state.pid);
  await host.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].show(),
  );
  // Assert actual Manager process exit first. Playwright's close additionally
  // waits for inherited Windows process handles; the detached Runtime remains
  // deliberately alive until this test explicitly stops it below.
  const exited = new Promise((resolve) => host.process().once("exit", resolve));
  await host.evaluate(({ app }) => {
    setTimeout(() => app.quit(), 0);
  });
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
  const reconnected = await electron.launch({
    args: [
      path.resolve(__dirname, "../../src/desktop/main.js"),
      "--config",
      path.join(f.config.instanceRoot, "config.json"),
    ],
    env,
    timeout: 60000,
  });
  const nextPage = await reconnected.firstWindow();
  await nextPage.setViewportSize({ width: 1920, height: 1080 });
  await reconnected.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.setAudioMuted(true),
    ),
  );
  await nextPage.waitForFunction(
    () =>
      document.querySelector("#stop") &&
      !document.querySelector("#stop").disabled &&
      !window.__managerCandidate.state.status.hostBusy,
    null,
    { polling: 100 },
  );
  assert.equal(JSON.parse(fs.readFileSync(f.config.statusPath)).pid, state.pid);
  await nextPage.locator("#restart").click();
  await nextPage.waitForFunction(
    () =>
      document.querySelector("#stop") &&
      !document.querySelector("#stop").disabled &&
      !window.__managerCandidate.state.status.hostBusy,
    null,
    { polling: 100 },
  );
  assert.notEqual(
    JSON.parse(fs.readFileSync(f.config.statusPath)).pid,
    state.pid,
  );
  const nextExit = new Promise((resolve) =>
    reconnected.process().once("exit", resolve),
  );
  await reconnected.evaluate(({ app }) => {
    setTimeout(() => app.quit(), 0);
  });
  await nextExit;
  await stopRuntime(f.config);
  await reconnected.close();
  await host.close();
  closed = true;
});

test("Manager keeps an invalid active pointer failure visible with diagnostics and retry controls", async (t) => {
  const f = await fixture(t, { empty: true });
  fs.writeFileSync(
    f.config.activeGenerationPath,
    JSON.stringify({
      pointerVersion: 999,
      generationId: "missing",
      manifestPath: "generations/missing/manifest.json",
    }),
  );
  const icon = path.join(f.config.instanceRoot, "test-icon.png");
  fs.writeFileSync(icon, require("../../tools/demo/image.cjs").image(1));
  const env = {
    ...process.env,
    GALLERY_NODE: process.execPath,
    GALLERY_ICON_PATH: icon,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const host = await electron.launch({
    args: [
      path.resolve(__dirname, "../../src/desktop/main.js"),
      "--config",
      path.join(f.config.instanceRoot, "config.json"),
    ],
    env,
    timeout: 60000,
  });
  f.cleanup.push(() => host.close());
  const page = await host.firstWindow();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await host.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.setAudioMuted(true),
    ),
  );
  await page.waitForFunction(
    () =>
      document.querySelector("#start") &&
      document.body.textContent.includes("读取服务状态失败"),
  );
  assert.equal(await page.locator("#start").isEnabled(), true);
  assert.equal(
    await host.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    ),
    true,
  );
});

test("native Manager scans, filters access, saves/restarts and reads diagnostics over authenticated IPC", async (t) => {
  const { freePort } = require("../support/runtime.js");
  const { readRuntimeConfig } = require("../../src/instance/config.js");
  const f = await fixture(t),
    file = path.join(f.config.instanceRoot, "config.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), liveUpdates: true }),
  );
  const icon = path.join(f.config.instanceRoot, "test-icon.png");
  fs.writeFileSync(icon, require("../../tools/demo/image.cjs").image(2));
  const env = {
    ...process.env,
    GALLERY_NODE: process.execPath,
    GALLERY_ICON_PATH: icon,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const host = await electron.launch({
    args: [
      path.resolve("src/desktop/main.js"),
      "--config",
      file,
      "--mute-audio",
    ],
    env,
  });
  f.cleanup.push(async () => {
    await stopRuntime(readRuntimeConfig(file));
    await host.close();
  });
  const page = await host.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  const ready = () =>
    page.waitForFunction(
      () =>
        window.__managerCandidate?.state.status.state === "READY" &&
        !__managerCandidate.state.status.hostBusy &&
        !__managerCandidate.state.busy,
      null,
      { polling: 100 },
    );
  await ready();
  await page.locator("#update-start").click();
  await page.waitForFunction(
    () =>
      __managerCandidate.state.scan.state === "READY" &&
      !__managerCandidate.state.scan.running,
    null,
    { polling: 100, timeout: 60000 },
  );
  assert.equal(
    await page.evaluate(() => __managerCandidate.state.status.counts.works),
    6,
  );
  await page.locator("[data-page=access]").click();
  await page.waitForFunction(() => !!__managerCandidate.state.access);
  await page.locator("#blocking").click();
  await page.waitForFunction(
    () =>
      __managerCandidate.state.access.enabled === false &&
      !__managerCandidate.state.busy,
  );
  await page.locator('[data-period="7"]').click();
  await page.waitForFunction(
    () =>
      __managerCandidate.state.period === 7 && !__managerCandidate.state.busy,
  );
  await page.locator("[data-page=settings]").click();
  const nextPort = await freePort();
  await page.locator("#network-port").fill(String(nextPort));
  await page.locator("#network-port").dispatchEvent("change");
  await page.locator("#save").click();
  await ready();
  assert.equal(JSON.parse(fs.readFileSync(file)).port, nextPort);
  await page.locator("[data-page=diagnose]").click();
  await page.waitForFunction(
    () =>
      !!__managerCandidate.state.environment &&
      !__managerCandidate.state.environmentLoading,
    null,
    { polling: 100 },
  );
  assert.equal(await page.locator(".environment>div").count(), 11);
  for (let cycle = 0; cycle < 2; cycle++)
    for (const name of ["update", "access", "settings", "diagnose"]) {
      await page.evaluate(async (name) => {
        await __managerCandidate.go(name);
        await __managerCandidate.poll();
      }, name);
      assert.deepEqual(
        await page.evaluate(() =>
          Object.values(__managerCandidate.state.errors).filter(Boolean),
        ),
        [],
      );
    }
  await page.evaluate(() => __managerCandidate.go("update"));
  await page.locator("#stop").click();
  await page.waitForFunction(
    () =>
      __managerCandidate.state.status.state === "STOPPED" &&
      !__managerCandidate.state.busy,
    null,
    { polling: 100 },
  );
  await page.locator("#start").click();
  await ready();
});
