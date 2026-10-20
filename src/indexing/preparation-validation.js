"use strict";

const path = require("node:path");

const { adapterForPlatform } = require("../metadata/index.js");
const {
  COLLECTION_STATES,
  FILESYSTEM_OBSERVATION_CONTRACT_VERSION,
  PRESENCE_STATES,
} = require("../library/observation.js");
const { normalizeRelativePath } = require("../library/paths.js");
const { fail } = require("./preparation-contract.js");

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function assertText(value, field) {
  if (typeof value !== "string" || value.length === 0)
    fail("invalid_platform_observation", `${field} must be non-empty text`);
}

function assertMtimeNs(value, field, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "bigint" || value < 0n)
    fail(
      "invalid_platform_observation",
      `${field} must be a non-negative BigInt${nullable ? " or null" : ""}`,
    );
}

function assertCollectionState(value, field) {
  if (!COLLECTION_STATES.includes(value))
    fail(
      "invalid_platform_observation",
      `${field} has an unsupported collection state`,
    );
}

function assertPresenceState(value, field) {
  if (!PRESENCE_STATES.includes(value))
    fail(
      "invalid_platform_observation",
      `${field} has an unsupported presence state`,
    );
}

function assertRelativeIdentity(relativePath, relativePathKey, field) {
  let normalized;
  try {
    normalized = normalizeRelativePath(relativePath);
  } catch {
    fail(
      "invalid_platform_observation",
      `${field} has an invalid relative path`,
    );
  }
  if (
    normalized.relativePath !== relativePath ||
    normalized.relativePathKey !== relativePathKey
  ) {
    fail(
      "invalid_platform_observation",
      `${field} does not match the shared relative path identity contract`,
    );
  }
}

function validateMetadataObservation(metadata, work) {
  if (!isPlainObject(metadata))
    fail(
      "invalid_platform_observation",
      "WorkObservation.metadata must be a plain object",
    );
  assertPresenceState(metadata.state, "WorkObservation.metadata.state");
  assertRelativeIdentity(
    metadata.relativePath,
    metadata.relativePathKey,
    "WorkObservation.metadata",
  );
  const expected = normalizeRelativePath(
    `${work.workRelativePath}\\metadata.json`,
  );
  if (
    metadata.relativePath !== expected.relativePath ||
    metadata.relativePathKey !== expected.relativePathKey
  ) {
    fail(
      "invalid_platform_observation",
      "WorkObservation.metadata identity does not belong to the work",
    );
  }
  if (metadata.state === "present") {
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0)
      fail(
        "invalid_platform_observation",
        "Present metadata size must be a non-negative safe integer",
      );
    assertMtimeNs(metadata.mtimeNs, "WorkObservation.metadata.mtimeNs");
    if (typeof metadata.sourceText !== "string")
      fail(
        "invalid_platform_observation",
        "Present metadata sourceText must be text",
      );
  } else if (metadata.sourceText !== null) {
    fail(
      "invalid_platform_observation",
      "Non-present metadata must not carry sourceText",
    );
  }
}

function validateFilesystemFile(file, index) {
  if (!isPlainObject(file))
    fail(
      "invalid_platform_observation",
      `filesystemFiles[${index}] must be a plain object`,
    );
  assertRelativeIdentity(
    file.relativePath,
    file.relativePathKey,
    `filesystemFiles[${index}]`,
  );
  if (file.fileName !== path.win32.basename(file.relativePath))
    fail(
      "invalid_platform_observation",
      `filesystemFiles[${index}].fileName does not match relativePath`,
    );
  if (file.extension !== path.win32.extname(file.fileName))
    fail(
      "invalid_platform_observation",
      `filesystemFiles[${index}].extension does not match fileName`,
    );
  if (file.entryType !== "regular_file")
    fail(
      "invalid_platform_observation",
      `filesystemFiles[${index}] is not a regular file`,
    );
  if (!Number.isSafeInteger(file.size) || file.size < 0)
    fail(
      "invalid_platform_observation",
      `filesystemFiles[${index}].size is invalid`,
    );
  assertMtimeNs(file.mtimeNs, `filesystemFiles[${index}].mtimeNs`);
}

function validateWorkObservation(work, author, platformId) {
  if (!isPlainObject(work))
    fail(
      "invalid_platform_observation",
      "WorkObservation must be a plain object",
    );
  if (
    work.platformId !== platformId ||
    work.authorDirectoryName !== author.authorDirectoryName
  ) {
    fail(
      "invalid_platform_observation",
      "WorkObservation parent identity mismatch",
    );
  }
  assertText(work.workDirectoryName, "WorkObservation.workDirectoryName");
  assertPresenceState(work.state, "WorkObservation.state");
  assertRelativeIdentity(
    work.workRelativePath,
    work.workRelativePathKey,
    "WorkObservation",
  );
  const expected = normalizeRelativePath(
    `${author.authorDirectoryName}\\${work.workDirectoryName}`,
  );
  if (
    work.workRelativePath !== expected.relativePath ||
    work.workRelativePathKey !== expected.relativePathKey
  ) {
    fail(
      "invalid_platform_observation",
      "WorkObservation identity does not match its directory names",
    );
  }
  assertMtimeNs(work.workDirMtimeNs, "WorkObservation.workDirMtimeNs");
  assertCollectionState(
    work.filesystemFilesState,
    "WorkObservation.filesystemFilesState",
  );
  validateMetadataObservation(work.metadata, work);
  if (!Array.isArray(work.diagnostics))
    fail(
      "invalid_platform_observation",
      "WorkObservation.diagnostics must be an array",
    );
  if (work.state === "present") {
    if (!Array.isArray(work.filesystemFiles))
      fail(
        "invalid_platform_observation",
        "Present WorkObservation.filesystemFiles must be an array",
      );
  } else if (
    work.filesystemFiles !== null ||
    work.filesystemFilesState !== "incomplete"
  ) {
    fail(
      "invalid_platform_observation",
      "Unreadable WorkObservation must carry an incomplete null filesystem collection",
    );
  }
  const seen = new Set();
  for (let index = 0; index < (work.filesystemFiles || []).length; index++) {
    const file = work.filesystemFiles[index];
    validateFilesystemFile(file, index);
    if (seen.has(file.relativePathKey))
      fail(
        "duplicate_filesystem_identity",
        `Duplicate filesystem identity in WorkObservation: ${file.relativePathKey}`,
      );
    seen.add(file.relativePathKey);
  }
}

function validateAuthorObservation(author, platformId) {
  if (!isPlainObject(author))
    fail(
      "invalid_platform_observation",
      "AuthorObservation must be a plain object",
    );
  if (author.platformId !== platformId)
    fail(
      "invalid_platform_observation",
      "AuthorObservation platform identity mismatch",
    );
  assertText(
    author.authorDirectoryName,
    "AuthorObservation.authorDirectoryName",
  );
  assertPresenceState(author.state, "AuthorObservation.state");
  assertRelativeIdentity(
    author.authorRelativePath,
    author.authorRelativePathKey,
    "AuthorObservation",
  );
  const expected = normalizeRelativePath(author.authorDirectoryName);
  if (
    author.authorRelativePath !== expected.relativePath ||
    author.authorRelativePathKey !== expected.relativePathKey
  ) {
    fail(
      "invalid_platform_observation",
      "AuthorObservation identity does not match its directory name",
    );
  }
  assertMtimeNs(author.authorDirMtimeNs, "AuthorObservation.authorDirMtimeNs");
  assertCollectionState(author.worksState, "AuthorObservation.worksState");
  if (!Array.isArray(author.diagnostics))
    fail(
      "invalid_platform_observation",
      "AuthorObservation.diagnostics must be an array",
    );
  if (author.state === "present") {
    if (!Array.isArray(author.works))
      fail(
        "invalid_platform_observation",
        "Present AuthorObservation.works must be an array",
      );
    if (
      !Number.isSafeInteger(author.childWorkCountObserved) ||
      author.childWorkCountObserved !== author.works.length
    ) {
      fail(
        "invalid_platform_observation",
        "AuthorObservation.childWorkCountObserved must equal observed works length",
      );
    }
  } else if (
    author.works !== null ||
    author.childWorkCountObserved !== null ||
    author.worksState !== "incomplete"
  ) {
    fail(
      "invalid_platform_observation",
      "Unreadable AuthorObservation must carry an incomplete null work collection",
    );
  }
  const seen = new Set();
  for (const work of author.works || []) {
    validateWorkObservation(work, author, platformId);
    if (seen.has(work.workRelativePathKey))
      fail(
        "duplicate_work_observation_identity",
        `Duplicate work observation identity: ${work.workRelativePathKey}`,
      );
    seen.add(work.workRelativePathKey);
  }
}

function validatePlatformObservation(observation) {
  if (!isPlainObject(observation))
    fail(
      "invalid_platform_observation",
      "PlatformObservation must be a plain object",
    );
  if (observation.contractVersion !== FILESYSTEM_OBSERVATION_CONTRACT_VERSION) {
    fail(
      "unsupported_filesystem_observation_contract",
      "PlatformObservation contract version is unsupported",
    );
  }
  assertText(observation.platformId, "PlatformObservation.platformId");
  if (!adapterForPlatform(observation.platformId))
    fail(
      "unsupported_platform",
      `Unknown platformId: ${observation.platformId}`,
    );
  assertPresenceState(observation.state, "PlatformObservation.state");
  assertCollectionState(
    observation.authorsState,
    "PlatformObservation.authorsState",
  );
  if (!Array.isArray(observation.diagnostics))
    fail(
      "invalid_platform_observation",
      "PlatformObservation.diagnostics must be an array",
    );
  if (observation.state === "present") {
    if (!Array.isArray(observation.authors))
      fail(
        "invalid_platform_observation",
        "Present PlatformObservation.authors must be an array",
      );
  } else if (
    observation.authors !== null ||
    observation.authorsState !== "incomplete"
  ) {
    fail(
      "invalid_platform_observation",
      "Non-present PlatformObservation must carry an incomplete null author collection",
    );
  }
  const seen = new Set();
  for (const author of observation.authors || []) {
    validateAuthorObservation(author, observation.platformId);
    if (seen.has(author.authorRelativePathKey))
      fail(
        "duplicate_author_observation_identity",
        `Duplicate author observation identity: ${author.authorRelativePathKey}`,
      );
    seen.add(author.authorRelativePathKey);
  }
  return observation;
}

module.exports = { validatePlatformObservation };
