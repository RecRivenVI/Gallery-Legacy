"use strict";

const crypto = require("node:crypto");

const { ADAPTER_CONTRACT_VERSION } = require("../metadata/contract.js");
const { METADATA_SHAPE_SIGNATURE_VERSION, shapePolicyForPlatform } = require("../metadata/shape/index.js");
const {
  FILESYSTEM_AUTHORITY_CONTRACT_VERSION,
  selectAuthorDisplayName,
  selectSortTime,
  selectSourceIdentities,
  selectWorkDisplayTitle,
} = require("../library/identity.js");
const { PLATFORM_REGISTRY, bindSources, normalizePhysicalRootKey } = require("../library/platforms.js");
const { CATALOG_SCHEMA_VERSION } = require("./schema.js");
const { normalizeOptionalRelativePath, normalizeRelativePath } = require("../library/paths.js");
const { stableJson } = require("./stable-json.js");

const SQLITE_INT64_MAX = 9223372036854775807n;

function safeInteger(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be a safe integer or null`);
  return value;
}

function nsInteger(value, field, nullable = true) {
  if (nullable && (value === undefined || value === null)) return null;
  if (typeof value !== "bigint" || value < 0n || value > SQLITE_INT64_MAX) throw new TypeError(`${field} must be a non-negative signed int64 BigInt${nullable ? " or null" : ""}`);
  return value;
}

function nullableText(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${field} must be text or null`);
  return value;
}

function requiredText(value, field) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be non-empty text`);
  return value;
}

function booleanInteger(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new TypeError(`${field} must be boolean or null`);
  return value ? 1 : 0;
}

function shapeIdentity(shape, platformId) {
  if (shape === undefined || shape === null) return null;
  if (!shape || typeof shape !== "object" || Array.isArray(shape)) throw new TypeError("shape result must be an object or null");
  if (shape.platformId !== platformId) throw new Error("shape platform does not match normalized result");
  if (!Number.isInteger(shape.signatureVersion) || shape.signatureVersion < 1) throw new TypeError("shape signature version is invalid");
  if (!Number.isInteger(shape.policyVersion) || shape.policyVersion < 1) throw new TypeError("shape policy version is invalid");
  if (typeof shape.hash !== "string" || !/^[0-9a-f]{64}$/.test(shape.hash)) throw new TypeError("shape hash must be lowercase SHA-256");
  return { platform_id: platformId, signature_version: shape.signatureVersion, policy_version: shape.policyVersion, shape_hash: shape.hash };
}

function platformRegistryFingerprint(sources) {
  const facts = bindSources(sources).map(entry => ({
    adapterVersion: entry.adapterVersion,
    enabled: entry.enabled,
    family: entry.family,
    id: entry.id,
    physicalRoot: entry.physicalRoot,
    physicalRootKey: normalizePhysicalRootKey(entry.physicalRoot),
  }));
  return crypto.createHash("sha256").update(stableJson(facts), "utf8").digest("hex");
}

function mapCatalogState({ catalogRevision = 0, builtAtMs, platformRoots } = {}) {
  const built = safeInteger(builtAtMs, "builtAtMs");
  if (built === null) throw new TypeError("builtAtMs is required");
  return {
    singleton: 1,
    schema_version: CATALOG_SCHEMA_VERSION,
    catalog_revision: safeInteger(catalogRevision, "catalogRevision"),
    built_at_ms: built,
    adapter_contract_version: ADAPTER_CONTRACT_VERSION,
    shape_signature_version: METADATA_SHAPE_SIGNATURE_VERSION,
    filesystem_authority_contract_version: FILESYSTEM_AUTHORITY_CONTRACT_VERSION,
    normalizer_version: null,
    sanitizer_version: null,
    search_index_version: null,
    platform_registry_fingerprint: platformRegistryFingerprint(platformRoots),
  };
}

function mapPlatformRegistry(platformRoots) {
  return bindSources(platformRoots).map(entry => {
    const policy = shapePolicyForPlatform(entry.id);
    if (!policy) throw new Error(`Missing shape policy for registry platform: ${entry.id}`);
    return {
      platform_id: entry.id,
      family: entry.family,
      physical_root: entry.physicalRoot,
      physical_root_key: normalizePhysicalRootKey(entry.physicalRoot),
      enabled: entry.enabled ? 1 : 0,
      adapter_version: entry.adapterVersion,
      shape_policy_version: policy.SHAPE_POLICY_VERSION,
    };
  });
}

function adapterVersionFor(platformId, normalized) {
  const expected = PLATFORM_REGISTRY.find(platform => platform.id === platformId)?.adapterVersion;
  if (!Number.isInteger(expected)) throw new Error(`Unknown platformId: ${platformId}`);
  if (normalized && normalized.adapterVersion !== expected) throw new Error(`Adapter version mismatch for ${platformId}`);
  return expected;
}

function evidence(field, selection, priority) {
  return {
    work_id: null,
    field,
    source_kind: selection.source === "metadata" || selection.source === "metadata_published" ? "metadata" : "filesystem",
    source_path: selection.sourcePath,
    priority,
  };
}

function dedupeFieldSources(rows) {
  const unique = new Map();
  for (const row of rows) unique.set(`${row.field}\0${row.source_kind}\0${row.source_path}\0${row.priority}`, row);
  return [...unique.values()].sort((left, right) => left.field < right.field ? -1 : left.field > right.field ? 1
    : left.priority - right.priority || (left.source_kind < right.source_kind ? -1 : left.source_kind > right.source_kind ? 1
      : left.source_path < right.source_path ? -1 : left.source_path > right.source_path ? 1 : 0));
}

function mapNormalizedToRelational(normalized, context, shape = null) {
  if (normalized !== null && normalized !== undefined && (!normalized || typeof normalized !== "object" || Array.isArray(normalized))) throw new TypeError("normalized result must be an object or null");
  if (!context || typeof context !== "object" || Array.isArray(context)) throw new TypeError("relational mapping context must be an object");
  if (normalized && normalized.contractVersion !== ADAPTER_CONTRACT_VERSION) throw new Error("unsupported Adapter Contract version");

  const platformId = requiredText(context.platformId || normalized?.platformId, "platformId");
  if (normalized && normalized.platformId !== platformId) throw new Error("normalized platform differs from filesystem context");
  const adapterVersion = adapterVersionFor(platformId, normalized);
  const workRelative = normalizeRelativePath(context.relativePath);
  const authorRelative = normalizeRelativePath(context.authorRelativePath || context.authorDirectoryName);
  const metadataRelative = normalizeOptionalRelativePath(context.metadataRelativePath || normalized?.sourceContext?.metadataRelativePath);
  const workDirMtimeNs = nsInteger(context.workDirMtimeNs, "workDirMtimeNs", false);
  const metadataMtimeNs = nsInteger(context.metadataMtimeNs, "metadataMtimeNs");
  const metadataSize = safeInteger(context.metadataSize, "metadataSize");
  const metadataState = requiredText(context.metadataState, "metadataState");
  const enrichmentState = requiredText(context.enrichmentState, "enrichmentState");
  const filesystemState = context.filesystemState === "unreadable" ? "unreadable" : "present";
  const filesystemFilesState = context.filesystemFilesState === "complete" ? "complete" : "incomplete";
  const shapeKey = shapeIdentity(shape, platformId);
  const selectedIdentity = selectSourceIdentities(normalized, {
    platformId,
    authorDirectoryName: context.authorDirectoryName,
    workDirectoryName: context.workDirectoryName,
  });
  const identity = {
    ...selectedIdentity,
    ...(context.authorSourceIdentity || {}),
  };
  const title = selectWorkDisplayTitle(normalized, { ...context, platformId });
  const authorDisplay = context.authorDisplaySelection || selectAuthorDisplayName(normalized, { ...context, platformId });
  const sort = selectSortTime(normalized, { ...context, platformId, workDirMtimeNs });
  const profile = normalized?.authorProfile || {};
  const authoritativeProfile = context.authorProfileAuthority === true && normalized?.valid === true;

  const author = {
    author_id: null,
    platform_id: platformId,
    relative_path: authorRelative.relativePath,
    relative_path_key: authorRelative.relativePathKey,
    folder_name: requiredText(context.authorDirectoryName, "authorDirectoryName"),
    source_author_id: identity.sourceAuthorId,
    source_author_id_source: identity.sourceAuthorIdSource,
    display_name: authorDisplay.value,
    display_name_source: authorDisplay.source,
    handle: nullableText(context.authorHandleOverride, "authorHandleOverride"),
    name_rank: null,
    work_count: 0,
    latest_work_at_ms: null,
    latest_work_id: null,
    profile_state: authoritativeProfile ? "valid" : context.authorProfileState || "unavailable",
  };

  const flags = normalized?.work?.flags || {};
  const work = {
    work_id: null,
    platform_id: platformId,
    author_id: null,
    relative_path: workRelative.relativePath,
    relative_path_key: workRelative.relativePathKey,
    source_work_id: identity.sourceWorkId,
    source_work_id_source: identity.sourceWorkIdSource,
    published_at_ms: safeInteger(normalized?.work?.publishedAtMs, "work.publishedAtMs"),
    updated_at_ms: safeInteger(normalized?.work?.updatedAtMs, "work.updatedAtMs"),
    sort_at_ms: sort.value,
    sort_time_source: sort.source,
    title: title.value,
    title_source: title.source,
    title_rank: null,
    language: nullableText(normalized?.work?.language, "work.language"),
    is_adult: booleanInteger(flags.adult, "work.flags.adult"),
    is_ai_generated: booleanInteger(flags.aiGenerated, "work.flags.aiGenerated"),
    is_paid: booleanInteger(flags.paid, "work.flags.paid"),
    is_restricted: booleanInteger(flags.restricted, "work.flags.restricted"),
    is_sensitive: booleanInteger(flags.sensitive, "work.flags.sensitive"),
    has_full: booleanInteger(flags.hasFull, "work.flags.hasFull"),
    is_advertisement: booleanInteger(flags.advertisement, "work.flags.advertisement"),
    image_count: 0,
    video_count: 0,
    media_count: 0,
    cover_media_id: null,
    filesystem_state: filesystemState,
    filesystem_files_state: filesystemFilesState,
    work_dir_mtime_ns: workDirMtimeNs,
    metadata_state: metadataState,
    enrichment_state: enrichmentState,
    metadata_mtime_ns: metadataMtimeNs,
    metadata_size: metadataSize,
    adapter_version: adapterVersion,
    metadata_shape_id: null,
  };

  const authorProfile = authoritativeProfile ? {
    author_id: null,
    bio: nullableText(profile.bio, "authorProfile.bio"), avatar_url: nullableText(profile.avatarUrl, "authorProfile.avatarUrl"),
    banner_url: nullableText(profile.bannerUrl, "authorProfile.bannerUrl"), profile_url: nullableText(profile.profileUrl, "authorProfile.profileUrl"),
    location: nullableText(profile.location, "authorProfile.location"), language: nullableText(profile.language, "authorProfile.language"),
    verified: booleanInteger(profile.verified, "authorProfile.verified"), verification_type: safeInteger(profile.verificationType, "authorProfile.verificationType"),
    verification_reason: nullableText(profile.verificationReason, "authorProfile.verificationReason"),
    followers_count: safeInteger(profile.followersCount, "authorProfile.followersCount"), following_count: safeInteger(profile.followingCount, "authorProfile.followingCount"),
    statuses_count: safeInteger(profile.statusesCount, "authorProfile.statusesCount"), profile_links_json: stableJson(Array.isArray(profile.profileLinks) ? profile.profileLinks : []),
    authority_work_id: null, source_published_at_ms: safeInteger(normalized.work.publishedAtMs, "work.publishedAtMs"),
    source_metadata_mtime_ns: metadataMtimeNs, adapter_version: adapterVersion, metadata_shape_id: null,
  } : null;

  const aliases = authoritativeProfile ? [["display_name", profile.displayName], ["handle", profile.handle]]
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([kind, value]) => ({ author_id: null, platform_id: platformId, alias_kind: kind, display_value: value, normalized_value: null })) : [];

  const access = normalized?.work?.access || {};
  const workAccess = access.currentUserCanView == null && access.minimumCentsPledgedToView == null ? null : {
    work_id: null,
    current_user_can_view: booleanInteger(access.currentUserCanView, "work.access.currentUserCanView"),
    minimum_cents_pledged_to_view: safeInteger(access.minimumCentsPledgedToView, "work.access.minimumCentsPledgedToView"),
  };
  const primary = normalized?.richText?.primary || null;
  const workText = primary ? { work_id: null, source_format: primary.sourceFormat, source_text: primary.sourceText, safe_format: null, safe_text: null, plain_text: null, search_text: null, normalizer_version: null, sanitizer_version: null } : null;
  const textSources = (normalized?.richText?.supplementary || []).map((item, ordinal) => ({ work_id: null, ordinal, role: item.role, source_path: item.sourcePath, source_format: item.sourceFormat, source_text: item.sourceText }));
  const structuredSources = (normalized?.structuredSources || []).map((item, ordinal) => ({ work_id: null, ordinal, role: item.role, source_path: item.sourcePath, encoding: item.encoding, source_text: item.sourceText, schema_hint: item.schemaHint }));
  const fieldSources = dedupeFieldSources([
    ...(normalized?.fieldSources || []).map(item => ({ work_id: null, field: item.field, source_kind: item.sourceKind, source_path: item.sourcePath, priority: item.priority })),
    evidence("work.title", title, 100), evidence("work.sortAtMs", sort, 100), evidence("author.displayName", authorDisplay, 100),
    ...(identity.sourceWorkId ? [{ work_id: null, field: "work.sourceWorkId", source_kind: identity.sourceWorkIdSource === "metadata" ? "metadata" : "filesystem", source_path: identity.sourceWorkIdSource === "metadata" ? "adapter.selected" : "workDirectoryName.timestampedSuffix", priority: 100 }] : []),
    ...(identity.sourceAuthorId ? [{ work_id: null, field: "author.sourceAuthorId", source_kind: identity.sourceAuthorIdSource === "metadata" ? "metadata" : "filesystem", source_path: identity.sourceAuthorIdSource === "metadata" ? "adapter.selected" : "authorDirectoryName", priority: 100 }] : []),
  ]);
  const declarations = (normalized?.mediaDeclarations || []).map((item, ordinal) => ({
    work_id: null, ordinal, source_media_id: nullableText(item.sourceId, `mediaDeclarations[${ordinal}].sourceId`),
    declared_name: nullableText(item.name, `mediaDeclarations[${ordinal}].name`), declared_media_type: nullableText(item.kind, `mediaDeclarations[${ordinal}].kind`),
    declared_size: safeInteger(item.size, `mediaDeclarations[${ordinal}].size`), remote_url: nullableText(item.url, `mediaDeclarations[${ordinal}].url`),
    source_hash: nullableText(item.hash, `mediaDeclarations[${ordinal}].hash`), duration_ms: safeInteger(item.durationMs, `mediaDeclarations[${ordinal}].durationMs`),
    match_state: "unmatched", matched_media_id: null,
  }));
  const tags = (normalized?.tags || []).map((item, ordinal) => ({ tag_id: null, display_value: requiredText(item.displayValue, `tags[${ordinal}].displayValue`), normalized_value: null, work_count: 0 }));
  const workTags = tags.map((tag, ordinal) => ({ tag_id: null, work_id: null, ordinal, sort_at_ms: work.sort_at_ms }));
  const relations = (normalized?.relations || []).map((item, ordinal) => ({ work_id: null, ordinal, relation_type: item.type, target_platform_id: platformId, target_source_work_id: requiredText(item.sourceWorkId, `relations[${ordinal}].sourceWorkId`), target_work_id: null }));
  const metricValues = normalized?.metrics || {};
  const metrics = { work_id: null, likes: safeInteger(metricValues.likes, "metrics.likes"), replies: safeInteger(metricValues.replies, "metrics.replies"), comments: safeInteger(metricValues.comments, "metrics.comments"), reposts: safeInteger(metricValues.reposts, "metrics.reposts"), views: safeInteger(metricValues.views, "metrics.views"), bookmarks: safeInteger(metricValues.bookmarks, "metrics.bookmarks") };

  return {
    ok: true,
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
    identities: {
      author: { platform_id: platformId, relative_path_key: author.relative_path_key },
      work: { platform_id: platformId, relative_path_key: work.relative_path_key },
      sourceAuthor: identity.sourceAuthorId ? { platform_id: platformId, source_author_id: identity.sourceAuthorId } : null,
      sourceWork: identity.sourceWorkId ? { platform_id: platformId, source_work_id: identity.sourceWorkId } : null,
      metadataShape: shapeKey,
    },
    rows: {
      author, authorProfile, authorAliases: aliases, work, workAccess, workText, textSources, structuredSources,
      fieldSources, mediaDeclarations: declarations, tags, workTags, relations, metrics,
      metadataShape: shapeKey ? { ...shapeKey, first_seen_at_ms: null, last_seen_at_ms: null, work_count: 0, representative_metadata_relative_path: metadataRelative?.relativePath || null } : null,
    },
  };
}

module.exports = { SQLITE_INT64_MAX, mapCatalogState, mapNormalizedToRelational, mapPlatformRegistry, platformRegistryFingerprint };
