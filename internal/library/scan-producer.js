"use strict";
const fs = require("node:fs"), path = require("node:path");
const { PLATFORM_REGISTRY } = require("./platforms.js");
const { normalizeRelativePath } = require("./paths.js");
const {
  diagnostic,
  sortDiagnostics,
  deepFreeze,
  compareText,
  FILESYSTEM_OBSERVATION_CONTRACT_VERSION,
} = require("./observation-contract.js");
const { safeFileSize, expectedErrorDiagnostic: describeOsError } = require(
  "./observer.js",
);
const { diskProfiles, createLimiter } = require("./disk-scheduler.js");
const ASYNC_IO = Object.freeze({
  lstat: (p) => fs.promises.lstat(p, { bigint: true }),
  readdir: (p) => fs.promises.readdir(p, { withFileTypes: true }),
  readFile: (p) => fs.promises.readFile(p),
});
const CANCEL = () =>
  Object.assign(new Error("Scan cancelled"), { code: "SCAN_CANCELLED" });
function expectedErrorDiagnostic(error, ...args) {
  if (!/^E[A-Z0-9]+$/.test(error?.code || "")) throw error;
  return describeOsError(error, ...args);
}
function entryPath(parent, name) {
  if (
    typeof name !== "string" || !name || /[\\/\0]/.test(name) || name === "." ||
    name === ".."
  ) throw new TypeError("Unsafe directory entry");
  normalizeRelativePath(name);
  return path.join(parent, name);
}
function metadata(state, identity, fields = {}) {
  return {
    state,
    relativePath: identity.relativePath,
    relativePathKey: identity.relativePathKey,
    size: null,
    mtimeNs: null,
    sourceText: null,
    ...fields,
  };
}
async function inspectMetadata(io, absolute, relative) {
  const id = normalizeRelativePath(relative), diagnostics = [];
  let before, size;
  try {
    before = await io.lstat(absolute);
  } catch (e) {
    if (e.code === "ENOENT") {
      return { metadata: metadata("missing", id), diagnostics, before: null };
    }
    diagnostics.push(
      expectedErrorDiagnostic(
        e,
        relative,
        "metadata_lstat_before",
        "entry_stat_failed",
      ),
    );
    return { metadata: metadata("unreadable", id), diagnostics, before: null };
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    diagnostics.push(
      diagnostic(
        before.isSymbolicLink()
          ? "reparse_not_followed"
          : "metadata_not_regular_file",
        relative,
        "metadata_lstat",
      ),
    );
    return { metadata: metadata("unreadable", id), diagnostics, before: null };
  }
  try {
    size = safeFileSize(before.size);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    diagnostics.push(
      diagnostic("file_size_unsafe", relative, "metadata_lstat"),
    );
    return { metadata: metadata("unreadable", id), diagnostics, before: null };
  }
  return {
    metadata: metadata("present", id, { size, mtimeNs: before.mtimeNs }),
    diagnostics,
    before,
  };
}
async function readMetadata(io, absolute, relative, inspected) {
  const id = normalizeRelativePath(relative),
    diagnostics = [...inspected.diagnostics];
  if (!inspected.before) return inspected;
  const before = inspected.before, size = inspected.metadata.size;
  let buffer, after;
  try {
    buffer = await io.readFile(absolute);
  } catch (e) {
    diagnostics.push(
      expectedErrorDiagnostic(e, relative, "metadata_read", "entry_unreadable"),
    );
    return {
      metadata: metadata("unreadable", id, {
        size,
        mtimeNs: before.mtimeNs,
      }),
      diagnostics,
    };
  }
  try {
    after = await io.lstat(absolute);
  } catch (e) {
    diagnostics.push(
      expectedErrorDiagnostic(
        e,
        relative,
        "metadata_lstat_after",
        "entry_stat_failed",
      ),
    );
    return { metadata: metadata("unstable", id), diagnostics };
  }
  if (
    !after.isFile() || after.isSymbolicLink() || before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs || BigInt(buffer.length) !== before.size
  ) {
    diagnostics.push(
      diagnostic(
        "metadata_changed_during_observation",
        relative,
        "metadata_verify",
      ),
    );
    return { metadata: metadata("unstable", id), diagnostics };
  }
  const sourceText = buffer.toString("utf8");
  if (!Buffer.from(sourceText, "utf8").equals(buffer)) {
    diagnostics.push(
      diagnostic("metadata_utf8_decode_failed", relative, "metadata_decode"),
    );
    return {
      metadata: metadata("unreadable", id, { size, mtimeNs: before.mtimeNs }),
      diagnostics,
    };
  }
  return {
    metadata: metadata("present", id, {
      size,
      mtimeNs: before.mtimeNs,
      sourceText,
    }),
    diagnostics,
  };
}

// At most window tasks are launched. Results are delivered in path order;
// early consumer return drains only this bounded in-flight window.
async function* ordered(items, window, fn, check) {
  const pending = [];
  let next = 0;
  const launch = () => {
    while (next < items.length && pending.length < window) {
      check();
      const index = next++;
      pending.push(
        Promise.resolve().then(() => fn(items[index])).then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
      );
    }
  };
  try {
    launch();
    while (pending.length) {
      check();
      const r = await pending.shift();
      if (r.error) throw r.error;
      yield r.value;
      launch();
    }
  } finally {
    await Promise.all(pending);
  }
}

async function observeWork(
  io,
  root,
  platformId,
  authorName,
  workName,
  stat,
  check,
  window,
  metadataReuseProbe,
) {
  const id = normalizeRelativePath(`${authorName}\\${workName}`),
    absolute = path.join(root, authorName, workName),
    diagnostics = [];
  let children;
  try {
    children = await io.readdir(absolute);
  } catch (e) {
    diagnostics.push(
      expectedErrorDiagnostic(
        e,
        id.relativePath,
        "work_readdir",
        "directory_enumeration_failed",
      ),
    );
    return {
      state: "unreadable",
      platformId,
      authorDirectoryName: authorName,
      workDirectoryName: workName,
      workRelativePath: id.relativePath,
      workRelativePathKey: id.relativePathKey,
      workDirMtimeNs: stat.mtimeNs,
      metadata: metadata(
        "unreadable",
        normalizeRelativePath(id.relativePath + "\\metadata.json"),
      ),
      filesystemFilesState: "incomplete",
      filesystemFiles: [],
      diagnostics,
    };
  }
  const inspected = await inspectMetadata(
    io,
    path.join(absolute, "metadata.json"),
    id.relativePath + "\\metadata.json",
  );
  diagnostics.push(...inspected.diagnostics);
  const files = [];
  let complete = true;
  async function visit(directory, relative, known) {
    check();
    let entries;
    try {
      entries = known || await io.readdir(directory);
    } catch (e) {
      complete = false;
      diagnostics.push(
        expectedErrorDiagnostic(
          e,
          relative ? id.relativePath + "\\" + relative : id.relativePath,
          "directory_readdir",
          "directory_enumeration_failed",
        ),
      );
      return;
    }
    entries.sort((a, b) => compareText(a.name, b.name));
    const selected = entries.filter((e) =>
      relative || e.name !== "metadata.json"
    );
    for await (
      const r of ordered(selected, window, async (e) => {
        const p = entryPath(directory, e.name),
          rel = relative ? relative + "\\" + e.name : e.name;
        try {
          return { p, rel, stat: await io.lstat(p) };
        } catch (error) {
          return { rel, error };
        }
      }, check)
    ) {
      const full = id.relativePath + "\\" + r.rel;
      if (r.error) {
        complete = false;
        diagnostics.push(
          expectedErrorDiagnostic(
            r.error,
            full,
            "entry_lstat",
            "entry_stat_failed",
          ),
        );
        continue;
      }
      if (r.stat.isSymbolicLink()) {
        complete = false;
        diagnostics.push(
          diagnostic("reparse_not_followed", full, "entry_lstat"),
        );
        continue;
      }
      if (r.stat.isDirectory()) {
        await visit(r.p, r.rel);
        continue;
      }
      if (!r.stat.isFile()) {
        diagnostics.push(
          diagnostic("unsupported_entry_type", full, "entry_lstat"),
        );
        continue;
      }
      let size;
      try {
        size = safeFileSize(r.stat.size);
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        complete = false;
        diagnostics.push(diagnostic("file_size_unsafe", full, "file_lstat"));
        continue;
      }
      const file = normalizeRelativePath(r.rel),
        parent = path.win32.dirname(file.relativePath),
        fileName = path.win32.basename(file.relativePath);
      files.push({
        relativePath: file.relativePath,
        relativePathKey: file.relativePathKey,
        directoryRelativePath: parent === "." ? null : parent,
        fileName,
        extension: path.win32.extname(fileName),
        size,
        mtimeNs: r.stat.mtimeNs,
        entryType: "regular_file",
      });
    }
  }
  await visit(absolute, "", children);
  files.sort((a, b) => compareText(a.relativePath, b.relativePath));
  let metadataResult = inspected, reuse = null;
  if (
    complete && inspected.metadata.state === "present" &&
    typeof metadataReuseProbe === "function"
  ) {
    const tentative = {
      state: "present",
      platformId,
      authorDirectoryName: authorName,
      workDirectoryName: workName,
      workRelativePath: id.relativePath,
      workRelativePathKey: id.relativePathKey,
      workDirMtimeNs: stat.mtimeNs,
      metadata: inspected.metadata,
      filesystemFilesState: "complete",
      filesystemFiles: files,
      diagnostics: sortDiagnostics(diagnostics),
    };
    reuse = await metadataReuseProbe(tentative);
    if (reuse) {
      try {
        const after = await io.lstat(path.join(absolute, "metadata.json"));
        if (
          !after.isFile() || after.isSymbolicLink() ||
          after.size !== inspected.before.size ||
          after.mtimeNs !== inspected.before.mtimeNs
        ) reuse = null;
      } catch (error) {
        reuse = null;
      }
    }
  }
  if (!reuse) {
    metadataResult = await readMetadata(
      io,
      path.join(absolute, "metadata.json"),
      id.relativePath + "\\metadata.json",
      inspected,
    );
    diagnostics.splice(0, diagnostics.length, ...metadataResult.diagnostics);
  }
  return {
    state: "present",
    platformId,
    authorDirectoryName: authorName,
    workDirectoryName: workName,
    workRelativePath: id.relativePath,
    workRelativePathKey: id.relativePathKey,
    workDirMtimeNs: stat.mtimeNs,
    metadata: metadataResult.metadata,
    ...(reuse ? { metadataReuse: reuse } : {}),
    filesystemFilesState: complete ? "complete" : "incomplete",
    filesystemFiles: files,
    diagnostics: sortDiagnostics(diagnostics),
  };
}

async function* platformEvents(
  scope,
  root,
  io,
  profile,
  check,
  metadataReuseProbe,
  preferredWorkKey,
) {
  const { platformId } = scope, diagnostics = [], started = performance.now();
  const observation = {
    contractVersion: FILESYSTEM_OBSERVATION_CONTRACT_VERSION,
    platformId,
    state: "present",
    authorsState: "complete",
    authorsObserved: 0,
    worksObserved: 0,
    filesystemFilesObserved: 0,
    metadataBytesRead: 0,
    diagnostics,
  };
  const topology = {
    platformId,
    status: "SAFE",
    rootState: "present",
    authorDirectoryCount: 0,
    workDirectoryCount: 0,
    authorReparseCount: 0,
    workReparseCount: 0,
    nestedReparseCount: 0,
    unreadableCount: 0,
    abnormalEntryCount: 0,
    nestedSampledWorkCount: 0,
    diagnostics: [],
    durationMs: 0,
  };
  let entries;
  try {
    const stat = await io.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      observation.state = "unreadable";
      diagnostics.push(
        diagnostic(
          stat.isSymbolicLink() ? "reparse_not_followed" : "root_not_directory",
          ".",
          "root_lstat",
        ),
      );
    } else entries = await io.readdir(root);
  } catch (e) {
    observation.state = e.code === "ENOENT" ? "missing" : "unreadable";
    diagnostics.push(
      expectedErrorDiagnostic(
        e,
        ".",
        "root_observation",
        "directory_enumeration_failed",
      ),
    );
  }
  if (!entries) {
    observation.authorsState = "incomplete";
    topology.status = "TOPOLOGY_BLOCKED";
    topology.rootState = observation.state;
    topology.diagnostics = [...diagnostics];
  }
  yield {
    type: "platformStart",
    platformId,
    physicalRoot: root,
    topology: deepFreeze({ ...topology }),
    disk: {
      type: profile.type,
      ioLimit: profile.ioLimit,
      workWindow: profile.workWindow,
    },
  };
  if (entries) {
    entries.sort((a, b) => compareText(a.name, b.name));
    const wanted = scope.authorDirectoryName
      ? normalizeRelativePath(scope.authorDirectoryName).relativePathKey
      : null;
    for (const entry of entries) {
      check();
      const authorPath = entryPath(root, entry.name),
        id = normalizeRelativePath(entry.name);
      if (wanted && wanted !== id.relativePathKey) continue;
      let stat;
      try {
        stat = await io.lstat(authorPath);
      } catch (e) {
        observation.authorsState = "incomplete";
        diagnostics.push(
          expectedErrorDiagnostic(
            e,
            id.relativePath,
            "author_lstat",
            "entry_stat_failed",
          ),
        );
        continue;
      }
      if (stat.isSymbolicLink()) {
        observation.authorsState = "incomplete";
        topology.authorReparseCount++;
        diagnostics.push(
          diagnostic("reparse_not_followed", id.relativePath, "author_lstat"),
        );
        continue;
      }
      if (!stat.isDirectory()) {
        diagnostics.push(
          diagnostic(
            "unexpected_platform_file",
            id.relativePath,
            "root_readdir",
          ),
        );
        continue;
      }
      observation.authorsObserved++;
      topology.authorDirectoryCount++;
      const author = {
        state: "present",
        platformId,
        authorDirectoryName: entry.name,
        authorRelativePath: id.relativePath,
        authorRelativePathKey: id.relativePathKey,
        authorDirMtimeNs: stat.mtimeNs,
        childWorkCountObserved: null,
        worksState: "incomplete",
        diagnostics: [],
      };
      yield {
        type: "authorStart",
        platformId,
        author: deepFreeze({ ...author }),
      };
      const authorDiagnostics = [];
      let workEntries, complete = true, count = 0;
      try {
        workEntries = await io.readdir(authorPath);
      } catch (e) {
        complete = false;
        author.state = "unreadable";
        authorDiagnostics.push(
          expectedErrorDiagnostic(
            e,
            id.relativePath,
            "author_readdir",
            "directory_enumeration_failed",
          ),
        );
      }
      if (workEntries) {
        workEntries.sort((a, b) => compareText(a.name, b.name));
        const preferred = typeof preferredWorkKey === "function"
          ? preferredWorkKey(platformId, id.relativePathKey)
          : null;
        let preferredEntry = null;
        if (preferred) {
          const index = workEntries.findIndex((entry) => {
            if (!entry?.name) return false;
            return normalizeRelativePath(
              `${entry.name}`,
            ).relativePathKey === preferred;
          });
          if (index >= 0) preferredEntry = workEntries.splice(index, 1)[0];
        }
        const observeEntry = async (e) => {
          check();
          const p = entryPath(authorPath, e.name),
            rel = id.relativePath + "\\" + e.name;
          let s;
          try {
            s = await io.lstat(p);
          } catch (error) {
            return { error, rel };
          }
          if (s.isSymbolicLink()) return { reparse: true, rel };
          if (!s.isDirectory()) return { ignored: true, rel };
          return {
            work: await observeWork(
              io,
              root,
              platformId,
              entry.name,
              e.name,
              s,
              check,
              profile.ioLimit,
              metadataReuseProbe,
            ),
          };
        };
        async function* observedEntries() {
          if (preferredEntry) yield await observeEntry(preferredEntry);
          yield* ordered(workEntries, profile.workWindow, observeEntry, check);
        }
        for await (
          const r of observedEntries()
        ) {
          if (r.error) {
            complete = false;
            authorDiagnostics.push(
              expectedErrorDiagnostic(
                r.error,
                r.rel,
                "work_lstat",
                "entry_stat_failed",
              ),
            );
            continue;
          }
          if (r.reparse) {
            complete = false;
            topology.workReparseCount++;
            authorDiagnostics.push(
              diagnostic("reparse_not_followed", r.rel, "work_lstat"),
            );
            continue;
          }
          if (r.ignored) {
            authorDiagnostics.push(
              diagnostic("unexpected_author_file", r.rel, "author_readdir"),
            );
            continue;
          }
          const work = r.work;
          count++;
          observation.worksObserved++;
          topology.workDirectoryCount++;
          for (const d of work.diagnostics) {
            if (
              d.code === "reparse_not_followed" &&
              !d.operation.startsWith("metadata")
            ) topology.nestedReparseCount++;
            if (
              [
                "entry_unreadable",
                "directory_enumeration_failed",
                "entry_stat_failed",
              ].includes(d.code) && !d.operation.startsWith("metadata")
            ) topology.unreadableCount++;
          }
          observation.filesystemFilesObserved += work.filesystemFiles.length;
          if (work.metadata.state === "present" && !work.metadataReuse) {
            observation.metadataBytesRead += work.metadata.size;
          }
          if (
            work.state !== "present" || work.filesystemFilesState !== "complete"
          ) {
            complete = false;
            authorDiagnostics.push(
              diagnostic(
                "work_observation_incomplete",
                work.workRelativePath,
                "work_observation",
              ),
            );
          }
          yield {
            type: "work",
            platformId,
            authorKey: id.relativePathKey,
            work: deepFreeze(work),
          };
        }
      }
      if (!complete) observation.authorsState = "incomplete";
      yield {
        type: "authorEnd",
        platformId,
        authorKey: id.relativePathKey,
        completion: deepFreeze({
          ...author,
          worksState: complete ? "complete" : "incomplete",
          childWorkCountObserved: workEntries ? count : null,
          diagnostics: sortDiagnostics(authorDiagnostics),
        }),
      };
    }
  }
  topology.status = observation.authorsState === "complete"
    ? "SAFE"
    : "TOPOLOGY_BLOCKED";
  topology.durationMs = performance.now() - started;
  yield {
    type: "platformEnd",
    platformId,
    observation: deepFreeze({
      ...observation,
      diagnostics: sortDiagnostics(diagnostics),
    }),
    topology: deepFreeze({ ...topology }),
    durationMs: performance.now() - started,
  };
}

async function* createObservationProducer(
  {
    platformRoots,
    scopes,
    io = ASYNC_IO,
    checkCancelled = () => {},
    concurrency = {},
    metadataReuseProbe = null,
    preferredWorkKey = null,
  },
) {
  io = io || ASYNC_IO;
  if (
    !Array.isArray(scopes) || !io ||
    ["lstat", "readdir", "readFile"].some((k) => typeof io[k] !== "function")
  ) throw new TypeError("Invalid producer parameters");
  for (const s of scopes) {
    if (
      !PLATFORM_REGISTRY.some((p) => p.id === s.platformId) ||
      !path.isAbsolute(platformRoots[s.platformId] || "")
    ) throw new TypeError("Invalid scan scope");
    if (s.authorDirectoryName) {
      entryPath(platformRoots[s.platformId], s.authorDirectoryName);
    }
  }
  const profiles = await diskProfiles(platformRoots, concurrency),
    groups = new Map();
  let closed = false;
  const check = () => {
    if (closed) throw CANCEL();
    checkCancelled();
  };
  for (const scope of scopes) {
    const profile = profiles[scope.platformId];
    if (!groups.has(profile.id)) {
      groups.set(profile.id, { profile, scopes: [] });
    }
    groups.get(profile.id).scopes.push(scope);
  }
  const streams = [];
  for (const group of groups.values()) {
    const limiter = createLimiter(group.profile.ioLimit, check),
      limited = Object.fromEntries(
        ["lstat", "readdir", "readFile"].map((
          k,
        ) => [k, (p) => limiter.run(() => io[k](p))]),
      );
    const stream = (async function* () {
      for (const scope of group.scopes) {
        yield* platformEvents(
          scope,
          platformRoots[scope.platformId],
          limited,
          group.profile,
          check,
          metadataReuseProbe,
          preferredWorkKey,
        );
      }
    })();
    streams.push(stream);
  }
  const pending = new Map();
  const schedule = (i) =>
    pending.set(
      i,
      streams[i].next().then(
        (result) => ({ i, result }),
        (error) => ({ i, error }),
      ),
    );
  streams.forEach((_, i) => schedule(i));
  try {
    while (pending.size) {
      check();
      const { i, result, error } = await Promise.race(pending.values());
      pending.delete(i);
      if (error) throw error;
      if (result.done) continue;
      yield result.value;
      schedule(i);
    }
  } finally {
    closed = true;
    await Promise.allSettled(pending.values());
    await Promise.allSettled(streams.map((s) => s.return()));
  }
}
module.exports = { ASYNC_IO, createObservationProducer };
