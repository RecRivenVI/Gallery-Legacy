"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  cp = require("node:child_process");
const {
  ROOT,
  REPO,
  OUTPUT,
  PORTS,
  assertOwned,
  assertConfig,
  environment,
} = require("./paths.cjs");
const env = environment();
for (const [k, v] of Object.entries(env))
  if (
    [
      "TEMP",
      "TMP",
      "APPDATA",
      "LOCALAPPDATA",
      "USERPROFILE",
      "HOME",
      "MAGICK_TEMPORARY_PATH",
      "GALLERY_DEMO_ROOT",
      "GALLERY_ASSETS_ROOT",
    ].includes(k)
  )
    process.env[k] = v;
require("./guard.cjs");
const { fullScan } = require(path.join(REPO, "src/indexing/task.js"));
const { readRuntimeConfig, ensureLayout } = require(
  path.join(REPO, "src/instance/config.js"),
);
async function setup() {
  const rejected = [];
  const pristine = JSON.parse(
    fs.readFileSync(path.join(ROOT, "full/instance/config.json")),
  );
  for (const test of [
    { ...pristine, instanceRoot: "C:/NotTheSandbox" },
    { ...pristine, port: 8081 },
    {
      ...pristine,
      sources: { ...pristine.sources, pixiv: "G:/NotTheSandbox" },
    },
  ]) {
    try {
      assertConfig(test);
      throw new Error("UNSAFE_CONFIG_ACCEPTED");
    } catch (e) {
      if (e.message === "UNSAFE_CONFIG_ACCEPTED") throw e;
      rejected.push("rejected");
    }
  }
  const testPath = "F:/NotTheSandbox/forbidden-demo-probe";
  try {
    fs.readFileSync(testPath);
    throw new Error("REAL_READ_ACCEPTED");
  } catch (e) {
    if (e.code !== "DEMO_IO_REJECTED") throw e;
  }
  try {
    await fetch("https://example.invalid/");
    throw new Error("EXTERNAL_NETWORK_ACCEPTED");
  } catch (e) {
    if (e.code !== "DEMO_NETWORK_REJECTED") throw e;
  }
  const configPath = path.join(ROOT, "full/instance/config.json");
  assertConfig(JSON.parse(fs.readFileSync(configPath)));
  const config = readRuntimeConfig(configPath);
  ensureLayout(config);
  const updated = process.argv.includes("--updated");
  const final = process.argv.includes("--final");
  const report = await fullScan(config, {
    confirmReadOnly: true,
    generationId: final
      ? "demo-final"
      : updated
        ? "demo-updated"
        : "demo-baseline",
    mode: updated || final ? "incremental" : "full",
  });
  const summary = {
    state: report.state,
    synthetic: true,
    generationId: report.generationId,
    works: report.build?.counts?.works,
    media: report.build?.counts?.media,
    sourceWriteAttempts: report.sourceWriteAttempts,
    guard: global.__galleryDemoGuard,
    negativeTests: rejected,
  };
  fs.writeFileSync(
    path.join(
      OUTPUT,
      final
        ? "sandbox/scan-final.json"
        : updated
          ? "sandbox/scan-updated.json"
          : "sandbox/scan-baseline.json",
    ),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
}
setup().catch((e) => {
  console.error(e.code || e.message);
  process.exitCode = 1;
});
