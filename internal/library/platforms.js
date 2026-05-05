"use strict";

const path = require("path");

// Fixed product identity. Private physical roots are bound by the local instance.
// Source configuration cannot add platforms or change adapter identity/version.
// adapterVersion 是该平台 extraction behavior 的期望版本，与公共 contractVersion 独立演进。
const PLATFORM_REGISTRY = Object.freeze(
  [
    {
      id: "pixiv",
      family: "art_distribution",
      enabled: true,
      adapterVersion: 2,
    },
    {
      id: "pixivFANBOX",
      family: "art_distribution",
      enabled: true,
      adapterVersion: 2,
    },
    {
      id: "Gank",
      family: "art_distribution",
      enabled: true,
      adapterVersion: 2,
    },
    {
      id: "Fantia",
      family: "art_distribution",
      enabled: true,
      adapterVersion: 2,
    },
    {
      id: "Patreon",
      family: "art_distribution",
      enabled: true,
      adapterVersion: 2,
    },
    {
      id: "Pawchive",
      family: "art_distribution",
      enabled: true,
      adapterVersion: 3,
    },
    { id: "X", family: "social_feed", enabled: true, adapterVersion: 2 },
    { id: "微博", family: "social_feed", enabled: true, adapterVersion: 2 },
  ].map((entry) => Object.freeze(entry)),
);

function normalizePhysicalRootKey(value) {
  return path.win32
    .normalize(String(value || ""))
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function validatePlatformRegistry(entries) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error("平台 registry 不能为空");
  const ids = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || !entry.id)
      throw new Error("平台 registry 含无效 id");
    if (ids.has(entry.id))
      throw new Error(`平台 registry 含重复 id：${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.enabled !== "boolean")
      throw new Error(`平台 ${entry.id} 缺少 enabled`);
    if (!Number.isInteger(entry.adapterVersion) || entry.adapterVersion < 1)
      throw new Error(`平台 ${entry.id} 的 adapterVersion 无效`);
  }
  return true;
}

validatePlatformRegistry(PLATFORM_REGISTRY);

function bindSources(sources) {
  if (
    !sources ||
    typeof sources !== "object" ||
    Array.isArray(sources) ||
    Object.keys(sources).length !== PLATFORM_REGISTRY.length
  )
    throw new Error("Exactly eight source bindings are required");
  const seen = new Set();
  return PLATFORM_REGISTRY.map((platform) => {
    const root = sources[platform.id];
    if (typeof root !== "string" || !path.isAbsolute(root))
      throw new Error("Source roots must be absolute paths");
    const physicalRoot = path.resolve(root),
      key = normalizePhysicalRootKey(physicalRoot);
    if (seen.has(key)) throw new Error("Duplicate physical source root");
    seen.add(key);
    return Object.freeze({ ...platform, physicalRoot });
  });
}
module.exports = {
  PLATFORM_REGISTRY,
  bindSources,
  normalizePhysicalRootKey,
  validatePlatformRegistry,
};
