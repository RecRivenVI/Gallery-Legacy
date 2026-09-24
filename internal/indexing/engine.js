"use strict";

const fs = require("node:fs"), path = require("node:path");
const { performance } = require("node:perf_hooks");
const Database = require("better-sqlite3");
const { PLATFORM_REGISTRY, bindSources } = require("../library/platforms.js");
const { normalizeRelativePath } = require("../library/paths.js");
const { overlap, physicalPath, noLinks } = require("../library/io-paths.js");
const { mapCatalogState, mapPlatformRegistry } = require(
  "../catalog/mapping.js",
);
const { validateCatalog } = require("../catalog/validation.js");
const {
  initializeCatalog,
  applyMappedBatchCore,
  finalizeCatalogWrites,
  upsertPhysicalAuthorsCore,
  verifyCatalogContract,
} = require("../catalog/writer.js");
const {
  collectWorkCountIdentities,
  createAffectedCounts,
  recountAffectedCounts,
} = require("../catalog/counts.js");
const { validateReconciledMediaPersistence } = require(
  "../catalog/media-persistence.js",
);
const { createStreamingAuthorPreparation } = require("./preparation.js");
const { createPreparationPool } = require("./preparation-pool.js");
const { scanPlatforms } = require("./scope.js");
const {
  evaluateFilesystemMediaEligibility,
} = require("../media/eligibility.js");
const {
  filesystemPresentationSources,
} = require("../media/presentation.js");
const { adapterForPlatform } = require("../metadata/index.js");

const RUNTIME_BACKEND_IDENTITY = "Catalog v4 — Filesystem Authority";
function emptyMediaStats() {
  return {
    actualMedia: 0,
    actualImages: 0,
    actualVideos: 0,
    metadataDeclarations: 0,
    matchedEnrichments: 0,
    unmatchedDeclarations: 0,
    ambiguousEnrichments: 0,
    typeConflicts: 0,
    ignoredFilesystemFiles: 0,
  };
}
function same(a, b) {
  if (typeof a === "bigint" && Number.isSafeInteger(b)) return a === BigInt(b);
  if (typeof b === "bigint" && Number.isSafeInteger(a)) return b === BigInt(a);
  return a === b;
}
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function sourceCollisionStats(db, platformId) {
  const works = db.prepare(
      `SELECT count(*) groups_count,coalesce(sum(entity_count),0) entities FROM (SELECT count(*) entity_count FROM works WHERE platform_id=? AND source_work_id IS NOT NULL GROUP BY source_work_id HAVING count(*)>1)`,
    ).get(platformId),
    authors = db.prepare(
      `SELECT count(*) groups_count,coalesce(sum(entity_count),0) entities FROM (SELECT count(*) entity_count FROM authors WHERE platform_id=? AND source_author_id IS NOT NULL GROUP BY source_author_id HAVING count(*)>1)`,
    ).get(platformId);
  return {
    workGroups: Number(works.groups_count),
    physicalWorks: Number(works.entities),
    authorGroups: Number(authors.groups_count),
    physicalAuthors: Number(authors.entities),
  };
}
function candidateUnchanged(db, candidate) {
  const w = candidate.rows.work,
    s = db.prepare(
      `SELECT filesystem_state,filesystem_files_state,work_dir_mtime_ns,metadata_state,enrichment_state,metadata_mtime_ns,metadata_size,adapter_version FROM works WHERE platform_id=? AND relative_path_key=?`,
    ).get(w.platform_id, w.relative_path_key);
  if (!s) return false;
  for (
    const f of [
      "filesystem_state",
      "filesystem_files_state",
      "work_dir_mtime_ns",
      "metadata_state",
      "enrichment_state",
      "metadata_mtime_ns",
      "metadata_size",
      "adapter_version",
    ]
  ) if (!same(s[f], w[f])) return false;
  const actual = db.prepare(
      `SELECT relative_path_key,filesystem_size,filesystem_mtime_ns,filesystem_media_type FROM media WHERE work_id=(SELECT work_id FROM works WHERE platform_id=? AND relative_path_key=?) ORDER BY relative_path_key`,
    ).all(w.platform_id, w.relative_path_key),
    seen = validateReconciledMediaPersistence(candidate).actualMediaRows.map(
      (r) => ({
        relative_path_key: r.relative_path_key,
        filesystem_size: BigInt(r.filesystem_size),
        filesystem_mtime_ns: r.filesystem_mtime_ns,
        filesystem_media_type: r.filesystem_media_type,
      }),
    );
  if (
    actual.length !== seen.length ||
    !actual.every((r, i) => Object.keys(r).every((f) => same(r[f], seen[i][f])))
  ) return false;
  const oldP = db.prepare(
      `SELECT field,source_kind,source_path,priority FROM field_sources WHERE work_id=(SELECT work_id FROM works WHERE platform_id=? AND relative_path_key=?) AND field LIKE 'media.%' ORDER BY field,priority,source_kind,source_path`,
    ).all(w.platform_id, w.relative_path_key),
    newP = (candidate.rows.fieldSources || []).filter((r) =>
      r.field.startsWith("media.")
    ).map(({ field, source_kind, source_path, priority }) => ({
      field,
      source_kind,
      source_path,
      priority,
    })).sort((a, b) =>
      compareText(a.field, b.field) || a.priority - b.priority ||
      compareText(a.source_kind, b.source_kind) ||
      compareText(a.source_path, b.source_path)
    );
  return oldP.length === newP.length &&
    oldP.every((r, i) => Object.keys(r).every((f) => same(r[f], newP[i][f])));
}
function incrementalReuseFacts(db, work, currentAdapterVersion) {
  if (
    work.state !== "present" || work.filesystemFilesState !== "complete" ||
    work.metadata.state !== "present"
  ) return null;
  const old = db.prepare(
    `SELECT w.work_id,w.work_dir_mtime_ns,w.metadata_state,w.metadata_mtime_ns,
      w.metadata_size,w.adapter_version
     FROM works w WHERE w.platform_id=? AND w.relative_path_key=?`,
  ).get(work.platformId, work.workRelativePathKey);
  if (
    !old || Number(old.adapter_version) !== currentAdapterVersion ||
    old.metadata_mtime_ns === null || old.metadata_size === null ||
    !same(old.work_dir_mtime_ns, work.workDirMtimeNs) ||
    !same(old.metadata_mtime_ns, work.metadata.mtimeNs) ||
    !same(old.metadata_size, work.metadata.size)
  ) return null;
  const eligibility = evaluateFilesystemMediaEligibility({
      filesystemFiles: work.filesystemFiles,
    }),
    eligibleByKey = new Map(
      eligibility.files.map((file) => [file.relativePathKey, file]),
    ),
    actual = work.filesystemFiles.filter((file) =>
      eligibleByKey.get(file.relativePathKey)?.eligible
    ).map((file) => ({
      relative_path_key: file.relativePathKey,
      filesystem_size: file.size,
      filesystem_mtime_ns: file.mtimeNs,
      filesystem_media_type:
        eligibleByKey.get(file.relativePathKey).filesystemMediaType,
    })).sort((a, b) => compareText(a.relative_path_key, b.relative_path_key)),
    stored = db.prepare(
      `SELECT relative_path_key,filesystem_size,filesystem_mtime_ns,
        filesystem_media_type FROM media WHERE work_id=?
       ORDER BY relative_path_key`,
    ).all(old.work_id);
  if (
    actual.length !== stored.length ||
    !actual.every((row, index) =>
      Object.keys(row).every((field) => same(row[field], stored[index][field]))
    )
  ) return null;
  const adapter = adapterForPlatform(work.platformId),
    presentation = [
      ...filesystemPresentationSources(work.filesystemFiles),
      ...(adapter?.presentationSources?.(null, work.filesystemFiles) || [])
        .filter((source) => source.sourceKind === "filesystem"),
    ].map((source) => ({
      field: source.field,
      source_kind: source.sourceKind,
      source_path: source.sourcePath,
      priority: source.priority,
    })).sort((a, b) =>
      compareText(a.field, b.field) || a.priority - b.priority ||
      compareText(a.source_kind, b.source_kind) ||
      compareText(a.source_path, b.source_path)
    ),
    storedPresentation = db.prepare(
      `SELECT field,source_kind,source_path,priority FROM field_sources
       WHERE work_id=? AND source_kind='filesystem' AND field LIKE 'media.%'
       ORDER BY field,priority,source_kind,source_path`,
    ).all(old.work_id);
  if (
    presentation.length !== storedPresentation.length ||
    !presentation.every((row, index) =>
      Object.keys(row).every((field) =>
        same(row[field], storedPresentation[index][field])
      )
    )
  ) return null;
  const explainedIgnored = new Set(
    presentation.map((row) =>
      normalizeRelativePath(row.source_path).relativePathKey
    ),
  );
  if (
    work.filesystemFiles.some((file) =>
      !eligibleByKey.get(file.relativePathKey)?.eligible &&
      !explainedIgnored.has(file.relativePathKey)
    )
  ) return null;
  const declaration = db.prepare(
      `SELECT count(*) total,
        coalesce(sum(match_state='matched'),0) matched,
        coalesce(sum(match_state='unmatched'),0) unmatched,
        coalesce(sum(match_state='ambiguous'),0) ambiguous,
        coalesce(sum(match_state='type_conflict'),0) type_conflicts
       FROM media_declarations WHERE work_id=?`,
    ).get(old.work_id),
    imageCount =
      actual.filter((row) => row.filesystem_media_type === "image").length;
  return {
    metadataState: old.metadata_state,
    media: {
      actualMedia: actual.length,
      actualImages: imageCount,
      actualVideos: actual.length - imageCount,
      metadataDeclarations: Number(declaration.total),
      matchedEnrichments: Number(declaration.matched),
      unmatchedDeclarations: Number(declaration.unmatched),
      ambiguousEnrichments: Number(declaration.ambiguous),
      typeConflicts: Number(declaration.type_conflicts),
      ignoredFilesystemFiles: work.filesystemFiles.length - actual.length,
    },
  };
}
function deleteWorks(db, ids, affected) {
  const clear = db.prepare(
      "UPDATE works SET cover_media_id=NULL WHERE work_id=?",
    ),
    remove = db.prepare("DELETE FROM works WHERE work_id=?");
  for (const id of ids) {
    collectWorkCountIdentities(db, id, affected);
    clear.run(id);
    remove.run(id);
  }
}
function removeMissingWorks(db, platformId, authorKey, observed, affected) {
  const missing = missingWorkIds(db, platformId, authorKey, observed);
  deleteWorks(db, missing, affected);
  return missing.length;
}
function missingWorkIds(db, platformId, authorKey, observed) {
  const rows = db.prepare(
    `SELECT w.work_id,w.relative_path_key FROM works w JOIN authors a USING(author_id) WHERE w.platform_id=? AND a.relative_path_key=?`,
  ).all(platformId, authorKey);
  return rows.filter((r) => !observed.has(r.relative_path_key)).map((r) =>
    r.work_id
  );
}
function removeMissingAuthors(db, platformId, observed, targetKey, affected) {
  let rows = db.prepare(
    "SELECT author_id,relative_path_key FROM authors WHERE platform_id=?",
  ).all(platformId);
  if (targetKey) rows = rows.filter((r) => r.relative_path_key === targetKey);
  let removedWorks = 0, removedAuthors = 0;
  for (const a of rows) {
    if (observed.has(a.relative_path_key)) continue;
    const ids = db.prepare("SELECT work_id FROM works WHERE author_id=?").all(
      a.author_id,
    ).map((r) => r.work_id);
    deleteWorks(db, ids, affected);
    db.prepare("DELETE FROM authors WHERE author_id=?").run(a.author_id);
    removedWorks += ids.length;
    removedAuthors++;
  }
  return { removedWorks, removedAuthors };
}
function synchronizeRegistry(db, roots, builtAtMs, allowLive) {
  verifyCatalogContract(db, { allowLive });
  const current = mapPlatformRegistry(roots),
    stored = new Map(
      db.prepare("SELECT * FROM platforms").all().map(
        (r) => [r.platform_id, r],
      ),
    ),
    invalid = [];
  for (const row of current) {
    const old = stored.get(row.platform_id);
    if (!old) {
      throw Object.assign(
        new Error("Catalog platform registry identity is incomplete"),
        { code: "CATALOG_BASELINE_INCOMPATIBLE" },
      );
    }
    if (
      old.adapter_version > BigInt(row.adapter_version) ||
      old.shape_policy_version > BigInt(row.shape_policy_version)
    ) {
      throw Object.assign(
        new Error("Catalog baseline uses a future extraction version"),
        { code: "CATALOG_BASELINE_FUTURE_VERSION" },
      );
    }
    if (
      [
        "family",
        "physical_root",
        "physical_root_key",
        "enabled",
        "adapter_version",
        "shape_policy_version",
      ].some((f) =>
        old[f] !== (typeof old[f] === "bigint" ? BigInt(row[f]) : row[f])
      )
    ) invalid.push(row.platform_id);
  }
  const old = db.prepare(
      "SELECT catalog_revision FROM catalog_state WHERE singleton=1",
    ).get(),
    state = mapCatalogState({
      catalogRevision: Number(old.catalog_revision) + 1,
      builtAtMs,
      platformRoots: roots,
    });
  db.transaction(() => {
    db.prepare(
      `UPDATE catalog_state SET catalog_revision=@catalog_revision,built_at_ms=@built_at_ms,adapter_contract_version=@adapter_contract_version,shape_signature_version=@shape_signature_version,filesystem_authority_contract_version=@filesystem_authority_contract_version,normalizer_version=@normalizer_version,sanitizer_version=@sanitizer_version,search_index_version=@search_index_version,platform_registry_fingerprint=@platform_registry_fingerprint WHERE singleton=1`,
    ).run(state);
    const update = db.prepare(
      `UPDATE platforms SET family=@family,physical_root=@physical_root,physical_root_key=@physical_root_key,enabled=@enabled,adapter_version=@adapter_version,shape_policy_version=@shape_policy_version WHERE platform_id=@platform_id`,
    );
    for (const row of current) update.run(row);
  })();
  verifyCatalogContract(db, { requireCurrentRegistry: true, allowLive });
  return invalid;
}
function platformFacts(db, id) {
  const r = db.prepare(
    `SELECT count(DISTINCT a.author_id) authors,count(DISTINCT w.work_id) works,count(DISTINCT m.media_id) media,count(DISTINCT CASE WHEN m.filesystem_media_type='image' THEN m.media_id END) images,count(DISTINCT CASE WHEN m.filesystem_media_type='video' THEN m.media_id END) videos FROM platforms p LEFT JOIN authors a ON a.platform_id=p.platform_id LEFT JOIN works w ON w.author_id=a.author_id LEFT JOIN media m ON m.work_id=w.work_id WHERE p.platform_id=?`,
  ).get(id);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}
function addPreparedStats(report, prepared) {
  const state = prepared.metadataDiagnostic.state;
  report.preparation.metadataStates[state] =
    (report.preparation.metadataStates[state] || 0) + 1;
  report.media.ignoredFilesystemFiles +=
    prepared.metadataDiagnostic.ignoredFilesystemFiles?.length || 0;
  const a = validateReconciledMediaPersistence(prepared.candidate);
  report.media.actualMedia += a.mediaCounts.mediaCount;
  report.media.actualImages += a.mediaCounts.imageCount;
  report.media.actualVideos += a.mediaCounts.videoCount;
  report.media.metadataDeclarations += a.declarationRows.length;
  for (const row of a.declarationRows) {
    if (row.match_state === "matched") report.media.matchedEnrichments++;
    else if (row.match_state === "unmatched") {
      report.media.unmatchedDeclarations++;
    } else if (row.match_state === "ambiguous") {
      report.media.ambiguousEnrichments++;
    } else if (row.match_state === "type_conflict") {
      report.media.typeConflicts++;
    }
  }
}

async function executeCatalogBuild(options = {}) {
  const requestedPlatforms = scanPlatforms(options),
    requestedAuthorName = options.authorDirectoryName || null;
  if (requestedAuthorName && requestedPlatforms?.length !== 1) {
    throw Object.assign(
      new Error("Author scope requires exactly one selected platform"),
      { code: "SCAN_AUTHOR_PLATFORM_REQUIRED" },
    );
  }
  const catalogPath = path.resolve(options.catalogPath),
    roots = options.platformRoots,
    strategy = options.strategy || "full";
  bindSources(roots);
  noLinks(catalogPath);
  for (const root of Object.values(roots)) {
    if (overlap(physicalPath(root), physicalPath(catalogPath))) {
      throw Object.assign(new Error("Catalog output overlaps a source"), {
        code: "SOURCE_PATH_OVERLAP",
      });
    }
  }
  if (fs.existsSync(catalogPath)) {
    throw Object.assign(new Error("Catalog already exists"), {
      code: "RUNTIME_CATALOG_EXISTS",
    });
  }
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  if (strategy === "incremental") {
    fs.copyFileSync(
      path.resolve(options.baseCatalogPath),
      catalogPath,
      fs.constants.COPYFILE_EXCL,
    );
  }
  const clock = typeof options.nowMs === "function"
      ? options.nowMs
      : () => Date.now(),
    db = new Database(catalogPath);
  db.defaultSafeIntegers(true);
  db.pragma("foreign_keys=ON");
  db.pragma("journal_mode=WAL");
  db.pragma("synchronous=NORMAL");
  const report = {
      reportVersion: 2,
      track: "Gallery Runtime",
      state: "BUILDING",
      backendIdentity: RUNTIME_BACKEND_IDENTITY,
      sourceRoots: [],
      platforms: [],
      global: null,
      catalogCounts: null,
      changes: null,
      scope: null,
    },
    changes = {
      authorsObserved: 0,
      authorsRebuilt: 0,
      authorsReused: 0,
      authorsDeleted: 0,
      worksObserved: 0,
      worksRebuilt: 0,
      worksReused: 0,
      worksDeleted: 0,
      metadataObserved: 0,
      metadataRead: 0,
      metadataReused: 0,
      metadataReparsed: 0,
      metadataBytesRead: 0,
      filesystemFilesObserved: 0,
    };
  let pool = null, ownsPool = false;
  try {
    let invalidated = [], liveBaseline = false;
    if (strategy === "full") {
      initializeCatalog(db, { builtAtMs: clock(), platformRoots: roots });
    } else {
      liveBaseline = !!db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_meta'",
      ).get();
      invalidated = synchronizeRegistry(db, roots, clock(), liveBaseline);
    }
    const requestedPlatformId = options.platformId || null,
      requestedPlatformIds = requestedPlatforms ||
        PLATFORM_REGISTRY.map((platform) => platform.id),
      requestedAuthorKey = requestedAuthorName
        ? normalizeRelativePath(requestedAuthorName).relativePathKey
        : null,
      effective = new Set([...requestedPlatformIds, ...invalidated]);
    report.scope = {
      mode: options.mode || strategy,
      requestedPlatformId,
      requestedPlatformIds,
      requestedAuthorDirectoryName: requestedAuthorName,
      invalidatedPlatformIds: invalidated,
      effectivePlatformIds: PLATFORM_REGISTRY.map((platform) => platform.id)
        .filter((platformId) => effective.has(platformId)),
    };
    report.sourceRoots = report.scope.effectivePlatformIds.map((
      platformId,
    ) => ({
      platformId,
      physicalRoot: roots[platformId],
    }));
    const reports = new Map(), platformStates = new Map(), authors = new Map();
    for (const p of PLATFORM_REGISTRY) {
      const selected = effective.has(p.id),
        r = {
          platformId: p.id,
          physicalRoot: roots[p.id],
          status: selected ? "PREFLIGHT" : "REUSED",
          filesystemIndexing: "COMPLETE",
          metadataEnrichment: "COMPLETE",
          topology: null,
          observation: null,
          preparation: {
            preparedWorks: 0,
            failedWorks: 0,
            authorsPrepared: 0,
            incompleteAuthors: 0,
            metadataStates: {},
          },
          worksRebuilt: 0,
          worksReused: 0,
          media: emptyMediaStats(),
          sourceIdentityCollisions: null,
          timings: {},
          error: null,
        };
      reports.set(p.id, r);
      report.platforms.push(r);
      if (selected) {
        platformStates.set(p.id, {
          started: performance.now(),
          force: strategy === "full" || options.mode === "full" ||
            invalidated.includes(p.id),
          authorKey: requestedPlatformIds.length === 1 &&
              requestedPlatformIds[0] === p.id && requestedAuthorKey &&
              !invalidated.includes(p.id)
            ? requestedAuthorKey
            : null,
          observedAuthors: new Set(),
        });
      }
    }
    let pendingCandidates = [],
      pendingAuthors = [],
      pendingCompleteAuthors = [],
      pendingCandidateBytes = 0,
      peakWriterCandidates = 0,
      peakWriterBytes = 0,
      writerDatabaseMs = 0,
      liveCallbackMs = 0;
    let pendingCandidateIndexes = new Map();
    const writerSoftBytes = options.writerSoftBytes || 64 * 1024 * 1024;
    const candidateKey = (candidate) =>
      candidate.rows.work.platform_id + "\0" +
      candidate.rows.work.relative_path_key;
    const estimateCandidateBytes = (candidate) =>
      2048 + (candidate.mediaPersistence?.actualMediaRows?.length || 0) * 512 +
      (candidate.rows.textSources || []).reduce(
        (sum, row) => sum + (row.source_text?.length || 0) * 2,
        0,
      );
    const queueCandidate = (
      candidate,
      bytes = estimateCandidateBytes(candidate),
    ) => {
      const key = candidateKey(candidate),
        existing = pendingCandidateIndexes.get(key);
      if (existing === undefined) {
        pendingCandidateIndexes.set(key, pendingCandidates.length);
        pendingCandidates.push({ candidate, bytes });
        pendingCandidateBytes += bytes;
      } else {
        pendingCandidateBytes += bytes - pendingCandidates[existing].bytes;
        pendingCandidates[existing] = { candidate, bytes };
      }
      peakWriterCandidates = Math.max(
        peakWriterCandidates,
        pendingCandidates.length,
      );
      peakWriterBytes = Math.max(peakWriterBytes, pendingCandidateBytes);
    };
    const flush = async () => {
      if (!pendingCandidates.length && !pendingAuthors.length) return;
      const candidates = pendingCandidates.map((item) => item.candidate),
        preparedAuthors = pendingAuthors,
        completeAuthors = pendingCompleteAuthors;
      const databaseStarted = performance.now();
      db.transaction(() => {
        const affected = createAffectedCounts();
        if (preparedAuthors.length) {
          upsertPhysicalAuthorsCore(db, preparedAuthors, affected);
        }
        if (candidates.length) {
          applyMappedBatchCore(
            db,
            candidates,
            { observedAtMs: clock() },
            affected,
          );
        }
        recountAffectedCounts(db, affected);
      })();
      writerDatabaseMs += performance.now() - databaseStarted;
      pendingCandidates = [];
      pendingCandidateIndexes = new Map();
      pendingCandidateBytes = 0;
      pendingAuthors = [];
      pendingCompleteAuthors = [];
      if (options.onCommittedBatch) {
        const liveStarted = performance.now();
        await options.onCommittedBatch({
          mappedCandidates: candidates,
          preparedAuthors,
          completeAuthors,
        });
        liveCallbackMs += performance.now() - liveStarted;
      }
    };
    const scopes = [...platformStates].map(([platformId, s]) => ({
      platformId,
      authorDirectoryName: s.authorKey ? requestedAuthorName : null,
    }));
    const reuseAuthors = new Map(),
      latestWork = db.prepare(
        `SELECT w.relative_path_key FROM authors a
         JOIN works w ON w.work_id=a.latest_work_id
         WHERE a.platform_id=? AND a.relative_path_key=?`,
      );
    const preferredWorkKey = strategy === "incremental"
      ? (platformId, authorKey) => {
        const ps = platformStates.get(platformId);
        if (!ps || ps.force) return null;
        const row = latestWork.get(platformId, authorKey);
        if (!row) return null;
        const key = platformId + "\0" + authorKey;
        reuseAuthors.set(key, {
          latestWorkKey: row.relative_path_key,
          stable: null,
        });
        return normalizeRelativePath(
          path.win32.basename(row.relative_path_key),
        ).relativePathKey;
      }
      : null;
    const adapterVersions = new Map(
      PLATFORM_REGISTRY.map((platform) => [
        platform.id,
        platform.adapterVersion,
      ]),
    );
    const metadataReuseProbe = strategy === "incremental"
      ? async (work) => {
        const state = reuseAuthors.get(
          work.platformId + "\0" +
            normalizeRelativePath(work.authorDirectoryName).relativePathKey,
        );
        if (!state) return null;
        const facts = incrementalReuseFacts(
          db,
          work,
          adapterVersions.get(work.platformId),
        );
        if (work.workRelativePathKey === state.latestWorkKey) {
          state.stable = !!facts;
          return null;
        }
        return state.stable ? facts : null;
      }
      : null;
    const factory = options.createObservationProducer ||
      require("../library/scan-producer.js").createObservationProducer;
    const events = await factory({
      platformRoots: roots,
      scopes,
      io: options.io || undefined,
      checkCancelled: options.checkCancelled || (() => {}),
      nestedSampleLimit: options.nestedSampleLimit ?? 32,
      concurrency: options.concurrency,
      metadataReuseProbe,
      preferredWorkKey,
    });
    pool = options.preparationPool || createPreparationPool({
      maxWorkers: options.maxPreparationWorkers,
    });
    ownsPool = !options.preparationPool;
    const prepareWindow = Math.max(
      1,
      Math.min(
        pool.maxWorkers,
        options.prepareWindow || pool.maxWorkers,
      ),
    );
    const prepareSoftBytes = options.prepareSoftBytes || 64 * 1024 * 1024;
    const preparationJobs = [];
    let pendingPreparationWorks = 0,
      bufferedPreparationBytes = 0,
      peakPendingWorks = 0,
      peakBufferedBytes = 0;
    const estimateWorkBytes = (work) =>
      Buffer.byteLength(work.metadata?.sourceText || "", "utf16le") +
      (work.filesystemFiles?.length || 0) * 512 + 1024;
    const emitWorkProgress = (platformId, platform) => {
      const observed = platform.worksRebuilt + platform.worksReused;
      if (
        observed !== 1 && observed % (options.progressEvery || 100) !== 0
      ) return;
      options.onProgress?.({
        phase: "WORK_PROGRESS",
        state: "SCANNING",
        platformId,
        observedWorks: observed,
        indexedWorks: platform.worksRebuilt,
        reusedWorks: platform.worksReused,
        actualMedia: platform.media.actualMedia,
        metadataStates: { ...platform.preparation.metadataStates },
        changes: { ...changes },
      });
    };
    const compactJobs = () => {
      while (preparationJobs[0]?.done) preparationJobs.shift();
    };
    const consumePrepared = async (job) => {
      if (job.done) return;
      const outcome = await job.promise;
      if (outcome.error) throw outcome.error;
      const mapped = outcome.value;
      const prepared = job.author.preparation.acceptPreparedEntry(mapped, {
        mapped: true,
      });
      const { event, author: a, platform: p, platformState: ps } = job;
      const candidate = prepared.candidate,
        changed = ps.force || !candidateUnchanged(db, candidate);
      if (a.observedWorks) {
        a.observedWorks.add(candidate.rows.work.relative_path_key);
      }
      if (changed) {
        queueCandidate(candidate, job.bytes);
        a.changed = true;
        changes.worksRebuilt++;
        p.worksRebuilt++;
      } else {
        changes.worksReused++;
        p.worksReused++;
      }
      changes.worksObserved++;
      changes.metadataObserved++;
      if (event.work.metadata.state === "present") changes.metadataReparsed++;
      p.preparation.preparedWorks++;
      addPreparedStats(p, prepared);
      emitWorkProgress(event.platformId, p);
      if (
        pendingCandidates.length >= (options.batchSize || 500) ||
        pendingCandidateBytes >= writerSoftBytes
      ) await flush();
      job.done = true;
      pendingPreparationWorks--;
      bufferedPreparationBytes -= job.bytes;
      if (a.preparationJobs[0] === job) a.preparationJobs.shift();
      else {
        const index = a.preparationJobs.indexOf(job);
        if (index >= 0) a.preparationJobs.splice(index, 1);
      }
      job.promise = null;
      job.event = null;
      job.author = null;
      job.platform = null;
      job.platformState = null;
      compactJobs();
    };
    const drainOldest = async () => {
      compactJobs();
      if (preparationJobs[0]) await consumePrepared(preparationJobs[0]);
    };
    const drainAuthor = async (author) => {
      while (author.preparationJobs.length) {
        await consumePrepared(author.preparationJobs[0]);
      }
    };
    const queuePreparation = async (event, author, platform, platformState) => {
      const bytes = estimateWorkBytes(event.work);
      while (
        pendingPreparationWorks >= prepareWindow ||
        (pendingPreparationWorks > 0 &&
          bufferedPreparationBytes + bytes > prepareSoftBytes)
      ) await drainOldest();
      const job = {
        event,
        author,
        platform,
        platformState,
        bytes,
        done: false,
        promise: pool.prepareMapped(
          event.work,
          author.author,
          author.preparation.provisionalSelections(),
        ).then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
      };
      preparationJobs.push(job);
      author.preparationJobs.push(job);
      pendingPreparationWorks++;
      bufferedPreparationBytes += bytes;
      peakPendingWorks = Math.max(peakPendingWorks, pendingPreparationWorks);
      peakBufferedBytes = Math.max(peakBufferedBytes, bufferedPreparationBytes);
    };
    for await (const event of events) {
      options.checkCancelled?.();
      const p = reports.get(event.platformId),
        ps = platformStates.get(event.platformId);
      if (!p || !ps) throw new Error("Producer emitted an unselected platform");
      if (event.type === "platformEnd" && event.topology) {
        p.topology = event.topology;
      }
      if (event.type === "platformStart") {
        p.topology = event.topology || null;
        p.storage = event.disk
          ? {
            type: event.disk.type,
            ioLimit: event.disk.ioLimit,
            workWindow: event.disk.workWindow,
          }
          : null;
        options.log?.(`PLATFORM_START ${event.platformId}`);
        options.onProgress?.({
          phase: "PLATFORM_START",
          state: "SCANNING",
          platformId: event.platformId,
          currentPlatform: event.platformId,
        });
        if (event.topology && event.topology.status !== "SAFE") {
          p.status = "TOPOLOGY_BLOCKED";
          p.filesystemIndexing = "BLOCKED";
        } else {options.onProgress?.({
            phase: "PREFLIGHT_DONE",
            state: "SCANNING",
            platformId: event.platformId,
            currentPlatform: event.platformId,
            topology: event.topology?.status || "SAFE",
            storage: p.storage,
          });}
        continue;
      }
      if (event.type === "authorStart") {
        const a = event.author,
          key = event.platformId + "\0" + a.authorRelativePathKey;
        ps.observedAuthors.add(a.authorRelativePathKey);
        authors.set(key, {
          preparation: createStreamingAuthorPreparation(a, { pool }),
          preparationJobs: [],
          observedWorks: strategy === "incremental" ? new Set() : null,
          changed: ps.force ||
            !db.prepare(
              "SELECT 1 FROM authors WHERE platform_id=? AND relative_path_key=?",
            ).get(event.platformId, a.authorRelativePathKey),
          author: a,
        });
        changes.authorsObserved++;
        continue;
      }
      if (event.type === "work") {
        const key = event.platformId + "\0" + event.authorKey,
          a = authors.get(key);
        if (!a) throw new Error("Work event has no authorStart");
        if (event.work.metadataReuse) {
          a.observedWorks?.add(event.work.workRelativePathKey);
          changes.worksObserved++;
          changes.worksReused++;
          changes.metadataObserved++;
          changes.metadataReused++;
          p.worksReused++;
          const reused = event.work.metadataReuse;
          p.preparation.metadataStates[reused.metadataState] =
            (p.preparation.metadataStates[reused.metadataState] || 0) + 1;
          for (const [field, value] of Object.entries(reused.media)) {
            p.media[field] += value;
          }
          emitWorkProgress(event.platformId, p);
          continue;
        }
        if (event.work.metadata.state === "present") changes.metadataRead++;
        await queuePreparation(event, a, p, ps);
        continue;
      }
      if (event.type === "authorEnd") {
        const key = event.platformId + "\0" + event.authorKey,
          a = authors.get(key);
        if (!a) throw new Error("authorEnd has no authorStart");
        await drainAuthor(a);
        const completed = await a.preparation.finishAsync(event.completion);
        p.preparation.authorsPrepared++;
        if (completed.authorOutcome.preparationState !== "complete") {
          p.preparation.incompleteAuthors++;
        }
        if (
          strategy === "incremental" &&
          event.completion.worksState === "complete"
        ) {
          const missing = missingWorkIds(
            db,
            event.platformId,
            a.author.authorRelativePathKey,
            a.observedWorks,
          );
          if (missing.length) {
            await flush();
            const affected = createAffectedCounts();
            db.transaction(() => {
              deleteWorks(db, missing, affected);
              recountAffectedCounts(db, affected);
            })();
            a.changed = true;
            changes.worksDeleted += missing.length;
          }
        }
        if (a.changed) {
          pendingAuthors.push(completed.preparedAuthor);
          if (completed.authorOutcome.preparationState === "complete") {
            pendingCompleteAuthors.push(completed.preparedAuthor);
          }
          if (completed.authoritativeCandidate) {
            queueCandidate(completed.authoritativeCandidate);
          }
          if (
            pendingCandidates.length >= (options.batchSize || 500) ||
            pendingAuthors.length >= (options.batchSize || 500) ||
            pendingCandidateBytes >= writerSoftBytes
          ) {
            await flush();
          }
          changes.authorsRebuilt++;
        } else changes.authorsReused++;
        authors.delete(key);
        reuseAuthors.delete(key);
        continue;
      }
      if (event.type === "platformEnd") {
        await flush();
        p.observation = event.observation;
        changes.filesystemFilesObserved +=
          event.observation?.filesystemFilesObserved || 0;
        changes.metadataBytesRead += event.observation?.metadataBytesRead || 0;
        const complete = p.filesystemIndexing !== "BLOCKED" &&
          event.observation?.state === "present" &&
          event.observation?.authorsState === "complete" &&
          p.preparation.incompleteAuthors === 0;
        if (complete && strategy === "incremental") {
          const affected = createAffectedCounts(),
            removed = db.transaction(() => {
              const r = removeMissingAuthors(
                db,
                event.platformId,
                ps.observedAuthors,
                ps.authorKey,
                affected,
              );
              recountAffectedCounts(db, affected);
              return r;
            })();
          changes.worksDeleted += removed.removedWorks;
          changes.authorsDeleted += removed.removedAuthors;
        }
        p.filesystemIndexing = complete
          ? "COMPLETE"
          : p.filesystemIndexing === "BLOCKED"
          ? "BLOCKED"
          : "INCOMPLETE";
        p.metadataEnrichment =
          Object.entries(p.preparation.metadataStates).some(([s, n]) =>
              s !== "valid" && n > 0
            )
            ? "PARTIAL"
            : "COMPLETE";
        p.status = complete
          ? (ps.force ? "COMPLETE" : "INCREMENTAL_COMPLETE")
          : p.filesystemIndexing === "BLOCKED"
          ? "TOPOLOGY_BLOCKED"
          : "FILESYSTEM_INCOMPLETE";
        p.timings.totalMs = performance.now() - ps.started;
        p.timings.producerSpanMs = event.durationMs ?? null;
        p.sourceIdentityCollisions = sourceCollisionStats(db, event.platformId);
        options.log?.(
          `PLATFORM_DONE ${event.platformId} filesystem=${p.filesystemIndexing} metadata=${p.metadataEnrichment} works=${event.observation?.worksObserved || 0} parsed=${p.preparation.preparedWorks} reused=${p.worksReused}`,
        );
        options.onProgress?.({
          phase: "PLATFORM_DONE",
          state: "SCANNING",
          platformId: event.platformId,
          status: p.status,
          observedWorks: event.observation?.worksObserved || 0,
          indexedWorks: p.worksRebuilt,
          reusedWorks: p.worksReused,
          authors: event.observation?.authorsObserved || 0,
          actualMedia: p.media.actualMedia,
          metadataStates: { ...p.preparation.metadataStates },
          diagnostics: event.observation?.diagnostics?.length || 0,
          timings: { ...p.timings },
          changes: { ...changes },
        });
        continue;
      }
      throw new Error(`Unknown producer event: ${event.type}`);
    }
    while (pendingPreparationWorks) await drainOldest();
    const preparationPoolStats = pool.stats();
    if (ownsPool) {
      await pool.close();
      pool = null;
    }
    await flush();
    report.execution = {
      preparation: {
        coordinatorHeapUsedBytes: process.memoryUsage().heapUsed,
        workers: preparationPoolStats.maxWorkers,
        window: prepareWindow,
        softBufferedBytes: prepareSoftBytes,
        peakPendingWorks,
        peakBufferedBytes,
        ...(preparationPoolStats.workMs !== undefined
          ? { workMs: preparationPoolStats.workMs }
          : {}),
        ...(preparationPoolStats.peakReportedWorkerHeapBytes !== undefined
          ? {
            peakReportedWorkerHeapBytes:
              preparationPoolStats.peakReportedWorkerHeapBytes,
            workerHeapUsedBytes: preparationPoolStats.workerHeapUsedBytes,
          }
          : {}),
      },
      writer: {
        batchSize: options.batchSize || 500,
        softBufferedBytes: writerSoftBytes,
        peakPendingCandidates: peakWriterCandidates,
        peakBufferedBytes: peakWriterBytes,
        databaseMs: writerDatabaseMs,
        liveCallbackMs,
      },
      observation: {
        boundedProducer: true,
        crossDiskConcurrency: true,
        producerSpanIncludesConsumerBackpressure: true,
      },
    };
    if (authors.size) {
      throw Object.assign(new Error("Producer ended with unfinished authors"), {
        code: "SCAN_PRODUCER_INCOMPLETE",
      });
    }
    db.transaction(() => finalizeCatalogWrites(db, createAffectedCounts()))();
    if (
      db.prepare(
        "SELECT 1 FROM works w JOIN platforms p ON p.platform_id=w.platform_id WHERE w.adapter_version<>p.adapter_version LIMIT 1",
      ).get()
    ) {
      throw Object.assign(
        new Error("Candidate contains stale adapter extraction"),
        { code: "CATALOG_STALE_ADAPTER_VERSION" },
      );
    }
    if (liveBaseline) {
      db.exec("DROP INDEX IF EXISTS live_idx_relation_target_all");
      for (
        const table of [
          "live_work_fts",
          "live_short_fts",
          "live_work_sort",
          "live_search_docs",
          "live_work_tags",
          "live_authors",
          "live_tags",
          "live_stats",
          "live_metadata_stats",
          "live_platform_stats",
          "live_id_high_water",
          "live_meta",
        ]
      ) db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    report.catalogCounts = validateCatalog(db);
    verifyCatalogContract(db, { requireCurrentRegistry: true });
    for (const r of report.platforms) {
      r.catalog = platformFacts(db, r.platformId);
    }
    report.global = {
      authorsObserved: changes.authorsObserved,
      physicalWorksObserved: changes.worksObserved,
      worksIndexed: changes.worksRebuilt,
      filesystemFilesObserved: changes.filesystemFilesObserved,
      actualMedia: report.catalogCounts.media,
      actualImages: Number(
        db.prepare(
          "SELECT count(*) n FROM media WHERE filesystem_media_type='image'",
        ).get().n,
      ),
      actualVideos: Number(
        db.prepare(
          "SELECT count(*) n FROM media WHERE filesystem_media_type='video'",
        ).get().n,
      ),
      metadataDeclarations: report.catalogCounts.mediaDeclarations,
      catalogSizeBytes: fs.statSync(catalogPath).size,
    };
    report.changes = changes;
    report.state = report.platforms.some((r) =>
        r.filesystemIndexing !== "COMPLETE"
      )
      ? "INCOMPLETE"
      : "READY";
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    return { catalogPath, report };
  } catch (error) {
    if (ownsPool && pool) {
      try {
        await pool.cancel(error.code || "Catalog build failed");
      } catch {}
    }
    try {
      db.close();
    } catch {}
    report.state = "FAILED";
    error.report = error.report || report;
    throw error;
  }
}

module.exports = {
  RUNTIME_BACKEND_IDENTITY,
  candidateUnchanged,
  emptyMediaStats,
  executeCatalogBuild,
  sourceCollisionStats,
};
