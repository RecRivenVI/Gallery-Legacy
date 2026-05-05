"use strict";

const { addFieldSource, beginAdapt, fileReference, finalize, richText, selectField, setPrimaryRichText } = require("./contract.js");
const { asBoolean, asId, asInteger, asObject, asText, fallback, httpUrl, invalid, normalizeTags, oneOrMany, parseTimestamp, warning, workIdFromDirectory } = require("./helpers.js");

const PLATFORM_ID = "Pawchive";
const VERSION = 3;

function directoryIdentity(authorDirectoryName) {
  // Targeted real fanbox/patreon samples consistently matched this prefix to
  // metadata.service, so the physical directory namespace is authoritative.
  const match = typeof authorDirectoryName === "string" ? authorDirectoryName.match(/^([^_]+)_(.+)$/) : null;
  return match ? { service: match[1], user: match[2] } : { service: null, user: null };
}

function addCompositeSources(result, field, serviceSource, idSource) {
  addFieldSource(result, field, serviceSource.sourceKind, serviceSource.sourcePath, serviceSource.priority);
  addFieldSource(result, field, idSource.sourceKind, idSource.sourcePath, idSource.priority);
}

function adapt(context) {
  const { result, metadata } = beginAdapt(PawchiveAdapter, context);
  if (!metadata) return finalize(result);
  const d = result.diagnostics; const profile = asObject(metadata.user_profile, d, "user_profile") || {};
  const directory = directoryIdentity(context.authorDirectoryName);
  const metadataService = asText(metadata.service, d, "service");
  const metadataWork = asId(metadata.id, d, "id");
  const metadataUserPrimary = asId(metadata.user, d, "user");
  const metadataUserProfile = asId(profile.id, d, "user_profile.id");
  const directoryWork = workIdFromDirectory(context.workDirectoryName);

  if (directory.service && metadataService && directory.service !== metadataService) {
    invalid(d, "service", `match filesystem service ${directory.service}`, metadata.service);
    warning(d, "service_identity_conflict", "service");
    result.valid = false;
    result.invalidReason = "service_identity_conflict";
  } else {
    const service = directory.service || metadataService;
    const serviceSource = directory.service
      ? { sourceKind: "filesystem", sourcePath: "authorDirectoryName.servicePrefix", priority: 1 }
      : metadataService ? { sourceKind: "metadata", sourcePath: "service", priority: 2 } : null;
    if (!directory.service && metadataService) fallback(d, "identity.service", "service");
    if (!service) warning(d, "missing_service", "identity.service");

    const workId = metadataWork || directoryWork;
    const workSource = metadataWork
      ? { sourceKind: "metadata", sourcePath: "id", priority: 1 }
      : directoryWork ? { sourceKind: "filesystem", sourcePath: "workDirectoryName", priority: 2 } : null;
    if (!metadataWork && directoryWork) fallback(d, "work.sourceWorkId", "workDirectoryName");

    const userId = metadataUserPrimary || metadataUserProfile || directory.user;
    const userSource = metadataUserPrimary
      ? { sourceKind: "metadata", sourcePath: "user", priority: 1 }
      : metadataUserProfile
        ? { sourceKind: "metadata", sourcePath: "user_profile.id", priority: 2 }
        : directory.user ? { sourceKind: "filesystem", sourcePath: "authorDirectoryName.userSuffix", priority: 3 } : null;
    if (!metadataUserPrimary && !metadataUserProfile && directory.user) fallback(d, "authorProfile.sourceAuthorId", "authorDirectoryName.userSuffix");

    result.work.sourceWorkId = service && workId ? `${service}:${workId}` : null;
    result.authorProfile.sourceAuthorId = service && userId ? `${service}:${userId}` : null;
    if (result.work.sourceWorkId && serviceSource && workSource) addCompositeSources(result, "work.sourceWorkId", serviceSource, workSource);
    if (result.authorProfile.sourceAuthorId && serviceSource && userSource) addCompositeSources(result, "authorProfile.sourceAuthorId", serviceSource, userSource);
  }

  result.work.title = selectField(result, "work.title", [{ path: "title", value: metadata.title }], asText);
  result.work.publishedAtMs = selectField(result, "work.publishedAtMs", [{ path: "published", value: metadata.published }, { path: "date", value: metadata.date }, { path: "added", value: metadata.added }], parseTimestamp);
  result.work.updatedAtMs = selectField(result, "work.updatedAtMs", [{ path: "edited", value: metadata.edited }], parseTimestamp);
  result.authorProfile.displayName = selectField(result, "authorProfile.displayName", [{ path: "user_profile.name", value: profile.name }, { path: "username", value: metadata.username }], asText);
  result.authorProfile.handle = selectField(result, "authorProfile.handle", [{ path: "user_profile.public_id", value: profile.public_id }, { path: "username", value: metadata.username }], asText);
  result.work.flags.hasFull = asBoolean(metadata.has_full, d, "has_full");
  const content = asText(metadata.content, d, "content"); if (content !== null) setPrimaryRichText(result, richText("content", "html", content));
  result.tags = normalizeTags(oneOrMany(metadata.tags, d, "tags").map((value, index) => asText(value, d, `tags[${index}]`)));
  const media = [];
  const single = asObject(metadata.file, d, "file");
  if (single) {
    const reference = fileReference("file_name", single.name, "file.name", d);
    media.push({ sourceId: asId(single.filename || single.name, d, "file.filename"), kind: asText(single.type || single.extension, d, "file.type"), name: asText(single.name || single.filename, d, "file.name"), url: httpUrl(single.url, d, "file.url"), hash: asText(single.hash, d, "file.hash"), size: asInteger(single.size, d, "file.size", { allowString: true }), durationMs: null, fileReferences: reference ? [reference] : [] });
  }
  for (const field of ["attachments", "archives"]) oneOrMany(metadata[field], d, field).forEach((item, index) => {
    const value = asObject(item, d, `${field}[${index}]`) || {};
    // Four real fixture generations prove file.name and attachments[].name
    // are basenames distinct from the content-addressed remote path. No real
    // archive fixture exists, so archives[].name intentionally stays opaque.
    const reference = field === "attachments" ? fileReference("file_name", value.name, `${field}[${index}].name`, d) : null;
    media.push({ sourceId: asId(value.filename || value.id || value.name, d, `${field}[${index}].id`), kind: asText(value.type || value.extension, d, `${field}[${index}].type`), name: asText(value.name || value.filename, d, `${field}[${index}].name`), url: httpUrl(value.url, d, `${field}[${index}].url`), hash: asText(value.hash, d, `${field}[${index}].hash`), size: asInteger(value.size, d, `${field}[${index}].size`, { allowString: true }), durationMs: null, fileReferences: reference ? [reference] : [] });
  });
  result.mediaDeclarations = media;
  return finalize(result);
}

const PawchiveAdapter = Object.freeze({ PLATFORM_ID, VERSION, adapt });
module.exports = PawchiveAdapter;
