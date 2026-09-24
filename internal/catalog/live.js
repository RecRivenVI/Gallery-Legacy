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
const { collectWorkCountIdentities, createAffectedCounts, recountAffectedCounts } = require("./counts.js");
const { applyMappedBatchCore, finalizeCatalogWrites, refreshRelationTargetsForIdentities, upsertPhysicalAuthorsCore, verifyCatalogContract } = require("./writer.js");
const { createLiveSearchSchema, rebuildLiveSearch, refreshLiveSearch } = require("../search/live.js");

const LIVE_SCHEMA_VERSION = 2;

function liveCatalogPath(config) { return path.join(config.instanceRoot, "live", "catalog.sqlite"); }

function assertSourceBindings(db, config) {
  for (const row of db.prepare("SELECT platform_id,physical_root_key FROM platforms").all())
    if (normalizePhysicalRootKey(config.sources[row.platform_id]) !== row.physical_root_key)
      throw Object.assign(new Error("Live Catalog source bindings differ from runtime configuration"), { code: "LIVE_SOURCE_BINDING_MISMATCH" });
}

function getLiveState(db) {
  const row = db.prepare("SELECT * FROM live_meta WHERE singleton=1").get();
  if (!row) throw Object.assign(new Error("Live metadata missing"), { code: "LIVE_META_MISSING" });
  const schemaVersion = Number(row.schema_version), revision = Number(row.revision), initializedAtMs = Number(row.initialized_at_ms);
  if (schemaVersion !== LIVE_SCHEMA_VERSION) throw Object.assign(new Error("Unsupported live schema version"), { code: "LIVE_SCHEMA_UNSUPPORTED" });
  if (typeof row.base_generation_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.base_generation_id))
    throw Object.assign(new Error("Invalid live base generation"), { code: "LIVE_META_INVALID" });
  if (typeof row.epoch !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.epoch))
    throw Object.assign(new Error("Invalid live epoch"), { code: "LIVE_META_INVALID" });
  if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(initializedAtMs) || initializedAtMs < 0)
    throw Object.assign(new Error("Invalid live revision metadata"), { code: "LIVE_META_INVALID" });
  const platformRevisions = Object.fromEntries(db.prepare("SELECT platform_id,last_revision FROM live_platform_stats ORDER BY platform_id").all()
    .map((item) => [item.platform_id,Number(item.last_revision)]));
  if (Object.values(platformRevisions).some((value) => !Number.isSafeInteger(value) || value < 0 || value > revision))
    throw Object.assign(new Error("Invalid live platform revision metadata"), { code: "LIVE_META_INVALID" });
  return Object.freeze({
    schemaVersion, baseGenerationId: row.base_generation_id,
    epoch: row.epoch, revision, initializedAtMs, platformRevisions: Object.freeze(platformRevisions),
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
  const row = db.prepare("SELECT schema_version FROM live_meta WHERE singleton=1").get();
  if (!row || typeof row.schema_version !== "bigint") throw Object.assign(new Error("Live schema metadata missing"), { code: "LIVE_META_INVALID" });
  const version = Number(row.schema_version);
  if (version === LIVE_SCHEMA_VERSION) return false;
  if (version !== 1) throw Object.assign(new Error("Unsupported live schema version"), { code: "LIVE_SCHEMA_UNSUPPORTED" });
  db.transaction(() => { createLiveStatsSchema(db); rebuildLiveStats(db); db.prepare("UPDATE live_meta SET schema_version=? WHERE singleton=1").run(LIVE_SCHEMA_VERSION); })();
  return true;
}

function initializeLiveFile(target, generation) {
  const root = path.dirname(target);
  fs.mkdirSync(root, { recursive: true });
  const temp = path.join(root, `.catalog-${crypto.randomUUID()}.tmp`);
  noLinks(temp);
  fs.copyFileSync(generation.catalogPath, temp, fs.constants.COPYFILE_EXCL);
  let db;
  try {
    db = new Database(temp);
    db.defaultSafeIntegers(true);
    db.pragma("foreign_keys=ON");
    db.pragma("journal_mode=WAL");
    db.pragma("synchronous=NORMAL");
    db.transaction(() => {
      db.exec(`CREATE TABLE live_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,base_generation_id TEXT NOT NULL,epoch TEXT NOT NULL,revision INTEGER NOT NULL,initialized_at_ms INTEGER NOT NULL);
        CREATE TABLE live_id_high_water(entity TEXT PRIMARY KEY,value INTEGER NOT NULL);`);
      db.prepare("INSERT INTO live_meta VALUES (1,?,?,?,?,?)").run(LIVE_SCHEMA_VERSION,generation.generationId,crypto.randomUUID(),0,Date.now());
      for (const [entity, table, id] of [["author","authors","author_id"],["work","works","work_id"],["media","media","media_id"],["tag","tags","tag_id"]]) {
        const value = db.prepare(`SELECT coalesce(max(${id}),0) value FROM ${table}`).get().value;
        db.prepare("INSERT INTO live_id_high_water VALUES (?,?)").run(entity,value);
      }
      createLiveSearchSchema(db);
      rebuildLiveSearch(db);
      createLiveStatsSchema(db);
      rebuildLiveStats(db);
    })();
    verifyCatalogContract(db, { allowLive: true });
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close(); db = null;
    fs.renameSync(temp, target);
  } catch (error) {
    try { db?.close(); } catch {}
    try { fs.rmSync(temp, { force: true }); } catch {}
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
    throw Object.assign(new Error("Live Catalog is still in use and cannot be replaced"), { code: "LIVE_RESTART_REQUIRED", cause: error });
  } finally { try { db.close(); } catch {} }
  for (const suffix of ["-wal","-shm","-journal"]) {
    const sidecar = target + suffix;
    if (fs.existsSync(sidecar)) {
      try { fs.rmSync(sidecar, { force: true }); }
      catch (error) { throw Object.assign(new Error("Live SQLite sidecar remains in use"), { code: "LIVE_RESTART_REQUIRED", cause: error }); }
    }
  }
}

function externalOwner(config,kind) {
  const lock = readJson(path.join(config.stateRoot,kind + ".lock"));
  if (!lock) return false;
  if (!lock.identity) return true;
  if (lock.identity.pid === process.pid) return false;
  try { return sameIdentity(processIdentity(lock.identity.pid),lock.identity); }
  catch { return true; }
}

function externalProcessOwnsLive(config) { return externalOwner(config,"runtime") || externalOwner(config,"scan"); }

async function ensureLive(config, generation) {
  if (!config.liveUpdates) return Object.freeze({ enabled: false, catalogPath: null });
  const target = liveCatalogPath(config);
  return withMaintenance(config, () => {
    const source = new Database(generation.catalogPath, { readonly: true, fileMustExist: true });
    source.defaultSafeIntegers(true);
    try { verifyCatalogContract(source); assertSourceBindings(source,config); }
    finally { source.close(); }
    let current = null;
    if (fs.existsSync(target)) {
      let db;
      try {
        db = new Database(target); db.defaultSafeIntegers(true);db.pragma("foreign_keys=ON");db.pragma("journal_mode=WAL");db.pragma("busy_timeout=5000");
        const schemaRow=db.prepare("SELECT schema_version FROM live_meta WHERE singleton=1").get();
        const schemaVersion=typeof schemaRow?.schema_version==="bigint"?Number(schemaRow.schema_version):null;
        if(schemaVersion===1){
          verifyCatalogContract(db,{allowLive:true,allowLegacyLive:true});assertSourceBindings(db,config);
          if(externalProcessOwnsLive(config))throw Object.assign(new Error("Runtime or scan owner must restart before live schema upgrade"),{code:"LIVE_RESTART_REQUIRED"});
          migrateLiveSchema(db);
        }
        verifyCatalogContract(db, { allowLive: true }); assertSourceBindings(db,config); current = getLiveState(db);
      } catch (error) {
        const preserved = ["LIVE_SOURCE_BINDING_MISMATCH","LIVE_RESTART_REQUIRED"].includes(error.code) ? error.code : "LIVE_CATALOG_INVALID";
        throw Object.assign(new Error("Existing live Catalog failed validation; committed live facts were preserved"), { code: preserved, cause: error });
      } finally { try { db?.close(); } catch {} }
    } else if (["-wal","-shm","-journal"].some((suffix) => fs.existsSync(target + suffix))) {
      throw Object.assign(new Error("Live Catalog main file is missing while SQLite sidecars remain"), { code: "LIVE_CATALOG_INVALID" });
    }
    const reset = !current || current.baseGenerationId !== generation.generationId;
    if (reset && current) {
      const runtime = readJson(config.statusPath);
      if ((["STARTING","READY"].includes(runtime?.state) || readJson(path.join(config.stateRoot,"scan.lock"))) && externalProcessOwnsLive(config))
        throw Object.assign(new Error("Running Runtime must restart to select another live base generation"), { code: "LIVE_RESTART_REQUIRED" });
      prepareLiveReplacement(target);
    }
    if (reset) initializeLiveFile(target, generation);
    const db = new Database(target, { readonly: true, fileMustExist: true }); db.defaultSafeIntegers(true);
    try { return Object.freeze({ enabled: true, catalogPath: target, reset, ...getLiveState(db) }); }
    finally { db.close(); }
  });
}

function openLive(config, generation, { readonly = true } = {}) {
  if (!config.liveUpdates) return Object.freeze({ enabled: false, catalogPath: null });
  const catalogPath = liveCatalogPath(config);
  if (!fs.existsSync(catalogPath)) throw Object.assign(new Error("Live Catalog has not been prepared"), { code: "LIVE_NOT_PREPARED" });
  const db = new Database(catalogPath, { readonly, fileMustExist: true });
  db.defaultSafeIntegers(true); if (!readonly) { db.pragma("foreign_keys=ON"); db.pragma("journal_mode=WAL"); db.pragma("busy_timeout=5000"); }
  try {
    verifyCatalogContract(db, { allowLive: true }); assertSourceBindings(db,config);
    const state = getLiveState(db);
    if (state.baseGenerationId !== generation.generationId) throw Object.assign(new Error("Live Catalog base differs from active generation"), { code: "LIVE_BASE_GENERATION_MISMATCH" });
    return { enabled: true, catalogPath, reset: false, db, ...state, close() { db.close(); } };
  } catch (error) { db.close(); throw error; }
}

function impactedBefore(db, candidates) {
  const workIds = new Set(), authorIds = new Set(), tagIds = new Set(), sourceIdentities = [];
  for (const candidate of candidates) {
    const work = candidate.rows.work;
    const row = db.prepare("SELECT work_id,author_id,source_work_id FROM works WHERE platform_id=? AND relative_path_key=?").get(work.platform_id,work.relative_path_key);
    if (!row || row.source_work_id !== work.source_work_id) {
      if (row?.source_work_id) sourceIdentities.push({ platformId: work.platform_id, sourceWorkId: row.source_work_id });
      if (work.source_work_id) sourceIdentities.push({ platformId: work.platform_id, sourceWorkId: work.source_work_id });
    }
    if (row) {
      workIds.add(row.work_id); authorIds.add(row.author_id);
      for (const tag of db.prepare("SELECT tag_id FROM work_tags WHERE work_id=?").all(row.work_id)) tagIds.add(tag.tag_id);
    }
  }
  return { workIds, authorIds, tagIds, sourceIdentities };
}

function aggregateSnapshot(db, candidates, preparedAuthors) {
  const works = new Map(), authors = new Map();
  for (const candidate of candidates) {
    const row = candidate.rows.work, key = row.platform_id + "\0" + row.relative_path_key;
    if (!works.has(key)) works.set(key,db.prepare("SELECT platform_id,metadata_state,media_count FROM works WHERE platform_id=? AND relative_path_key=?").get(row.platform_id,row.relative_path_key) || null);
  }
  for (const row of [...candidates.map((item) => item.rows.author),...preparedAuthors]) {
    const key = row.platform_id + "\0" + row.relative_path_key;
    if (!authors.has(key)) authors.set(key,!!db.prepare("SELECT 1 FROM authors WHERE platform_id=? AND relative_path_key=?").get(row.platform_id,row.relative_path_key));
  }
  return { works, authors };
}

function applyAggregateDelta(db, before, after, nextRevision) {
  let workDelta = 0, mediaDelta = 0, authorDelta = 0;
  const metadata = new Map(), platforms = new Map();
  const addMetadata = (state,delta) => { if (state) metadata.set(state,(metadata.get(state) || 0) + delta); };
  const addPlatform = (id,works,media) => { const value = platforms.get(id) || { works: 0, media: 0 }; value.works += works; value.media += media; platforms.set(id,value); };
  for (const [key,oldRow] of before.works) {
    const newRow = after.works.get(key);
    if (!oldRow && newRow) { workDelta++;mediaDelta+=Number(newRow.media_count);addMetadata(newRow.metadata_state,1);addPlatform(newRow.platform_id,1,Number(newRow.media_count)); }
    else if (oldRow && newRow) { const delta=Number(newRow.media_count-oldRow.media_count);mediaDelta+=delta;addPlatform(newRow.platform_id,0,delta);if(oldRow.metadata_state!==newRow.metadata_state){addMetadata(oldRow.metadata_state,-1);addMetadata(newRow.metadata_state,1);} }
  }
  for (const [key,existed] of before.authors) if (!existed && after.authors.get(key)) authorDelta++;
  db.prepare("UPDATE live_stats SET works=works+?,media=media+?,authors=authors+? WHERE singleton=1").run(workDelta,mediaDelta,authorDelta);
  const metadataUpdate=db.prepare("UPDATE live_metadata_stats SET count=count+? WHERE metadata_state=?");
  const metadataInsert=db.prepare("INSERT INTO live_metadata_stats(metadata_state,count) VALUES (?,?)");
  for(const [state,delta] of metadata)if(delta){const changed=metadataUpdate.run(delta,state).changes;if(!changed){if(delta<0)throw Object.assign(new Error("Live metadata aggregate underflow"),{code:"LIVE_STATS_INVALID"});metadataInsert.run(state,delta);}}
  const platformUpdate=db.prepare("UPDATE live_platform_stats SET count_works=count_works+?,count_media=count_media+?,last_revision=? WHERE platform_id=?");
  for(const [id,value] of platforms)platformUpdate.run(value.works,value.media,nextRevision,id);
  for (const row of [...candidatesPlatforms(after,before)])
    if (!platforms.has(row)) db.prepare("UPDATE live_platform_stats SET last_revision=? WHERE platform_id=?").run(nextRevision,row);
}

function candidatesPlatforms(after,before) {
  const ids = new Set();
  for (const row of [...after.works.values(),...before.works.values()]) if (row) ids.add(row.platform_id);
  for (const key of new Set([...after.authors.keys(),...before.authors.keys()])) ids.add(key.split("\0",1)[0]);
  return ids;
}

function applyLiveBatch(db, { mappedCandidates = [], preparedAuthors = [], observedAtMs = Date.now() } = {}) {
  for (const candidate of mappedCandidates)
    if (candidate.rows.work.filesystem_state !== "present" || candidate.rows.work.filesystem_files_state !== "complete")
      throw Object.assign(new Error("Only complete physical works may become live"), { code: "LIVE_WORK_INCOMPLETE" });
  if (!mappedCandidates.length && !preparedAuthors.length) return { ...getLiveState(db), workIds: [], authorIds: [] };
  return db.transaction(() => {
    const beforeAggregate = aggregateSnapshot(db,mappedCandidates,preparedAuthors);
    const nextRevision = getLiveState(db).revision + 1;
    const impacted = impactedBefore(db,mappedCandidates), affected = createAffectedCounts();
    if (preparedAuthors.length) {
      const ids = upsertPhysicalAuthorsCore(db,preparedAuthors,affected);
      for (const id of ids.values()) impacted.authorIds.add(id);
    }
    let applied = { works: [] };
    if (mappedCandidates.length) applied = applyMappedBatchCore(db,mappedCandidates,{ observedAtMs },affected,{ preserveExistingAuthorAuthority: true });
    recountAffectedCounts(db,affected);
    refreshRelationTargetsForIdentities(db,impacted.sourceIdentities);
    for (const item of applied.works) { impacted.workIds.add(item.workId); impacted.authorIds.add(item.authorId); }
    for (const id of affected.authorIds) impacted.authorIds.add(id);
    for (const id of affected.tagIds) impacted.tagIds.add(id);
    refreshLiveSearch(db,{ workIds: impacted.workIds, authorIds: impacted.authorIds, tagIds: impacted.tagIds });
    const afterAggregate = aggregateSnapshot(db,mappedCandidates,preparedAuthors);
    applyAggregateDelta(db,beforeAggregate,afterAggregate,nextRevision);
    db.prepare("UPDATE live_meta SET revision=revision+1 WHERE singleton=1").run();
    return { ...getLiveState(db), workIds: [...impacted.workIds], authorIds: [...impacted.authorIds] };
  })();
}

function checkpointLive(db, { candidateCatalogPath, scope = {}, baseGenerationId } = {}) {
  db.prepare("ATTACH DATABASE ? AS checkpoint_catalog").run(candidateCatalogPath);
  try {
    return db.transaction(() => {
      const affected = createAffectedCounts(), deletedWorkIds = [], deletedAuthorIds = [];
      const nextRevision = getLiveState(db).revision + 1;
      const fullPlatforms = new Set(scope.invalidatedPlatformIds || []);
      if (scope.requestedPlatformId && !scope.requestedAuthorDirectoryName) fullPlatforms.add(scope.requestedPlatformId);
      if (scope.requestedPlatformIds && !scope.requestedAuthorDirectoryName) for (const id of scope.requestedPlatformIds) fullPlatforms.add(id);
      const authorKey = scope.requestedAuthorDirectoryName ? require("../library/paths.js").normalizeRelativePath(scope.requestedAuthorDirectoryName).relativePathKey : null;
      const args = [], parts = [];
      if (!scope.requestedPlatformId && !scope.requestedPlatformIds) parts.push("1");
      if (fullPlatforms.size) { parts.push(`w.platform_id IN (${[...fullPlatforms].map(() => "?").join(",")})`); args.push(...fullPlatforms); }
      const authorPlatform = scope.requestedPlatformId || (scope.requestedPlatformIds?.length === 1 ? scope.requestedPlatformIds[0] : null);
      if (authorPlatform && authorKey && !fullPlatforms.has(authorPlatform)) { parts.push("(w.platform_id=? AND a.relative_path_key=?)"); args.push(authorPlatform,authorKey); }
      const selected = parts.length ? "(" + parts.join(" OR ") + ")" : "0";
      db.exec("DROP TABLE IF EXISTS temp.live_checkpoint_delete_works");
      db.prepare(`CREATE TEMP TABLE live_checkpoint_delete_works AS SELECT w.work_id FROM works w JOIN authors a USING(author_id)
        WHERE ${selected} AND NOT EXISTS(SELECT 1 FROM checkpoint_catalog.works c WHERE c.platform_id=w.platform_id AND c.relative_path_key=w.relative_path_key)`).run(...args);
      const removedTotals=db.prepare("SELECT count(*) works,coalesce(sum(w.media_count),0) media FROM live_checkpoint_delete_works d JOIN works w USING(work_id)").get();
      db.prepare("UPDATE live_stats SET works=works-?,media=media-? WHERE singleton=1").run(removedTotals.works,removedTotals.media);
      for(const row of db.prepare("SELECT w.metadata_state,count(*) count FROM live_checkpoint_delete_works d JOIN works w USING(work_id) GROUP BY w.metadata_state").all())
        db.prepare("UPDATE live_metadata_stats SET count=count-? WHERE metadata_state=?").run(row.count,row.metadata_state);
      for(const row of db.prepare("SELECT w.platform_id,count(*) works,coalesce(sum(w.media_count),0) media FROM live_checkpoint_delete_works d JOIN works w USING(work_id) GROUP BY w.platform_id").all())
        db.prepare("UPDATE live_platform_stats SET count_works=count_works-?,count_media=count_media-?,last_revision=? WHERE platform_id=?").run(row.works,row.media,nextRevision,row.platform_id);
      let afterWork = 0n;
      while (true) {
        const rows = db.prepare("SELECT work_id FROM live_checkpoint_delete_works WHERE work_id>? ORDER BY work_id LIMIT 500").all(afterWork);
        if (!rows.length) break;
        for (const row of rows) {
          collectWorkCountIdentities(db,row.work_id,affected);
          db.prepare("UPDATE works SET cover_media_id=NULL WHERE work_id=?").run(row.work_id);
          db.prepare("DELETE FROM works WHERE work_id=?").run(row.work_id);
          deletedWorkIds.push(row.work_id);
        }
        afterWork = rows.at(-1).work_id;
      }
      const authorSelected = selected.replaceAll("w.platform_id", "a.platform_id");
      db.exec("DROP TABLE IF EXISTS temp.live_checkpoint_delete_authors");
      db.prepare(`CREATE TEMP TABLE live_checkpoint_delete_authors AS SELECT a.author_id FROM authors a
        WHERE ${authorSelected} AND NOT EXISTS(SELECT 1 FROM checkpoint_catalog.authors c WHERE c.platform_id=a.platform_id AND c.relative_path_key=a.relative_path_key)`).run(...args);
      const removedAuthors=db.prepare("SELECT count(*) count FROM live_checkpoint_delete_authors").get().count;
      db.prepare("UPDATE live_stats SET authors=authors-? WHERE singleton=1").run(removedAuthors);
      let afterAuthor = 0n;
      while (true) {
        const rows = db.prepare("SELECT author_id FROM live_checkpoint_delete_authors WHERE author_id>? ORDER BY author_id LIMIT 500").all(afterAuthor);
        if (!rows.length) break;
        for (const author of rows) { db.prepare("DELETE FROM authors WHERE author_id=?").run(author.author_id); deletedAuthorIds.push(author.author_id); }
        afterAuthor = rows.at(-1).author_id;
      }
      finalizeCatalogWrites(db,affected);
      refreshLiveSearch(db,{ workIds: deletedWorkIds, authorIds: [...affected.authorIds,...deletedAuthorIds], tagIds: affected.tagIds });
      db.exec(`UPDATE catalog_state SET
        schema_version=(SELECT schema_version FROM checkpoint_catalog.catalog_state WHERE singleton=1),
        catalog_revision=(SELECT catalog_revision FROM checkpoint_catalog.catalog_state WHERE singleton=1),
        built_at_ms=(SELECT built_at_ms FROM checkpoint_catalog.catalog_state WHERE singleton=1),
        adapter_contract_version=(SELECT adapter_contract_version FROM checkpoint_catalog.catalog_state WHERE singleton=1),
        shape_signature_version=(SELECT shape_signature_version FROM checkpoint_catalog.catalog_state WHERE singleton=1),
        filesystem_authority_contract_version=(SELECT filesystem_authority_contract_version FROM checkpoint_catalog.catalog_state WHERE singleton=1),
        normalizer_version=(SELECT normalizer_version FROM checkpoint_catalog.catalog_state WHERE singleton=1),
        sanitizer_version=(SELECT sanitizer_version FROM checkpoint_catalog.catalog_state WHERE singleton=1),
        search_index_version=(SELECT search_index_version FROM checkpoint_catalog.catalog_state WHERE singleton=1),
        platform_registry_fingerprint=(SELECT platform_registry_fingerprint FROM checkpoint_catalog.catalog_state WHERE singleton=1)
        WHERE singleton=1;
        UPDATE platforms SET family=(SELECT c.family FROM checkpoint_catalog.platforms c WHERE c.platform_id=platforms.platform_id),
        physical_root=(SELECT c.physical_root FROM checkpoint_catalog.platforms c WHERE c.platform_id=platforms.platform_id),
        physical_root_key=(SELECT c.physical_root_key FROM checkpoint_catalog.platforms c WHERE c.platform_id=platforms.platform_id),
        enabled=(SELECT c.enabled FROM checkpoint_catalog.platforms c WHERE c.platform_id=platforms.platform_id),
        adapter_version=(SELECT c.adapter_version FROM checkpoint_catalog.platforms c WHERE c.platform_id=platforms.platform_id),
        shape_policy_version=(SELECT c.shape_policy_version FROM checkpoint_catalog.platforms c WHERE c.platform_id=platforms.platform_id);`);
      db.prepare("UPDATE live_meta SET base_generation_id=?,revision=revision+1 WHERE singleton=1").run(baseGenerationId);
      db.prepare("UPDATE live_platform_stats SET last_revision=?").run(nextRevision);
      return { ...getLiveState(db), deletedWorks: deletedWorkIds.length, deletedAuthors: deletedAuthorIds.length };
    })();
  } finally { db.exec("DETACH DATABASE checkpoint_catalog"); }
}

module.exports = { LIVE_SCHEMA_VERSION, applyLiveBatch, checkpointLive, ensureLive, getLiveState, liveCatalogPath, openLive };
