"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { withMaintenance } = require("../publication/retention.js");
const { noLinks } = require("../library/io-paths.js");
const { normalizePhysicalRootKey } = require("../library/platforms.js");
const { readJson } = require("../instance/files.js");
const { processIdentity, sameIdentity } = require("../instance/ownership.js");
const {
  collectWorkCountIdentities,
  createAffectedCounts,
  recountAffectedCounts,
} = require("./counts.js");
const {
  applyMappedBatchCore,
  initializeCatalog,
  refreshRelationTargetsForIdentities,
  upsertPhysicalAuthorsCore,
  verifyCatalogContract,
} = require("./writer.js");
const {
  createLiveSearchSchema,
  rebuildLiveSearch,
  refreshLiveSearch,
} = require("../search/live.js");

const LIVE_SCHEMA_VERSION = 3;

function liveCatalogPath(config) {
  return path.join(config.instanceRoot, "live", "catalog.sqlite");
}

function assertSourceBindings(db, config) {
  for (const row of db
    .prepare("SELECT platform_id,physical_root_key FROM platforms")
    .all())
    if (
      normalizePhysicalRootKey(config.sources[row.platform_id]) !==
      row.physical_root_key
    )
      throw Object.assign(
        new Error(
          "Live Catalog source bindings differ from runtime configuration",
        ),
        { code: "LIVE_SOURCE_BINDING_MISMATCH" },
      );
}

function getLiveState(db) {
  const row = db.prepare("SELECT * FROM live_meta WHERE singleton=1").get();
  if (!row)
    throw Object.assign(new Error("Live metadata missing"), {
      code: "LIVE_META_MISSING",
    });
  const schemaVersion = Number(row.schema_version),
    revision = Number(row.revision),
    initializedAtMs = Number(row.initialized_at_ms);
  if (schemaVersion !== LIVE_SCHEMA_VERSION)
    throw Object.assign(new Error("Unsupported live schema version"), {
      code: "LIVE_SCHEMA_UNSUPPORTED",
    });
  if (
    row.base_generation_id !== null &&
    (typeof row.base_generation_id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.base_generation_id))
  )
    throw Object.assign(new Error("Invalid live base generation"), {
      code: "LIVE_META_INVALID",
    });
  if (
    typeof row.epoch !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      row.epoch,
    )
  )
    throw Object.assign(new Error("Invalid live epoch"), {
      code: "LIVE_META_INVALID",
    });
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Number.isSafeInteger(initializedAtMs) ||
    initializedAtMs < 0
  )
    throw Object.assign(new Error("Invalid live revision metadata"), {
      code: "LIVE_META_INVALID",
    });
  const platformRevisions = Object.fromEntries(
    db
      .prepare(
        "SELECT platform_id,last_revision FROM live_platform_stats ORDER BY platform_id",
      )
      .all()
      .map((item) => [item.platform_id, Number(item.last_revision)]),
  );
  if (
    Object.values(platformRevisions).some(
      (value) => !Number.isSafeInteger(value) || value < 0 || value > revision,
    )
  )
    throw Object.assign(new Error("Invalid live platform revision metadata"), {
      code: "LIVE_META_INVALID",
    });
  return Object.freeze({
    schemaVersion,
    baseGenerationId: row.base_generation_id,
    epoch: row.epoch,
    revision,
    initializedAtMs,
    platformRevisions: Object.freeze(platformRevisions),
  });
}

function createLiveStatsSchema(db) {
  db.exec(`CREATE TABLE live_stats(singleton INTEGER PRIMARY KEY CHECK(singleton=1),works INTEGER NOT NULL CHECK(works>=0),media INTEGER NOT NULL CHECK(media>=0),authors INTEGER NOT NULL CHECK(authors>=0));
    CREATE TABLE live_metadata_stats(metadata_state TEXT PRIMARY KEY,count INTEGER NOT NULL CHECK(count>=0));
    CREATE TABLE live_platform_stats(platform_id TEXT PRIMARY KEY,count_works INTEGER NOT NULL CHECK(count_works>=0),count_media INTEGER NOT NULL CHECK(count_media>=0),last_revision INTEGER NOT NULL CHECK(last_revision>=0));`);
}

function rebuildLiveStats(db) {
  db.exec(`DELETE FROM live_stats;DELETE FROM live_metadata_stats;DELETE FROM live_platform_stats;
    INSERT INTO live_stats SELECT 1,(SELECT count(*) FROM works),(SELECT count(*) FROM media),(SELECT count(*) FROM authors);
    INSERT INTO live_metadata_stats SELECT metadata_state,count(*) FROM works GROUP BY metadata_state;
    INSERT INTO live_platform_stats SELECT p.platform_id,count(w.work_id),coalesce(sum(w.media_count),0),(SELECT revision FROM live_meta WHERE singleton=1) FROM platforms p LEFT JOIN works w ON w.platform_id=p.platform_id GROUP BY p.platform_id;`);
}

function migrateLiveSchema(db) {
  const row = db
    .prepare("SELECT schema_version FROM live_meta WHERE singleton=1")
    .get();
  if (!row || typeof row.schema_version !== "bigint")
    throw Object.assign(new Error("Live schema metadata missing"), {
      code: "LIVE_META_INVALID",
    });
  const version = Number(row.schema_version);
  if (version === LIVE_SCHEMA_VERSION) return false;
  if (![1, 2].includes(version))
    throw Object.assign(new Error("Unsupported live schema version"), {
      code: "LIVE_SCHEMA_UNSUPPORTED",
    });
  db.transaction(() => {
    if (version === 1) {
      createLiveStatsSchema(db);
      rebuildLiveStats(db);
    }
    db.exec(`ALTER TABLE live_meta RENAME TO live_meta_previous;
      CREATE TABLE live_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,base_generation_id TEXT,epoch TEXT NOT NULL,revision INTEGER NOT NULL,initialized_at_ms INTEGER NOT NULL);
      INSERT INTO live_meta SELECT * FROM live_meta_previous; DROP TABLE live_meta_previous;`);
    createScanLedger(db);
    db.prepare("UPDATE live_meta SET schema_version=? WHERE singleton=1").run(
      LIVE_SCHEMA_VERSION,
    );
  })();
  return true;
}

function createScanLedger(db) {
  // These signatures certify committed extraction, not just a fetched listing.
  db.exec(`CREATE TABLE IF NOT EXISTS live_scan_works(platform_id TEXT NOT NULL,relative_path_key TEXT NOT NULL,fingerprint TEXT NOT NULL,adapter_version INTEGER NOT NULL,authority_at_ms INTEGER NOT NULL,authority_source_id TEXT NOT NULL,PRIMARY KEY(platform_id,relative_path_key));
    CREATE TABLE IF NOT EXISTS live_scan_authors(platform_id TEXT NOT NULL,relative_path_key TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(platform_id,relative_path_key));`);
}

function initializeLiveFile(target, generation, config) {
  const root = path.dirname(target);
  fs.mkdirSync(root, { recursive: true });
  const temp = path.join(root, `.catalog-${crypto.randomUUID()}.tmp`);
  noLinks(temp);
  if (generation)
    fs.copyFileSync(generation.catalogPath, temp, fs.constants.COPYFILE_EXCL);
  let db;
  try {
    db = new Database(temp);
    db.defaultSafeIntegers(true);
    db.pragma("foreign_keys=ON");
    db.pragma("journal_mode=WAL");
    db.pragma("synchronous=NORMAL");
    if (!generation)
      initializeCatalog(db, {
        builtAtMs: Date.now(),
        platformRoots: config.sources,
      });
    db.transaction(() => {
      db.exec(`CREATE TABLE live_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,base_generation_id TEXT,epoch TEXT NOT NULL,revision INTEGER NOT NULL,initialized_at_ms INTEGER NOT NULL);
        CREATE TABLE live_id_high_water(entity TEXT PRIMARY KEY,value INTEGER NOT NULL);`);
      db.prepare("INSERT INTO live_meta VALUES (1,?,?,?,?,?)").run(
        LIVE_SCHEMA_VERSION,
        generation?.generationId || null,
        crypto.randomUUID(),
        0,
        Date.now(),
      );
      for (const [entity, table, id] of [
        ["author", "authors", "author_id"],
        ["work", "works", "work_id"],
        ["media", "media", "media_id"],
        ["tag", "tags", "tag_id"],
      ]) {
        const value = db
          .prepare(`SELECT coalesce(max(${id}),0) value FROM ${table}`)
          .get().value;
        db.prepare("INSERT INTO live_id_high_water VALUES (?,?)").run(
          entity,
          value,
        );
      }
      createLiveSearchSchema(db);
      rebuildLiveSearch(db);
      createLiveStatsSchema(db);
      rebuildLiveStats(db);
      createScanLedger(db);
    })();
    verifyCatalogContract(db, { allowLive: true });
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    db = null;
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      db?.close();
    } catch {}
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
    throw error;
  }
}

function prepareLiveReplacement(target) {
  const db = new Database(target);
  try {
    db.pragma("busy_timeout=1000");
    const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)")[0];
    if (checkpoint.busy !== 0) throw new Error("checkpoint busy");
    db.exec("BEGIN EXCLUSIVE; ROLLBACK");
  } catch (error) {
    throw Object.assign(
      new Error("Live Catalog is still in use and cannot be replaced"),
      { code: "LIVE_RESTART_REQUIRED", cause: error },
    );
  } finally {
    try {
      db.close();
    } catch {}
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = target + suffix;
    if (fs.existsSync(sidecar)) {
      try {
        fs.rmSync(sidecar, { force: true });
      } catch (error) {
        throw Object.assign(new Error("Live SQLite sidecar remains in use"), {
          code: "LIVE_RESTART_REQUIRED",
          cause: error,
        });
      }
    }
  }
}

function externalOwner(config, kind) {
  const lock = readJson(path.join(config.stateRoot, kind + ".lock"));
  if (!lock) return false;
  if (!lock.identity) return true;
  if (lock.identity.pid === process.pid) return false;
  try {
    return sameIdentity(processIdentity(lock.identity.pid), lock.identity);
  } catch {
    return true;
  }
}

function externalProcessOwnsLive(config) {
  return externalOwner(config, "runtime") || externalOwner(config, "scan");
}

async function ensureLive(config, generation) {
  if (!config.liveUpdates)
    return Object.freeze({ enabled: false, catalogPath: null });
  const target = liveCatalogPath(config);
  return withMaintenance(config, () => {
    const source = generation
      ? new Database(generation.catalogPath, {
          readonly: true,
          fileMustExist: true,
        })
      : null;
    if (source) {
      source.defaultSafeIntegers(true);
      try {
        verifyCatalogContract(source);
        assertSourceBindings(source, config);
      } finally {
        source.close();
      }
    }
    let current = null;
    if (fs.existsSync(target)) {
      let db;
      try {
        db = new Database(target);
        db.defaultSafeIntegers(true);
        db.pragma("foreign_keys=ON");
        db.pragma("journal_mode=WAL");
        db.pragma("busy_timeout=5000");
        const schemaRow = db
          .prepare("SELECT schema_version FROM live_meta WHERE singleton=1")
          .get();
        const schemaVersion =
          typeof schemaRow?.schema_version === "bigint"
            ? Number(schemaRow.schema_version)
            : null;
        if (schemaVersion === 1 || schemaVersion === 2) {
          verifyCatalogContract(db, { allowLive: true, allowLegacyLive: true });
          assertSourceBindings(db, config);
          if (externalProcessOwnsLive(config))
            throw Object.assign(
              new Error(
                "Runtime or scan owner must restart before live schema upgrade",
              ),
              { code: "LIVE_RESTART_REQUIRED" },
            );
          migrateLiveSchema(db);
        }
        verifyCatalogContract(db, { allowLive: true });
        assertSourceBindings(db, config);
        current = getLiveState(db);
      } catch (error) {
        const preserved = [
          "LIVE_SOURCE_BINDING_MISMATCH",
          "LIVE_RESTART_REQUIRED",
        ].includes(error.code)
          ? error.code
          : "LIVE_CATALOG_INVALID";
        throw Object.assign(
          new Error(
            "Existing live Catalog failed validation; committed live facts were preserved",
          ),
          { code: preserved, cause: error },
        );
      } finally {
        try {
          db?.close();
        } catch {}
      }
    } else if (
      ["-wal", "-shm", "-journal"].some((suffix) =>
        fs.existsSync(target + suffix),
      )
    ) {
      throw Object.assign(
        new Error(
          "Live Catalog main file is missing while SQLite sidecars remain",
        ),
        { code: "LIVE_CATALOG_INVALID" },
      );
    }
    const reset =
      !current ||
      (generation && current.baseGenerationId !== generation.generationId);
    if (reset && current) {
      const runtime = readJson(config.statusPath);
      if (
        (["STARTING", "READY"].includes(runtime?.state) ||
          readJson(path.join(config.stateRoot, "scan.lock"))) &&
        externalProcessOwnsLive(config)
      )
        throw Object.assign(
          new Error(
            "Running Runtime must restart to select another live base generation",
          ),
          { code: "LIVE_RESTART_REQUIRED" },
        );
      prepareLiveReplacement(target);
    }
    if (reset) initializeLiveFile(target, generation, config);
    const db = new Database(target, { readonly: true, fileMustExist: true });
    db.defaultSafeIntegers(true);
    try {
      return Object.freeze({
        enabled: true,
        catalogPath: target,
        reset,
        ...getLiveState(db),
      });
    } finally {
      db.close();
    }
  });
}

function openLive(config, generation, { readonly = true } = {}) {
  if (!config.liveUpdates)
    return Object.freeze({ enabled: false, catalogPath: null });
  const catalogPath = liveCatalogPath(config);
  if (!fs.existsSync(catalogPath))
    throw Object.assign(new Error("Live Catalog has not been prepared"), {
      code: "LIVE_NOT_PREPARED",
    });
  const db = new Database(catalogPath, { readonly, fileMustExist: true });
  db.defaultSafeIntegers(true);
  if (!readonly) {
    db.pragma("foreign_keys=ON");
    db.pragma("journal_mode=WAL");
    db.pragma("busy_timeout=5000");
  }
  try {
    verifyCatalogContract(db, { allowLive: true });
    assertSourceBindings(db, config);
    const state = getLiveState(db);
    if (generation && state.baseGenerationId !== generation.generationId)
      throw Object.assign(
        new Error("Live Catalog base differs from active generation"),
        { code: "LIVE_BASE_GENERATION_MISMATCH" },
      );
    return {
      enabled: true,
      catalogPath,
      reset: false,
      db,
      ...state,
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function impactedBefore(db, candidates) {
  const workIds = new Set(),
    authorIds = new Set(),
    tagIds = new Set(),
    sourceIdentities = [];
  for (const candidate of candidates) {
    const work = candidate.rows.work;
    const row = db
      .prepare(
        "SELECT work_id,author_id,source_work_id FROM works WHERE platform_id=? AND relative_path_key=?",
      )
      .get(work.platform_id, work.relative_path_key);
    if (!row || row.source_work_id !== work.source_work_id) {
      if (row?.source_work_id)
        sourceIdentities.push({
          platformId: work.platform_id,
          sourceWorkId: row.source_work_id,
        });
      if (work.source_work_id)
        sourceIdentities.push({
          platformId: work.platform_id,
          sourceWorkId: work.source_work_id,
        });
    }
    if (row) {
      workIds.add(row.work_id);
      authorIds.add(row.author_id);
      for (const tag of db
        .prepare("SELECT tag_id FROM work_tags WHERE work_id=?")
        .all(row.work_id))
        tagIds.add(tag.tag_id);
    }
  }
  return { workIds, authorIds, tagIds, sourceIdentities };
}

function aggregateSnapshot(db, candidates, preparedAuthors) {
  const works = new Map(),
    authors = new Map();
  for (const candidate of candidates) {
    const row = candidate.rows.work,
      key = row.platform_id + "\0" + row.relative_path_key;
    if (!works.has(key))
      works.set(
        key,
        db
          .prepare(
            "SELECT platform_id,metadata_state,media_count FROM works WHERE platform_id=? AND relative_path_key=?",
          )
          .get(row.platform_id, row.relative_path_key) || null,
      );
  }
  for (const row of [
    ...candidates.map((item) => item.rows.author),
    ...preparedAuthors,
  ]) {
    const key = row.platform_id + "\0" + row.relative_path_key;
    if (!authors.has(key))
      authors.set(
        key,
        !!db
          .prepare(
            "SELECT 1 FROM authors WHERE platform_id=? AND relative_path_key=?",
          )
          .get(row.platform_id, row.relative_path_key),
      );
  }
  return { works, authors };
}

function applyAggregateDelta(db, before, after, nextRevision) {
  let workDelta = 0,
    mediaDelta = 0,
    authorDelta = 0;
  const metadata = new Map(),
    platforms = new Map();
  const addMetadata = (state, delta) => {
    if (state) metadata.set(state, (metadata.get(state) || 0) + delta);
  };
  const addPlatform = (id, works, media) => {
    const value = platforms.get(id) || { works: 0, media: 0 };
    value.works += works;
    value.media += media;
    platforms.set(id, value);
  };
  for (const [key, oldRow] of before.works) {
    const newRow = after.works.get(key);
    if (!oldRow && newRow) {
      workDelta++;
      mediaDelta += Number(newRow.media_count);
      addMetadata(newRow.metadata_state, 1);
      addPlatform(newRow.platform_id, 1, Number(newRow.media_count));
    } else if (oldRow && newRow) {
      const delta = Number(newRow.media_count - oldRow.media_count);
      mediaDelta += delta;
      addPlatform(newRow.platform_id, 0, delta);
      if (oldRow.metadata_state !== newRow.metadata_state) {
        addMetadata(oldRow.metadata_state, -1);
        addMetadata(newRow.metadata_state, 1);
      }
    }
  }
  for (const [key, existed] of before.authors)
    if (!existed && after.authors.get(key)) authorDelta++;
  db.prepare(
    "UPDATE live_stats SET works=works+?,media=media+?,authors=authors+? WHERE singleton=1",
  ).run(workDelta, mediaDelta, authorDelta);
  const metadataUpdate = db.prepare(
    "UPDATE live_metadata_stats SET count=count+? WHERE metadata_state=?",
  );
  const metadataInsert = db.prepare(
    "INSERT INTO live_metadata_stats(metadata_state,count) VALUES (?,?)",
  );
  for (const [state, delta] of metadata)
    if (delta) {
      const changed = metadataUpdate.run(delta, state).changes;
      if (!changed) {
        if (delta < 0)
          throw Object.assign(new Error("Live metadata aggregate underflow"), {
            code: "LIVE_STATS_INVALID",
          });
        metadataInsert.run(state, delta);
      }
    }
  const platformUpdate = db.prepare(
    "UPDATE live_platform_stats SET count_works=count_works+?,count_media=count_media+?,last_revision=? WHERE platform_id=?",
  );
  for (const [id, value] of platforms)
    platformUpdate.run(value.works, value.media, nextRevision, id);
  for (const row of [...candidatesPlatforms(after, before)])
    if (!platforms.has(row))
      db.prepare(
        "UPDATE live_platform_stats SET last_revision=? WHERE platform_id=?",
      ).run(nextRevision, row);
}

function candidatesPlatforms(after, before) {
  const ids = new Set();
  for (const row of [...after.works.values(), ...before.works.values()])
    if (row) ids.add(row.platform_id);
  for (const key of new Set([
    ...after.authors.keys(),
    ...before.authors.keys(),
  ]))
    ids.add(key.split("\0", 1)[0]);
  return ids;
}

function applyLiveBatch(
  db,
  {
    mappedCandidates = [],
    preparedAuthors = [],
    scanWorks = [],
    scanAuthors = [],
    observedAtMs = Date.now(),
  } = {},
) {
  for (const candidate of mappedCandidates)
    if (
      candidate.rows.work.filesystem_state !== "present" ||
      candidate.rows.work.filesystem_files_state !== "complete"
    )
      throw Object.assign(
        new Error("Only complete physical works may become live"),
        { code: "LIVE_WORK_INCOMPLETE" },
      );
  if (
    !mappedCandidates.length &&
    !preparedAuthors.length &&
    !scanWorks.length &&
    !scanAuthors.length
  )
    return { ...getLiveState(db), workIds: [], authorIds: [] };
  return db.transaction(() => {
    const beforeAggregate = aggregateSnapshot(
      db,
      mappedCandidates,
      preparedAuthors,
    );
    const visibleChange =
      mappedCandidates.length > 0 || preparedAuthors.length > 0;
    const nextRevision = getLiveState(db).revision + Number(visibleChange);
    const impacted = impactedBefore(db, mappedCandidates),
      affected = createAffectedCounts();
    if (preparedAuthors.length) {
      const ids = upsertPhysicalAuthorsCore(db, preparedAuthors, affected);
      for (const id of ids.values()) impacted.authorIds.add(id);
    }
    let applied = { works: [] };
    if (mappedCandidates.length)
      applied = applyMappedBatchCore(
        db,
        mappedCandidates,
        { observedAtMs },
        affected,
        { preserveExistingAuthorAuthority: true },
      );
    recountAffectedCounts(db, affected);
    refreshRelationTargetsForIdentities(db, impacted.sourceIdentities);
    for (const item of applied.works) {
      impacted.workIds.add(item.workId);
      impacted.authorIds.add(item.authorId);
    }
    for (const id of affected.authorIds) impacted.authorIds.add(id);
    for (const id of affected.tagIds) impacted.tagIds.add(id);
    refreshLiveSearch(db, {
      workIds: impacted.workIds,
      authorIds: impacted.authorIds,
      tagIds: impacted.tagIds,
    });
    const afterAggregate = aggregateSnapshot(
      db,
      mappedCandidates,
      preparedAuthors,
    );
    applyAggregateDelta(db, beforeAggregate, afterAggregate, nextRevision);
    const workStamp = db.prepare(
      "INSERT INTO live_scan_works VALUES (@platformId,@key,@fingerprint,@adapterVersion,@authorityAtMs,@authoritySourceId) ON CONFLICT(platform_id,relative_path_key) DO UPDATE SET fingerprint=excluded.fingerprint,adapter_version=excluded.adapter_version,authority_at_ms=excluded.authority_at_ms,authority_source_id=excluded.authority_source_id",
    );
    for (const row of scanWorks) {
      if (row.fingerprint === null)
        db.prepare(
          "DELETE FROM live_scan_works WHERE platform_id=? AND relative_path_key=?",
        ).run(row.platformId, row.key);
      else workStamp.run(row);
    }
    const authorStamp = db.prepare(
      "INSERT INTO live_scan_authors VALUES (@platformId,@key,@fingerprint) ON CONFLICT(platform_id,relative_path_key) DO UPDATE SET fingerprint=excluded.fingerprint",
    );
    for (const row of scanAuthors) authorStamp.run(row);
    if (visibleChange)
      db.prepare(
        "UPDATE live_meta SET revision=revision+1 WHERE singleton=1",
      ).run();
    return {
      ...getLiveState(db),
      workIds: [...impacted.workIds],
      authorIds: [...impacted.authorIds],
    };
  })();
}

function removeLiveEntities(db, { workIds = [], authorIds = [] } = {}) {
  if (!workIds.length && !authorIds.length)
    return { ...getLiveState(db), deletedWorks: 0, deletedAuthors: 0 };
  return db.transaction(() => {
    const affected = createAffectedCounts(),
      tags = new Set(),
      authors = new Set(authorIds),
      identities = [],
      touchedPlatforms = new Set();
    let deletedWorks = 0,
      deletedAuthors = 0;
    for (const id of workIds) {
      const row = db.prepare("SELECT * FROM works WHERE work_id=?").get(id);
      if (!row) continue;
      collectWorkCountIdentities(db, id, affected);
      authors.add(row.author_id);
      touchedPlatforms.add(row.platform_id);
      for (const tag of db
        .prepare("SELECT tag_id FROM work_tags WHERE work_id=?")
        .all(id))
        tags.add(tag.tag_id);
      if (row.source_work_id)
        identities.push({
          platformId: row.platform_id,
          sourceWorkId: row.source_work_id,
        });
      db.prepare("UPDATE works SET cover_media_id=NULL WHERE work_id=?").run(
        id,
      );
      db.prepare("DELETE FROM works WHERE work_id=?").run(id);
      db.prepare(
        "DELETE FROM live_scan_works WHERE platform_id=? AND relative_path_key=?",
      ).run(row.platform_id, row.relative_path_key);
      db.prepare(
        "UPDATE live_stats SET works=works-1,media=media-? WHERE singleton=1",
      ).run(row.media_count);
      db.prepare(
        "UPDATE live_metadata_stats SET count=count-1 WHERE metadata_state=?",
      ).run(row.metadata_state);
      db.prepare(
        "UPDATE live_platform_stats SET count_works=count_works-1,count_media=count_media-? WHERE platform_id=?",
      ).run(row.media_count, row.platform_id);
      deletedWorks++;
    }
    for (const id of authorIds) {
      const row = db
        .prepare(
          "SELECT platform_id,relative_path_key FROM authors WHERE author_id=?",
        )
        .get(id);
      if (!row) continue;
      db.prepare("DELETE FROM authors WHERE author_id=?").run(id);
      db.prepare(
        "DELETE FROM live_scan_authors WHERE platform_id=? AND relative_path_key=?",
      ).run(row.platform_id, row.relative_path_key);
      db.prepare(
        "UPDATE live_stats SET authors=authors-1 WHERE singleton=1",
      ).run();
      touchedPlatforms.add(row.platform_id);
      deletedAuthors++;
    }
    recountAffectedCounts(db, affected);
    refreshRelationTargetsForIdentities(db, identities);
    refreshLiveSearch(db, { workIds, authorIds: authors, tagIds: tags });
    db.prepare(
      "UPDATE live_meta SET revision=revision+1 WHERE singleton=1",
    ).run();
    for (const id of touchedPlatforms)
      db.prepare(
        "UPDATE live_platform_stats SET last_revision=(SELECT revision FROM live_meta WHERE singleton=1) WHERE platform_id=?",
      ).run(id);
    return { ...getLiveState(db), deletedWorks, deletedAuthors };
  })();
}

module.exports = {
  LIVE_SCHEMA_VERSION,
  applyLiveBatch,
  removeLiveEntities,
  ensureLive,
  getLiveState,
  liveCatalogPath,
  openLive,
};
