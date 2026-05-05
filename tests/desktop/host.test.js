"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { _electron: electron } = require("playwright");
const { fixture } = require("../support/runtime.js");
test("Electron hosts Manager, owns only its Runtime child, and clears ownership on quit", async (t) => {
  const f = await fixture(t);
  f.build();
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
  f.cleanup.push(async () => {
    if (!closed) await host.close();
  });
  const page = await host.firstWindow();
  await page.waitForSelector("#scan");
  let visible=false;for(let i=0;i<20&&!visible;i++){visible=await host.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible()));if(!visible)await new Promise(r=>setTimeout(r,100));}
  assert.equal(visible,true);
  assert.equal(new URL(page.url()).pathname, "/manage");
  assert.equal(
    await page.evaluate(() => typeof window.galleryHost.restart),
    "function",
  );
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  const state = JSON.parse(fs.readFileSync(f.config.statusPath));
  assert.equal(state.state, "READY");
  assert.equal(state.managerPid, await host.evaluate(() => process.pid));
  await host.close();
  closed = true;
  for (
    let i = 0;
    i < 40 &&
    JSON.parse(fs.readFileSync(f.config.statusPath)).state !== "STOPPED";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  const stopped = JSON.parse(fs.readFileSync(f.config.statusPath));
  assert.equal(stopped.state, "STOPPED");
  assert.equal(stopped.managerPid, null);
  assert.equal(
    fs.existsSync(path.join(f.config.stateRoot, "runtime.lock")),
    false,
  );
});
