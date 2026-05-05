"use strict";

const FILESYSTEM_MEDIA_ELIGIBILITY_CONTRACT_VERSION = 1;

// The fixed extension vocabulary is shared by filesystem eligibility and browse,
// search, thumbnail and rules-validation paths. It is intentionally hardcoded
// here so read-only compatibility rules cannot change future Catalog identity.
const SUPPORTED_IMAGE_EXTENSIONS = Object.freeze([
  "avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp",
]);
const SUPPORTED_VIDEO_EXTENSIONS = Object.freeze([
  "avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm",
]);
const FILESYSTEM_MEDIA_TYPES = Object.freeze(["image", "video"]);

class FilesystemMediaEligibilityContractError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "FilesystemMediaEligibilityContractError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new FilesystemMediaEligibilityContractError(code, message, details);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

module.exports = {
  FILESYSTEM_MEDIA_ELIGIBILITY_CONTRACT_VERSION,
  FILESYSTEM_MEDIA_TYPES,
  FilesystemMediaEligibilityContractError,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  compareText,
  deepFreeze,
  fail,
};
