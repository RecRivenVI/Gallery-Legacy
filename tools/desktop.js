"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");
const env = { ...process.env, GALLERY_NODE: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  require("electron"),
  [path.resolve(__dirname, "../desktop/main.js"), ...process.argv.slice(2)],
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
