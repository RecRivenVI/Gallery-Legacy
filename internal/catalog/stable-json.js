"use strict";

const { compareText } = require("../library/paths.js");

function canonicalJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("stable JSON does not support non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort(compareText)) result[key] = canonicalJsonValue(value[key]);
    return result;
  }
  throw new TypeError(`stable JSON does not support ${typeof value}`);
}

function stableJson(value) {
  return JSON.stringify(canonicalJsonValue(value));
}

module.exports = { canonicalJsonValue, stableJson };
