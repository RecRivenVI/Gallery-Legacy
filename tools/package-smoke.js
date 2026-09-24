"use strict";
// Explicit portable artifact validation, with temporary public fixture data only.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { _electron: electron } = require("playwright");
const { fixture } = require("../tests/support/runtime.js");
const { execFileSync } = require("node:child_process");
async function main() {
  const args = process.argv.slice(2), at = args.indexOf("--package"), reportAt = args.indexOf("--report");
  if (at < 0) throw new Error("Explicit --package required");
  const directory = path.resolve(args[at + 1]), executable = path.join(directory, "Gallery.exe");
  const cli = path.join(directory, "resources/runtime/cmd/gallery/main.js"), node = path.join(directory, "resources/node/node.exe");
  assert.ok(fs.existsSync(executable) && fs.existsSync(node));
  const help = execFileSync(node, [cli, "--help"], { encoding: "utf8", windowsHide: true });
  assert.match(help, /serve/);
  const cleanup = [], f = await fixture({ after: (fn) => cleanup.push(fn) });
  let host;
  const config = path.join(f.config.instanceRoot, "config.json");
  const stop = () => { try { execFileSync(node, [cli, "stop", "--config", config], { windowsHide: true, stdio: "ignore", timeout: 40000 }); } catch {} };
  try {
    await f.build(); f.publish();
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.GALLERY_NODE;
    host = await electron.launch({ executablePath: executable, args: ["--config", config], env, timeout: 60000 });
    const page = await host.firstWindow();
    await page.waitForFunction(() => document.querySelector("#stop") && !document.querySelector("#stop").disabled, null, { timeout: 60000 });
    assert.equal(await host.evaluate(({ app }) => app.isPackaged), true);
    assert.equal(await page.locator('.manager-nav [data-tab]').count(), 9);
    await page.locator('[data-tab="validation"]').click();await page.waitForSelector('#validation-start');assert.equal(await page.locator('[data-check]').count(),12);
    await page.locator('[data-tab="config"]').click();await page.waitForSelector('#config-save');
    await page.locator('[data-tab="generations"]').click();await page.waitForSelector('#retention-plan');
    await page.locator('[data-tab="overview"]').click();
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    assert.equal((await fetch(f.config.url + "/api/v1/health")).status, 200);
    const hidden = await host.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.close(); return !w.isDestroyed() && !w.isVisible(); });
    assert.ok(hidden);
    await host.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    const exited = new Promise((resolve) => host.process().once("exit", resolve));
    await host.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); }); await exited;
    assert.equal((await fetch(f.config.url + "/api/v1/health")).status, 200);
    stop(); await host.close(); host = null;
    const result = { state: "PASS", atMs: Date.now(), packaged: true, bundledNode: true, runtime: true, manager: true, tray: true, runtimeSurvivesManagerExit: true, screenshots: 0, realSourcesAccessed: false };
    if (reportAt >= 0) fs.writeFileSync(path.resolve(args[reportAt + 1]), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    stop(); if (host) await host.close(); for (const close of cleanup.reverse()) await close();
  }
}
main().catch((error) => { console.error(error.code || error.message); process.exitCode = 1; });
