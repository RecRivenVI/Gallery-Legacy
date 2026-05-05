"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function collect(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? collect(path.join(dir, e.name))
        : e.name.endsWith(".test.js")
          ? [path.join(dir, e.name)]
          : [],
    );
}
const core = new Set(["library", "metadata", "media", "catalog"]);
const tests = collect(path.join(root, "tests"))
  .filter(
    (file) =>
      !process.argv.includes("--core") ||
      core.has(
        path.relative(path.join(root, "tests"), file).split(path.sep)[0],
      ),
  )
  .sort();
// No excluded test manifest: every current test is active by default.
const run = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", "--test-reporter=spec", ...tests],
  { cwd: root, env: process.env, stdio: "inherit", windowsHide: true },
);
process.exitCode = run.status ?? 1;
