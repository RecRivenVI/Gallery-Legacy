"use strict";

const { beginAdapt, finalize, richText, selectField, setIdentities, setPrimaryRichText } = require("./contract.js");
const { asBoolean, asId, asInteger, asObject, asText, fallback, httpUrl, normalizeTags, oneOrMany, parseTimestamp, stableObjectEntries } = require("./helpers.js");

const PLATFORM_ID = "pixivFANBOX";
const VERSION = 2;

function adapt(context) {
  const { result, metadata } = beginAdapt(FanboxAdapter, context);
  if (!metadata) return finalize(result);
  const d = result.diagnostics; const user = asObject(metadata.user, d, "user") || {};
  setIdentities(result, context, [{ path: "id", value: metadata.id }], [{ path: "user.userId", value: user.userId }, { path: "user.creatorId", value: user.creatorId }, { path: "creatorId", value: metadata.creatorId }]);
  result.work.title = selectField(result, "work.title", [{ path: "title", value: metadata.title }], asText);
  result.work.publishedAtMs = selectField(result, "work.publishedAtMs", [{ path: "publishedDatetime", value: metadata.publishedDatetime }, { path: "date", value: metadata.date }], parseTimestamp);
  result.work.updatedAtMs = selectField(result, "work.updatedAtMs", [{ path: "updatedDatetime", value: metadata.updatedDatetime }], parseTimestamp);
  result.authorProfile.displayName = selectField(result, "authorProfile.displayName", [{ path: "user.name", value: user.name }, { path: "user.creatorId", value: user.creatorId }], asText);
  result.authorProfile.handle = selectField(result, "authorProfile.handle", [{ path: "user.creatorId", value: user.creatorId }], asText);
  result.authorProfile.bio = selectField(result, "authorProfile.bio", [{ path: "user.description", value: user.description }], asText);
  result.authorProfile.avatarUrl = httpUrl(user.iconUrl, d, "user.iconUrl");
  result.authorProfile.bannerUrl = httpUrl(user.coverImageUrl, d, "user.coverImageUrl");
  result.authorProfile.profileLinks = oneOrMany(user.profileLinks, d, "user.profileLinks").map((value, index) => httpUrl(value, d, `user.profileLinks[${index}]`)).filter(Boolean);
  result.work.flags.adult = asBoolean(metadata.hasAdultContent, d, "hasAdultContent");
  result.work.flags.restricted = asBoolean(metadata.isRestricted, d, "isRestricted");
  const fee = asInteger(metadata.feeRequired, d, "feeRequired", { allowString: true }); result.work.flags.paid = fee === null ? null : fee > 0;
  result.metrics.likes = asInteger(metadata.likeCount, d, "likeCount", { allowString: true });
  result.metrics.comments = asInteger(metadata.commentCount, d, "commentCount", { allowString: true });
  result.tags = normalizeTags(oneOrMany(metadata.tags, d, "tags").map((value, index) => asText(value, d, `tags[${index}]`)));

  const content = asText(metadata.content, d, "content"); const text = asText(metadata.text, d, "text"); const excerpt = asText(metadata.excerpt, d, "excerpt");
  if (content !== null) setPrimaryRichText(result, richText("content", "plain", content), 1);
  else if (text !== null) { setPrimaryRichText(result, richText("text", "plain", text), 2); fallback(d, "richText.primary", "text"); }
  else if (excerpt !== null) { setPrimaryRichText(result, richText("excerpt", "plain", excerpt, "summary"), 3); fallback(d, "richText.primary", "excerpt"); }
  if (excerpt !== null && result.richText.primary?.sourcePath !== "excerpt") result.richText.supplementary.push(richText("excerpt", "plain", excerpt, "summary"));
  const article = asObject(metadata.articleBody, d, "articleBody");
  oneOrMany(article?.blocks, d, "articleBody.blocks").forEach((block, index) => {
    const value = asObject(block, d, `articleBody.blocks[${index}]`) || {}; const blockText = asText(value.text, d, `articleBody.blocks[${index}].text`);
    if (blockText !== null) result.richText.supplementary.push(richText(`articleBody.blocks[${index}].text`, "plain", blockText, "body_fragment"));
  });
  const archives = oneOrMany(metadata.archives, d, "archives");
  result.mediaDeclarations = archives.map((item, index) => { const value = asObject(item, d, `archives[${index}]`) || {}; return { sourceId: asId(value.id, d, `archives[${index}].id`), kind: "archive", name: asText(value.name, d, `archives[${index}].name`), url: httpUrl(value.url, d, `archives[${index}].url`), hash: null, size: asInteger(value.size, d, `archives[${index}].size`, { allowString: true }), durationMs: null }; });
  for (const [key, value] of stableObjectEntries(article?.imageMap)) {
    const image = asObject(value, d, `articleBody.imageMap.${key}`) || {};
    result.mediaDeclarations.push({ sourceId: key, kind: "image", name: null, url: httpUrl(image.originalUrl || image.url, d, `articleBody.imageMap.${key}.url`), hash: null, size: null, durationMs: null });
  }
  return finalize(result);
}

const FanboxAdapter = Object.freeze({ PLATFORM_ID, VERSION, adapt });
module.exports = FanboxAdapter;
