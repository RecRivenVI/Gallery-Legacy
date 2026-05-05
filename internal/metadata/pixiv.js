"use strict";

const { beginAdapt, finalize, richText, selectField, setIdentities, setPrimaryRichText } = require("./contract.js");
const { asInteger, asObject, asText, httpUrl, isObject, normalizeTags, oneOrMany, parseTimestamp } = require("./helpers.js");

const PLATFORM_ID = "pixiv";
const VERSION = 2;

function adapt(context) {
  const { result, metadata } = beginAdapt(PixivAdapter, context);
  if (!metadata) return finalize(result);
  const d = result.diagnostics; const user = asObject(metadata.user, d, "user") || {};
  setIdentities(result, context, [{ path: "id", value: metadata.id }], [{ path: "user.id", value: user.id }]);
  result.work.title = selectField(result, "work.title", [{ path: "title.text", value: isObject(metadata.title) ? metadata.title.text : null }, { path: "title", value: metadata.title }], asText);
  result.work.publishedAtMs = selectField(result, "work.publishedAtMs", [{ path: "date", value: metadata.date }, { path: "create_date", value: metadata.create_date }], parseTimestamp);
  result.authorProfile.displayName = selectField(result, "authorProfile.displayName", [{ path: "user.name", value: user.name }], asText);
  result.authorProfile.handle = selectField(result, "authorProfile.handle", [{ path: "user.account", value: user.account }], asText);
  result.authorProfile.avatarUrl = httpUrl(asObject(user.profile_image_urls, d, "user.profile_image_urls")?.medium, d, "user.profile_image_urls.medium");
  const caption = asText(metadata.caption, d, "caption");
  if (caption !== null) setPrimaryRichText(result, richText("caption", "html", caption));
  const tags = oneOrMany(metadata.tags, d, "tags").map((tag, index) => typeof tag === "string" ? tag : asText(asObject(tag, d, `tags[${index}]`)?.name, d, `tags[${index}].name`));
  result.tags = normalizeTags(tags);
  result.work.flags.aiGenerated = metadata.illust_ai_type === undefined ? null : asInteger(metadata.illust_ai_type, d, "illust_ai_type", { allowString: true }) === 2;
  const restriction = asInteger(metadata.x_restrict ?? metadata.restrict, d, metadata.x_restrict !== undefined ? "x_restrict" : "restrict", { allowString: true });
  result.work.flags.adult = restriction === null ? null : restriction > 0;
  result.metrics.bookmarks = asInteger(metadata.total_bookmarks, d, "total_bookmarks", { allowString: true });
  result.metrics.comments = asInteger(metadata.total_comments, d, "total_comments", { allowString: true });
  result.metrics.views = asInteger(metadata.total_view, d, "total_view", { allowString: true });
  result.mediaDeclarations = oneOrMany(metadata.frames, d, "frames").map((frame, index) => {
    const value = asObject(frame, d, `frames[${index}]`) || {};
    return { sourceId: asText(value.file, d, `frames[${index}].file`), kind: "animation_frame", name: asText(value.file, d, `frames[${index}].file`), url: null, hash: null, size: null, durationMs: asInteger(value.delay, d, `frames[${index}].delay`, { allowString: true }) };
  });
  return finalize(result);
}

const PixivAdapter = Object.freeze({ PLATFORM_ID, VERSION, adapt });
module.exports = PixivAdapter;
