"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  observePlatformTree,
} = require("../../internal/library/observation.js");
const {
  createTempRoot,
  createWork,
  writeFile,
} = require("../support/filesystem.js");

function onlyWork(snapshot) {
  return snapshot.authors[0].works[0];
}

function allFieldNames(value, result = new Set()) {
  if (!value || typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value)) {
    result.add(key);
    allFieldNames(item, result);
  }
  return result;
}

test("连续snapshot只反映当前filesystem事实，不生成change/rename/deletion语义", (t) => {
  const root = createTempRoot(t);
  const workPath = createWork(root, "author", "2026-01-01_00-00-00_work", {
    metadata: '{"id":"first"}',
    files: { "a.jpg": "first file" },
  });

  const observedA = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
  });
  assert.equal(onlyWork(observedA).metadata.sourceText, '{"id":"first"}');
  assert.deepEqual(
    onlyWork(observedA).filesystemFiles.map((file) => file.relativePath),
    ["a.jpg"],
  );

  writeFile(
    path.join(workPath, "metadata.json"),
    '{"id":"second","text":"changed"}',
  );
  const observedB = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
  });
  assert.equal(
    onlyWork(observedB).metadata.sourceText,
    '{"id":"second","text":"changed"}',
  );
  assert.notEqual(
    onlyWork(observedB).metadata.size,
    onlyWork(observedA).metadata.size,
  );

  writeFile(path.join(workPath, "nested", "b.bin"), Buffer.from([1, 2, 3]));
  const observedC = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
  });
  assert.deepEqual(
    onlyWork(observedC).filesystemFiles.map((file) => file.relativePath),
    ["a.jpg", "nested\\b.bin"],
  );

  fs.rmSync(path.join(workPath, "a.jpg"));
  const observedD = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
  });
  assert.deepEqual(
    onlyWork(observedD).filesystemFiles.map((file) => file.relativePath),
    ["nested\\b.bin"],
  );

  fs.renameSync(
    path.join(workPath, "nested", "b.bin"),
    path.join(workPath, "nested", "renamed.bin"),
  );
  const observedE = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
  });
  assert.deepEqual(
    onlyWork(observedE).filesystemFiles.map((file) => file.relativePath),
    ["nested\\renamed.bin"],
  );

  const forbidden = [
    "added",
    "modified",
    "deleted",
    "removed",
    "renamed",
    "tombstone",
    "scanId",
    "revision",
    "generation",
  ];
  const names = allFieldNames(observedE);
  for (const name of forbidden) assert.equal(names.has(name), false, name);
});
