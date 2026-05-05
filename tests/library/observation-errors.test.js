"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  NODE_FS_IO,
  expectedErrorDiagnostic,
  observePlatformTree,
  safeFileSize,
} = require("../../internal/library/observer.js");
const {
  createTempRoot,
  createWork,
  writeFile,
} = require("../support/filesystem.js");

function osError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

test("root missing/file与非法platform参数边界明确", (t) => {
  const root = createTempRoot(t);
  const missing = observePlatformTree({
    platformId: "pixiv",
    observationRoot: path.join(root, "missing"),
  });
  assert.equal(missing.state, "missing");
  assert.equal(missing.authorsState, "incomplete");
  assert.equal(missing.authors, null);
  assert.deepEqual(missing.diagnostics, [
    {
      code: "root_missing",
      path: ".",
      operation: "root_lstat",
      osCode: "ENOENT",
    },
  ]);
  const file = path.join(root, "root-file");
  writeFile(file, "x");
  const notDirectory = observePlatformTree({
    platformId: "pixiv",
    observationRoot: file,
  });
  assert.equal(notDirectory.state, "unreadable");
  assert.equal(notDirectory.diagnostics[0].code, "root_not_directory");
  assert.throws(
    () => observePlatformTree({ platformId: "unknown", observationRoot: root }),
    /Unknown platformId/,
  );
  assert.throws(
    () =>
      observePlatformTree({ platformId: "pixiv", observationRoot: "relative" }),
    /absolute path/,
  );
});

test("author/work enumeration failure与成功空目录语义不同", (t) => {
  const root = createTempRoot(t);
  const workPath = createWork(root, "author-a", "2026-01-01_00-00-00_work", {
    metadata: "{}",
  });
  createWork(root, "author-empty", "2026-01-01_00-00-00_empty", {});
  const authorPath = path.join(root, "author-a");
  const authorIo = {
    ...NODE_FS_IO,
    readdir(target) {
      if (target === authorPath) throw osError("EACCES");
      return NODE_FS_IO.readdir(target);
    },
  };
  const authorFailed = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
    io: authorIo,
  }).authors.find((author) => author.authorDirectoryName === "author-a");
  assert.equal(authorFailed.state, "unreadable");
  assert.equal(authorFailed.worksState, "incomplete");
  assert.equal(authorFailed.childWorkCountObserved, null);
  assert.equal(authorFailed.works, null);
  assert.equal(authorFailed.diagnostics[0].code, "entry_unreadable");

  const workIo = {
    ...NODE_FS_IO,
    readdir(target) {
      if (target === workPath) throw osError("EPERM");
      return NODE_FS_IO.readdir(target);
    },
  };
  const workFailedAuthor = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
    io: workIo,
  }).authors.find((author) => author.authorDirectoryName === "author-a");
  assert.equal(workFailedAuthor.state, "present");
  assert.equal(workFailedAuthor.childWorkCountObserved, 1);
  assert.equal(workFailedAuthor.works[0].state, "unreadable");
  assert.equal(workFailedAuthor.works[0].filesystemFilesState, "incomplete");
  assert.equal(workFailedAuthor.works[0].filesystemFiles, null);
  assert.equal(workFailedAuthor.works[0].metadata.state, "unreadable");

  const normalEmpty = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
  }).authors.find((author) => author.authorDirectoryName === "author-empty")
    .works[0];
  assert.equal(normalEmpty.state, "present");
  assert.equal(normalEmpty.filesystemFilesState, "complete");
  assert.deepEqual(normalEmpty.filesystemFiles, []);
  assert.equal(normalEmpty.metadata.state, "missing");
});

test("metadata read race返回unstable而不组合跨版本事实", (t) => {
  const root = createTempRoot(t);
  const workPath = createWork(root, "author", "2026-01-01_00-00-00_work", {
    metadata: '{"v":1}',
  });
  const metadataPath = path.join(workPath, "metadata.json");
  const racingIo = {
    ...NODE_FS_IO,
    readFile(target) {
      const value = NODE_FS_IO.readFile(target);
      if (target === metadataPath) fs.appendFileSync(target, " ");
      return value;
    },
  };
  const work = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
    io: racingIo,
  }).authors[0].works[0];
  assert.equal(work.metadata.state, "unstable");
  assert.equal(work.metadata.sourceText, null);
  assert.equal(work.metadata.size, null);
  assert.equal(work.metadata.mtimeNs, null);
  assert.ok(
    work.diagnostics.some(
      (item) => item.code === "metadata_changed_during_observation",
    ),
  );
});

test("metadata unreadable和file stat race产生稳定diagnostic而不伪造空事实", (t) => {
  const root = createTempRoot(t);
  const workPath = createWork(root, "author", "2026-01-01_00-00-00_work", {
    metadata: "{}",
    files: { "gone.bin": "content", "kept.bin": "ok" },
  });
  const metadataPath = path.join(workPath, "metadata.json");
  const gonePath = path.join(workPath, "gone.bin");
  const io = {
    ...NODE_FS_IO,
    readFile(target) {
      if (target === metadataPath) throw osError("EPERM");
      return NODE_FS_IO.readFile(target);
    },
    lstat(target) {
      if (target === gonePath) throw osError("ENOENT");
      return NODE_FS_IO.lstat(target);
    },
  };
  const work = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
    io,
  }).authors[0].works[0];
  assert.equal(work.metadata.state, "unreadable");
  assert.ok(
    work.diagnostics.some(
      (item) =>
        item.code === "entry_unreadable" && item.operation === "metadata_read",
    ),
  );
  assert.ok(
    work.diagnostics.some(
      (item) =>
        item.code === "entry_missing_during_observation" &&
        item.path.endsWith("gone.bin"),
    ),
  );
  assert.equal(work.filesystemFilesState, "incomplete");
  assert.deepEqual(
    work.filesystemFiles.map((file) => file.fileName),
    ["kept.bin"],
  );
  const sorted = work.diagnostics
    .slice()
    .sort((a, b) =>
      a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : a.operation < b.operation
            ? -1
            : a.operation > b.operation
              ? 1
              : a.code < b.code
                ? -1
                : 1,
    );
  assert.deepEqual(work.diagnostics, sorted);
});

test("platform/author/nested集合完整性不依赖diagnostic数量推断", (t) => {
  const root = createTempRoot(t);
  const workPath = createWork(root, "author", "2026-01-01_00-00-00_work", {
    metadata: "{}",
    files: { "nested/a.jpg": "x" },
  });
  const authorPath = path.join(root, "author");
  const nestedPath = path.join(workPath, "nested");

  const platformIo = {
    ...NODE_FS_IO,
    lstat(target) {
      if (target === authorPath) throw osError("ENOENT");
      return NODE_FS_IO.lstat(target);
    },
  };
  const platform = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
    io: platformIo,
  });
  assert.equal(platform.state, "present");
  assert.equal(platform.authorsState, "incomplete");
  assert.deepEqual(platform.authors, []);

  const authorIo = {
    ...NODE_FS_IO,
    lstat(target) {
      if (target === workPath) throw osError("ENOENT");
      return NODE_FS_IO.lstat(target);
    },
  };
  const author = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
    io: authorIo,
  }).authors[0];
  assert.equal(author.state, "present");
  assert.equal(author.worksState, "incomplete");
  assert.deepEqual(author.works, []);

  const nestedIo = {
    ...NODE_FS_IO,
    readdir(target) {
      if (target === nestedPath) throw osError("EPERM");
      return NODE_FS_IO.readdir(target);
    },
  };
  const work = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
    io: nestedIo,
  }).authors[0].works[0];
  assert.equal(work.state, "present");
  assert.equal(work.filesystemFilesState, "incomplete");
  assert.deepEqual(work.filesystemFiles, []);
  assert.ok(
    work.diagnostics.some(
      (item) =>
        item.code === "entry_unreadable" &&
        item.operation === "directory_readdir",
    ),
  );
});

test("metadata显式按UTF-8解码且invalid byte sequence fail closed", (t) => {
  const root = createTempRoot(t);
  const workPath = createWork(root, "author", "2026-01-01_00-00-00_work", {});
  writeFile(path.join(workPath, "metadata.json"), Buffer.from([0xc3, 0x28]));
  const work = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
  }).authors[0].works[0];
  assert.equal(work.metadata.state, "unreadable");
  assert.equal(work.metadata.sourceText, null);
  assert.equal(work.metadata.size, 2);
  assert.equal(typeof work.metadata.mtimeNs, "bigint");
  assert.deepEqual(work.diagnostics, [
    {
      code: "metadata_utf8_decode_failed",
      path: "author\\2026-01-01_00-00-00_work\\metadata.json",
      operation: "metadata_decode",
      osCode: null,
    },
  ]);
});

test("expected OS error分类与unsafe size fail closed", () => {
  assert.deepEqual(
    expectedErrorDiagnostic(
      osError("ENOENT"),
      "a",
      "stat",
      "entry_stat_failed",
    ),
    {
      code: "entry_missing_during_observation",
      path: "a",
      operation: "stat",
      osCode: "ENOENT",
    },
  );
  assert.deepEqual(
    expectedErrorDiagnostic(osError("EPERM"), "a", "read", "entry_stat_failed"),
    { code: "entry_unreadable", path: "a", operation: "read", osCode: "EPERM" },
  );
  assert.throws(
    () => safeFileSize(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
    /MAX_SAFE_INTEGER/,
  );
  assert.equal(safeFileSize(123n), 123);
});

test("symlink/broken symlink不跟随；无权限创建时明确skip", (t) => {
  const root = createTempRoot(t);
  const platformRoot = path.join(root, "platform");
  const external = path.join(root, "external");
  fs.mkdirSync(platformRoot);
  fs.mkdirSync(external);
  writeFile(path.join(external, "secret.bin"), "outside");
  const workPath = createWork(
    platformRoot,
    "author",
    "2026-01-01_00-00-00_work",
    { metadata: "{}", files: { "inside.bin": "inside" } },
  );
  try {
    fs.symlinkSync(
      path.join(external, "secret.bin"),
      path.join(workPath, "linked.bin"),
      "file",
    );
    fs.symlinkSync(
      path.join(external, "missing.bin"),
      path.join(workPath, "broken.bin"),
      "file",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error.code || "UNKNOWN")) {
      t.skip(`symlink unavailable: ${error.code || "UNKNOWN"}`);
      return;
    }
    throw error;
  }
  const work = observePlatformTree({
    platformId: "pixiv",
    observationRoot: platformRoot,
  }).authors[0].works[0];
  assert.deepEqual(
    work.filesystemFiles.map((file) => file.fileName),
    ["inside.bin"],
  );
  assert.equal(
    work.filesystemFilesState,
    "complete",
    "明确跳过reparse不等同枚举不完整",
  );
  assert.equal(
    work.diagnostics.filter((item) => item.code === "reparse_not_followed")
      .length,
    2,
  );

  const rootLink = path.join(root, "platform-link");
  try {
    fs.symlinkSync(
      platformRoot,
      rootLink,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    t.skip(`root symlink unavailable: ${error.code || "UNKNOWN"}`);
    return;
  }
  const linkedRoot = observePlatformTree({
    platformId: "pixiv",
    observationRoot: rootLink,
  });
  assert.equal(linkedRoot.state, "unreadable");
  assert.equal(linkedRoot.authors, null);
  assert.equal(linkedRoot.diagnostics[0].code, "reparse_not_followed");
});
