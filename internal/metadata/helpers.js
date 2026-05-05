"use strict";

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function warning(diagnostics, code, path, detail = null) {
  diagnostics.warnings.push({ code, path, detail });
}

function invalid(diagnostics, path, expected, value) {
  diagnostics.invalidFields.push({ path, expected, actual: valueType(value) });
}

function fallback(diagnostics, field, source) {
  diagnostics.fallbacksUsed.push({ field, source });
}

function asId(value, diagnostics, path) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return String(value);
    invalid(diagnostics, path, "safe integer or string ID", value);
    warning(diagnostics, "unsafe_numeric_id", path);
    return null;
  }
  invalid(diagnostics, path, "string ID", value);
  return null;
}

function asText(value, diagnostics, path) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  invalid(diagnostics, path, "string", value);
  return null;
}

function asBoolean(value, diagnostics, path, options = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (options.allowNumeric && (value === 0 || value === 1)) return value === 1;
  invalid(diagnostics, path, options.allowNumeric ? "boolean or 0/1" : "boolean", value);
  return null;
}

function asInteger(value, diagnostics, path, options = {}) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (options.allowString && typeof value === "string" && /^-?\d+$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
  }
  invalid(diagnostics, path, options.allowString ? "safe integer or integer string" : "safe integer", value);
  return null;
}

function asObject(value, diagnostics, path) {
  if (value === undefined || value === null) return null;
  if (isObject(value)) return value;
  invalid(diagnostics, path, "object", value);
  return null;
}

function asArray(value, diagnostics, path) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value;
  invalid(diagnostics, path, "array", value);
  return null;
}

function oneOrMany(value, diagnostics, path, options = {}) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (options.allowObject && isObject(value)) {
    warning(diagnostics, "object_used_as_single_item", path);
    return [value];
  }
  invalid(diagnostics, path, options.allowObject ? "array or object" : "array", value);
  return [];
}

function firstSelection(candidates, decoder, diagnostics) {
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const value = decoder(candidate.value, diagnostics, candidate.path);
    if (value !== null && value !== undefined && value !== "") {
      return { candidate, index, value };
    }
  }
  return null;
}

function firstValid(candidates, decoder, diagnostics, field) {
  const selection = firstSelection(candidates, decoder, diagnostics);
  if (!selection) return null;
  if (selection.index > 0) fallback(diagnostics, field, selection.candidate.path);
  return selection.value;
}

function workIdFromDirectory(name) {
  if (typeof name !== "string" || !name) return null;
  const match = name.match(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_(.+)$/);
  return match ? match[1] : name;
}

function directoryTimestampMs(name) {
  if (typeof name !== "string") return null;
  const match = name.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_/);
  if (!match) return null;
  const value = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  return Number.isFinite(value) ? value : null;
}

function parseTimestamp(value, diagnostics, path) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string") {
    invalid(diagnostics, path, "timestamp string", value);
    return null;
  }
  const text = value.trim();
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const normalized = zoned ? text : text.replace(" ", "T") + "Z";
  const result = Date.parse(normalized);
  if (!Number.isFinite(result)) {
    invalid(diagnostics, path, "parseable timestamp", value);
    return null;
  }
  return result;
}

function resolveIdentity(contextValue, candidates, diagnostics, field) {
  const contextId = typeof contextValue === "string" && contextValue ? contextValue : null;
  const decoded = candidates.map(candidate => ({ ...candidate, decoded: asId(candidate.value, diagnostics, candidate.path) }));
  if (contextId) return contextId;
  const selected = decoded.find(candidate => candidate.decoded !== null);
  if (selected) {
    fallback(diagnostics, field, selected.path);
    return selected.decoded;
  }
  warning(diagnostics, "missing_identity", field);
  return null;
}

function normalizeTags(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value.trim() || seen.has(value)) continue;
    seen.add(value);
    result.push({ displayValue: value });
  }
  return result;
}

function stableObjectEntries(value) {
  return isObject(value) ? Object.keys(value).sort().map(key => [key, value[key]]) : [];
}

function httpUrl(value, diagnostics, path) {
  const text = asText(value, diagnostics, path);
  if (text === null) return null;
  if (text === "") return null;
  if (!/^https?:\/\//i.test(text)) {
    invalid(diagnostics, path, "http(s) URL", value);
    return null;
  }
  return text;
}

module.exports = {
  asArray,
  asBoolean,
  asId,
  asInteger,
  asObject,
  asText,
  directoryTimestampMs,
  fallback,
  firstSelection,
  firstValid,
  httpUrl,
  invalid,
  isObject,
  normalizeTags,
  oneOrMany,
  parseTimestamp,
  resolveIdentity,
  stableObjectEntries,
  valueType,
  warning,
  workIdFromDirectory,
};
