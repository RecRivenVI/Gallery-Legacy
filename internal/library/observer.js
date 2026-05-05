"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { PLATFORM_REGISTRY } = require("./platforms.js");
const { normalizeRelativePath } = require("./paths.js");
const { FILESYSTEM_OBSERVATION_CONTRACT_VERSION, compareText, deepFreeze, diagnostic, sortDiagnostics } = require("./observation-contract.js");

const NODE_FS_IO = Object.freeze({
  lstat(target) { return fs.lstatSync(target, { bigint: true }); },
  readFile(target) { return fs.readFileSync(target); },
  readdir(target) { return fs.readdirSync(target, { withFileTypes: true }); },
});

function assertIo(io) {
  if (!io || ["lstat", "readFile", "readdir"].some(name => typeof io[name] !== "function")) throw new TypeError("Filesystem observation IO contract is invalid");
}

function safeFileSize(value) {
  if (typeof value !== "bigint" || value < 0n) throw new TypeError("Filesystem stat size must be a non-negative BigInt");
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Filesystem file size exceeds Number.MAX_SAFE_INTEGER");
  return Number(value);
}

function errorCode(error) {
  return error && typeof error.code === "string" ? error.code : "UNKNOWN";
}

function expectedErrorDiagnostic(error, relativePath, operation, fallbackCode) {
  const osCode = errorCode(error);
  const code = osCode === "ENOENT" ? "entry_missing_during_observation"
    : osCode === "EACCES" || osCode === "EPERM" ? "entry_unreadable"
      : fallbackCode;
  return diagnostic(code, relativePath, operation, osCode);
}

function metadataFact(state, relativePath, relativePathKey, values = {}) {
  return {
    state,
    relativePath,
    relativePathKey,
    size: values.size ?? null,
    mtimeNs: values.mtimeNs ?? null,
    sourceText: values.sourceText ?? null,
  };
}

function observeMetadataFile(io, absolutePath, platformRelativePath) {
  const identity = normalizeRelativePath(platformRelativePath);
  let before;
  try { before = io.lstat(absolutePath); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return { metadata: metadataFact("missing", identity.relativePath, identity.relativePathKey), diagnostics: [] };
    return { metadata: metadataFact("unreadable", identity.relativePath, identity.relativePathKey), diagnostics: [expectedErrorDiagnostic(error, identity.relativePath, "metadata_lstat_before", "entry_stat_failed")] };
  }
  if (before.isSymbolicLink()) {
    return { metadata: metadataFact("unreadable", identity.relativePath, identity.relativePathKey), diagnostics: [diagnostic("reparse_not_followed", identity.relativePath, "metadata_lstat", null)] };
  }
  if (!before.isFile()) {
    return { metadata: metadataFact("unreadable", identity.relativePath, identity.relativePathKey), diagnostics: [diagnostic("metadata_not_regular_file", identity.relativePath, "metadata_lstat", null)] };
  }
  let size;
  try { size = safeFileSize(before.size); }
  catch (error) {
    return { metadata: metadataFact("unreadable", identity.relativePath, identity.relativePathKey), diagnostics: [diagnostic("file_size_unsafe", identity.relativePath, "metadata_lstat", error.code || null)] };
  }
  let buffer;
  try { buffer = io.readFile(absolutePath); }
  catch (error) {
    return { metadata: metadataFact("unreadable", identity.relativePath, identity.relativePathKey), diagnostics: [expectedErrorDiagnostic(error, identity.relativePath, "metadata_read", "entry_unreadable")] };
  }
  let after;
  try { after = io.lstat(absolutePath); }
  catch (error) {
    return { metadata: metadataFact("unstable", identity.relativePath, identity.relativePathKey), diagnostics: [expectedErrorDiagnostic(error, identity.relativePath, "metadata_lstat_after", "entry_stat_failed")] };
  }
  if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeNs !== after.mtimeNs || BigInt(buffer.length) !== before.size) {
    return { metadata: metadataFact("unstable", identity.relativePath, identity.relativePathKey), diagnostics: [diagnostic("metadata_changed_during_observation", identity.relativePath, "metadata_verify", null)] };
  }
  const sourceText = buffer.toString("utf8");
  if (!Buffer.from(sourceText, "utf8").equals(buffer)) {
    return {
      metadata: metadataFact("unreadable", identity.relativePath, identity.relativePathKey, { size, mtimeNs: before.mtimeNs }),
      diagnostics: [diagnostic("metadata_utf8_decode_failed", identity.relativePath, "metadata_decode", null)],
    };
  }
  return {
    metadata: metadataFact("present", identity.relativePath, identity.relativePathKey, {
      size,
      mtimeNs: before.mtimeNs,
      // Buffer UTF-8 decoding intentionally preserves a leading BOM code point
      // and does not trim, normalize newlines, parse JSON, or rewrite Unicode.
      sourceText,
    }),
    diagnostics: [],
  };
}

function observeRegularFile(io, absolutePath, workRelativeFilePath, platformRelativeFilePath) {
  const identity = normalizeRelativePath(workRelativeFilePath);
  let stat;
  try { stat = io.lstat(absolutePath); }
  catch (error) { return { file: null, diagnostics: [expectedErrorDiagnostic(error, platformRelativeFilePath, "file_lstat", "entry_stat_failed")] }; }
  if (stat.isSymbolicLink()) return { file: null, diagnostics: [diagnostic("reparse_not_followed", platformRelativeFilePath, "file_lstat", null)] };
  if (!stat.isFile()) return { file: null, diagnostics: [diagnostic("entry_type_changed_during_observation", platformRelativeFilePath, "file_lstat", null)] };
  let size;
  try { size = safeFileSize(stat.size); }
  catch (error) { return { file: null, diagnostics: [diagnostic("file_size_unsafe", platformRelativeFilePath, "file_lstat", error.code || null)] }; }
  const fileName = path.win32.basename(identity.relativePath);
  const directory = path.win32.dirname(identity.relativePath);
  return {
    file: {
      relativePath: identity.relativePath,
      relativePathKey: identity.relativePathKey,
      directoryRelativePath: directory === "." ? null : directory,
      fileName,
      extension: path.win32.extname(fileName),
      size,
      mtimeNs: stat.mtimeNs,
      entryType: "regular_file",
    },
    diagnostics: [],
  };
}

function observeWorkDirectory(io, root, platformId, authorName, workName, workStat) {
  const workIdentity = normalizeRelativePath(`${authorName}\\${workName}`);
  const absoluteWork = path.join(root, authorName, workName);
  const diagnostics = [];
  let entries;
  try { entries = io.readdir(absoluteWork); }
  catch (error) {
    diagnostics.push(expectedErrorDiagnostic(error, workIdentity.relativePath, "work_readdir", "directory_enumeration_failed"));
    const metadataIdentity = normalizeRelativePath(`${workIdentity.relativePath}\\metadata.json`);
    return {
      state: "unreadable",
      platformId,
      authorDirectoryName: authorName,
      workDirectoryName: workName,
      workRelativePath: workIdentity.relativePath,
      workRelativePathKey: workIdentity.relativePathKey,
      workDirMtimeNs: workStat.mtimeNs,
      metadata: metadataFact("unreadable", metadataIdentity.relativePath, metadataIdentity.relativePathKey),
      filesystemFilesState: "incomplete",
      filesystemFiles: null,
      diagnostics: sortDiagnostics(diagnostics),
    };
  }

  const metadataPath = path.join(absoluteWork, "metadata.json");
  const observedMetadata = observeMetadataFile(io, metadataPath, `${workIdentity.relativePath}\\metadata.json`);
  diagnostics.push(...observedMetadata.diagnostics);
  const files = [];
  let filesystemFilesState = "complete";

  function visitDirectory(absoluteDirectory, workRelativeDirectory, knownChildren = null) {
    let children;
    try { children = knownChildren || io.readdir(absoluteDirectory); }
    catch (error) {
      const relative = workRelativeDirectory ? `${workIdentity.relativePath}\\${workRelativeDirectory}` : workIdentity.relativePath;
      diagnostics.push(expectedErrorDiagnostic(error, relative, "directory_readdir", "directory_enumeration_failed"));
      filesystemFilesState = "incomplete";
      return;
    }
    children.sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      const workRelative = workRelativeDirectory ? `${workRelativeDirectory}\\${child.name}` : child.name;
      if (!workRelativeDirectory && child.name === "metadata.json") continue;
      const platformRelative = `${workIdentity.relativePath}\\${workRelative}`;
      const absoluteChild = path.join(absoluteDirectory, child.name);
      let stat;
      try { stat = io.lstat(absoluteChild); }
      catch (error) {
        diagnostics.push(expectedErrorDiagnostic(error, platformRelative, "entry_lstat", "entry_stat_failed"));
        filesystemFilesState = "incomplete";
        continue;
      }
      if (stat.isSymbolicLink()) {
        diagnostics.push(diagnostic("reparse_not_followed", platformRelative, "entry_lstat", null));
        continue;
      }
      if (stat.isDirectory()) {
        visitDirectory(absoluteChild, workRelative);
        continue;
      }
      if (stat.isFile()) {
        const observed = observeRegularFile(io, absoluteChild, workRelative, platformRelative);
        diagnostics.push(...observed.diagnostics);
        if (observed.file) files.push(observed.file);
        else filesystemFilesState = "incomplete";
        continue;
      }
      diagnostics.push(diagnostic("unsupported_entry_type", platformRelative, "entry_lstat", null));
    }
  }

  visitDirectory(absoluteWork, "", entries);
  files.sort((left, right) => compareText(left.relativePath, right.relativePath));
  return {
    state: "present",
    platformId,
    authorDirectoryName: authorName,
    workDirectoryName: workName,
    workRelativePath: workIdentity.relativePath,
    workRelativePathKey: workIdentity.relativePathKey,
    workDirMtimeNs: workStat.mtimeNs,
    metadata: observedMetadata.metadata,
    filesystemFilesState,
    filesystemFiles: files,
    diagnostics: sortDiagnostics(diagnostics),
  };
}

function observeAuthorDirectory(io, root, platformId, authorName, authorStat) {
  const identity = normalizeRelativePath(authorName);
  const absoluteAuthor = path.join(root, authorName);
  const diagnostics = [];
  let entries;
  try { entries = io.readdir(absoluteAuthor); }
  catch (error) {
    diagnostics.push(expectedErrorDiagnostic(error, identity.relativePath, "author_readdir", "directory_enumeration_failed"));
    return {
      state: "unreadable",
      platformId,
      authorDirectoryName: authorName,
      authorRelativePath: identity.relativePath,
      authorRelativePathKey: identity.relativePathKey,
      authorDirMtimeNs: authorStat.mtimeNs,
      childWorkCountObserved: null,
      worksState: "incomplete",
      works: null,
      diagnostics: sortDiagnostics(diagnostics),
    };
  }
  const works = [];
  let worksState = "complete";
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const relative = `${identity.relativePath}\\${entry.name}`;
    const absoluteEntry = path.join(absoluteAuthor, entry.name);
    let stat;
    try { stat = io.lstat(absoluteEntry); }
    catch (error) {
      diagnostics.push(expectedErrorDiagnostic(error, relative, "work_lstat", "entry_stat_failed"));
      worksState = "incomplete";
      continue;
    }
    if (stat.isSymbolicLink()) {
      diagnostics.push(diagnostic("reparse_not_followed", relative, "work_lstat", null));
      continue;
    }
    if (!stat.isDirectory()) {
      diagnostics.push(diagnostic("unexpected_author_file", relative, "author_readdir", null));
      continue;
    }
    const work = observeWorkDirectory(io, root, platformId, authorName, entry.name, stat);
    works.push(work);
    // Metadata quality does not affect filesystem completeness. A failed file
    // enumeration does, even when the physical work directory still exists.
    if (work.state !== "present" || work.filesystemFilesState !== "complete") {
      worksState = "incomplete";
      diagnostics.push(diagnostic("work_observation_incomplete", work.workRelativePath, "work_observation", null));
    }
  }
  works.sort((left, right) => compareText(left.workDirectoryName, right.workDirectoryName));
  return {
    state: "present",
    platformId,
    authorDirectoryName: authorName,
    authorRelativePath: identity.relativePath,
    authorRelativePathKey: identity.relativePathKey,
    authorDirMtimeNs: authorStat.mtimeNs,
    childWorkCountObserved: works.length,
    worksState,
    works,
    diagnostics: sortDiagnostics(diagnostics),
  };
}

function observePlatformTree({ platformId, observationRoot, io = NODE_FS_IO } = {}) {
  if (!PLATFORM_REGISTRY.some(platform => platform.id === platformId)) throw new Error(`Unknown platformId: ${platformId || "(missing)"}`);
  if (typeof observationRoot !== "string" || !path.isAbsolute(observationRoot)) throw new TypeError("observationRoot must be an absolute path");
  assertIo(io);
  const diagnostics = [];
  let rootStat;
  try { rootStat = io.lstat(observationRoot); }
  catch (error) {
    const osCode = errorCode(error);
    const state = osCode === "ENOENT" ? "missing" : "unreadable";
    diagnostics.push(osCode === "ENOENT" ? diagnostic("root_missing", ".", "root_lstat", osCode) : expectedErrorDiagnostic(error, ".", "root_lstat", "entry_stat_failed"));
    return deepFreeze({ contractVersion: FILESYSTEM_OBSERVATION_CONTRACT_VERSION, platformId, state, authorsState: "incomplete", authors: null, diagnostics: sortDiagnostics(diagnostics) });
  }
  if (rootStat.isSymbolicLink()) {
    diagnostics.push(diagnostic("reparse_not_followed", ".", "root_lstat", null));
    return deepFreeze({ contractVersion: FILESYSTEM_OBSERVATION_CONTRACT_VERSION, platformId, state: "unreadable", authorsState: "incomplete", authors: null, diagnostics: sortDiagnostics(diagnostics) });
  }
  if (!rootStat.isDirectory()) {
    diagnostics.push(diagnostic("root_not_directory", ".", "root_lstat", null));
    return deepFreeze({ contractVersion: FILESYSTEM_OBSERVATION_CONTRACT_VERSION, platformId, state: "unreadable", authorsState: "incomplete", authors: null, diagnostics: sortDiagnostics(diagnostics) });
  }
  let entries;
  try { entries = io.readdir(observationRoot); }
  catch (error) {
    diagnostics.push(expectedErrorDiagnostic(error, ".", "root_readdir", "directory_enumeration_failed"));
    return deepFreeze({ contractVersion: FILESYSTEM_OBSERVATION_CONTRACT_VERSION, platformId, state: "unreadable", authorsState: "incomplete", authors: null, diagnostics: sortDiagnostics(diagnostics) });
  }
  const authors = [];
  let authorsState = "complete";
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const absoluteEntry = path.join(observationRoot, entry.name);
    let stat;
    try { stat = io.lstat(absoluteEntry); }
    catch (error) {
      diagnostics.push(expectedErrorDiagnostic(error, entry.name, "author_lstat", "entry_stat_failed"));
      authorsState = "incomplete";
      continue;
    }
    if (stat.isSymbolicLink()) {
      diagnostics.push(diagnostic("reparse_not_followed", entry.name, "author_lstat", null));
      continue;
    }
    if (!stat.isDirectory()) {
      diagnostics.push(diagnostic("unexpected_platform_file", entry.name, "root_readdir", null));
      continue;
    }
    const author = observeAuthorDirectory(io, observationRoot, platformId, entry.name, stat);
    authors.push(author);
    if (author.state !== "present" || author.worksState !== "complete") authorsState = "incomplete";
  }
  authors.sort((left, right) => compareText(left.authorDirectoryName, right.authorDirectoryName));
  return deepFreeze({
    contractVersion: FILESYSTEM_OBSERVATION_CONTRACT_VERSION,
    platformId,
    state: "present",
    authorsState,
    authors,
    diagnostics: sortDiagnostics(diagnostics),
  });
}

// Bounded-memory production observation path. The callback receives one frozen
// author scope at a time; metadata sourceText and filesystem file arrays are no
// longer retained for the entire platform.
function observePlatformTreeStreaming({ platformId, observationRoot, io = NODE_FS_IO, onAuthor } = {}) {
  if (!PLATFORM_REGISTRY.some(platform => platform.id === platformId)) throw new Error(`Unknown platformId: ${platformId || "(missing)"}`);
  if (typeof observationRoot !== "string" || !path.isAbsolute(observationRoot)) throw new TypeError("observationRoot must be an absolute path");
  if (typeof onAuthor !== "function") throw new TypeError("onAuthor callback is required");
  assertIo(io);
  const diagnostics = [];
  let rootStat;
  try { rootStat = io.lstat(observationRoot); }
  catch (error) {
    const osCode = errorCode(error);
    const state = osCode === "ENOENT" ? "missing" : "unreadable";
    diagnostics.push(osCode === "ENOENT" ? diagnostic("root_missing", ".", "root_lstat", osCode) : expectedErrorDiagnostic(error, ".", "root_lstat", "entry_stat_failed"));
    return deepFreeze({ contractVersion: FILESYSTEM_OBSERVATION_CONTRACT_VERSION, platformId, state, authorsState: "incomplete", authorsObserved: 0, worksObserved: 0, filesystemFilesObserved: 0, metadataBytesRead: 0, diagnostics: sortDiagnostics(diagnostics) });
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    diagnostics.push(diagnostic(rootStat.isSymbolicLink() ? "reparse_not_followed" : "root_not_directory", ".", "root_lstat", null));
    return deepFreeze({ contractVersion: FILESYSTEM_OBSERVATION_CONTRACT_VERSION, platformId, state: "unreadable", authorsState: "incomplete", authorsObserved: 0, worksObserved: 0, filesystemFilesObserved: 0, metadataBytesRead: 0, diagnostics: sortDiagnostics(diagnostics) });
  }
  let entries;
  try { entries = io.readdir(observationRoot); }
  catch (error) {
    diagnostics.push(expectedErrorDiagnostic(error, ".", "root_readdir", "directory_enumeration_failed"));
    return deepFreeze({ contractVersion: FILESYSTEM_OBSERVATION_CONTRACT_VERSION, platformId, state: "unreadable", authorsState: "incomplete", authorsObserved: 0, worksObserved: 0, filesystemFilesObserved: 0, metadataBytesRead: 0, diagnostics: sortDiagnostics(diagnostics) });
  }
  let authorsState = "complete";
  let authorsObserved = 0;
  let worksObserved = 0;
  let filesystemFilesObserved = 0;
  let metadataBytesRead = 0;
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const absoluteEntry = path.join(observationRoot, entry.name);
    let stat;
    try { stat = io.lstat(absoluteEntry); }
    catch (error) {
      diagnostics.push(expectedErrorDiagnostic(error, entry.name, "author_lstat", "entry_stat_failed"));
      authorsState = "incomplete";
      continue;
    }
    if (stat.isSymbolicLink()) {
      diagnostics.push(diagnostic("reparse_not_followed", entry.name, "author_lstat", null));
      continue;
    }
    if (!stat.isDirectory()) {
      diagnostics.push(diagnostic("unexpected_platform_file", entry.name, "root_readdir", null));
      continue;
    }
    const author = deepFreeze(observeAuthorDirectory(io, observationRoot, platformId, entry.name, stat));
    if (author.state !== "present" || author.worksState !== "complete") authorsState = "incomplete";
    authorsObserved++;
    worksObserved += author.works?.length || 0;
    for (const work of author.works || []) {
      filesystemFilesObserved += work.filesystemFiles?.length || 0;
      if (work.metadata?.state === "present") metadataBytesRead += work.metadata.size;
    }
    onAuthor(author);
  }
  return deepFreeze({
    contractVersion: FILESYSTEM_OBSERVATION_CONTRACT_VERSION,
    platformId,
    state: "present",
    authorsState,
    authorsObserved,
    worksObserved,
    filesystemFilesObserved,
    metadataBytesRead,
    diagnostics: sortDiagnostics(diagnostics),
  });
}

// Stronger streaming contract for production-scale authors: at most one
// WorkObservation (plus the author's sorted directory-entry names) is live in
// the observer at a time. Consumers can persist each work before the next one.
function observePlatformWorksStreaming({ platformId, observationRoot, io = NODE_FS_IO, onAuthorStart, onWork, onAuthorEnd } = {}) {
  if (!PLATFORM_REGISTRY.some(platform => platform.id === platformId)) throw new Error(`Unknown platformId: ${platformId || "(missing)"}`);
  if (typeof observationRoot !== "string" || !path.isAbsolute(observationRoot)) throw new TypeError("observationRoot must be an absolute path");
  if ([onAuthorStart, onWork, onAuthorEnd].some(callback => typeof callback !== "function")) throw new TypeError("Author/work streaming callbacks are required");
  assertIo(io);
  const diagnostics = [];
  let rootStat;
  try { rootStat = io.lstat(observationRoot); }
  catch (error) {
    const osCode = errorCode(error);
    diagnostics.push(osCode === "ENOENT" ? diagnostic("root_missing", ".", "root_lstat", osCode) : expectedErrorDiagnostic(error, ".", "root_lstat", "entry_stat_failed"));
    return deepFreeze({ contractVersion: FILESYSTEM_OBSERVATION_CONTRACT_VERSION, platformId, state: osCode === "ENOENT" ? "missing" : "unreadable", authorsState: "incomplete", authorsObserved: 0, worksObserved: 0, filesystemFilesObserved: 0, metadataBytesRead: 0, diagnostics: sortDiagnostics(diagnostics) });
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    diagnostics.push(diagnostic(rootStat.isSymbolicLink() ? "reparse_not_followed" : "root_not_directory", ".", "root_lstat", null));
    return deepFreeze({ contractVersion: FILESYSTEM_OBSERVATION_CONTRACT_VERSION, platformId, state: "unreadable", authorsState: "incomplete", authorsObserved: 0, worksObserved: 0, filesystemFilesObserved: 0, metadataBytesRead: 0, diagnostics: sortDiagnostics(diagnostics) });
  }
  let authorEntries;
  try { authorEntries = io.readdir(observationRoot); }
  catch (error) {
    diagnostics.push(expectedErrorDiagnostic(error, ".", "root_readdir", "directory_enumeration_failed"));
    return deepFreeze({ contractVersion: FILESYSTEM_OBSERVATION_CONTRACT_VERSION, platformId, state: "unreadable", authorsState: "incomplete", authorsObserved: 0, worksObserved: 0, filesystemFilesObserved: 0, metadataBytesRead: 0, diagnostics: sortDiagnostics(diagnostics) });
  }
  authorEntries.sort((left, right) => compareText(left.name, right.name));
  let authorsState = "complete";
  let authorsObserved = 0;
  let worksObserved = 0;
  let filesystemFilesObserved = 0;
  let metadataBytesRead = 0;
  for (const authorEntry of authorEntries) {
    const absoluteAuthor = path.join(observationRoot, authorEntry.name);
    let authorStat;
    try { authorStat = io.lstat(absoluteAuthor); }
    catch (error) {
      diagnostics.push(expectedErrorDiagnostic(error, authorEntry.name, "author_lstat", "entry_stat_failed"));
      authorsState = "incomplete";
      continue;
    }
    if (authorStat.isSymbolicLink()) { diagnostics.push(diagnostic("reparse_not_followed", authorEntry.name, "author_lstat", null)); continue; }
    if (!authorStat.isDirectory()) { diagnostics.push(diagnostic("unexpected_platform_file", authorEntry.name, "root_readdir", null)); continue; }
    const identity = normalizeRelativePath(authorEntry.name);
    const authorBase = {
      state: "present",
      platformId,
      authorDirectoryName: authorEntry.name,
      authorRelativePath: identity.relativePath,
      authorRelativePathKey: identity.relativePathKey,
      authorDirMtimeNs: authorStat.mtimeNs,
    };
    authorsObserved++;
    let workEntries;
    const authorDiagnostics = [];
    try { workEntries = io.readdir(absoluteAuthor); }
    catch (error) {
      authorDiagnostics.push(expectedErrorDiagnostic(error, identity.relativePath, "author_readdir", "directory_enumeration_failed"));
      authorsState = "incomplete";
      const unreadable = deepFreeze({ ...authorBase, state: "unreadable", childWorkCountObserved: null, worksState: "incomplete", diagnostics: sortDiagnostics(authorDiagnostics) });
      onAuthorStart(unreadable);
      onAuthorEnd(unreadable);
      continue;
    }
    workEntries.sort((left, right) => compareText(left.name, right.name));
    const startedAuthor = deepFreeze({ ...authorBase, childWorkCountObserved: null, worksState: "incomplete", diagnostics: [] });
    onAuthorStart(startedAuthor);
    let worksState = "complete";
    let childWorkCountObserved = 0;
    for (const workEntry of workEntries) {
      const relative = `${identity.relativePath}\\${workEntry.name}`;
      const absoluteWork = path.join(absoluteAuthor, workEntry.name);
      let workStat;
      try { workStat = io.lstat(absoluteWork); }
      catch (error) { authorDiagnostics.push(expectedErrorDiagnostic(error, relative, "work_lstat", "entry_stat_failed")); worksState = "incomplete"; continue; }
      if (workStat.isSymbolicLink()) { authorDiagnostics.push(diagnostic("reparse_not_followed", relative, "work_lstat", null)); continue; }
      if (!workStat.isDirectory()) { authorDiagnostics.push(diagnostic("unexpected_author_file", relative, "author_readdir", null)); continue; }
      const work = deepFreeze(observeWorkDirectory(io, observationRoot, platformId, authorEntry.name, workEntry.name, workStat));
      if (work.state !== "present" || work.filesystemFilesState !== "complete") {
        worksState = "incomplete";
        authorDiagnostics.push(diagnostic("work_observation_incomplete", work.workRelativePath, "work_observation", null));
      }
      childWorkCountObserved++;
      worksObserved++;
      filesystemFilesObserved += work.filesystemFiles?.length || 0;
      if (work.metadata?.state === "present") metadataBytesRead += work.metadata.size;
      onWork(work, startedAuthor);
    }
    if (worksState !== "complete") authorsState = "incomplete";
    onAuthorEnd(deepFreeze({ ...authorBase, childWorkCountObserved, worksState, diagnostics: sortDiagnostics(authorDiagnostics) }));
  }
  return deepFreeze({ contractVersion: FILESYSTEM_OBSERVATION_CONTRACT_VERSION, platformId, state: "present", authorsState, authorsObserved, worksObserved, filesystemFilesObserved, metadataBytesRead, diagnostics: sortDiagnostics(diagnostics) });
}

module.exports = {
  NODE_FS_IO,
  expectedErrorDiagnostic,
  observeMetadataFile,
  observePlatformTree,
  observePlatformTreeStreaming,
  observePlatformWorksStreaming,
  safeFileSize,
};
