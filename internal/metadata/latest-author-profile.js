"use strict";

function comparisonKey(candidate) {
  const work = candidate.work || {};
  const source = candidate.sourceContext || {};
  const time = Number.isSafeInteger(work.publishedAtMs) ? work.publishedAtMs : Number.isSafeInteger(source.directoryTimestampMs) ? source.directoryTimestampMs : Number.MIN_SAFE_INTEGER;
  return [time, String(work.sourceWorkId || ""), String(source.workDirectoryName || "")];
}

function compareCandidates(left, right) {
  const a = comparisonKey(left); const b = comparisonKey(right);
  return (a[0] - b[0]) || compareText(a[1], b[1]) || compareText(a[2], b[2]);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function selectLatestAuthorProfile(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { valid: false, profile: null, sourceWorkId: null, sourceWorkDirectoryName: null, reason: "no_candidates" };
  }
  const ordered = [...candidates].sort(compareCandidates);
  const latest = ordered[ordered.length - 1];
  if (!latest || latest.valid !== true) {
    return {
      valid: false,
      profile: null,
      sourceWorkId: latest?.work?.sourceWorkId || null,
      sourceWorkDirectoryName: latest?.sourceContext?.workDirectoryName || null,
      reason: "latest_metadata_invalid",
    };
  }
  return {
    valid: true,
    profile: structuredClone(latest.authorProfile),
    sourceWorkId: latest.work.sourceWorkId,
    sourceWorkDirectoryName: latest.sourceContext?.workDirectoryName || null,
    sourcePublishedAtMs: Number.isSafeInteger(latest.work.publishedAtMs) ? latest.work.publishedAtMs : null,
    sourceDirectoryTimestampMs: Number.isSafeInteger(latest.sourceContext?.directoryTimestampMs) ? latest.sourceContext.directoryTimestampMs : null,
    reason: null,
  };
}

module.exports = { selectLatestAuthorProfile };
