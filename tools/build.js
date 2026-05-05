"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const { spawnSync } = require("node:child_process");
const { noLinks } = require("../internal/library/io-paths.js");
const root = path.resolve(__dirname, ".."),
  out = path.join(root, "dist", "gallery");
noLinks(out);
if (fs.existsSync(out))
  throw new Error(
    "Build output exists. Move the previous dist/gallery out before rebuilding.",
  );
fs.mkdirSync(out, { recursive: true });
for (const name of [
  "cmd",
  "internal",
  "frontend",
  "desktop",
  "protocol",
  "config",
  "docs",
  "tools",
  "extensions",
  "tests",
  "fixtures",
  "package.json",
  "package-lock.json",
  "README.md",
]) {
  fs.cpSync(path.join(root, name), path.join(out, name), {
    recursive: true,
    filter: (file) => !file.endsWith(".local.json"),
  });
}
// Install the same locked versions. No upgrade or dependency resolution changes.
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run through npm run build");
const result = spawnSync(
  process.execPath,
  [npm, "ci", "--omit=dev", "--no-audit", "--no-fund"],
  { cwd: out, stdio: "inherit", windowsHide: true },
);
process.exitCode = result.status ?? 1;
if (!process.exitCode)
  process.stdout.write(
    "Built dist/gallery (Server/CLI). Install locked dev dependencies there for Electron Manager.\n",
  );
