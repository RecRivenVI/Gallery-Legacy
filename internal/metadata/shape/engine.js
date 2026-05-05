"use strict";

const crypto = require("node:crypto");

const METADATA_SHAPE_SIGNATURE_VERSION = 1;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (["string", "number", "boolean"].includes(typeof value)) return typeof value;
  throw new TypeError(`Metadata shape only supports JSON values, received ${typeof value}`);
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new TypeError("Shape policy must be an object");
  if (typeof policy.PLATFORM_ID !== "string" || !policy.PLATFORM_ID) throw new TypeError("Shape policy PLATFORM_ID is required");
  if (!Number.isInteger(policy.SHAPE_POLICY_VERSION) || policy.SHAPE_POLICY_VERSION < 1) throw new TypeError("Shape policy version must be a positive integer");
  for (const field of ["wildcardObjectPaths", "excludedPaths"]) {
    if (!Array.isArray(policy[field]) || policy[field].some(value => typeof value !== "string" || !value.startsWith("$"))) {
      throw new TypeError(`Shape policy ${field} must be JSON paths`);
    }
  }
}

function canonicalShapeSignature(metadata, policy) {
  validatePolicy(policy);
  if (jsonType(metadata) !== "object") throw new TypeError("Metadata shape root must be an object");
  const wildcardPaths = new Set(policy.wildcardObjectPaths);
  const excludedPaths = new Set(policy.excludedPaths);
  const entries = new Set();

  function visit(value, canonicalPath, policyPath) {
    const type = jsonType(value);
    entries.add(`${canonicalPath}:${type}`);
    if (type === "array") {
      for (const item of value) visit(item, `${canonicalPath}[]`, `${policyPath}[]`);
      return;
    }
    if (type !== "object") return;

    const keys = Object.keys(value).sort(compareText);
    const wildcard = wildcardPaths.has(policyPath);
    for (const key of keys) {
      const nextPolicyPath = wildcard ? `${policyPath}.*` : `${policyPath}.${key}`;
      if (excludedPaths.has(nextPolicyPath)) continue;
      const nextCanonicalPath = wildcard ? `${canonicalPath}[*]` : `${canonicalPath}[${JSON.stringify(key)}]`;
      visit(value[key], nextCanonicalPath, nextPolicyPath);
    }
  }

  visit(metadata, "$", "$");
  const header = [
    `metadata-shape-signature:${METADATA_SHAPE_SIGNATURE_VERSION}`,
    `platform:${JSON.stringify(policy.PLATFORM_ID)}`,
    `policy:${policy.SHAPE_POLICY_VERSION}`,
  ];
  return [...header, ...[...entries].sort(compareText)].join("\n");
}

function analyzeMetadataShape(metadata, policy) {
  const canonicalSignature = canonicalShapeSignature(metadata, policy);
  return {
    signatureVersion: METADATA_SHAPE_SIGNATURE_VERSION,
    policyVersion: policy.SHAPE_POLICY_VERSION,
    platformId: policy.PLATFORM_ID,
    hash: crypto.createHash("sha256").update(canonicalSignature, "utf8").digest("hex"),
    canonicalSignature,
  };
}

module.exports = {
  METADATA_SHAPE_SIGNATURE_VERSION,
  analyzeMetadataShape,
  canonicalShapeSignature,
};
