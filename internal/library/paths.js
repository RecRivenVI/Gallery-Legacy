"use strict";

const path = require("node:path");

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("relative path must be a non-empty string");
  if (value.includes("\0")) throw new Error("relative path contains NUL");
  const windowsValue = value.replace(/\//g, "\\");
  if (path.win32.isAbsolute(windowsValue) || /^[a-z]:/i.test(windowsValue) || windowsValue.startsWith("\\\\")) {
    throw new Error("relative path must not be absolute");
  }
  const segments = windowsValue.split(/\\+/).filter(Boolean);
  if (segments.some(segment => segment === "." || segment === "..")) throw new Error("relative path traversal is forbidden");
  const normalized = path.win32.normalize(windowsValue).replace(/[\\/]+$/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("..\\")) throw new Error("relative path escapes the platform root");
  return {
    relativePath: normalized,
    relativePathKey: normalized.toLowerCase(),
  };
}

function normalizeOptionalRelativePath(value) {
  return value === undefined || value === null ? null : normalizeRelativePath(value);
}

module.exports = { compareText, normalizeOptionalRelativePath, normalizeRelativePath };
