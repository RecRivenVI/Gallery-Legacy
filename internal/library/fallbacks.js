"use strict";

const { mtimeNsToSafeMs } = require("./observation-source.js");
const { parsePlatformDirectoryIdentity } = require("./directory-parsers.js");

function nonEmptyText(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function selectWorkDisplayTitle(normalized, context) {
  const metadata = nonEmptyText(normalized?.work?.title);
  if (metadata !== null) return { value: metadata, source: "metadata", sourcePath: "$.work.title" };
  const parsed = parsePlatformDirectoryIdentity(context.platformId, context.authorDirectoryName, context.workDirectoryName).work.displayTitle;
  if (parsed !== null) return { value: parsed, source: "directory_parsed", sourcePath: "workDirectoryName.timestampedSuffix" };
  const raw = nonEmptyText(context.workDirectoryName) || nonEmptyText(context.workRelativePath?.split(/[\\/]/).pop());
  if (raw === null) throw new Error("Physical work has no displayable directory identity");
  return { value: raw, source: "directory_raw", sourcePath: "workDirectoryName" };
}

function selectAuthorDisplayName(normalized, context) {
  const display = nonEmptyText(normalized?.authorProfile?.displayName);
  if (display !== null) return { value: display, source: "metadata", sourcePath: "$.authorProfile.displayName" };
  const handle = nonEmptyText(normalized?.authorProfile?.handle);
  if (handle !== null) return { value: handle, source: "metadata", sourcePath: "$.authorProfile.handle" };
  const parsed = parsePlatformDirectoryIdentity(context.platformId, context.authorDirectoryName, context.workDirectoryName).author.displayName;
  if (parsed !== null) return { value: parsed, source: "directory_parsed", sourcePath: "authorDirectoryName" };
  const raw = nonEmptyText(context.authorDirectoryName);
  if (raw === null) throw new Error("Physical author has no displayable directory identity");
  return { value: raw, source: "directory_raw", sourcePath: "authorDirectoryName" };
}

function selectSortTime(normalized, context) {
  if (Number.isSafeInteger(normalized?.work?.publishedAtMs)) {
    return { value: normalized.work.publishedAtMs, source: "metadata_published", sourcePath: "$.work.publishedAtMs" };
  }
  const parsed = parsePlatformDirectoryIdentity(context.platformId, context.authorDirectoryName, context.workDirectoryName).work.timestampMs;
  if (Number.isSafeInteger(parsed)) return { value: parsed, source: "directory_parsed", sourcePath: "workDirectoryName.timestamp" };
  return { value: mtimeNsToSafeMs(context.workDirMtimeNs), source: "directory_mtime", sourcePath: "workDirMtimeNs" };
}

function selectSourceIdentities(normalized, context) {
  const parsed = parsePlatformDirectoryIdentity(context.platformId, context.authorDirectoryName, context.workDirectoryName);
  return {
    sourceAuthorId: nonEmptyText(normalized?.authorProfile?.sourceAuthorId) || parsed.author.sourceAuthorId || null,
    sourceAuthorIdSource: nonEmptyText(normalized?.authorProfile?.sourceAuthorId) ? "metadata" : parsed.author.sourceAuthorId ? "directory_parsed" : null,
    sourceWorkId: nonEmptyText(normalized?.work?.sourceWorkId) || parsed.work.sourceWorkId || null,
    sourceWorkIdSource: nonEmptyText(normalized?.work?.sourceWorkId) ? "metadata" : parsed.work.sourceWorkId ? "directory_parsed" : null,
  };
}

module.exports = { selectAuthorDisplayName, selectSortTime, selectSourceIdentities, selectWorkDisplayTitle };
