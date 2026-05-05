"use strict";

const fs = require("node:fs");
const path = require("node:path");

const Database = require("better-sqlite3");
const { hashDatabaseFile } = require("../catalog/file-hash.js");
const { noLinks, overlap, physicalPath } = require("../library/io-paths.js");
const { bindSources } = require("../library/platforms.js");

const { validateCatalog } = require("../catalog/validation.js");
const { buildCatalog } = require("../indexing/build.js");
const {
  RUNTIME_SEARCH_INDEX_VERSION,
  buildSearchIndex,
} = require("../search/build.js");
const { QueryIndex } = require("../search/query.js");

const GENERATION_MANIFEST_VERSION = 1;
const GENERATION_POINTER_VERSION = 1;
const GENERATION_STATES = Object.freeze(["BUILDING", "VALIDATED", "READY"]);
const GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CATALOG_RELATIVE_PATH = "catalog/gallery-v4.sqlite";
const SEARCH_RELATIVE_PATH = "search/gallery-search.sqlite";
const SQLITE_FINALIZATION_VERSION = 1;

class GenerationPublicationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "GenerationPublicationError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new GenerationPublicationError(code, message, details);
}

function emitProgress(callback, event) {
  if (typeof callback !== "function") return;
  try {
    callback(Object.freeze({ ...event }));
  } catch {
    /* Progress reporting must not change publication semantics. */
  }
}

function assertAbsolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value))
    fail("GENERATION_PATH_NOT_ABSOLUTE", `${name} must be an absolute path`, {
      name,
      value,
    });
  return path.resolve(value);
}

function assertGenerationId(value) {
  if (typeof value !== "string" || !GENERATION_ID_PATTERN.test(value))
    fail(
      "GENERATION_ID_INVALID",
      "Generation ID contains unsupported characters or is too long",
      { generationId: value },
    );
  return value;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function assertInside(root, target, code = "GENERATION_PATH_ESCAPE") {
  if (!inside(root, target))
    fail(code, "Generation path escapes its instance root", { root, target });
  return target;
}

function generationPaths(
  instanceRoot,
  generationId,
  generationsRootOverride = null,
) {
  const root = assertAbsolute(instanceRoot, "instanceRoot");
  const id = assertGenerationId(generationId);
  const generationsRoot = generationsRootOverride
    ? assertInside(
        root,
        assertAbsolute(generationsRootOverride, "generationsRoot"),
      )
    : path.join(root, "generations");
  const generationRoot = assertInside(root, path.join(generationsRoot, id));
  noLinks(generationRoot);
  return Object.freeze({
    instanceRoot: root,
    generationsRoot,
    generationId: id,
    generationRoot,
    catalogRoot: path.join(generationRoot, "catalog"),
    searchRoot: path.join(generationRoot, "search"),
    catalogPath: path.join(generationRoot, CATALOG_RELATIVE_PATH),
    searchIndexPath: path.join(generationRoot, SEARCH_RELATIVE_PATH),
    manifestPath: path.join(generationRoot, "manifest.json"),
  });
}

function activePointerPath(instanceRoot, override = null) {
  const root = assertAbsolute(instanceRoot, "instanceRoot");
  const target = override
    ? assertAbsolute(override, "activeGenerationPath")
    : path.join(root, "active-generation.json");
  noLinks(target);
  return assertInside(root, target);
}

const { writeJson: atomicWriteJson } = require("../instance/files.js");

const hashFileSync = hashDatabaseFile;

function statFile(filePath) {
  noLinks(filePath);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    fail(
      "GENERATION_FILE_STAT_FAILED",
      `Unable to stat generation file: ${filePath}`,
      { cause: error.code || error.message },
    );
  }
  if (!Number.isSafeInteger(stat.size))
    fail(
      "GENERATION_FILE_SIZE_UNSAFE",
      `Generation file size is outside the safe integer range: ${filePath}`,
      { size: String(stat.size) },
    );
  if (
    !Number.isFinite(stat.mtimeMs) ||
    !Number.isSafeInteger(Math.trunc(stat.mtimeMs))
  )
    fail(
      "GENERATION_FILE_MTIME_UNSAFE",
      `Generation file mtime is outside the safe integer range: ${filePath}`,
      { mtimeMs: stat.mtimeMs },
    );
  return { sizeBytes: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
}

function sqliteSidecars(filePath) {
  return ["-wal", "-shm", "-journal"].map((suffix) => `${filePath}${suffix}`);
}

function finalizeSqliteFile(filePath) {
  const target = assertAbsolute(filePath, "SQLite generation file");
  noLinks(target);
  const manifestFile = path.join(
    path.dirname(path.dirname(target)),
    "manifest.json",
  );
  if (
    fs.existsSync(manifestFile) &&
    readManifest(manifestFile).state === "READY"
  )
    fail("GENERATION_IMMUTABLE", "READY generation cannot be modified");
  if (!fs.existsSync(target))
    fail(
      "GENERATION_FILE_MISSING",
      `Generation SQLite file does not exist: ${target}`,
    );
  let db;
  try {
    db = new Database(target);
    const mode = String(
      db.pragma("journal_mode", { simple: true }) || "",
    ).toLowerCase();
    if (mode === "wal") db.pragma("wal_checkpoint(TRUNCATE)");
    const finalMode = String(
      db.pragma("journal_mode = DELETE", { simple: true }) || "",
    ).toLowerCase();
    if (finalMode !== "delete")
      fail(
        "GENERATION_SQLITE_FINALIZE_MODE",
        `Unable to finalize SQLite journal mode for ${target}`,
        { mode: finalMode },
      );
  } catch (error) {
    if (error instanceof GenerationPublicationError) throw error;
    throw new GenerationPublicationError(
      error.code || "GENERATION_SQLITE_FINALIZE_FAILED",
      `Unable to finalize SQLite file: ${target}: ${error.message}`,
      { cause: error.code || error.message },
    );
  } finally {
    try {
      db?.close();
    } catch {}
  }
  for (const sidecar of sqliteSidecars(target)) {
    try {
      fs.rmSync(sidecar, { force: true });
    } catch (error) {
      throw new GenerationPublicationError(
        "GENERATION_SQLITE_SIDECAR_REMOVE_FAILED",
        `Unable to remove SQLite sidecar: ${sidecar}`,
        { cause: error.code || error.message },
      );
    }
    if (fs.existsSync(sidecar))
      fail(
        "GENERATION_SQLITE_SIDECAR_REMAINS",
        `SQLite sidecar remains after finalization: ${sidecar}`,
      );
  }
  let verify;
  try {
    verify = new Database(target, { readonly: true, fileMustExist: true });
    const mode = String(
      verify.pragma("journal_mode", { simple: true }) || "",
    ).toLowerCase();
    if (mode !== "delete")
      fail(
        "GENERATION_SQLITE_FINALIZE_VERIFY_FAILED",
        `Finalized SQLite file is not DELETE journal mode: ${target}`,
        { mode },
      );
  } catch (error) {
    if (error instanceof GenerationPublicationError) throw error;
    throw new GenerationPublicationError(
      error.code || "GENERATION_SQLITE_FINALIZE_VERIFY_FAILED",
      `Unable to verify finalized SQLite file: ${target}: ${error.message}`,
      { cause: error.code || error.message },
    );
  } finally {
    try {
      verify?.close();
    } catch {}
  }
  for (const sidecar of sqliteSidecars(target))
    if (fs.existsSync(sidecar))
      fail(
        "GENERATION_SQLITE_SIDECAR_CREATED_ON_READ",
        `Read-only verification created a SQLite sidecar: ${sidecar}`,
      );
  return {
    journalMode: "delete",
    sidecars: false,
    finalizationVersion: SQLITE_FINALIZATION_VERSION,
  };
}

function finalizeGenerationSqlite(paths, options = {}) {
  const finalizeFile = options.finalizeFile || finalizeSqliteFile;
  const catalog = finalizeFile(paths.catalogPath);
  if (options.rebuildSearch !== false) {
    buildSearchIndex({
      catalogPath: paths.catalogPath,
      searchIndexPath: paths.searchIndexPath,
    });
  }
  const search = finalizeFile(paths.searchIndexPath);
  return Object.freeze({
    version: SQLITE_FINALIZATION_VERSION,
    catalog,
    search,
  });
}

function readManifest(manifestPath) {
  const target = assertAbsolute(manifestPath, "manifestPath");
  noLinks(target);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    fail(
      "GENERATION_MANIFEST_INVALID",
      `Unable to read generation manifest: ${target}`,
      { cause: error.code || error.message },
    );
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    fail(
      "GENERATION_MANIFEST_INVALID",
      "Generation manifest must be an object",
      { manifestPath: target },
    );
  return manifest;
}

function baseManifest(generationId, state = "BUILDING", nowMs = Date.now()) {
  assertGenerationId(generationId);
  if (!GENERATION_STATES.includes(state))
    fail("GENERATION_STATE_INVALID", `Unsupported generation state: ${state}`, {
      state,
    });
  return {
    manifestVersion: GENERATION_MANIFEST_VERSION,
    generationId,
    state,
    createdAtMs: nowMs,
    build: { status: state },
    catalog: { relativePath: CATALOG_RELATIVE_PATH },
    search: { relativePath: SEARCH_RELATIVE_PATH },
  };
}

function validateRelativeFile(generationRoot, value, expected) {
  if (value !== expected || path.isAbsolute(value) || value.includes(".."))
    fail(
      "GENERATION_MANIFEST_PATH_INVALID",
      "Generation manifest contains an invalid relative file path",
      { value, expected },
    );
  return assertInside(generationRoot, path.resolve(generationRoot, value));
}

function collectEvidence(paths, state, nowMs = Date.now()) {
  const catalogStat = statFile(paths.catalogPath);
  let db;
  let facts;
  try {
    db = new Database(paths.catalogPath, {
      readonly: true,
      fileMustExist: true,
    });
    db.defaultSafeIntegers(true);
    facts = validateCatalog(db);
    if (
      db
        .prepare(
          "SELECT 1 FROM works WHERE filesystem_state<>'present' OR filesystem_files_state<>'complete' LIMIT 1",
        )
        .get()
    )
      fail(
        "GENERATION_FILESYSTEM_INCOMPLETE",
        "Generation contains incomplete filesystem observations",
      );
  } catch (error) {
    if (error instanceof GenerationPublicationError) throw error;
    throw new GenerationPublicationError(
      error.code || "GENERATION_CATALOG_INVALID",
      `Catalog validation failed for generation ${paths.generationId}: ${error.message}`,
      { cause: error.code || error.message },
    );
  } finally {
    try {
      db?.close();
    } catch {}
  }
  const catalogHash = hashFileSync(paths.catalogPath);
  let index;
  try {
    index = new QueryIndex(paths.searchIndexPath, {
      workCount: facts.works,
      catalogSize: catalogStat.sizeBytes,
      catalogMtimeMs: catalogStat.mtimeMs,
      catalogSha256: catalogHash,
    });
  } catch (error) {
    if (error instanceof GenerationPublicationError) throw error;
    throw new GenerationPublicationError(
      error.code || "GENERATION_BINDING_MISMATCH",
      `Search index is not bound to Catalog generation ${paths.generationId}: ${error.message}`,
      { cause: error.code || error.message },
    );
  } finally {
    try {
      index?.close();
    } catch {}
  }
  // Validation has closed every reader before the final identity is captured.
  // Hashes therefore describe exactly the files that a READY Runtime will open,
  // not a transient pre-validation state.
  const searchStat = statFile(paths.searchIndexPath);
  const searchHash = hashFileSync(paths.searchIndexPath);
  return {
    manifestVersion: GENERATION_MANIFEST_VERSION,
    generationId: paths.generationId,
    state,
    createdAtMs: nowMs,
    build: { status: state === "BUILDING" ? "BUILDING" : "COMPLETE" },
    validatedAtMs:
      state === "VALIDATED" || state === "READY" ? nowMs : undefined,
    readyAtMs: state === "READY" ? nowMs : undefined,
    catalog: {
      relativePath: CATALOG_RELATIVE_PATH,
      schemaVersion: 4,
      sha256: catalogHash,
      sizeBytes: catalogStat.sizeBytes,
      mtimeMs: catalogStat.mtimeMs,
      workCount: facts.works,
    },
    search: {
      relativePath: SEARCH_RELATIVE_PATH,
      indexVersion: RUNTIME_SEARCH_INDEX_VERSION,
      sha256: searchHash,
      sizeBytes: searchStat.sizeBytes,
      mtimeMs: searchStat.mtimeMs,
      catalogWorkCount: facts.works,
      catalogSizeBytes: catalogStat.sizeBytes,
      catalogMtimeMs: catalogStat.mtimeMs,
    },
    validation: {
      catalog: "passed",
      search: "passed",
      crossGenerationBinding: "passed",
    },
  };
}

function assertManifestShape(manifest, paths, allowedStates = ["READY"]) {
  if (manifest.manifestVersion !== GENERATION_MANIFEST_VERSION)
    fail(
      "GENERATION_MANIFEST_VERSION_UNSUPPORTED",
      "Unsupported generation manifest version",
      { version: manifest.manifestVersion },
    );
  if (manifest.generationId !== paths.generationId)
    fail(
      "GENERATION_ID_MISMATCH",
      "Generation manifest ID does not match its directory",
      { expected: paths.generationId, actual: manifest.generationId },
    );
  if (!allowedStates.includes(manifest.state))
    fail(
      "GENERATION_NOT_READY",
      `Generation state ${manifest.state || "UNKNOWN"} cannot be opened`,
      { generationId: paths.generationId, state: manifest.state },
    );
  validateRelativeFile(
    paths.generationRoot,
    manifest.catalog?.relativePath,
    CATALOG_RELATIVE_PATH,
  );
  validateRelativeFile(
    paths.generationRoot,
    manifest.search?.relativePath,
    SEARCH_RELATIVE_PATH,
  );
  if (manifest.catalog?.schemaVersion !== 4)
    fail(
      "GENERATION_CATALOG_SCHEMA_UNSUPPORTED",
      "Generation Catalog is not Schema v4",
      { schemaVersion: manifest.catalog?.schemaVersion },
    );
  if (manifest.search?.indexVersion !== RUNTIME_SEARCH_INDEX_VERSION)
    fail(
      "GENERATION_SEARCH_VERSION_UNSUPPORTED",
      "Generation search index version is unsupported",
      { version: manifest.search?.indexVersion },
    );
  if (
    manifest.state === "READY" &&
    (!manifest.finalization ||
      manifest.finalization.version !== SQLITE_FINALIZATION_VERSION ||
      manifest.finalization.catalog?.journalMode !== "delete" ||
      manifest.finalization.search?.journalMode !== "delete" ||
      manifest.finalization.catalog?.sidecars !== false ||
      manifest.finalization.search?.sidecars !== false)
  ) {
    fail(
      "GENERATION_NOT_FINALIZED",
      "READY generation has no complete SQLite finalization evidence",
      { generationId: paths.generationId },
    );
  }
  if (
    manifest.state === "READY" &&
    (!manifest.validation ||
      manifest.validation.catalog !== "passed" ||
      manifest.validation.search !== "passed" ||
      manifest.validation.crossGenerationBinding !== "passed")
  ) {
    fail(
      "GENERATION_VALIDATION_INCOMPLETE",
      "READY generation manifest is missing successful validation evidence",
      { generationId: paths.generationId },
    );
  }
}

function validateGeneration(generationRoot, options = {}) {
  const root = assertAbsolute(generationRoot, "generationRoot");
  const id = assertGenerationId(path.basename(root));
  const instanceRoot = options.instanceRoot
    ? assertAbsolute(options.instanceRoot, "instanceRoot")
    : path.dirname(path.dirname(root));
  const paths = generationPaths(
    instanceRoot,
    id,
    options.generationsRoot || null,
  );
  if (paths.generationRoot !== root)
    fail(
      "GENERATION_PATH_INVALID",
      "Generation root is not below instanceRoot/generations",
      { generationRoot: root },
    );
  const manifest = readManifest(paths.manifestPath);
  assertManifestShape(manifest, paths, options.allowedStates || ["READY"]);
  if (
    !fs.existsSync(paths.catalogPath) ||
    !fs.existsSync(paths.searchIndexPath)
  )
    fail(
      "GENERATION_FILE_MISSING",
      "READY generation is missing Catalog or Search file",
      { generationId: id },
    );
  for (const filePath of [paths.catalogPath, paths.searchIndexPath])
    for (const sidecar of sqliteSidecars(filePath))
      if (fs.existsSync(sidecar))
        fail(
          "GENERATION_SQLITE_SIDECAR_PRESENT",
          `READY generation contains a SQLite sidecar: ${sidecar}`,
          { generationId: id },
        );
  const evidence = collectEvidence(
    paths,
    manifest.state,
    manifest.createdAtMs || Date.now(),
  );
  for (const section of ["catalog", "search"]) {
    for (const key of ["sha256", "sizeBytes", "mtimeMs"]) {
      if (manifest[section]?.[key] !== evidence[section][key])
        fail(
          "GENERATION_IDENTITY_MISMATCH",
          `Generation ${section} identity does not match its manifest`,
          { generationId: id, section, key },
        );
    }
  }
  if (
    manifest.catalog.workCount !== evidence.catalog.workCount ||
    manifest.search.catalogWorkCount !== evidence.search.catalogWorkCount ||
    manifest.search.catalogSizeBytes !== evidence.search.catalogSizeBytes ||
    manifest.search.catalogMtimeMs !== evidence.search.catalogMtimeMs
  ) {
    fail(
      "GENERATION_BINDING_MISMATCH",
      "Catalog and Search facts are not bound to the same generation",
      { generationId: id },
    );
  }
  return Object.freeze({
    generationId: id,
    generationRoot: root,
    generationsRoot: paths.generationsRoot,
    manifest,
    catalogPath: paths.catalogPath,
    searchIndexPath: paths.searchIndexPath,
    catalogFacts: evidence.catalog,
    searchFacts: evidence.search,
  });
}

function prepareCandidate(instanceRoot, generationId, generationsRoot = null) {
  const paths = generationPaths(instanceRoot, generationId, generationsRoot);
  if (fs.existsSync(paths.generationRoot))
    fail("GENERATION_EXISTS", `Generation already exists: ${generationId}`, {
      generationId,
    });
  fs.mkdirSync(paths.catalogRoot, { recursive: true });
  fs.mkdirSync(paths.searchRoot, { recursive: true });
  atomicWriteJson(paths.manifestPath, baseManifest(generationId, "BUILDING"));
  return paths;
}

function finishCandidate(paths, nowMs = Date.now(), options = {}) {
  const finalization =
    options.finalization ||
    (options.finalizeGeneration || finalizeGenerationSqlite)(
      paths,
      options.finalizationOptions || {},
    );
  const validated = collectEvidence(paths, "VALIDATED", nowMs);
  validated.finalization = finalization;
  atomicWriteJson(paths.manifestPath, validated);
  const ready = { ...validated, state: "READY", readyAtMs: nowMs };
  atomicWriteJson(paths.manifestPath, ready);
  return validateGeneration(paths.generationRoot, {
    instanceRoot: paths.instanceRoot,
    generationsRoot: paths.generationsRoot,
  });
}

function buildGeneration({
  instanceRoot,
  generationId,
  generationsRoot = null,
  catalogOptions = {},
  searchOptions = {},
  nowMs = () => Date.now(),
  finalizeGeneration = finalizeGenerationSqlite,
  finalizationOptions = {},
  onProgress = null,
  onCatalogReport = null,
  requireCompleteCatalog = true,
} = {}) {
  for (const source of bindSources(catalogOptions.platformRoots)) {
    if (overlap(physicalPath(instanceRoot), physicalPath(source.physicalRoot)))
      fail(
        "INSTANCE_SOURCE_OVERLAP",
        "Generation output overlaps a source root",
      );
  }
  const paths = prepareCandidate(instanceRoot, generationId, generationsRoot);
  try {
    emitProgress(onProgress, {
      phase: "CATALOG_BUILD_START",
      state: "SCANNING",
      generationId,
      currentPlatform: null,
    });
    const catalogLog =
      typeof catalogOptions.log === "function" ? catalogOptions.log : null;
    const built = buildCatalog({
      ...catalogOptions,
      catalogPath: paths.catalogPath,
      onProgress: (event) =>
        emitProgress(onProgress, { ...event, generationId }),
      log: (line) => {
        try {
          catalogLog?.(line);
        } catch {}
        emitProgress(onProgress, {
          phase: "CATALOG_LOG",
          state: "SCANNING",
          generationId,
          line: String(line),
        });
      },
    });
    try {
      onCatalogReport?.(built.report);
    } catch (error) {
      throw error;
    }
    if (built.report.state !== "READY" || built.report.platforms.length !== 8) {
      const error = new Error(
        `Catalog build did not complete all registry platforms: ${built.report.state}`,
      );
      error.code = "GENERATION_CATALOG_INCOMPLETE";
      error.report = built.report;
      throw error;
    }
    emitProgress(onProgress, {
      phase: "CATALOG_BUILD_DONE",
      state: "SCANNING",
      generationId,
      reportState: built.report.state,
      report: built.report,
    });
    emitProgress(onProgress, {
      phase: "CATALOG_FINALIZE",
      state: "VALIDATING",
      generationId,
    });
    const catalogFinalization = finalizeSqliteFile(paths.catalogPath);
    emitProgress(onProgress, {
      phase: "SEARCH_BUILD_START",
      state: "BUILDING_SEARCH",
      generationId,
    });
    const searchLog =
      typeof searchOptions.log === "function" ? searchOptions.log : null;
    buildSearchIndex({
      ...searchOptions,
      catalogPath: paths.catalogPath,
      searchIndexPath: paths.searchIndexPath,
      log: (line) => {
        try {
          searchLog?.(line);
        } catch {}
        const text = String(line);
        const match = /^SEARCH_INDEX_WORKS\s+(\d+)/.exec(text);
        emitProgress(onProgress, {
          phase: match ? "SEARCH_WORK_PROGRESS" : "SEARCH_LOG",
          state: "BUILDING_SEARCH",
          generationId,
          indexedWorks: match ? Number(match[1]) : undefined,
          line: text,
        });
      },
    });
    emitProgress(onProgress, {
      phase: "SEARCH_FINALIZE",
      state: "VALIDATING",
      generationId,
    });
    const searchFinalization =
      finalizeGeneration === finalizeGenerationSqlite
        ? finalizeSqliteFile(paths.searchIndexPath)
        : null;
    const finalization = searchFinalization
      ? {
          version: SQLITE_FINALIZATION_VERSION,
          catalog: catalogFinalization,
          search: searchFinalization,
        }
      : null;
    emitProgress(onProgress, {
      phase: "VALIDATING",
      state: "VALIDATING",
      generationId,
    });
    const result = finishCandidate(paths, nowMs(), {
      finalization,
      finalizeGeneration,
      finalizationOptions,
    });
    emitProgress(onProgress, { phase: "READY", state: "READY", generationId });
    return result;
  } catch (error) {
    // Leave BUILDING/partial files as evidence; they are never resolvable or published.
    throw error;
  }
}

function publishGeneration(instanceRoot, generationId, options = {}) {
  const root = assertAbsolute(instanceRoot, "instanceRoot");
  const id = assertGenerationId(generationId);
  const candidatePaths = generationPaths(
    root,
    id,
    options.generationsRoot || null,
  );
  const resolved = validateGeneration(candidatePaths.generationRoot, {
    instanceRoot: root,
    generationsRoot: candidatePaths.generationsRoot,
  });
  const pointerPath = activePointerPath(
    root,
    options.activePointerPath || null,
  );
  const pointer = {
    pointerVersion: GENERATION_POINTER_VERSION,
    generationId: id,
    manifestPath: path
      .relative(root, candidatePaths.manifestPath)
      .split(path.sep)
      .join("/"),
    publishedAtMs: (options.nowMs || (() => Date.now()))(),
  };
  atomicWriteJson(pointerPath, pointer, options.atomicWriteHooks || {});
  return Object.freeze({ ...resolved, pointerPath, pointer });
}

function resolveActiveGeneration(instanceRoot, options = {}) {
  const root = assertAbsolute(instanceRoot, "instanceRoot");
  const pointerPath = activePointerPath(
    root,
    options.activePointerPath || null,
  );
  if (!fs.existsSync(pointerPath))
    fail(
      "ACTIVE_GENERATION_MISSING",
      `Active generation pointer does not exist: ${pointerPath}`,
      { pointerPath },
    );
  const pointer = readManifest(pointerPath);
  if (pointer.pointerVersion !== GENERATION_POINTER_VERSION)
    fail(
      "ACTIVE_POINTER_VERSION_UNSUPPORTED",
      "Unsupported active generation pointer version",
      { version: pointer.pointerVersion },
    );
  const id = assertGenerationId(pointer.generationId);
  const paths = generationPaths(root, id, options.generationsRoot || null);
  const expectedManifestPath = path
    .relative(root, paths.manifestPath)
    .split(path.sep)
    .join("/");
  if (pointer.manifestPath !== expectedManifestPath)
    fail(
      "ACTIVE_POINTER_INVALID",
      "Active pointer manifest path does not match generation ID",
      { expected: expectedManifestPath, actual: pointer.manifestPath },
    );
  const resolved = validateGeneration(paths.generationRoot, {
    instanceRoot: root,
    generationsRoot: paths.generationsRoot,
  });
  return Object.freeze({ ...resolved, pointerPath, pointer });
}

function rollbackGeneration(instanceRoot, generationId, options = {}) {
  return publishGeneration(instanceRoot, generationId, options);
}

module.exports = {
  CATALOG_RELATIVE_PATH,
  GENERATION_ID_PATTERN,
  GENERATION_MANIFEST_VERSION,
  GENERATION_POINTER_VERSION,
  GENERATION_STATES,
  SQLITE_FINALIZATION_VERSION,
  GenerationPublicationError,
  SEARCH_RELATIVE_PATH,
  activePointerPath,
  buildGeneration,
  finalizeGenerationSqlite,
  finalizeSqliteFile,
  generationPaths,
  publishGeneration,
  readManifest,
  resolveActiveGeneration,
  rollbackGeneration,
  validateGeneration,
};
