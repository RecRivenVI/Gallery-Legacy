"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const env = { ...process.env, GALLERY_NODE: process.execPath };
const localFile = path.resolve(__dirname, "../build/paths.local.json");
const local = fs.existsSync(localFile)
  ? JSON.parse(fs.readFileSync(localFile))
  : {};
if (!env.GALLERY_ICON_PATH && local.output)
  env.GALLERY_ICON_PATH = path.join(local.output, "resources/app-icon.png");
if (!env.GALLERY_RUNTIME && local.output)
  env.GALLERY_RUNTIME = path.join(local.output, "bin/gallery-runtime.exe");
if (!env.GALLERY_ASSETS_ROOT && local.resources)
  env.GALLERY_ASSETS_ROOT = local.resources;
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  require("electron"),
  [
    path.resolve(__dirname, "../../src/desktop/main.js"),
    ...process.argv.slice(2),
  ],
  // The requested GUI must be visible; only its Node helper is hidden.
  { stdio: "inherit", windowsHide: false, env },
);
child.on("error", () => {
  process.stderr.write("DESKTOP_LAUNCH_FAILED\n");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code || 0;
});
