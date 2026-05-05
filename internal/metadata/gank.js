"use strict";

const { beginAdapt, finalize, richText, selectField, setIdentities, setPrimaryRichText } = require("./contract.js");
const { asBoolean, asId, asInteger, asObject, asText, httpUrl, normalizeTags, oneOrMany, parseTimestamp } = require("./helpers.js");

const PLATFORM_ID = "Gank";
const VERSION = 2;

function adapt(context) {
  const { result, metadata } = beginAdapt(GankAdapter, context);
  if (!metadata) return finalize(result);
  const d = result.diagnostics; const user = asObject(metadata.user, d, "user") || {}; const authorUser = asObject(metadata.authorUser, d, "authorUser") || {};
  setIdentities(result, context, [{ path: "id", value: metadata.id }, { path: "post_id", value: metadata.post_id }], [{ path: "user.id", value: user.id }, { path: "author", value: metadata.author }, { path: "authorUser.id", value: authorUser.id }]);
  result.work.title = selectField(result, "work.title", [{ path: "title", value: metadata.title }], asText);
  result.work.publishedAtMs = selectField(result, "work.publishedAtMs", [{ path: "createdAt", value: metadata.createdAt }, { path: "date", value: metadata.date }], parseTimestamp);
  result.work.updatedAtMs = selectField(result, "work.updatedAtMs", [{ path: "updatedAt", value: metadata.updatedAt }, { path: "date_updated", value: metadata.date_updated }], parseTimestamp);
  result.authorProfile.displayName = selectField(result, "authorProfile.displayName", [{ path: "user.nickname", value: user.nickname }, { path: "authorUser.nickname", value: authorUser.nickname }], asText);
  result.authorProfile.handle = result.authorProfile.displayName;
  if (result.authorProfile.handle !== null) {
    const displaySource = result.fieldSources.find(item => item.field === "authorProfile.displayName");
    if (displaySource) result.fieldSources.push({ ...displaySource, field: "authorProfile.handle" });
  }
  result.authorProfile.bio = selectField(result, "authorProfile.bio", [{ path: "user.profile.description", value: asObject(user.profile, d, "user.profile")?.description }, { path: "user.description", value: user.description }], asText);
  result.authorProfile.avatarUrl = httpUrl(user.avatar || authorUser.avatar, d, user.avatar ? "user.avatar" : "authorUser.avatar");
  result.authorProfile.verified = asBoolean(user.verified, d, "user.verified");
  const content = asText(metadata.content, d, "content"); if (content !== null) setPrimaryRichText(result, richText("content", "plain", content));
  const tagValues = oneOrMany(metadata.tags, d, "tags").map((value, index) => asText(value, d, `tags[${index}]`));
  oneOrMany(metadata.postTags, d, "postTags").forEach((item, index) => tagValues.push(asText(asObject(item, d, `postTags[${index}]`)?.name, d, `postTags[${index}].name`)));
  result.tags = normalizeTags(tagValues);
  result.mediaDeclarations = oneOrMany(metadata.postMedia, d, "postMedia").map((item, index) => { const value = asObject(item, d, `postMedia[${index}]`) || {}; return { sourceId: asId(value.id, d, `postMedia[${index}].id`), kind: asText(value.type, d, `postMedia[${index}].type`), name: null, url: httpUrl(value.url || value.previewUrl || value.thumbUrl, d, `postMedia[${index}].url`), hash: null, size: null, durationMs: null }; });
  const summary = asObject(metadata.postSummary, d, "postSummary") || {};
  result.metrics.likes = asInteger(summary.count_like, d, "postSummary.count_like", { allowString: true });
  result.metrics.comments = asInteger(summary.count_comment, d, "postSummary.count_comment", { allowString: true });
  result.metrics.reposts = asInteger(summary.count_share, d, "postSummary.count_share", { allowString: true });
  result.metrics.bookmarks = asInteger(summary.count_bookmark, d, "postSummary.count_bookmark", { allowString: true });
  result.work.flags.restricted = metadata.isAllowToSee === undefined ? null : !asBoolean(metadata.isAllowToSee, d, "isAllowToSee");
  return finalize(result);
}

const GankAdapter = Object.freeze({ PLATFORM_ID, VERSION, adapt });
module.exports = GankAdapter;
