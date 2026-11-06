import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "../.."),
  file = path.join(root, "tools/build/paths.local.json");
const local = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : {};
const env = { ...process.env, GOTOOLCHAIN: "local" };
if (process.argv.includes("-race")) {
  env.CGO_ENABLED = "1";
  if (!env.CC && local.raceCompiler) env.CC = local.raceCompiler;
  if (env.CC && path.isAbsolute(env.CC)) {
    const inherited = Object.keys(env).find(
      (key) => key.toLowerCase() === "path",
    );
    const previous = env[inherited] || "";
    if (inherited) delete env[inherited];
    env.PATH = path.dirname(env.CC) + path.delimiter + previous;
  }
}
for (const [key, field] of Object.entries({
  GOCACHE: "goCache",
  GOMODCACHE: "moduleCache",
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
