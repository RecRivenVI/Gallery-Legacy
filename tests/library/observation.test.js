"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { adapterForPlatform } = require("../../internal/metadata/index.js");
const { adaptJson } = require("../../internal/metadata/contract.js");
const { normalizeRelativePath } = require("../../internal/library/paths.js");
const {
  FILESYSTEM_OBSERVATION_CONTRACT_VERSION,
  MTIME_AUTHORITY_LIMITATION,
  mtimeNsToSafeMs,
  observePlatformTree,
  workObservationToBuilderSourceRecord,
} = require("../../internal/library/observation.js");
const {
  codeUnitSort,
  createTempRoot,
  createWork,
  treeState,
  writeFile,
} = require("../support/filesystem.js");

test("真实temp树冻结platform/author/work/filesystemFiles contract且Observer零修改", (t) => {
  const root = createTempRoot(t);
  writeFile(path.join(root, "root ordinary.txt"), "root");
  const sourceText = '\uFEFF{\r\n  "text": "line 1\\nline 2\u200b😀"\r\n}\r\n';
  const workPath = createWork(
    root,
    "Author Mixed",
    "2026-01-02_03-04-05_Work One",
    {
      metadata: sourceText,
      files: {
        "Nested Folder/IMAGE.JPG": Buffer.from([0, 1, 2, 3]),
        "emoji😀 file.bin": Buffer.from([9, 8, 7]),
      },
    },
  );
  createWork(root, "Author Mixed", "2026-01-03_03-04-05_Missing Metadata", {
    files: {},
  });
  writeFile(path.join(root, "Author Mixed", "author note.txt"), "note");
  createWork(root, "中文作者", "2026-02-01_00-00-00_作品", {
    metadata: "[]",
    files: { "空 格.txt": "x" },
  });
  createWork(root, "emoji😀作者", "2026-02-02_00-00-00_作品", {
    metadata: "{}",
    files: {},
  });
  const before = treeState(root);

  const first = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
  });
  const second = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
  });
  assert.deepEqual(second, first);
  assert.deepEqual(treeState(root), before, "Observer不得改变content或mtime");
  assert.equal(first.contractVersion, FILESYSTEM_OBSERVATION_CONTRACT_VERSION);
  assert.equal(
    FILESYSTEM_OBSERVATION_CONTRACT_VERSION,
    2,
    "required completeness fields bump the observation contract",
  );
  assert.equal(first.platformId, "pixiv");
  assert.equal(first.state, "present");
  assert.equal(first.authorsState, "complete");
  assert.deepEqual(
    first.authors.map((author) => author.authorDirectoryName),
    codeUnitSort(["Author Mixed", "中文作者", "emoji😀作者"]),
  );
  assert.ok(
    first.diagnostics.some(
      (item) =>
        item.code === "unexpected_platform_file" &&
        item.path === "root ordinary.txt",
    ),
  );

  const author = first.authors.find(
    (value) => value.authorDirectoryName === "Author Mixed",
  );
  assert.equal(author.state, "present");
  assert.equal(author.worksState, "complete");
  assert.equal(author.authorRelativePath, "Author Mixed");
  assert.equal(author.authorRelativePathKey, "author mixed");
  assert.equal(typeof author.authorDirMtimeNs, "bigint");
  assert.equal(author.childWorkCountObserved, 2);
  assert.ok(
    author.diagnostics.some((item) => item.code === "unexpected_author_file"),
  );

  const work = author.works.find((value) =>
    value.workDirectoryName.endsWith("Work One"),
  );
  assert.equal(work.state, "present");
  assert.equal(work.filesystemFilesState, "complete");
  assert.equal(
    work.workRelativePath,
    "Author Mixed\\2026-01-02_03-04-05_Work One",
  );
  assert.equal(
    work.workRelativePathKey,
    "author mixed\\2026-01-02_03-04-05_work one",
  );
  assert.equal(typeof work.workDirMtimeNs, "bigint");
  assert.equal(work.metadata.state, "present");
  assert.equal(work.metadata.sourceText, sourceText);
  assert.equal(work.metadata.sourceText.charCodeAt(0), 0xfeff, "BOM必须保留");
  assert.equal(
    work.metadata.relativePath,
    `${work.workRelativePath}\\metadata.json`,
  );
  assert.equal(typeof work.metadata.mtimeNs, "bigint");
  assert.equal(
    work.metadata.size,
    Number(
      fs.statSync(path.join(workPath, "metadata.json"), { bigint: true }).size,
    ),
  );
  assert.deepEqual(
    work.filesystemFiles.map((file) => file.relativePath),
    codeUnitSort(["Nested Folder\\IMAGE.JPG", "emoji😀 file.bin"]),
  );
  assert.equal(
    work.filesystemFiles.some((file) => file.fileName === "metadata.json"),
    false,
  );
  const nested = work.filesystemFiles.find(
    (file) => file.fileName === "IMAGE.JPG",
  );
  assert.equal(nested.extension, ".JPG");
  assert.equal(nested.directoryRelativePath, "Nested Folder");
  assert.equal(nested.entryType, "regular_file");
  assert.equal(typeof nested.mtimeNs, "bigint");
  assert.equal(
    nested.mtimeNs,
    fs.statSync(path.join(workPath, "Nested Folder", "IMAGE.JPG"), {
      bigint: true,
    }).mtimeNs,
  );

  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.authors), true);
  assert.throws(() => first.authors.push({}));
  assert.deepEqual(
    observePlatformTree({ platformId: "pixiv", observationRoot: root }),
    second,
  );
});

test("metadata missing/zero-byte/non-object保持filesystem state并由Adapter另行判定", (t) => {
  const root = createTempRoot(t);
  createWork(root, "author", "2026-01-01_00-00-00_missing", {});
  createWork(root, "author", "2026-01-02_00-00-00_zero", { metadata: "" });
  createWork(root, "author", "2026-01-03_00-00-00_array", { metadata: "[]" });
  const observed = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
  });
  const works = Object.fromEntries(
    observed.authors[0].works.map((work) => [
      work.workDirectoryName.split("_").at(-1),
      work,
    ]),
  );
  assert.equal(works.missing.metadata.state, "missing");
  assert.equal(works.missing.metadata.sourceText, null);
  assert.equal(works.zero.metadata.state, "present");
  assert.equal(works.zero.metadata.size, 0);
  assert.equal(works.zero.metadata.sourceText, "");
  assert.equal(works.array.metadata.state, "present");
  assert.equal(works.array.metadata.sourceText, "[]");

  const zeroRecord = workObservationToBuilderSourceRecord(works.zero);
  const zeroAdapted = adaptJson(
    adapterForPlatform("pixiv"),
    zeroRecord.metadataSource,
    zeroRecord,
  );
  assert.equal(zeroAdapted.valid, false);
  assert.equal(zeroAdapted.invalidReason, "malformed_json");
  const arrayRecord = workObservationToBuilderSourceRecord(works.array);
  const arrayAdapted = adaptJson(
    adapterForPlatform("pixiv"),
    arrayRecord.metadataSource,
    arrayRecord,
  );
  assert.equal(arrayAdapted.valid, false);
  assert.equal(arrayAdapted.invalidReason, "metadata_not_object");
  assert.throws(
    () => workObservationToBuilderSourceRecord(works.missing),
    /not readable/,
  );
});

test("所有mtime来自真实BigInt lstat且ns→fallback ms采用整数除法", (t) => {
  const root = createTempRoot(t);
  const workPath = createWork(root, "作者", "2026-01-01_00-00-00_Work", {
    metadata: "{}",
    files: { "nested/文件.dat": "abc" },
  });
  const observed = observePlatformTree({
    platformId: "X",
    observationRoot: root,
  });
  const author = observed.authors[0];
  const work = author.works[0];
  const file = work.filesystemFiles[0];
  assert.equal(
    author.authorDirMtimeNs,
    fs.statSync(path.join(root, "作者"), { bigint: true }).mtimeNs,
  );
  assert.equal(
    work.workDirMtimeNs,
    fs.statSync(workPath, { bigint: true }).mtimeNs,
  );
  assert.equal(
    work.metadata.mtimeNs,
    fs.statSync(path.join(workPath, "metadata.json"), { bigint: true }).mtimeNs,
  );
  assert.equal(
    file.mtimeNs,
    fs.statSync(path.join(workPath, "nested", "文件.dat"), { bigint: true })
      .mtimeNs,
  );
  for (const value of [
    author.authorDirMtimeNs,
    work.workDirMtimeNs,
    work.metadata.mtimeNs,
    file.mtimeNs,
  ])
    assert.equal(typeof value, "bigint");
  assert.equal(mtimeNsToSafeMs(1700000000123456789n), 1700000000123);
  assert.throws(
    () => mtimeNsToSafeMs((BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 1000000n),
    /MAX_SAFE_INTEGER/,
  );
  const bridge = workObservationToBuilderSourceRecord(work);
  assert.equal(
    bridge.directoryTimestampMs,
    Number(work.workDirMtimeNs / 1000000n),
  );
  assert.equal(bridge.mappingContext.workDirMtimeNs, work.workDirMtimeNs);
  assert.equal(bridge.mappingContext.metadataMtimeNs, work.metadata.mtimeNs);
  assert.equal(bridge.mappingContext.metadataSize, work.metadata.size);
  assert.equal(
    Object.values(bridge).some(
      (value) => typeof value === "string" && value.includes(root),
    ),
    false,
    "bridge不得泄漏absolute temp path",
  );
});

test("复用既有relative path语义并明确mtime-authoritative限制", () => {
  assert.deepEqual(normalizeRelativePath("作者/Work/文件.JPG"), {
    relativePath: "作者\\Work\\文件.JPG",
    relativePathKey: "作者\\work\\文件.jpg",
  });
  for (const value of [
    "../escape",
    "a/../b",
    "C:\\absolute",
    "\\\\server\\share",
  ])
    assert.throws(() => normalizeRelativePath(value));
  assert.match(MTIME_AUTHORITY_LIMITATION, /preserve filesystem mtime/i);
  assert.match(MTIME_AUTHORITY_LIMITATION, /does not compute.*hash/i);
});
