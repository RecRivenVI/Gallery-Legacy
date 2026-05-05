"use strict";

const NS_PER_MS = 1000000n;

function mtimeNsToSafeMs(value) {
  if (typeof value !== "bigint" || value < 0n) throw new TypeError("mtimeNs must be a non-negative BigInt");
  const milliseconds = value / NS_PER_MS;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("mtimeNs milliseconds exceed Number.MAX_SAFE_INTEGER");
  return Number(milliseconds);
}

function workObservationToBuilderSourceRecord(work) {
  if (!work || typeof work !== "object" || Array.isArray(work)) throw new TypeError("WorkObservation is required");
  if (work.state !== "present" || work.metadata?.state !== "present") throw new Error("WorkObservation metadata is not readable");
  if (typeof work.metadata.sourceText !== "string" || typeof work.metadata.size !== "number") throw new Error("WorkObservation metadata facts are incomplete");
  return {
    platformId: work.platformId,
    authorDirectoryName: work.authorDirectoryName,
    workDirectoryName: work.workDirectoryName,
    metadataRelativePath: work.metadata.relativePath,
    directoryTimestampMs: mtimeNsToSafeMs(work.workDirMtimeNs),
    metadataSource: work.metadata.sourceText,
    filesystemFilesState: work.filesystemFilesState,
    filesystemFiles: structuredClone(work.filesystemFiles || []),
    mappingContext: {
      platformId: work.platformId,
      authorDirectoryName: work.authorDirectoryName,
      authorRelativePath: work.authorDirectoryName,
      workDirectoryName: work.workDirectoryName,
      relativePath: work.workRelativePath,
      workDirMtimeNs: work.workDirMtimeNs,
      metadataMtimeNs: work.metadata.mtimeNs,
      metadataSize: work.metadata.size,
    },
  };
}

module.exports = { NS_PER_MS, mtimeNsToSafeMs, workObservationToBuilderSourceRecord };
