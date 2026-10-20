"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../.."),
  file = path.join(root, "tools/build/paths.local.json");
const local = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : {};
const env = { ...process.env, GOTOOLCHAIN: "local" };
for (const [key, field] of Object.entries({
  GOCACHE: "goCache",
  GOMODCACHE: "moduleCache",
  GALLERY_GO_EMPTY_DB: "testSeed",
  GALLERY_GO_GOLDEN: "golden",
}))
  if (!env[key] && local[field]) env[key] = path.resolve(local[field]);
const run = spawnSync(
  process.env.GALLERY_GO || local.go || "go",
  process.argv.slice(2),
  { cwd: root, env, stdio: "inherit", windowsHide: true },
);
if (run.error) {
  console.error("Go 工具无法启动：请设置 tools/build/paths.local.json 中的 go");
  process.exitCode = 1;
} else process.exitCode = run.status ?? 1;
