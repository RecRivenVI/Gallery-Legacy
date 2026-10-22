#!/usr/bin/env node
"use strict";
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === "--help" || argv.includes("--help")) {
    process.stdout.write(
      "Gallery: connection | status --config <file>\n请在管理器内启动画廊和扫描。\n",
    );
    return;
  }
  if (!["connection", "status"].includes(command))
    throw Object.assign(new Error("请在管理器内启动画廊和扫描"), {
      code: "MANAGER_REQUIRED",
    });
  const executable =
    process.env.GALLERY_RUNTIME ||
    path.resolve(__dirname, "gallery-runtime.exe");
  try {
    const result = await promisify(execFile)(executable, argv, {
      windowsHide: true,
      maxBuffer: 1048576,
    });
    process.stdout.write(result.stdout);
  } catch (error) {
    const code = String(error.stderr || "").trim();
    throw Object.assign(new Error("Runtime operation failed"), {
      code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : "HOST_REQUEST_FAILED",
    });
  }
}
if (require.main === module)
  main().catch((error) => {
    process.stderr.write((error.code || "FAILED") + "\n");
    process.exitCode = 1;
  });
module.exports = { main };
