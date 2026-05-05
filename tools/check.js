"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? files(path.join(dir, e.name))
        : /\.(?:js|mjs)$/.test(e.name)
          ? [path.join(dir, e.name)]
          : [],
    );
}
const areas = process.argv.includes("--desktop")
  ? ["desktop"]
  : ["cmd", "internal", "frontend", "desktop", "extensions", "tools", "tests"];
const inputs = areas.flatMap((area) => files(path.join(root, area)));
for (const file of inputs) {
  const run = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (run.status !== 0) {
    process.stderr.write(path.relative(root, file) + "\n" + run.stderr);
    process.exitCode = 1;
  }
}
process.stdout.write(`Checked ${inputs.length} JavaScript modules\n`);
