"use strict";

const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { PLATFORM_REGISTRY } = require("../library/platforms.js");
const { normalizeRelativePath } = require("../library/paths.js");
const { inside, overlap, noLinks } = require("../library/io-paths.js");
const { readEverythingInventory } = require("../library/everything.js");
const {
  ASYNC_IO,
  inspectMetadata,
  readMetadata,
  ordered,
} = require("../library/scan-producer.js");
const { diskProfiles, createLimiter } = require("../library/disk-scheduler.js");
const {
  diagnostic,
  FILESYSTEM_OBSERVATION_CONTRACT_VERSION,
} = require("../library/observation-contract.js");
const { safeFileSize } = require("../library/observer.js");

function fail(code) {
  throw Object.assign(new Error(code), { code });
}
function parseEntry(root, row) {
  if (
    !row ||
    !["file", "folder"].includes(row.type) ||
    typeof row.path !== "string" ||
    !path.isAbsolute(row.path) ||
    typeof row.name !== "string" ||
    !row.name ||
    /[\\/\x00-\x1f]/.test(row.name) ||
    [".", ".."].includes(row.name)
  )
    fail("EVERYTHING_ROW_INVALID");
  const absolute = path.resolve(row.path, row.name);
  if (
    !inside(root, absolute) ||
    path.resolve(root).toLowerCase() === absolute.toLowerCase()
  )
    fail("EVERYTHING_SCOPE_ESCAPE");
  if (
    typeof row.date_modified !== "string" ||
    !/^\d+$/.test(row.date_modified) ||
    (row.type === "file" &&
      (typeof row.size !== "string" || !/^\d+$/.test(row.size)))
  )
    fail("EVERYTHING_PROPERTIES_MISSING");
  const mtime = (BigInt(row.date_modified) - 116444736000000000n) * 100n;
  if (mtime < -9223372036854775808n || mtime > 9223372036854775807n)
    fail("EVERYTHING_TIME_INVALID");
  const id = normalizeRelativePath(path.relative(root, absolute)),
    parts = id.relativePathKey.split("\\");
  return {
    key: id.relativePathKey,
    relative: id.relativePath,
    parent: parts.length === 1 ? "." : parts.slice(0, -1).join("\\"),
    kind: row.type,
    size: row.type === "file" ? BigInt(row.size).toString() : "0",
    mtime: mtime.toString(),
    author: parts[0],
    work: parts.length >= 2 ? parts.slice(0, 2).join("\\") : null,
    name: row.name,
  };
}

function prepareListingQueries(spool) {
  // The spool has no persistent planner statistics and several ordered indexes.
  // Pin each hot lookup to its scope index: choosing the platform primary key
  // here turns every author/work lookup into a whole-platform scan.
  return {
    authors: spool.prepare(
      "SELECT * FROM entries INDEXED BY entries_parent WHERE platform=? AND parent='.' AND kind='folder' AND key>? ORDER BY key LIMIT 64",
    ),
    authorFingerprint: spool.prepare(
      "SELECT key,relative,kind,size,mtime FROM entries INDEXED BY entries_author WHERE platform=? AND author=? ORDER BY key",
    ),
    workDirectories: spool.prepare(
      "SELECT * FROM entries INDEXED BY entries_parent WHERE platform=? AND parent=? AND kind='folder' ORDER BY key",
    ),
    workFingerprint: spool.prepare(
      "SELECT key,relative,kind,size,mtime FROM entries INDEXED BY entries_work WHERE platform=? AND work=? ORDER BY key",
    ),
    workEntries: spool.prepare(
      "SELECT * FROM entries INDEXED BY entries_work WHERE platform=? AND work=? ORDER BY key",
    ),
  };
}

// One disposable, bounded-memory listing spool. Only the live database holds
// committed reuse signatures. Cancelling cannot advance a separate baseline.
function createListingSession({
  config,
  database,
  io = ASYNC_IO,
  checkCancelled: externalCheck = () => {},
}) {
  let stopped = false;
  const checkCancelled = () => {
    if (stopped) fail("SCAN_CANCELLED");
    externalCheck();
  };
  const file = path.join(
    config.stateRoot,
    "indexing",
    `listing-${crypto.randomUUID()}.sqlite`,
  );
  if (
    !inside(config.instanceRoot, file) ||
    overlap(config.generationsRoot, file) ||
    config.protectedRoots.some((root) =>
      overlap(typeof root === "string" ? root : root.physicalRoot, file),
    )
  )
    fail("INVENTORY_PATH_INVALID");
  noLinks(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const spool = new Database(file);
  spool.pragma("journal_mode=OFF");
  spool.pragma("cache_size=-8192");
  spool.pragma("temp_store=FILE");
  spool.exec(`CREATE TABLE entries(platform TEXT NOT NULL,key TEXT NOT NULL,relative TEXT NOT NULL,parent TEXT NOT NULL,kind TEXT NOT NULL,size TEXT NOT NULL,mtime TEXT NOT NULL,author TEXT,work TEXT,name TEXT NOT NULL,PRIMARY KEY(platform,key)) WITHOUT ROWID;
    CREATE INDEX entries_parent ON entries(platform,parent,key); CREATE INDEX entries_work ON entries(platform,work,key); CREATE INDEX entries_author ON entries(platform,author,key);`);
  const counters = {
    provider: "everything",
    directListing: true,
    indexedEntries: 0,
    nativeStats: 0,
    nativeDirectoryReads: 0,
    metadataReads: 0,
    metadataBytesRead: 0,
    worksQualified: 0,
    worksChanged: 0,
    workListingReads: 0,
    workFingerprintReads: 0,
    authorFingerprintReads: 0,
  };
  const queries = prepareListingQueries(spool);
  const insert = spool.prepare(
    "INSERT INTO entries VALUES (@platform,@key,@relative,@parent,@kind,@size,@mtime,@author,@work,@name)",
  );
  const workLedger = database.prepare(
    "SELECT fingerprint,adapter_version FROM live_scan_works WHERE platform_id=? AND relative_path_key=?",
  );
  const authorLedger = database.prepare(
    "SELECT fingerprint FROM live_scan_authors WHERE platform_id=? AND relative_path_key=?",
  );
  function signature(rows) {
    const hash = crypto.createHash("sha256");
    for (const row of rows)
      hash.update(
        JSON.stringify([row.key, row.relative, row.kind, row.size, row.mtime]) +
          "\n",
      );
    return hash.digest("hex");
  }
  async function ingest(platformId, root) {
    checkCancelled();
    noLinks(root);
    const stat = await io.lstat(root);
    counters.nativeStats++;
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail("EVERYTHING_ROOT_INVALID");
    insert.run({
      platform: platformId,
      key: ".",
      relative: ".",
      parent: "",
      kind: "folder",
      size: "0",
      mtime: stat.mtimeNs.toString(),
      author: null,
      work: null,
      name: "",
    });
    const write = spool.transaction((rows) => {
      for (const item of rows) {
        const row = parseEntry(root, item);
        try {
          insert.run({ platform: platformId, ...row });
        } catch (error) {
          if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY")
            fail("EVERYTHING_DUPLICATE_PATH");
          throw error;
        }
      }
    });
    const result = await readEverythingInventory({
      endpoint: config.everything.endpoint,
      root,
      checkCancelled,
      onRows: async (rows) => {
        write(rows);
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    counters.indexedEntries += result.entries;
    if (
      spool
        .prepare(
          `SELECT 1 FROM entries c LEFT JOIN entries p ON p.platform=c.platform AND p.key=c.parent
      WHERE c.platform=? AND c.key<>'.' AND (p.key IS NULL OR p.kind<>'folder') LIMIT 1`,
        )
        .get(platformId)
    )
      fail("EVERYTHING_INVENTORY_INCOMPLETE");
  }
  async function* platformEvents(scope, options, profile, limiter) {
    const platformId = scope.platformId,
      root = options.platformRoots[platformId],
      start = performance.now();
    const adapterVersion = PLATFORM_REGISTRY.find(
      (row) => row.id === platformId,
    ).adapterVersion;
    const native = {
      lstat: (target) =>
        limiter.run(async () => {
          counters.nativeStats++;
          return io.lstat(target);
        }),
      readFile: (target) =>
        limiter.run(async () => {
          checkCancelled();
          const data = await io.readFile(target);
          counters.metadataReads++;
          counters.metadataBytesRead += data.length;
          return data;
        }),
    };
    const observation = {
      contractVersion: FILESYSTEM_OBSERVATION_CONTRACT_VERSION,
      platformId,
      state: "present",
      authorsState: "complete",
      authorsObserved: 0,
      worksObserved: 0,
      filesystemFilesObserved: 0,
      metadataBytesRead: 0,
      diagnostics: [],
    };
    yield {
      type: "platformStart",
      platformId,
      physicalRoot: root,
      topology: { platformId, status: "SAFE", rootState: "present" },
      disk: profile,
    };
    await ingest(platformId, root);
    const wanted = scope.authorDirectoryName
      ? normalizeRelativePath(scope.authorDirectoryName).relativePathKey
      : null;
    // Never keep an SQLite statement iterator alive across await/yield: another
    // platform can ingest into this spool meanwhile. Materialize bounded pages,
    // not the entire platform and not a long-lived read statement.
    const authors = queries.authors;
    function* authorRows() {
      let after = "";
      for (;;) {
        const rows = authors.all(platformId, after);
        if (!rows.length) return;
        after = rows.at(-1).key;
        yield* rows;
      }
    }
    for (const row of authorRows()) {
      checkCancelled();
      if (wanted && row.key !== wanted) continue;
      let authorStat;
      try {
        authorStat = await native.lstat(path.join(root, row.relative));
        if (!authorStat.isDirectory() || authorStat.isSymbolicLink())
          fail("PATH_REPARSE");
      } catch (error) {
        if (
          !/^E[A-Z0-9_]+$/.test(error.code || "") &&
          error.code !== "PATH_REPARSE"
        )
          throw error;
        observation.authorsState = "incomplete";
        observation.diagnostics.push(
          diagnostic("entry_stat_failed", row.relative, "author_lstat"),
        );
        continue;
      }
      const authorFingerprint = signature(
        queries.authorFingerprint.iterate(platformId, row.key),
      );
      counters.authorFingerprintReads++;
      const authorUnchanged =
        authorLedger.get(platformId, row.key)?.fingerprint ===
        authorFingerprint;
      const author = {
        state: "present",
        platformId,
        authorDirectoryName: row.name,
        authorRelativePath: row.relative,
        authorRelativePathKey: row.key,
        authorDirMtimeNs: authorStat.mtimeNs,
        childWorkCountObserved: null,
        worksState: "incomplete",
        diagnostics: [],
      };
      observation.authorsObserved++;
      yield { type: "authorStart", platformId, author };
      const workRows = queries.workDirectories.all(platformId, row.key);
      const unchangedKeys = new Set();
      for (const work of scope.forceFullObservation ? [] : workRows) {
        const previous = workLedger.get(platformId, work.key);
        // New works cannot be reuse anchors. Full scans likewise need no
        // fingerprint prepass; hash the rows already read by makeWork instead.
        if (!previous || Number(previous.adapter_version) !== adapterVersion)
          continue;
        if (authorUnchanged) work.fingerprint = previous.fingerprint;
        else {
          work.fingerprint = signature(
            queries.workFingerprint.iterate(platformId, work.key),
          );
          counters.workFingerprintReads++;
        }
        if (
          previous?.fingerprint === work.fingerprint &&
          Number(previous.adapter_version) === adapterVersion
        )
          unchangedKeys.add(work.key);
      }
      // The highest unchanged anchor plus changed works is enough to recompute
      // profile authority, even when the formerly latest work becomes older.
      const preferred = options.preferredWorkKey?.(
        platformId,
        row.key,
        unchangedKeys,
      );
      if (preferred) {
        const pos = workRows.findIndex(
          (work) =>
            normalizeRelativePath(work.name).relativePathKey === preferred,
        );
        if (pos > 0) workRows.unshift(...workRows.splice(pos, 1));
      }
      let complete = true,
        qualified = true,
        observed = 0;
      const makeWork = async (workRow) => {
        checkCancelled();
        const rows = queries.workEntries.all(platformId, workRow.key);
        counters.workListingReads++;
        const fingerprint = workRow.fingerprint ?? signature(rows),
          previous = workLedger.get(platformId, workRow.key);
        const unchanged =
          previous?.fingerprint === fingerprint &&
          Number(previous.adapter_version) === adapterVersion;
        const absolute = path.join(root, workRow.relative),
          diagnostics = [];
        let stat,
          filesComplete = true,
          signatureQualified = true;
        try {
          stat = await native.lstat(absolute);
          if (!stat.isDirectory() || stat.isSymbolicLink())
            fail("PATH_REPARSE");
        } catch (error) {
          if (
            error.code !== "PATH_REPARSE" &&
            !/^E[A-Z0-9_]+$/.test(error.code || "")
          )
            throw error;
          return null;
        }
        const files = [];
        if (!unchanged || scope.forceFullObservation) {
          const listed = new Set(
            rows
              .filter((entry) => entry.kind === "file")
              .map((entry) => entry.key),
          );
          const oldMedia = database
            .prepare(
              "SELECT m.relative_path FROM media m JOIN works w USING(work_id) WHERE w.platform_id=? AND w.relative_path_key=?",
            )
            .all(platformId, workRow.key);
          for (const old of oldMedia) {
            const relative = normalizeRelativePath(
              workRow.relative + "\\" + old.relative_path,
            );
            if (listed.has(relative.relativePathKey)) continue;
            try {
              await native.lstat(path.join(root, relative.relativePath));
              filesComplete = false;
              diagnostics.push(
                diagnostic(
                  "indexed_existing_file_missing",
                  relative.relativePath,
                  "media_absence_check",
                ),
              );
            } catch (error) {
              if (error.code !== "ENOENT") {
                if (!/^E[A-Z0-9_]+$/.test(error.code || "")) throw error;
                filesComplete = false;
                diagnostics.push(
                  diagnostic(
                    "entry_stat_failed",
                    relative.relativePath,
                    "media_absence_check",
                  ),
                );
              }
            }
          }
        }
        {
          // Directories are safety boundaries. Check each once, never enumerate
          // members. The spool already contains their full descendant listing.
          for (const dir of rows.filter(
            (item) => item.kind === "folder" && item.key !== workRow.key,
          )) {
            try {
              const current = await native.lstat(path.join(root, dir.relative));
              if (current.isSymbolicLink() || !current.isDirectory())
                fail("PATH_REPARSE");
            } catch (error) {
              if (
                error.code !== "PATH_REPARSE" &&
                !/^E[A-Z0-9_]+$/.test(error.code || "")
              )
                throw error;
              filesComplete = false;
              diagnostics.push(
                diagnostic(
                  "entry_stat_failed",
                  dir.relative,
                  "directory_lstat",
                ),
              );
            }
          }
        }
        if (filesComplete)
          for await (const entry of ordered(
            rows.filter(
              (item) =>
                item.kind === "file" &&
                !(
                  item.parent === workRow.key &&
                  item.name.toLowerCase() === "metadata.json"
                ),
            ),
            profile.ioLimit,
            async (fileRow) => {
              let size = BigInt(fileRow.size),
                mtimeNs = BigInt(fileRow.mtime);
              if (!unchanged || scope.forceFullObservation)
                try {
                  const actual = await native.lstat(
                    path.join(root, fileRow.relative),
                  );
                  if (actual.isSymbolicLink() || !actual.isFile())
                    fail("PATH_REPARSE");
                  signatureQualified &&=
                    actual.size === size && actual.mtimeNs === mtimeNs;
                  size = actual.size;
                  mtimeNs = actual.mtimeNs;
                } catch (error) {
                  if (
                    error.code !== "PATH_REPARSE" &&
                    !/^E[A-Z0-9_]+$/.test(error.code || "")
                  )
                    throw error;
                  return null;
                }
              try {
                size = safeFileSize(size);
              } catch {
                return null;
              }
              const id = normalizeRelativePath(
                  fileRow.relative.slice(workRow.relative.length + 1),
                ),
                parent = path.win32.dirname(id.relativePath);
              return {
                ...id,
                directoryRelativePath: parent === "." ? null : parent,
                fileName: fileRow.name,
                extension: path.win32.extname(fileRow.name),
                size,
                mtimeNs,
                entryType: "regular_file",
              };
            },
            checkCancelled,
          )) {
            if (entry) files.push(entry);
            else filesComplete = false;
          }
        files.sort((a, b) =>
          a.relativePath < b.relativePath
            ? -1
            : a.relativePath > b.relativePath
              ? 1
              : 0,
        );
        const metaId = normalizeRelativePath(
            workRow.relative + "\\metadata.json",
          ),
          metaRow = rows.find(
            (entry) =>
              entry.parent === workRow.key &&
              entry.name.toLowerCase() === "metadata.json",
          );
        let metadataSize = null;
        if (metaRow)
          try {
            metadataSize = safeFileSize(BigInt(metaRow.size));
          } catch {
            signatureQualified = false;
          }
        let metadata = {
          state: metaRow ? "present" : "missing",
          ...metaId,
          size: metadataSize,
          mtimeNs: metaRow ? BigInt(metaRow.mtime) : null,
          sourceText: null,
        };
        const work = {
          state: "present",
          platformId,
          authorDirectoryName: row.name,
          workDirectoryName: workRow.name,
          workRelativePath: workRow.relative,
          workRelativePathKey: workRow.key,
          workDirMtimeNs: stat.mtimeNs,
          metadata,
          filesystemFilesState: filesComplete ? "complete" : "incomplete",
          filesystemFiles: files,
          diagnostics,
          inventoryQualified: true,
          inventoryUnchanged: unchanged,
          inventoryAuthorUnchanged: authorUnchanged,
        };
        const reuse = filesComplete
          ? await options.metadataReuseProbe?.(work)
          : null;
        if (reuse) {
          work.metadataReuse = reuse;
          counters.worksQualified++;
        } else {
          // Only changed work content (plus a changed author's profile anchor)
          // is read; failures remain enrichment failures, not lost works.
          const inspected = await inspectMetadata(
            native,
            path.join(absolute, "metadata.json"),
            metaId.relativePath,
          );
          const result = await readMetadata(
            native,
            path.join(absolute, "metadata.json"),
            metaId.relativePath,
            inspected,
          );
          work.metadata = result.metadata;
          diagnostics.push(...result.diagnostics);
          counters.worksChanged++;
          signatureQualified &&= metaRow
            ? result.metadata.size !== null &&
              BigInt(result.metadata.size) === BigInt(metaRow.size) &&
              result.metadata.mtimeNs === BigInt(metaRow.mtime)
            : result.metadata.state === "missing";
          observation.metadataBytesRead += Buffer.byteLength(
            work.metadata.sourceText || "",
            "utf8",
          );
        }
        if (
          filesComplete &&
          signatureQualified &&
          !["unreadable", "unstable"].includes(work.metadata.state)
        )
          work.scanRecord = {
            platformId,
            key: workRow.key,
            fingerprint,
            adapterVersion,
          };
        return work;
      };
      for await (const work of ordered(
        workRows,
        profile.workWindow,
        makeWork,
        checkCancelled,
      )) {
        observed++;
        observation.worksObserved++;
        if (!work) {
          complete = false;
          qualified = false;
          observation.diagnostics.push(
            diagnostic("entry_stat_failed", row.relative, "work_lstat"),
          );
          continue;
        }
        complete &&= work.filesystemFilesState === "complete";
        qualified &&= !!work.scanRecord || !!work.metadataReuse;
        observation.filesystemFilesObserved += work.filesystemFiles.length;
        yield { type: "work", platformId, authorKey: row.key, work };
      }
      if (!complete) observation.authorsState = "incomplete";
      yield {
        type: "authorEnd",
        platformId,
        authorKey: row.key,
        completion: {
          state: "present",
          worksState: complete ? "complete" : "incomplete",
          childWorkCountObserved: observed,
          diagnostics: [],
          ...(complete && qualified && !authorUnchanged
            ? {
                scanRecord: {
                  platformId,
                  key: row.key,
                  fingerprint: authorFingerprint,
                },
              }
            : {}),
        },
      };
    }
    yield {
      type: "platformEnd",
      platformId,
      observation,
      durationMs: performance.now() - start,
    };
  }
  return {
    async createObservationProducer(options) {
      const selected = Object.fromEntries(
        options.scopes.map((scope) => [
          scope.platformId,
          options.platformRoots[scope.platformId],
        ]),
      );
      const profiles = await diskProfiles(selected, options.concurrency),
        limiters = new Map();
      // Merge bounded streams. Both I/O and work preparation keep their existing
      // per-physical-disk budget; response ingestion uses bounded row chunks.
      const streams = options.scopes.map((scope) => {
        const profile = profiles[scope.platformId];
        if (!limiters.has(profile.id))
          limiters.set(
            profile.id,
            createLimiter(profile.ioLimit, checkCancelled),
          );
        return platformEvents(
          scope,
          options,
          profile,
          limiters.get(profile.id),
        )[Symbol.asyncIterator]();
      });
      return (async function* () {
        const pending = new Map(
          streams.map((stream, index) => [
            index,
            stream.next().then((value) => ({ index, value })),
          ]),
        );
        try {
          while (pending.size) {
            const { index, value } = await Promise.race(pending.values());
            pending.delete(index);
            if (value.done) continue;
            yield value.value;
            pending.set(
              index,
              streams[index].next().then((next) => ({ index, value: next })),
            );
          }
        } finally {
          stopped = true;
          await Promise.allSettled(pending.values());
          await Promise.allSettled(streams.map((stream) => stream.return?.()));
        }
      })();
    },
    stats: () => ({ ...counters }),
    close() {
      spool.close();
      fs.rmSync(file, { force: true });
    },
  };
}
module.exports = { createListingSession, prepareListingQueries };
