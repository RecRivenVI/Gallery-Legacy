"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync, execFileSync } = require("node:child_process");
const { overlap, noLinks } = require("../../src/library/io-paths.js");
const root = path.resolve(__dirname, "../..");
async function main() {
  const localFile = path.join(__dirname, "paths.local.json");
  const local = fs.existsSync(localFile)
    ? JSON.parse(fs.readFileSync(localFile))
    : {};
  const output = process.env.GALLERY_BUILD_ROOT || local.output;
  if (!output || !path.isAbsolute(output))
    throw Error("Choose an external output in tools/build/paths.local.json");
  const out = path.resolve(output);
  noLinks(out);
  if (overlap(root, out) || fs.existsSync(out))
    throw Error("Build output must be a new directory outside the repository");
  const resources = process.env.GALLERY_ASSETS_ROOT || local.resources;
  if (
    !resources ||
    !fs.existsSync(path.join(resources, "misans/manifest.json"))
  )
    throw Error(
      "Provide licensed UI resources in tools/build/paths.local.json",
    );
  fs.mkdirSync(out, { recursive: true });
  for (const name of [
    "src",
    "public",
    "api",
    "bin",
    "package.json",
    "package-lock.json",
    "README.md",
    "NOTICE",
    "LICENSE",
  ])
    fs.cpSync(path.join(root, name), path.join(out, name), {
      recursive: true,
      filter: (file) => !file.endsWith(".local.json"),
    });
  fs.cpSync(resources, path.join(out, "resources"), { recursive: true });
  fs.mkdirSync(path.join(out, "resources/vendor"), { recursive: true });
  for (const name of ["canvaskit.js", "canvaskit.wasm"])
    fs.copyFileSync(
      path.join(path.dirname(require.resolve("canvaskit-wasm")), name),
      path.join(out, "resources/vendor", name),
    );
  const { chromium } = require("playwright"),
    browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    });
    await page.setContent(
      fs.readFileSync(path.join(root, "public/assets/app-icon.svg"), "utf8"),
    );
    await page.locator("svg").screenshot({
      path: path.join(out, "resources/app-icon.png"),
      omitBackground: true,
    });
  } finally {
    await browser.close();
  }
  let version = "dev";
  try {
    version = execFileSync("git", ["describe", "--tags", "--exact-match"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
  const build = spawnSync(
    process.execPath,
    [
      path.join(root, "tools/go/run.cjs"),
      "build",
      "-buildvcs=false",
      "-ldflags=-X main.version=" + version,
      "-o",
      path.join(out, "bin/gallery-scan.exe"),
      "./cmd/gallery-scan",
    ],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  if (build.status !== 0) throw Error("Go build failed");
  const npm = process.env.npm_execpath;
  if (!npm) throw Error("Run through npm run build");
  const install = spawnSync(
    process.execPath,
    [npm, "ci", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: out, stdio: "inherit", windowsHide: true },
  );
  if (install.status !== 0) throw Error("Locked runtime install failed");
  console.log(JSON.stringify({ state: "BUILT", output: out }));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
