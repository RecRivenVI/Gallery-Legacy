"use strict";

const path = require("node:path");

const { normalizeRelativePath } = require("../../library/paths.js");
const { compareText, fail } = require("./contract.js");

function canonicalFilesystemFiles(filesystemFiles) {
  if (!Array.isArray(filesystemFiles)) fail("invalid_filesystem_input", "filesystemFiles must be an array");
  const seen = new Set();
  const result = filesystemFiles.map((file, inputIndex) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) fail("invalid_filesystem_input", `filesystemFiles[${inputIndex}] must be an object`);
    let identity;
    try { identity = normalizeRelativePath(file.relativePath); }
    catch { fail("invalid_filesystem_identity", `filesystemFiles[${inputIndex}] has an invalid relativePath`); }
    if (file.relativePathKey !== identity.relativePathKey) fail("invalid_filesystem_identity", `filesystemFiles[${inputIndex}] relativePathKey does not match the shared path contract`);
    const fileName = path.win32.basename(identity.relativePath);
    if (file.fileName !== fileName) fail("invalid_filesystem_identity", `filesystemFiles[${inputIndex}] fileName does not match relativePath`);
    if (seen.has(identity.relativePathKey)) fail("duplicate_filesystem_identity", `Duplicate filesystem relativePathKey: ${identity.relativePathKey}`);
    seen.add(identity.relativePathKey);
    return {
      fileName,
      fileNameKey: fileName.toLowerCase(),
      relativePath: identity.relativePath,
      relativePathKey: identity.relativePathKey,
    };
  });
  return result.sort((left, right) => compareText(left.relativePathKey, right.relativePathKey));
}

module.exports = { canonicalFilesystemFiles };
