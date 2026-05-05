"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  FILESYSTEM_MEDIA_ELIGIBILITY_CONTRACT_VERSION,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  evaluateFilesystemMediaEligibility,
  validateFilesystemMediaEligibility,
} = require("../../internal/media/index.js");
const { normalizeRelativePath } = require("../../internal/library/paths.js");

function file(relativePath, options = {}) {
  const identity = normalizeRelativePath(relativePath);
  const fileName = path.win32.basename(identity.relativePath);
  return {
    relativePath: identity.relativePath,
    relativePathKey: identity.relativePathKey,
    directoryRelativePath:
      path.win32.dirname(identity.relativePath) === "."
        ? null
        : path.win32.dirname(identity.relativePath),
    fileName,
    extension: path.win32.extname(fileName),
    size: options.size ?? 1,
    mtimeNs: options.mtimeNs ?? 1700000000123456789n,
    entryType: "regular_file",
  };
}

function classify(relativePath) {
  return evaluateFilesystemMediaEligibility({
    filesystemFiles: [file(relativePath)],
  }).files[0];
}

test("Eligibility V1固定扩展名词汇不依赖管理员rules", () => {
  assert.equal(FILESYSTEM_MEDIA_ELIGIBILITY_CONTRACT_VERSION, 1);
  assert.deepEqual(SUPPORTED_IMAGE_EXTENSIONS, [
    "avif",
    "bmp",
    "gif",
    "ico",
    "jpeg",
    "jpg",
    "png",
    "svg",
    "tif",
    "tiff",
    "webp",
  ]);
  assert.deepEqual(SUPPORTED_VIDEO_EXTENSIONS, [
    "avi",
    "m4v",
    "mkv",
    "mov",
    "mp4",
    "ogv",
    "webm",
  ]);
  for (const extension of SUPPORTED_IMAGE_EXTENSIONS)
    assert.equal(
      classify(`file.${extension}`).filesystemMediaType,
      "image",
      extension,
    );
  for (const extension of SUPPORTED_VIDEO_EXTENSIONS)
    assert.equal(
      classify(`file.${extension}`).filesystemMediaType,
      "video",
      extension,
    );
});

test("uppercase、多点、nested、中文与emoji文件名按最后extension确定分类", () => {
  assert.deepEqual(classify("嵌套 目录\\图😀.final.JpG"), {
    relativePathKey: "嵌套 目录\\图😀.final.jpg",
    eligible: true,
    filesystemMediaType: "image",
    normalizedExtension: "jpg",
    eligibilityReason: "supported_image_extension",
  });
  assert.equal(classify("VIDEO.MP4").filesystemMediaType, "video");
  assert.equal(classify("clip.WebM").filesystemMediaType, "video");
});

test("unsupported/no-extension/trailing-dot/metadata明确ineligible且不伪装attachment", () => {
  assert.equal(
    classify("readme.txt").eligibilityReason,
    "unsupported_extension",
  );
  assert.equal(
    classify("archive.zip").eligibilityReason,
    "unsupported_extension",
  );
  assert.equal(classify("LICENSE").eligibilityReason, "missing_extension");
  assert.equal(classify("trailing.").eligibilityReason, "missing_extension");
  assert.equal(
    classify("metadata.json").eligibilityReason,
    "reserved_metadata_file",
  );
  assert.equal(classify(".jpg").eligibilityReason, "missing_extension");
});

test("leading-dot presentation visibility不污染type eligibility", () => {
  const hidden = classify(".hidden.JPG");
  assert.equal(hidden.eligible, true);
  assert.equal(hidden.filesystemMediaType, "image");
});

test("eligibility覆盖、顺序与输入事实严格验证且结果冻结", () => {
  const files = [file("z.MOV"), file("A.PNG")];
  const result = evaluateFilesystemMediaEligibility({ filesystemFiles: files });
  assert.deepEqual(
    result.files.map((item) => item.relativePathKey),
    ["a.png", "z.mov"],
  );
  assert.equal(
    validateFilesystemMediaEligibility(result, { filesystemFiles: files }),
    true,
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.files), true);
  const forged = structuredClone(result);
  forged.files[0].eligible = false;
  assert.throws(
    () =>
      validateFilesystemMediaEligibility(forged, { filesystemFiles: files }),
    (error) => error.code === "invalid_eligibility_result",
  );
  assert.throws(
    () =>
      evaluateFilesystemMediaEligibility({
        filesystemFiles: [{ ...files[0], extension: ".mp4" }],
      }),
    (error) => error.code === "invalid_filesystem_file",
  );
  assert.throws(
    () =>
      evaluateFilesystemMediaEligibility({
        filesystemFiles: [{ ...files[0], size: Number.MAX_SAFE_INTEGER + 1 }],
      }),
    (error) => error.code === "invalid_filesystem_size",
  );
  assert.throws(
    () =>
      evaluateFilesystemMediaEligibility({
        filesystemFiles: [{ ...files[0], mtimeNs: 1 }],
      }),
    (error) => error.code === "invalid_filesystem_mtime",
  );
});
