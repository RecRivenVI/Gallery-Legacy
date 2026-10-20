"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const localFile = path.join(__dirname, "paths.local.json");
const local = fs.existsSync(localFile)
  ? JSON.parse(fs.readFileSync(localFile, "utf8"))
  : {};
const ROOT =
  process.env.GALLERY_DEMO_ROOT ||
  local.root ||
  path.join(os.tmpdir(), "Gallery-Legacy", "Demo");
const REPO = path.resolve(__dirname, "../..");
const OUTPUT = process.env.GALLERY_DEMO_OUTPUT || path.join(ROOT, "reports");
const PORTS = {
  full: 18221,
  empty: 18222,
  managerFull: 18223,
  managerEmpty: 18224,
};
const within = (base, target) => {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return (
    rel === "" ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  );
};
function assertOwned(target) {
  if (
    !path.isAbsolute(target) ||
    !within(ROOT, target) ||
    path.resolve(target) === path.resolve(ROOT)
  )
    throw Object.assign(new Error("Sandbox path rejected"), {
      code: "DEMO_PATH_REJECTED",
    });
  let cur = path.resolve(target);
  while (within(ROOT, cur)) {
    if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink())
      throw Object.assign(new Error("Sandbox links rejected"), {
        code: "DEMO_REPARSE_REJECTED",
      });
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(target);
}
function assertConfig(value) {
  if (
    !value ||
    value.deployment !== "staging" ||
    value.mode !== "local" ||
    value.listenAddress !== "127.0.0.1" ||
    ![PORTS.full, PORTS.empty].includes(value.port)
  )
    throw new Error("DEMO_CONFIG_REJECTED");
  for (const key of [
    "instanceRoot",
    "generationsRoot",
    "cacheRoot",
    "logsRoot",
    "tempRoot",
    "stateRoot",
    "reportsRoot",
    "desktopDataRoot",
  ])
    if (value[key]) assertOwned(value[key]);
  for (const target of Object.values(value.sources || {})) assertOwned(target);
  for (const entry of value.fileBrowserRoots || []) assertOwned(entry.path);
  for (const key of [
    "catalogPath",
    "catalog",
    "searchIndexPath",
    "searchIndex",
    "rules",
  ])
    if (Object.hasOwn(value, key)) throw new Error("DEMO_DATABASE_REJECTED");
  if (
    value.allowedHosts?.some((h) => !h.startsWith("127.0.0.1:")) ||
    value.allowedOrigins?.some((h) => !h.startsWith("http://127.0.0.1:"))
  )
    throw new Error("DEMO_NETWORK_REJECTED");
  return value;
}
function environment() {
  const env = {
    ...process.env,
    GALLERY_NODE: process.execPath,
    GALLERY_DEMO_ROOT: ROOT,
    TEMP: path.join(ROOT, "host/temp"),
    TMP: path.join(ROOT, "host/temp"),
    APPDATA: path.join(ROOT, "host/roaming"),
    LOCALAPPDATA: path.join(ROOT, "host/local"),
    USERPROFILE: path.join(ROOT, "host/profile"),
    HOME: path.join(ROOT, "host/profile"),
    MAGICK_TEMPORARY_PATH: path.join(ROOT, "host/temp"),
    GALLERY_ASSETS_ROOT: local.resources || path.join(ROOT, "resources"),
    NODE_OPTIONS:
      '--require "' +
      path.join(__dirname, "guard.cjs").replaceAll("\\", "/") +
      '"',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
module.exports = {
  ROOT,
  REPO,
  OUTPUT,
  PORTS,
  within,
  assertOwned,
  assertConfig,
  environment,
};
