"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  net = require("node:net");
const { bindSources } = require("../library/platforms.js");
const {
  inside,
  overlap,
  physicalPath,
  noLinks,
} = require("../library/io-paths.js");
const { readJson } = require("./files.js");
function fail(code) {
  throw Object.assign(new Error(code), { code });
}
function defaultRoot() {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), "gallery-legacy");
}
function normalizeRuntimeConfig(source) {
  if (
    !source ||
    typeof source.instanceRoot !== "string" ||
    !path.isAbsolute(source.instanceRoot)
  )
    fail("INSTANCE_PATH_REQUIRED");
  for (const name of [
    "catalogPath",
    "catalog",
    "searchIndexPath",
    "searchIndex",
    "rules",
    "physicalRoot",
    "allowOldCatalog",
  ])
    if (Object.hasOwn(source, name)) fail("DIRECT_DATABASE_CONFIG_FORBIDDEN");
  noLinks(source.instanceRoot);
  const instanceRoot = physicalPath(path.resolve(source.instanceRoot));
  noLinks(instanceRoot);
  const platforms = bindSources(source.sources);
  const sources = Object.fromEntries(
    platforms.map((p) => [p.id, p.physicalRoot]),
  );
  const realInstance = physicalPath(instanceRoot);
  for (const p of platforms) {
    noLinks(p.physicalRoot);
    if (overlap(realInstance, physicalPath(p.physicalRoot)))
      fail("INSTANCE_SOURCE_OVERLAP");
  }
  for (let i = 0; i < platforms.length; i++)
    for (let j = i + 1; j < platforms.length; j++)
      if (
        overlap(
          physicalPath(platforms[i].physicalRoot),
          physicalPath(platforms[j].physicalRoot),
        )
      )
        fail("SOURCE_ROOT_OVERLAP");
  const mode = source.mode || "local",
    host = source.host || "127.0.0.1",
    port = source.port ?? 18104;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("PORT_INVALID");
  const loopback = host === "127.0.0.1" || host === "::1";
  const lan =
    net.isIPv4(host) &&
    (/^(10\.|192\.168\.)/.test(host) ||
      (/^172\./.test(host) &&
        Number(host.split(".")[1]) >= 16 &&
        Number(host.split(".")[1]) <= 31));
  if (
    !["local", "lan"].includes(mode) ||
    (!loopback && (mode !== "lan" || !lan))
  )
    fail("LISTEN_ADDRESS_FORBIDDEN");
  const instanceId = require("node:crypto")
    .createHash("sha256")
    .update(instanceRoot.toLowerCase())
    .digest("hex");
  const config = {
    instanceRoot,
    instanceId,
    sources,
    platforms,
    host,
    port,
    mode,
  };
  for (const name of [
    "generations",
    "cache",
    "logs",
    "temp",
    "state",
    "reports",
    "desktop-data",
  ]) {
    const key =
      name === "generations"
        ? "generationsRoot"
        : name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + "Root";
    const value = source[key] || path.join(instanceRoot, name);
    if (
      !path.isAbsolute(value) ||
      !inside(instanceRoot, value) ||
      path.resolve(value) === instanceRoot
    )
      fail("RUNTIME_PATH_ESCAPE");
    noLinks(value);
    config[key] = path.resolve(value);
  }
  for (const key of [
    "cacheRoot",
    "logsRoot",
    "tempRoot",
    "stateRoot",
    "reportsRoot",
    "desktopDataRoot",
  ]) {
    if (overlap(config[key], config.generationsRoot))
      fail("GENERATION_WRITE_OVERLAP");
  }
  const writable = [
    "cacheRoot",
    "logsRoot",
    "tempRoot",
    "stateRoot",
    "reportsRoot",
    "desktopDataRoot",
  ];
  for (let i = 0; i < writable.length; i++)
    for (let j = i + 1; j < writable.length; j++)
      if (overlap(config[writable[i]], config[writable[j]]))
        fail("RUNTIME_PATH_OVERLAP");
  config.activeGenerationPath = path.join(
    instanceRoot,
    "active-generation.json",
  );
  config.statusPath = path.join(config.stateRoot, "runtime.json");
  config.scanStatusPath = path.join(config.stateRoot, "scan.json");
  config.url = `http://${host.includes(":") ? "[" + host + "]" : host}:${port}`;
  return Object.freeze(config);
}
function readRuntimeConfig(file = path.join(defaultRoot(), "config.json")) {
  const source = readJson(path.resolve(file));
  if (!source) fail("CONFIG_REQUIRED");
  const properties = require("../../config/runtime.schema.json").properties;
  for (const key of Object.keys(source))
    if (!Object.hasOwn(properties, key)) fail("CONFIG_FIELD_UNSUPPORTED");
  return normalizeRuntimeConfig(source);
}
function ensureLayout(config) {
  for (const k of [
    "instanceRoot",
    "generationsRoot",
    "cacheRoot",
    "logsRoot",
    "tempRoot",
    "stateRoot",
    "reportsRoot",
    "desktopDataRoot",
  ])
    fs.mkdirSync(config[k], { recursive: true });
}
module.exports = {
  defaultRoot,
  normalizeRuntimeConfig,
  readRuntimeConfig,
  ensureLayout,
};
