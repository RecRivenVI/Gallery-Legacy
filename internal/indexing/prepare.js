"use strict";

const { adaptJsonWithMetadata } = require("../metadata/contract.js");
const { adapterForPlatform } = require("../metadata/index.js");
const {
  selectLatestAuthorProfile,
} = require("../metadata/latest-author-profile.js");
const { metadataShapeForPlatform } = require("../metadata/shape/index.js");
const { mapNormalizedToRelational } = require("../catalog/mapping.js");
const {
  bindReconciledMediaPersistence,
} = require("../catalog/media-persistence.js");
const {
  mtimeNsToSafeMs,
  workObservationToBuilderSourceRecord,
} = require("../library/observation.js");
const {
  selectAuthorDisplayName,
  selectSourceIdentities,
} = require("../library/identity.js");
const { evaluateFilesystemMediaEligibility } = require("../media/index.js");
const {
  mapReconciledMediaToRelational,
  reconcileMedia,
} = require("../media/reconciliation/index.js");
const { normalizeRelativePath } = require("../library/paths.js");
const { PLATFORM_REGISTRY } = require("../library/platforms.js");
const {
  SNAPSHOT_PREPARATION_CONTRACT_VERSION,
  compareAuthorOutcomes,
  comparePreparedCandidates,
  compareText,
  compareWorkFailures,
  deepFreeze,
} = require("./preparation-contract.js");
const { validatePlatformObservation } = require("./preparation-validation.js");

function authorityCandidate(work, normalized) {
  if (normalized) return normalized;
  return {
    valid: false,
    work: { sourceWorkId: null, publishedAtMs: null },
    sourceContext: {
      directoryTimestampMs: mtimeNsToSafeMs(work.workDirMtimeNs),
      workDirectoryName: work.workDirectoryName,
    },
    authorProfile: { sourceAuthorId: null },
  };
}

function metadataState(work, adapted) {
  if (work.metadata.state !== "present") return work.metadata.state;
  if (adapted.result.invalidReason === "malformed_json") return "malformed";
  if (adapted.result.invalidReason === "metadata_not_object")
    return "non_object";
  if (
    adapted.result.valid !== true ||
    adapted.result.diagnostics.invalidFields.length > 0
  )
    return "partial";
  return "valid";
}

function enrichmentState(state, adapted) {
  if (
    ["missing", "unreadable", "unstable", "malformed", "non_object"].includes(
      state,
    )
  )
    return "unavailable";
  if (!adapted || adapted.result.valid !== true || state === "partial")
    return "partial";
  return "available";
}

function prepareMetadataEntry(work) {
  const entry = {
    work,
    sourceRecord: null,
    metadata: null,
    normalized: null,
    shape: null,
    metadataState: work.metadata.state,
    enrichmentState: "unavailable",
    authoritative: false,
    preparedCandidate: null,
  };
  if (work.metadata.state !== "present") {
    entry.authorityCandidate = authorityCandidate(work, null);
    return entry;
  }
  const sourceRecord = workObservationToBuilderSourceRecord(work);
  const adapter = adapterForPlatform(work.platformId);
  if (!adapter) throw new Error(`Missing adapter for ${work.platformId}`);
  const adapted = adaptJsonWithMetadata(adapter, sourceRecord.metadataSource, {
    platformId: sourceRecord.platformId,
    authorDirectoryName: sourceRecord.authorDirectoryName,
    workDirectoryName: sourceRecord.workDirectoryName,
    metadataRelativePath: sourceRecord.metadataRelativePath,
    directoryTimestampMs: sourceRecord.directoryTimestampMs,
  });
  entry.sourceRecord = sourceRecord;
  entry.metadata = adapted.metadata;
  entry.normalized = adapted.result;
  entry.metadataState = metadataState(work, adapted);
  entry.enrichmentState = enrichmentState(entry.metadataState, adapted);
  if (
    adapted.metadata &&
    typeof adapted.metadata === "object" &&
    !Array.isArray(adapted.metadata)
  )
    entry.shape = metadataShapeForPlatform(work.platformId, adapted.metadata);
  entry.authorityCandidate = authorityCandidate(work, adapted.result);
  return entry;
}

function latestEntry(entries) {
  if (entries.length === 0)
    return {
      selected: null,
      authority: {
        state: "none",
        workDirectoryName: null,
        sourceWorkId: null,
        reason: null,
      },
    };
  const selected = selectLatestAuthorProfile(
    entries.map((entry) => entry.authorityCandidate),
  );
  const winner =
    entries.find(
      (entry) =>
        entry.work.workDirectoryName === selected.sourceWorkDirectoryName,
    ) || null;
  if (selected.valid && winner) {
    winner.authoritative = true;
    return {
      selected: winner,
      authority: {
        state: "authoritative",
        workDirectoryName: winner.work.workDirectoryName,
        sourceWorkId: selected.sourceWorkId,
        reason: null,
      },
    };
  }
  return {
    selected: winner,
    authority: {
      state: "latest_invalid",
      workDirectoryName: selected.sourceWorkDirectoryName,
      sourceWorkId: selected.sourceWorkId,
      reason: selected.reason,
    },
  };
}

function authorSelections(author, winner) {
  const base = {
    platformId: author.platformId,
    authorDirectoryName: author.authorDirectoryName,
    workDirectoryName: winner?.work.workDirectoryName || null,
  };
  const normalized = winner?.authoritative ? winner.normalized : null;
  const identity = selectSourceIdentities(normalized, base);
  const display = selectAuthorDisplayName(normalized, base);
  const profileState = winner?.authoritative
    ? "valid"
    : winner
      ? winner.metadataState === "missing" ||
        winner.metadataState === "unreadable" ||
        winner.metadataState === "unstable"
        ? "unavailable"
        : "invalid"
      : "unavailable";
  return {
    identity: {
      sourceAuthorId: identity.sourceAuthorId,
      sourceAuthorIdSource: identity.sourceAuthorIdSource,
    },
    display,
    handle: normalized?.authorProfile?.handle || null,
    profileState,
  };
}

function mapEntry(entry, author, selections) {
  const metadata = entry.work.metadata;
  const mapped = mapNormalizedToRelational(
    entry.normalized,
    {
      platformId: entry.work.platformId,
      authorDirectoryName: entry.work.authorDirectoryName,
      authorRelativePath: author.authorRelativePath,
      workDirectoryName: entry.work.workDirectoryName,
      relativePath: entry.work.workRelativePath,
      workDirMtimeNs: entry.work.workDirMtimeNs,
      metadataRelativePath: metadata.relativePath,
      metadataMtimeNs: metadata.mtimeNs,
      metadataSize: metadata.size,
      metadataState: entry.metadataState,
      enrichmentState: entry.enrichmentState,
      filesystemState: entry.work.state,
      filesystemFilesState: entry.work.filesystemFilesState,
      authorProfileAuthority: entry.authoritative,
      authorProfileState: selections.profileState,
      authorSourceIdentity: selections.identity,
      authorDisplaySelection: selections.display,
      authorHandleOverride: selections.handle,
    },
    entry.shape,
  );

  const metadataDeclarations = entry.normalized?.mediaDeclarations || [];
  const filesystemFiles = entry.work.filesystemFiles || [];
  const reconciliation = reconcileMedia({
    metadataDeclarations,
    filesystemFiles,
  });
  const eligibility = evaluateFilesystemMediaEligibility({ filesystemFiles });
  const relational = mapReconciledMediaToRelational({
    metadataDeclarations,
    filesystemFiles,
    reconciliation,
    eligibility,
  });
  entry.preparedCandidate = bindReconciledMediaPersistence(mapped, relational, {
    filesystemFilesState: entry.work.filesystemFilesState,
  });
  entry.reconciliationDiagnostics = relational.diagnostics;
  entry.ignoredFilesystemFiles = relational.ignoredFilesystemFiles;
}

function authorRow(author, selections, candidates) {
  if (candidates.length) return structuredClone(candidates[0].rows.author);
  const relative = normalizeRelativePath(author.authorRelativePath);
  return {
    author_id: null,
    platform_id: author.platformId,
    relative_path: relative.relativePath,
    relative_path_key: relative.relativePathKey,
    folder_name: author.authorDirectoryName,
    source_author_id: selections.identity.sourceAuthorId,
    source_author_id_source: selections.identity.sourceAuthorIdSource,
    display_name: selections.display.value,
    display_name_source: selections.display.source,
    handle: null,
    name_rank: null,
    work_count: 0,
    latest_work_at_ms: null,
    latest_work_id: null,
    profile_state: selections.profileState,
  };
}

function prepareAuthorObservation(authorObservation) {
  const entries = (authorObservation.works || []).map(prepareMetadataEntry);
  const { selected, authority } = latestEntry(entries);
  const selections = authorSelections(authorObservation, selected);
  for (const entry of entries) mapEntry(entry, authorObservation, selections);
  const candidates = entries
    .map((entry) => entry.preparedCandidate)
    .sort(comparePreparedCandidates);
  const preparedAuthor = authorRow(authorObservation, selections, candidates);
  const metadataDiagnostics = entries
    .map((entry) => ({
      platformId: entry.work.platformId,
      workRelativePathKey: entry.work.workRelativePathKey,
      state: entry.metadataState,
      invalidReason: entry.normalized?.invalidReason || null,
      warnings: entry.normalized?.diagnostics?.warnings || [],
      invalidFields: entry.normalized?.diagnostics?.invalidFields || [],
      reconciliation: entry.reconciliationDiagnostics || [],
      ignoredFilesystemFiles: entry.ignoredFilesystemFiles || [],
    }))
    .sort((left, right) =>
      compareText(left.workRelativePathKey, right.workRelativePathKey),
    );
  return {
    preparedAuthor,
    preparedCandidates: candidates,
    workFailures: [],
    metadataDiagnostics,
    authorOutcome: {
      platformId: authorObservation.platformId,
      authorDirectoryName: authorObservation.authorDirectoryName,
      authorRelativePathKey: authorObservation.authorRelativePathKey,
      preparationState:
        authorObservation.state === "present" &&
        authorObservation.worksState === "complete"
          ? "complete"
          : "incomplete",
      reason:
        authorObservation.state === "present" &&
        authorObservation.worksState === "complete"
          ? null
          : "author_snapshot_incomplete",
      authority,
      preparedWorkCount: candidates.length,
      failedWorkCount: 0,
    },
  };
}

function streamingEntryIsLater(current, candidate) {
  if (!current) return true;
  const selected = selectLatestAuthorProfile([
    current.authorityCandidate,
    candidate.authorityCandidate,
  ]);
  return selected.sourceWorkDirectoryName === candidate.work.workDirectoryName;
}

function metadataDiagnostic(entry) {
  return {
    platformId: entry.work.platformId,
    workRelativePathKey: entry.work.workRelativePathKey,
    state: entry.metadataState,
    invalidReason: entry.normalized?.invalidReason || null,
    warnings: entry.normalized?.diagnostics?.warnings || [],
    invalidFields: entry.normalized?.diagnostics?.invalidFields || [],
    reconciliation: entry.reconciliationDiagnostics || [],
    ignoredFilesystemFiles: entry.ignoredFilesystemFiles || [],
  };
}

function createStreamingAuthorPreparation(authorObservation) {
  if (!authorObservation || typeof authorObservation !== "object")
    throw new TypeError("AuthorObservation is required");
  let latest = null;
  let workCount = 0;
  const provisional = authorSelections(authorObservation, null);
  return {
    prepareWork(workObservation) {
      const entry = prepareMetadataEntry(workObservation);
      if (streamingEntryIsLater(latest, entry)) latest = entry;
      mapEntry(entry, authorObservation, provisional);
      workCount++;
      return {
        candidate: entry.preparedCandidate,
        metadataDiagnostic: metadataDiagnostic(entry),
      };
    },
    finish(authorCompletion = {}) {
      let authority;
      if (!latest)
        authority = {
          state: "none",
          workDirectoryName: null,
          sourceWorkId: null,
          reason: null,
        };
      else if (latest.authorityCandidate.valid === true) {
        latest.authoritative = true;
        authority = {
          state: "authoritative",
          workDirectoryName: latest.work.workDirectoryName,
          sourceWorkId: latest.authorityCandidate.work.sourceWorkId,
          reason: null,
        };
      } else
        authority = {
          state: "latest_invalid",
          workDirectoryName: latest.work.workDirectoryName,
          sourceWorkId: latest.authorityCandidate.work?.sourceWorkId || null,
          reason: "latest_metadata_invalid",
        };
      const selections = authorSelections(authorObservation, latest);
      if (latest) mapEntry(latest, authorObservation, selections);
      const candidates = latest ? [latest.preparedCandidate] : [];
      return {
        authoritativeCandidate: latest
          ? deepFreeze({
              ...latest.preparedCandidate,
              authorAuthorityFinal: true,
            })
          : null,
        preparedAuthor: authorRow(authorObservation, selections, candidates),
        authorOutcome: {
          platformId: authorObservation.platformId,
          authorDirectoryName: authorObservation.authorDirectoryName,
          authorRelativePathKey: authorObservation.authorRelativePathKey,
          preparationState:
            authorCompletion.worksState === "complete" &&
            authorObservation.state === "present"
              ? "complete"
              : "incomplete",
          reason:
            authorCompletion.worksState === "complete" &&
            authorObservation.state === "present"
              ? null
              : "author_snapshot_incomplete",
          authority,
          preparedWorkCount: workCount,
          failedWorkCount: 0,
        },
      };
    },
  };
}

function collisionDiagnostics(authors, candidates) {
  const diagnostics = [];
  const groups = [
    {
      entityKind: "author",
      rows: authors.filter((row) => row.source_author_id !== null),
      id: (row) => row.source_author_id,
      physical: (row) => row.relative_path_key,
    },
    {
      entityKind: "work",
      rows: candidates
        .map((candidate) => candidate.rows.work)
        .filter((row) => row.source_work_id !== null),
      id: (row) => row.source_work_id,
      physical: (row) => row.relative_path_key,
    },
  ];
  for (const group of groups) {
    const bySource = new Map();
    for (const row of group.rows) {
      const key = `${row.platform_id}\0${group.id(row)}`;
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key).push(group.physical(row));
    }
    for (const [key, paths] of bySource) {
      const unique = [...new Set(paths)].sort(compareText);
      if (unique.length < 2) continue;
      const [platformId, sourceId] = key.split("\0");
      diagnostics.push({
        code: `duplicate_source_${group.entityKind}_identity`,
        entityKind: group.entityKind,
        platformId,
        sourceId,
        physicalRelativePathKeys: unique,
      });
    }
  }
  return diagnostics.sort(
    (left, right) =>
      compareText(left.entityKind, right.entityKind) ||
      compareText(left.sourceId, right.sourceId),
  );
}

function incompletePlatformResult(observation) {
  return deepFreeze({
    contractVersion: SNAPSHOT_PREPARATION_CONTRACT_VERSION,
    platformId: observation.platformId,
    preparedAuthors: [],
    preparedCandidates: [],
    workFailures: [],
    authorOutcomes: [],
    metadataDiagnostics: [],
    sourceIdentityCollisions: [],
    diagnostics: [
      {
        scope: "platform",
        code: "platform_snapshot_incomplete",
        state: observation.state,
        authorsState: observation.authorsState,
      },
    ],
  });
}

function preparePlatformSnapshot(platformObservation) {
  const observation = validatePlatformObservation(platformObservation);
  if (observation.state !== "present" || !Array.isArray(observation.authors))
    return incompletePlatformResult(observation);
  const prepared = observation.authors.map(prepareAuthorObservation);
  const preparedAuthors = prepared
    .map((item) => item.preparedAuthor)
    .sort((left, right) =>
      compareText(left.relative_path_key, right.relative_path_key),
    );
  const preparedCandidates = prepared
    .flatMap((item) => item.preparedCandidates)
    .sort(comparePreparedCandidates);
  const workFailures = prepared
    .flatMap((item) => item.workFailures)
    .sort(compareWorkFailures);
  const authorOutcomes = prepared
    .map((item) => item.authorOutcome)
    .sort(compareAuthorOutcomes);
  const metadataDiagnostics = prepared
    .flatMap((item) => item.metadataDiagnostics)
    .sort((left, right) =>
      compareText(left.workRelativePathKey, right.workRelativePathKey),
    );
  return deepFreeze({
    contractVersion: SNAPSHOT_PREPARATION_CONTRACT_VERSION,
    platformId: observation.platformId,
    preparedAuthors,
    preparedCandidates,
    workFailures,
    authorOutcomes,
    metadataDiagnostics,
    sourceIdentityCollisions: collisionDiagnostics(
      preparedAuthors,
      preparedCandidates,
    ),
    diagnostics:
      observation.authorsState === "complete"
        ? []
        : [
            {
              scope: "platform",
              code: "platform_snapshot_incomplete",
              state: observation.state,
              authorsState: observation.authorsState,
            },
          ],
  });
}

module.exports = {
  createStreamingAuthorPreparation,
  prepareAuthorObservation,
  preparePlatformSnapshot,
};
