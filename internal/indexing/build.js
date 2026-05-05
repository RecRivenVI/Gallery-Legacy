"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const Database = require("better-sqlite3");

const { PLATFORM_REGISTRY, bindSources } = require("../library/platforms.js");
const {
  createAffectedCounts,
  recountAffectedCounts,
} = require("../catalog/counts.js");
const {
  initializeCatalog,
  applyMappedBatchCore,
  finalizeCatalogWrites,
  upsertPhysicalAuthorsCore,
  verifyCatalogContract,
} = require("../catalog/writer.js");
const { observePlatformWorksStreaming } = require("../library/observation.js");
const { NODE_FS_IO } = require("../library/observer.js");
const { createStreamingAuthorPreparation } = require("./preparation.js");
const { validateCatalog } = require("../catalog/validation.js");
const { preflightPlatformTopology } = require("../library/topology.js");
const { overlap, physicalPath, noLinks } = require("../library/io-paths.js");

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

function accumulatePreparedStats(target, prepared) {
  const state = prepared.metadataDiagnostic?.state || "unknown";
  target.metadataStates[state] = (target.metadataStates[state] || 0) + 1;
  target.media.ignoredFilesystemFiles +=
    prepared.metadataDiagnostic?.ignoredFilesystemFiles?.length || 0;
  for (const candidate of prepared.preparedCandidates || [prepared.candidate]) {
    if (!candidate) continue;
    const authority = candidate.mediaPersistence;
    target.media.actualMedia += authority.mediaCounts.mediaCount;
    target.media.actualImages += authority.mediaCounts.imageCount;
    target.media.actualVideos += authority.mediaCounts.videoCount;
    target.media.metadataDeclarations += authority.declarationRows.length;
    target.media.matchedEnrichments += authority.declarationRows.filter(
      (row) => row.match_state === "matched",
    ).length;
    target.media.unmatchedDeclarations += authority.declarationRows.filter(
      (row) => row.match_state === "unmatched",
    ).length;
    target.media.ambiguousEnrichments += authority.declarationRows.filter(
      (row) => row.match_state === "ambiguous",
    ).length;
    target.media.typeConflicts += authority.declarationRows.filter(
      (row) => row.match_state === "type_conflict",
    ).length;
  }
}

function sourceCollisionStats(db, platformId) {
  const works = db
    .prepare(
      `SELECT count(*) AS groups_count,coalesce(sum(entity_count),0) AS entities FROM (
    SELECT count(*) AS entity_count FROM works WHERE platform_id=? AND source_work_id IS NOT NULL GROUP BY source_work_id HAVING count(*)>1
  )`,
    )
    .get(platformId);
  const authors = db
    .prepare(
      `SELECT count(*) AS groups_count,coalesce(sum(entity_count),0) AS entities FROM (
    SELECT count(*) AS entity_count FROM authors WHERE platform_id=? AND source_author_id IS NOT NULL GROUP BY source_author_id HAVING count(*)>1
  )`,
    )
    .get(platformId);
  return {
    workGroups: Number(works.groups_count),
    physicalWorks: Number(works.entities),
    authorGroups: Number(authors.groups_count),
    physicalAuthors: Number(authors.entities),
  };
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value))
    throw new TypeError(`${label} must be an absolute path`);
  return path.resolve(value);
}

function emitProgress(options, event) {
  if (typeof options.onProgress !== "function") return;
  try {
    options.onProgress(Object.freeze({ ...event }));
  } catch {
    /* Progress reporting must never change build semantics. */
  }
}

function buildCatalog(options = {}) {
  const catalogPath = assertAbsolutePath(options.catalogPath, "catalogPath");
  const roots = options.platformRoots;
  bindSources(roots);
  noLinks(catalogPath);
  for (const root of Object.values(roots)) {
    if (overlap(physicalPath(root), physicalPath(catalogPath))) {
      throw Object.assign(new Error("Catalog output overlap a source"), {
        code: "SOURCE_PATH_OVERLAP",
      });
    }
  }
  if (fs.existsSync(catalogPath)) {
    const error = new Error(
      "Catalog already exists; use a caller-owned rebuild policy",
    );
    error.code = "RUNTIME_CATALOG_EXISTS";
    throw error;
  }
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  const clock =
    typeof options.nowMs === "function" ? options.nowMs : () => Date.now();
  const selectedIds =
    options.platformIds === undefined ? null : new Set(options.platformIds);
  if (
    selectedIds &&
    [...selectedIds].some(
      (id) => !PLATFORM_REGISTRY.some((platform) => platform.id === id),
    )
  ) {
    throw new Error(
      "Catalog build platform selection contains an unknown registry ID",
    );
  }
  const selectedPlatforms = selectedIds
    ? PLATFORM_REGISTRY.filter((platform) => selectedIds.has(platform.id))
    : PLATFORM_REGISTRY;
  const targetBatchWorks =
    Number.isInteger(options.batchSize) && options.batchSize > 0
      ? options.batchSize
      : 500;
  const report = {
    reportVersion: 1,
    track: "Gallery Runtime",
    state: "BUILDING",
    backendIdentity: RUNTIME_BACKEND_IDENTITY,
    sourceRoots: selectedPlatforms.map((platform) => ({
      platformId: platform.id,
      physicalRoot: roots[platform.id],
    })),
    platforms: [],
    global: null,
    catalogCounts: null,
  };
  let db = null;
  try {
    db = new Database(catalogPath);
    const journalMode = String(
      db.pragma("journal_mode = WAL", { simple: true }),
    ).toLowerCase();
    if (journalMode !== "wal")
      throw new Error(
        "Catalog requires WAL journal mode for bounded streaming batches",
      );
    db.pragma("synchronous = NORMAL");
    initializeCatalog(db, { builtAtMs: clock(), platformRoots: roots });

    for (const platform of selectedPlatforms) {
      const root = assertAbsolutePath(
        roots[platform.id],
        `${platform.id} root`,
      );
      const platformReport = {
        platformId: platform.id,
        physicalRoot: root,
        status: "PREFLIGHT",
        filesystemIndexing: "PENDING",
        metadataEnrichment: "PENDING",
        topology: null,
        observation: null,
        preparation: {
          preparedWorks: 0,
          failedWorks: 0,
          authorsPrepared: 0,
          incompleteAuthors: 0,
          metadataStates: {},
        },
        media: emptyMediaStats(),
        sourceIdentityCollisions: null,
        timings: {},
        error: null,
      };
      report.platforms.push(platformReport);
      emitProgress(options, {
        phase: "PLATFORM_START",
        state: "SCANNING",
        platformId: platform.id,
        currentPlatform: platform.id,
      });
      try {
        if (typeof options.log === "function")
          options.log(`PLATFORM_START ${platform.id}`);
        const preflightStart = performance.now();
        platformReport.topology = preflightPlatformTopology({
          platformId: platform.id,
          physicalRoot: root,
          nestedSampleLimit: options.nestedSampleLimit ?? 32,
        });
        platformReport.timings.preflightMs = performance.now() - preflightStart;
        emitProgress(options, {
          phase: "PREFLIGHT_DONE",
          state: "SCANNING",
          platformId: platform.id,
          currentPlatform: platform.id,
          topology: platformReport.topology.status,
        });
        if (platformReport.topology.status !== "SAFE") {
          platformReport.status = "TOPOLOGY_BLOCKED";
          platformReport.filesystemIndexing = "BLOCKED";
          emitProgress(options, {
            phase: "PLATFORM_DONE",
            state: "SCANNING",
            platformId: platform.id,
            currentPlatform: platform.id,
            status: platformReport.status,
            observedWorks: 0,
            indexedWorks: 0,
            actualMedia: 0,
            metadataStates: {},
            timings: { ...platformReport.timings },
          });
          continue;
        }

        platformReport.status = "STREAMING";
        const started = performance.now();
        let preparationMs = 0;
        let databaseMs = 0;
        let pendingAuthors = [];
        let pendingCandidates = [];
        let pendingCandidateIndexes = new Map();
        let pendingWorks = 0;
        const flush = () => {
          if (!pendingAuthors.length && !pendingCandidates.length) return;
          const writeStart = performance.now();
          db.transaction(() => {
            const affected = createAffectedCounts();
            upsertPhysicalAuthorsCore(db, pendingAuthors, affected);
            if (pendingCandidates.length)
              applyMappedBatchCore(
                db,
                pendingCandidates,
                { observedAtMs: clock() },
                affected,
              );
            recountAffectedCounts(db, affected);
          })();
          databaseMs += performance.now() - writeStart;
          pendingAuthors = [];
          pendingCandidates = [];
          pendingCandidateIndexes = new Map();
          pendingWorks = 0;
        };

        const observationStart = performance.now();
        let authorPreparation = null;
        const observation = observePlatformWorksStreaming({
          platformId: platform.id,
          observationRoot: root,
          io: options.io || NODE_FS_IO,
          onAuthorStart(authorObservation) {
            authorPreparation =
              createStreamingAuthorPreparation(authorObservation);
          },
          onWork(workObservation) {
            const preparationStart = performance.now();
            const prepared = authorPreparation.prepareWork(workObservation);
            preparationMs += performance.now() - preparationStart;
            platformReport.preparation.preparedWorks++;
            accumulatePreparedStats(
              {
                metadataStates: platformReport.preparation.metadataStates,
                media: platformReport.media,
              },
              prepared,
            );
            const key = prepared.candidate.rows.work.relative_path_key;
            pendingCandidateIndexes.set(key, pendingCandidates.length);
            pendingCandidates.push(prepared.candidate);
            pendingWorks++;
            if (
              platformReport.preparation.preparedWorks === 1 ||
              platformReport.preparation.preparedWorks %
                (options.progressEvery ?? 1000) ===
                0
            ) {
              emitProgress(options, {
                phase: "WORK_PROGRESS",
                state: "SCANNING",
                platformId: platform.id,
                currentPlatform: platform.id,
                observedWorks: platformReport.preparation.preparedWorks,
                indexedWorks: platformReport.preparation.preparedWorks,
                authors: platformReport.preparation.authorsPrepared,
                actualMedia: platformReport.media.actualMedia,
                metadataStates: {
                  ...platformReport.preparation.metadataStates,
                },
              });
            }
            if (pendingWorks >= targetBatchWorks) flush();
          },
          onAuthorEnd(authorCompletion) {
            const preparationStart = performance.now();
            const completed = authorPreparation.finish(authorCompletion);
            preparationMs += performance.now() - preparationStart;
            platformReport.preparation.authorsPrepared++;
            if (completed.authorOutcome.preparationState !== "complete")
              platformReport.preparation.incompleteAuthors++;
            pendingAuthors.push(completed.preparedAuthor);
            if (completed.authoritativeCandidate) {
              const key =
                completed.authoritativeCandidate.rows.work.relative_path_key;
              const pendingIndex = pendingCandidateIndexes.get(key);
              if (pendingIndex === undefined) {
                pendingCandidateIndexes.set(key, pendingCandidates.length);
                pendingCandidates.push(completed.authoritativeCandidate);
                pendingWorks++;
              } else
                pendingCandidates[pendingIndex] =
                  completed.authoritativeCandidate;
            }
            authorPreparation = null;
            if (pendingWorks >= targetBatchWorks) flush();
          },
        });
        const observationMs =
          performance.now() - observationStart - preparationMs - databaseMs;
        flush();
        platformReport.observation = observation;
        platformReport.timings.observationMs = Math.max(0, observationMs);
        platformReport.timings.preparationMs = preparationMs;
        platformReport.timings.databaseMs = databaseMs;
        platformReport.timings.totalMs = performance.now() - started;
        platformReport.timings.worksPerSecond =
          platformReport.timings.totalMs > 0
            ? platformReport.preparation.preparedWorks /
              (platformReport.timings.totalMs / 1000)
            : null;
        platformReport.sourceIdentityCollisions = sourceCollisionStats(
          db,
          platform.id,
        );
        const complete =
          observation.state === "present" &&
          observation.authorsState === "complete" &&
          platformReport.preparation.incompleteAuthors === 0;
        platformReport.filesystemIndexing = complete
          ? "COMPLETE"
          : "INCOMPLETE";
        const nonValid = Object.entries(
          platformReport.preparation.metadataStates,
        ).some(([state, count]) => state !== "valid" && count > 0);
        platformReport.metadataEnrichment = nonValid ? "PARTIAL" : "COMPLETE";
        platformReport.status = complete ? "COMPLETE" : "FILESYSTEM_INCOMPLETE";
        emitProgress(options, {
          phase: "PLATFORM_DONE",
          state: "SCANNING",
          platformId: platform.id,
          currentPlatform: platform.id,
          status: platformReport.status,
          observedWorks: platformReport.observation?.worksObserved || 0,
          indexedWorks: platformReport.preparation.preparedWorks,
          authors: platformReport.observation?.authorsObserved || 0,
          actualMedia: platformReport.media.actualMedia,
          metadataStates: { ...platformReport.preparation.metadataStates },
          diagnostics: platformReport.observation?.diagnostics?.length || 0,
          timings: { ...platformReport.timings },
        });
        if (typeof options.log === "function")
          options.log(
            `PLATFORM_DONE ${platform.id} filesystem=${platformReport.filesystemIndexing} metadata=${platformReport.metadataEnrichment} works=${platformReport.preparation.preparedWorks}`,
          );
      } catch (error) {
        platformReport.status = "FAILED";
        platformReport.filesystemIndexing = "FAILED";
        platformReport.error = {
          code: error?.code || "RUNTIME_PLATFORM_FAILED",
          message: String(error?.message || error),
        };
        emitProgress(options, {
          phase: "PLATFORM_DONE",
          state: "SCANNING",
          platformId: platform.id,
          currentPlatform: platform.id,
          status: "FAILED",
          error: platformReport.error,
        });
        if (typeof options.log === "function")
          options.log(
            `PLATFORM_FAILED ${platform.id} ${platformReport.error.code}`,
          );
      }
    }

    db.transaction(() => finalizeCatalogWrites(db, createAffectedCounts()))();
    report.catalogCounts = validateCatalog(db);
    verifyCatalogContract(db);
    report.global = {
      authorsObserved: report.platforms.reduce(
        (sum, item) => sum + (item.observation?.authorsObserved || 0),
        0,
      ),
      physicalWorksObserved: report.platforms.reduce(
        (sum, item) => sum + (item.observation?.worksObserved || 0),
        0,
      ),
      worksIndexed: report.platforms.reduce(
        (sum, item) => sum + (item.preparation?.preparedWorks || 0),
        0,
      ),
      filesystemFilesObserved: report.platforms.reduce(
        (sum, item) => sum + (item.observation?.filesystemFilesObserved || 0),
        0,
      ),
      actualMedia: report.platforms.reduce(
        (sum, item) => sum + item.media.actualMedia,
        0,
      ),
      actualImages: report.platforms.reduce(
        (sum, item) => sum + item.media.actualImages,
        0,
      ),
      actualVideos: report.platforms.reduce(
        (sum, item) => sum + item.media.actualVideos,
        0,
      ),
      metadataDeclarations: report.platforms.reduce(
        (sum, item) => sum + item.media.metadataDeclarations,
        0,
      ),
      catalogSizeBytes: fs.statSync(catalogPath).size,
    };
    report.state = report.platforms.some(
      (item) => item.filesystemIndexing !== "COMPLETE",
    )
      ? "INCOMPLETE"
      : "READY";
    emitProgress(options, {
      phase: "CATALOG_DONE",
      state: report.state === "READY" ? "SCANNING" : "FAILED",
      currentPlatform: null,
      observedWorks: report.global.physicalWorksObserved,
      indexedWorks: report.global.worksIndexed,
      actualMedia: report.global.actualMedia,
      metadataStates: Object.fromEntries(
        report.platforms
          .flatMap((item) => Object.entries(item.preparation.metadataStates))
          .reduce(
            (map, [key, value]) => map.set(key, (map.get(key) || 0) + value),
            new Map(),
          ),
      ),
      diagnostics: report.platforms.reduce(
        (sum, item) => sum + (item.observation?.diagnostics?.length || 0),
        0,
      ),
      reportState: report.state,
    });
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    db = null;
    return { catalogPath, report };
  } catch (error) {
    try {
      db?.close();
    } catch {}
    report.state = "FAILED";
    report.error = {
      code: error?.code || "RUNTIME_CATALOG_BUILD_FAILED",
      message: String(error?.message || error),
    };
    throw error;
  }
}

module.exports = {
  RUNTIME_BACKEND_IDENTITY,
  buildCatalog,
  emptyMediaStats,
  sourceCollisionStats,
};
