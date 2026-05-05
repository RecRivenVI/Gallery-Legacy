"use strict";

const path = require("node:path");

const { normalizeRelativePath } = require("../library/paths.js");
const {
  FILESYSTEM_MEDIA_ELIGIBILITY_CONTRACT_VERSION,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  compareText,
  deepFreeze,
  fail,
} = require("./eligibility-contract.js");

const IMAGE_EXTENSIONS = new Set(SUPPORTED_IMAGE_EXTENSIONS);
const VIDEO_EXTENSIONS = new Set(SUPPORTED_VIDEO_EXTENSIONS);

function canonicalFilesystemFile(file, inputIndex) {
  if (!file || typeof file !== "object" || Array.isArray(file)) fail("invalid_filesystem_file", `filesystemFiles[${inputIndex}] must be an object`);
  let identity;
  try { identity = normalizeRelativePath(file.relativePath); }
  catch { fail("invalid_filesystem_identity", `filesystemFiles[${inputIndex}] has an invalid relativePath`); }
  if (file.relativePathKey !== identity.relativePathKey) fail("invalid_filesystem_identity", `filesystemFiles[${inputIndex}] relativePathKey does not match the shared path contract`);
  const fileName = path.win32.basename(identity.relativePath);
  if (file.fileName !== fileName) fail("invalid_filesystem_identity", `filesystemFiles[${inputIndex}] fileName does not match relativePath`);
  if (file.entryType !== "regular_file") fail("invalid_filesystem_file", `filesystemFiles[${inputIndex}] is not a regular file`);
  const observedExtension = path.win32.extname(fileName);
  if (file.extension !== observedExtension) fail("invalid_filesystem_file", `filesystemFiles[${inputIndex}] extension does not match fileName`);
  if (!Number.isSafeInteger(file.size) || file.size < 0) fail("invalid_filesystem_size", `filesystemFiles[${inputIndex}] size must be a non-negative safe integer`);
  if (typeof file.mtimeNs !== "bigint" || file.mtimeNs < 0n) fail("invalid_filesystem_mtime", `filesystemFiles[${inputIndex}] mtimeNs must be a non-negative BigInt`);
  return { ...identity, fileName, extension: observedExtension };
}

function resultForFile(file, inputIndex) {
  const canonical = canonicalFilesystemFile(file, inputIndex);
  const lowerName = canonical.fileName.toLowerCase();
  const normalizedExtension = canonical.extension.startsWith(".") && canonical.extension.length > 1
    ? canonical.extension.slice(1).toLowerCase()
    : null;

  let eligible = false;
  let filesystemMediaType = null;
  let eligibilityReason;
  if (lowerName === "metadata.json") eligibilityReason = "reserved_metadata_file";
  else if (normalizedExtension === null) eligibilityReason = "missing_extension";
  else if (IMAGE_EXTENSIONS.has(normalizedExtension)) {
    eligible = true;
    filesystemMediaType = "image";
    eligibilityReason = "supported_image_extension";
  } else if (VIDEO_EXTENSIONS.has(normalizedExtension)) {
    eligible = true;
    filesystemMediaType = "video";
    eligibilityReason = "supported_video_extension";
  } else eligibilityReason = "unsupported_extension";

  return {
    relativePathKey: canonical.relativePathKey,
    eligible,
    filesystemMediaType,
    normalizedExtension,
    eligibilityReason,
  };
}

function evaluateFilesystemMediaEligibility({ filesystemFiles } = {}) {
  if (!Array.isArray(filesystemFiles)) fail("invalid_filesystem_input", "filesystemFiles must be an array");
  const seen = new Set();
  const files = filesystemFiles.map((file, index) => {
    const result = resultForFile(file, index);
    if (seen.has(result.relativePathKey)) fail("duplicate_filesystem_identity", `Duplicate filesystem relativePathKey: ${result.relativePathKey}`);
    seen.add(result.relativePathKey);
    return result;
  }).sort((left, right) => compareText(left.relativePathKey, right.relativePathKey));
  return deepFreeze({ contractVersion: FILESYSTEM_MEDIA_ELIGIBILITY_CONTRACT_VERSION, files });
}

function validateFilesystemMediaEligibility(result, { filesystemFiles } = {}) {
  if (!result || typeof result !== "object" || result.contractVersion !== FILESYSTEM_MEDIA_ELIGIBILITY_CONTRACT_VERSION || !Array.isArray(result.files)) {
    fail("invalid_eligibility_result", "Filesystem media eligibility contract version or shape is invalid");
  }
  const expected = evaluateFilesystemMediaEligibility({ filesystemFiles });
  if (result.files.length !== expected.files.length) fail("invalid_eligibility_result", "Eligibility result does not cover every filesystem file");
  for (let index = 0; index < expected.files.length; index++) {
    const left = result.files[index];
    const right = expected.files[index];
    if (!left || Object.keys(right).some(key => left[key] !== right[key]) || Object.keys(left).length !== Object.keys(right).length) {
      fail("invalid_eligibility_result", `Eligibility result differs from the frozen vocabulary at index ${index}`);
    }
  }
  return true;
}

module.exports = {
  evaluateFilesystemMediaEligibility,
  validateFilesystemMediaEligibility,
};
