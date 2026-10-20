"use strict";

const fs = require("node:fs"),
  path = require("node:path");
const Database = require("better-sqlite3");
const { PLATFORM_REGISTRY } = require("../library/platforms.js");
const { normalizeRelativePath } = require("../library/paths.js");
const { inside, overlap, noLinks } = require("../library/io-paths.js");
const { readEverythingInventory } = require("../library/everything.js");
const {
  ASYNC_IO,
  createObservationProducer,
} = require("../library/scan-producer.js");
const FILETIME_EPOCH = 116444736000000000n;
function fail(code) {
  throw Object.assign(new Error(code), { code });
}
function virtualStat(row) {
  return {
    size: BigInt(row.size),
    mtimeNs: BigInt(row.mtime),
    isDirectory: () => row.kind === "folder",
    isFile: () => row.kind === "file",
    isSymbolicLink: () => false,
  };
}
function nativeKind(stat) {
  return stat.isSymbolicLink()
    ? "link"
    : stat.isDirectory()
      ? "folder"
      : stat.isFile()
        ? "file"
        : "other";
}

// Instance-owned scan cache, never a Catalog table or a READY generation file.
// current is disposable; entries is advanced only after successful publication.
function createInventorySession({
  config,
  baselineGenerationId,
  mode,
  io = ASYNC_IO,
  checkCancelled = () => {},
}) {
  const file = path.join(config.stateRoot, "indexing", "inventory.sqlite");
  if (
    !inside(config.instanceRoot, file) ||
    overlap(config.generationsRoot, file) ||
    Object.values(config.sources).some((root) => overlap(root, file))
  )
    fail("INVENTORY_PATH_INVALID");
  noLinks(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.pragma("journal_mode=DELETE");
    db.pragma("synchronous=FULL");
    db.pragma("cache_size=-8192");
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bindings (platform TEXT PRIMARY KEY,root TEXT NOT NULL,adapter INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS entries (platform TEXT NOT NULL,key TEXT NOT NULL,parent TEXT NOT NULL,name TEXT NOT NULL,
      kind TEXT NOT NULL,size TEXT NOT NULL,mtime TEXT NOT NULL,author TEXT,work TEXT,PRIMARY KEY(platform,key));
    CREATE TABLE IF NOT EXISTS current (platform TEXT NOT NULL,key TEXT NOT NULL,parent TEXT NOT NULL,name TEXT NOT NULL,
      kind TEXT NOT NULL,size TEXT NOT NULL,mtime TEXT NOT NULL,author TEXT,work TEXT,dirty INTEGER NOT NULL DEFAULT 1,
      verified INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(platform,key));
    CREATE INDEX IF NOT EXISTS current_parent ON current(platform,parent);
    CREATE TABLE IF NOT EXISTS dirty_authors (platform TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(platform,key));
    CREATE TABLE IF NOT EXISTS dirty_works (platform TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(platform,key));`);
    const version = db
      .prepare("SELECT value FROM meta WHERE key='version'")
      .get()?.value;
    if (version && version !== "1") fail("INVENTORY_VERSION_INVALID");
    db.prepare("INSERT OR IGNORE INTO meta VALUES ('version','1')").run();
    // Only this scan owns the cache. Keep scratch rows and verification flags in
    // one transaction, not one durable SQLite commit per observed directory/file.
    // The baseline joins the same transaction only after publication succeeds.
    db.exec(
      "BEGIN; DELETE FROM current; DELETE FROM dirty_authors; DELETE FROM dirty_works;",
    );
  } catch (error) {
    db.close();
    throw error;
  }
  const baselineMatches =
    !!baselineGenerationId &&
    db.prepare("SELECT value FROM meta WHERE key='generation'").get()?.value ===
      baselineGenerationId;
  const scopes = new Map(),
    verifyAfterRead = new Set();
  const counters = {
    provider: "everything",
    indexedEntries: 0,
    added: 0,
    changed: 0,
    removed: 0,
    nativeStats: 0,
    nativeDirectoryReads: 0,
    indexedStats: 0,
    indexedDirectoryReads: 0,
    metadataReads: 0,
    directoryMtimeRefreshes: 0,
  };
  const rowAt = db.prepare("SELECT * FROM current WHERE platform=? AND key=?");
  const insert = db.prepare(
    "INSERT INTO current(platform,key,parent,name,kind,size,mtime,author,work) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  function locate(absolute) {
    for (const [platform, scope] of scopes) {
      if (!inside(scope.root, absolute)) continue;
      const relative = path.relative(scope.root, absolute);
      return {
        platform,
        scope,
        key: relative ? normalizeRelativePath(relative).relativePathKey : ".",
      };
    }
    fail("INVENTORY_SCOPE_ESCAPE");
  }
  function normalizeRow(root, row) {
    if (
      !row ||
      !["file", "folder"].includes(row.type) ||
      typeof row.name !== "string" ||
      !row.name ||
      /[\\/\x00-\x1f]/.test(row.name) ||
      [".", ".."].includes(row.name) ||
      typeof row.path !== "string" ||
      !path.isAbsolute(row.path)
    )
      fail("EVERYTHING_ROW_INVALID");
    const absolute = path.resolve(row.path, row.name);
    if (
      !inside(root, absolute) ||
      absolute.toLowerCase() === path.resolve(root).toLowerCase()
    )
      fail("EVERYTHING_SCOPE_ESCAPE");
    if (
      typeof row.date_modified !== "string" ||
      !/^\d+$/.test(row.date_modified) ||
      (row.type === "file" &&
        (typeof row.size !== "string" || !/^\d+$/.test(row.size)))
    )
      fail("EVERYTHING_PROPERTIES_MISSING");
    const mtime = (BigInt(row.date_modified) - FILETIME_EPOCH) * 100n;
    if (mtime < -9223372036854775808n || mtime > 9223372036854775807n)
      fail("EVERYTHING_TIME_INVALID");
    const id = normalizeRelativePath(path.relative(root, absolute)),
      parts = id.relativePathKey.split("\\");
    return {
      key: id.relativePathKey,
      parent: parts.length === 1 ? "." : parts.slice(0, -1).join("\\"),
      name: row.name,
      kind: row.type,
      size: row.type === "file" ? BigInt(row.size).toString() : "0",
      mtime: mtime.toString(),
      author: parts[0],
      work: parts.length >= 2 ? parts.slice(0, 2).join("\\") : null,
    };
  }
  async function ingest(
    platform,
    root,
    authorDirectoryName,
    forceFullObservation,
  ) {
    checkCancelled();
    const adapter = PLATFORM_REGISTRY.find(
      (p) => p.id === platform,
    ).adapterVersion;
    const binding = db
      .prepare("SELECT * FROM bindings WHERE platform=?")
      .get(platform);
    const reusable =
      !forceFullObservation &&
      mode === "incremental" &&
      baselineMatches &&
      binding?.root === path.resolve(root).toLowerCase() &&
      binding.adapter === adapter;
    const authorKey = authorDirectoryName
      ? normalizeRelativePath(authorDirectoryName).relativePathKey
      : null;
    scopes.set(platform, { root, adapter, reusable, authorKey });
    const rootStat = await io.lstat(root);
    counters.nativeStats++;
    if (nativeKind(rootStat) !== "folder") fail("EVERYTHING_ROOT_INVALID");
    insert.run(
      platform,
      ".",
      "",
      "",
      "folder",
      "0",
      rootStat.mtimeNs.toString(),
      null,
      null,
    );
    const writeRows = db.transaction((rows) => {
      for (const item of rows) {
        const row = normalizeRow(root, item);
        if (rowAt.get(platform, row.key)) fail("EVERYTHING_DUPLICATE_PATH");
        insert.run(
          platform,
          row.key,
          row.parent,
          row.name,
          row.kind,
          row.size,
          row.mtime,
          row.author,
          row.work,
        );
      }
    });
    const result = await readEverythingInventory({
      endpoint: config.everything.endpoint,
      root,
      checkCancelled,
      onRows: async (rows) => {
        writeRows(rows);
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    counters.indexedEntries += result.entries;
    // A missing indexed ancestor would otherwise silently turn a subtree into an
    // empty scope. Every returned child must have a returned directory parent.
    if (
      db
        .prepare(
          `SELECT 1 FROM current c LEFT JOIN current p ON p.platform=c.platform AND p.key=c.parent
      WHERE c.platform=? AND c.key<>'.' AND (p.key IS NULL OR p.kind<>'folder') LIMIT 1`,
        )
        .get(platform)
    )
      fail("EVERYTHING_INVENTORY_INCOMPLETE");
    if (reusable) {
      db.prepare(
        `UPDATE current AS c SET dirty=0 WHERE platform=? AND EXISTS (SELECT 1 FROM entries e
        WHERE e.platform=c.platform AND e.key=c.key AND e.name=c.name AND e.kind=c.kind AND e.size=c.size AND e.mtime=c.mtime)`,
      ).run(platform);
    }
    db.prepare(
      "INSERT OR IGNORE INTO dirty_authors SELECT platform,author FROM current WHERE platform=? AND dirty=1 AND author IS NOT NULL",
    ).run(platform);
    db.prepare(
      "INSERT OR IGNORE INTO dirty_works SELECT platform,work FROM current WHERE platform=? AND dirty=1 AND work IS NOT NULL",
    ).run(platform);
    if (reusable) {
      const missing =
        db.prepare(`SELECT e.* FROM entries e WHERE e.platform=? AND NOT EXISTS
        (SELECT 1 FROM current c WHERE c.platform=e.platform AND c.key=e.key)`);
      for (const row of missing.iterate(platform)) {
        checkCancelled();
        const absolute = path.join(root, ...row.key.split("\\"));
        noLinks(absolute);
        try {
          await io.lstat(absolute);
          counters.nativeStats++;
        } catch (error) {
          counters.nativeStats++;
          if (error.code !== "ENOENT") throw error;
          counters.removed++;
          continue;
        }
        fail("EVERYTHING_MISSING_EXISTING_PATH");
      }
      for (const [table, column] of [
        ["dirty_authors", "author"],
        ["dirty_works", "work"],
      ])
        db.prepare(
          `INSERT OR IGNORE INTO ${table} SELECT platform,${column} FROM entries e WHERE platform=? AND ${column} IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM current c WHERE c.platform=e.platform AND c.key=e.key)`,
        ).run(platform);
    }
    counters.added += db
      .prepare(
        `SELECT count(*) n FROM current c WHERE c.platform=? AND c.key<>'.' AND NOT EXISTS
      (SELECT 1 FROM entries e WHERE e.platform=c.platform AND e.key=c.key)`,
      )
      .get(platform).n;
    counters.changed += db
      .prepare(
        `SELECT count(*) n FROM current c WHERE platform=? AND key<>'.' AND dirty=1
      AND EXISTS (SELECT 1 FROM entries e WHERE e.platform=c.platform AND e.key=c.key)`,
      )
      .get(platform).n;
  }
  const nativeLstat = async (absolute, found, row) => {
    counters.nativeStats++;
    const stat = await io.lstat(absolute);
    // Links are returned to the existing observer, which propagates incomplete
    // scopes. They must never be represented by a synthetic regular-file stat.
    if (nativeKind(stat) === "link") return stat;
    if (
      !row ||
      nativeKind(stat) !== row.kind ||
      (row.kind === "file" &&
        (stat.mtimeNs.toString() !== row.mtime ||
          stat.size.toString() !== row.size))
    )
      fail("EVERYTHING_INDEX_MISMATCH");
    if (row.kind === "folder") {
      if (stat.mtimeNs.toString() !== row.mtime) {
        // Directory timestamps are hints, not an indexing gate. Use the physical
        // timestamp and force native membership/file checks for this directory.
        // readdir still rejects omitted/extra children; files stay exact-checked.
        db.prepare(
          "UPDATE current SET mtime=?,dirty=1 WHERE platform=? AND key=?",
        ).run(stat.mtimeNs.toString(), found.platform, found.key);
        if (row.author)
          db.prepare("INSERT OR IGNORE INTO dirty_authors VALUES (?,?)").run(
            found.platform,
            row.author,
          );
        if (row.work)
          db.prepare("INSERT OR IGNORE INTO dirty_works VALUES (?,?)").run(
            found.platform,
            row.work,
          );
        counters.directoryMtimeRefreshes++;
      }
      db.prepare(
        "UPDATE current SET verified=1 WHERE platform=? AND key=?",
      ).run(found.platform, found.key);
    }
    return stat;
  };
  const indexedIo = {
    async lstat(absolute) {
      checkCancelled();
      const found = locate(absolute),
        row = rowAt.get(found.platform, found.key);
      if (!row) {
        const parentKey = path.relative(
          found.scope.root,
          path.dirname(absolute),
        );
        const parent = rowAt.get(
          found.platform,
          parentKey ? normalizeRelativePath(parentKey).relativePathKey : ".",
        );
        if (found.scope.reusable && parent?.verified && !parent.dirty) {
          counters.indexedStats++;
          throw Object.assign(new Error("Absent indexed entry"), {
            code: "ENOENT",
          });
        }
        counters.nativeStats++;
        await io.lstat(absolute);
        fail("EVERYTHING_MISSING_EXISTING_PATH");
      }
      const parent = rowAt.get(found.platform, row.parent);
      if (
        verifyAfterRead.delete(absolute) ||
        row.kind === "folder" ||
        !found.scope.reusable ||
        row.dirty ||
        !parent?.verified ||
        parent.dirty
      )
        return nativeLstat(absolute, found, row);
      counters.indexedStats++;
      return virtualStat(row);
    },
    async readdir(absolute) {
      checkCancelled();
      const found = locate(absolute),
        row = rowAt.get(found.platform, found.key);
      if (!row?.verified || row.kind !== "folder")
        fail("EVERYTHING_DIRECTORY_UNVERIFIED");
      const children = db
        .prepare(
          "SELECT name,kind FROM current WHERE platform=? AND parent=? ORDER BY key",
        )
        .all(found.platform, found.key);
      if (!found.scope.reusable || row.dirty) {
        counters.nativeDirectoryReads++;
        const actual = await io.readdir(absolute);
        const names = new Map(
          children.map((child) => [child.name, child.kind]),
        );
        if (
          actual.length !== children.length ||
          actual.some(
            (child) =>
              names.get(child.name) !==
              (child.isDirectory()
                ? "folder"
                : child.isFile()
                  ? "file"
                  : "link"),
          )
        )
          fail("EVERYTHING_DIRECTORY_MISMATCH");
      } else counters.indexedDirectoryReads++;
      return children.map((child) => ({
        name: child.name,
        isDirectory: () => child.kind === "folder",
        isFile: () => child.kind === "file",
        isSymbolicLink: () => false,
      }));
    },
    async readFile(absolute) {
      counters.metadataReads++;
      const found = locate(absolute),
        row = rowAt.get(found.platform, found.key);
      await nativeLstat(absolute, found, row);
      const result = await io.readFile(absolute);
      verifyAfterRead.add(absolute); // The existing observer verifies after reading.
      return result;
    },
  };
  function workReuseHints(platform, workKey) {
    const scope = scopes.get(platform),
      author = workKey.split("\\")[0];
    return {
      inventoryUnchanged:
        !!scope?.reusable &&
        !db
          .prepare("SELECT 1 FROM dirty_works WHERE platform=? AND key=?")
          .get(platform, workKey),
      inventoryAuthorUnchanged:
        !!scope?.reusable &&
        !db
          .prepare("SELECT 1 FROM dirty_authors WHERE platform=? AND key=?")
          .get(platform, author),
    };
  }
  return {
    async createObservationProducer(options) {
      for (const scope of options.scopes)
        await ingest(
          scope.platformId,
          options.platformRoots[scope.platformId],
          scope.authorDirectoryName,
          scope.forceFullObservation,
        );
      return createObservationProducer({
        ...options,
        io: indexedIo,
        workReuseHints,
      });
    },
    commit(generationId) {
      db.transaction(() => {
        for (const [platform, scope] of scopes) {
          if (scope.authorKey) {
            db.prepare("DELETE FROM entries WHERE platform=? AND author=?").run(
              platform,
              scope.authorKey,
            );
            db.prepare(
              `INSERT INTO entries SELECT platform,key,parent,name,kind,size,mtime,author,work FROM current WHERE platform=? AND author=?`,
            ).run(platform, scope.authorKey);
            // A first scoped update cannot qualify the unvisited platform tree.
            if (!scope.reusable)
              db.prepare("DELETE FROM bindings WHERE platform=?").run(platform);
          } else {
            db.prepare("DELETE FROM entries WHERE platform=?").run(platform);
            db.prepare(
              `INSERT INTO entries SELECT platform,key,parent,name,kind,size,mtime,author,work FROM current WHERE platform=?`,
            ).run(platform);
            db.prepare("INSERT OR REPLACE INTO bindings VALUES (?,?,?)").run(
              platform,
              path.resolve(scope.root).toLowerCase(),
              scope.adapter,
            );
          }
        }
        db.prepare("INSERT OR REPLACE INTO meta VALUES ('generation',?)").run(
          generationId,
        );
        db.exec(
          "DELETE FROM current; DELETE FROM dirty_authors; DELETE FROM dirty_works;",
        );
      })();
      db.exec("COMMIT");
    },
    stats: () => ({ ...counters, baselineMatched: baselineMatches }),
    close() {
      try {
        if (db.inTransaction) db.exec("ROLLBACK");
      } finally {
        db.close();
      }
    },
  };
}
module.exports = { createInventorySession, FILETIME_EPOCH };
