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
  if (source.liveUpdates !== undefined && typeof source.liveUpdates !== "boolean") fail("LIVE_UPDATES_INVALID");
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
  if (source.fileBrowserRoots !== undefined && !Array.isArray(source.fileBrowserRoots)) fail("FILE_ROOT_INVALID");
  const fileBrowserRoots = (source.fileBrowserRoots || []).map((entry) => {
    if (!entry || !/^[a-zA-Z0-9_-]{1,40}$/.test(entry.id) || typeof entry.path !== "string" || !path.isAbsolute(entry.path)) fail("FILE_ROOT_INVALID");
    noLinks(entry.path);
    const physicalRoot = physicalPath(path.resolve(entry.path));
    if (overlap(instanceRoot, physicalRoot)) fail("INSTANCE_SOURCE_OVERLAP");
    if (platforms.some((p) => inside(p.physicalRoot, physicalRoot))) fail("FILE_ROOT_INSIDE_PLATFORM");
    return Object.freeze({ id: entry.id, name: entry.name || "文件浏览", path: physicalRoot, physicalRoot });
  });
  for (let i = 0; i < fileBrowserRoots.length; i++)
    for (let j = i + 1; j < fileBrowserRoots.length; j++)
      if (fileBrowserRoots[i].id === fileBrowserRoots[j].id || overlap(fileBrowserRoots[i].physicalRoot, fileBrowserRoots[j].physicalRoot)) fail("FILE_ROOT_OVERLAP");
  const mode = source.mode || "local",
    host = source.listenAddress || source.host || "127.0.0.1",
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
    !["local", "lan", "public"].includes(mode) ||
    (mode !== "public" && !loopback && (mode !== "lan" || !lan)) ||
    (mode === "public" && (!net.isIP(host) || !Array.isArray(source.allowedHosts) || !source.allowedHosts.length))
  )
    fail("LISTEN_ADDRESS_FORBIDDEN");
  const connectHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const url = `http://${connectHost.includes(":") ? "[" + connectHost + "]" : connectHost}:${port}`;
  function authority(value) {
    if (typeof value !== "string" || /[\s/\\@?#]/.test(value)) fail("ALLOWED_HOST_INVALID");
    let parsed; try { parsed = new URL("http://" + value); } catch { fail("ALLOWED_HOST_INVALID"); }
    if (!parsed.hostname || parsed.username || parsed.password) fail("ALLOWED_HOST_INVALID");
    return parsed.host.toLowerCase();
  }
  if (source.allowedHosts !== undefined && !Array.isArray(source.allowedHosts)) fail("ALLOWED_HOST_INVALID");
  const localHosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
  const allowedHosts = [...new Set([new URL(url).host, ...localHosts, ...(source.allowedHosts || []).map(authority)])];
  const allowedOrigins = source.allowedOrigins || allowedHosts.map((h) => "http://" + h);
  if (!Array.isArray(allowedOrigins)) fail("ALLOWED_ORIGIN_INVALID");
  for (const origin of allowedOrigins) {
    let parsed; try { parsed = new URL(origin); } catch { fail("ALLOWED_ORIGIN_INVALID"); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || !allowedHosts.includes(parsed.host.toLowerCase())) fail("ALLOWED_ORIGIN_INVALID");
  }
  const publicUrl = source.publicUrl || url;
  if (!allowedOrigins.includes(publicUrl)) fail("PUBLIC_URL_INVALID");
  const shortLinks = source.shortLinks || {};
  if (!shortLinks || typeof shortLinks !== "object" || Array.isArray(shortLinks)) fail("SHORT_LINKS_INVALID");
  for (const [key, target] of Object.entries(shortLinks))
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key) || typeof target !== "string" || !target.startsWith("/") || /^\/[\\/]/.test(target) || /[\x00-\x1f\x7f]/.test(target)) fail("SHORT_LINK_INVALID");
  const staleAfterMs = source.retention?.staleAfterMs ?? 86400000;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 3600000) fail("RETENTION_INVALID");
  const instanceId = require("node:crypto")
    .createHash("sha256")
    .update(instanceRoot.toLowerCase())
    .digest("hex");
  const config = {
    deployment: source.deployment || "development",
    instanceRoot,
    instanceId,
    liveUpdates: source.liveUpdates === true,
    sources,
    platforms,
    fileBrowserRoots,
    protectedRoots: [...platforms, ...fileBrowserRoots],
    host,
    port,
    mode,
    allowedHosts: Object.freeze(allowedHosts),
    allowedOrigins: Object.freeze([...allowedOrigins]),
    localHosts: Object.freeze(localHosts),
    publicUrl,
    shortLinks: Object.freeze({ ...shortLinks }),
    retention: Object.freeze({ enabled: source.retention?.enabled !== false, staleAfterMs }),
  };
  if (!["development", "staging", "production"].includes(config.deployment)) fail("DEPLOYMENT_INVALID");
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
  if (config.liveUpdates) {
    const liveRoot=path.join(instanceRoot,"live");noLinks(liveRoot);
    if ([config.generationsRoot,...writable.map(k=>config[k])].some(p=>overlap(p,liveRoot))) fail("LIVE_PATH_OVERLAP");
  }
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
  config.url = url;
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
