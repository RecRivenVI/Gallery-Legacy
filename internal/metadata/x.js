"use strict";

const { addFieldSource, beginAdapt, finalize, richText, selectField, setIdentities, setPrimaryRichText } = require("./contract.js");
const { asBoolean, asId, asInteger, asObject, asText, firstValid, httpUrl, normalizeTags, oneOrMany, parseTimestamp } = require("./helpers.js");

const PLATFORM_ID = "X";
const VERSION = 2;

function relation(result, type, value, path) {
  if (value === 0 || value === "0" || value === "") return null;
  const sourceWorkId = asId(value, result.diagnostics, path);
  if (!sourceWorkId) return null;
  addFieldSource(result, `relations.${type}`, "metadata", path, 1);
  return { type, sourceWorkId };
}

function adapt(context) {
  const { result, metadata } = beginAdapt(XAdapter, context);
  if (!metadata) return finalize(result);
  const d = result.diagnostics; const user = asObject(metadata.user, d, "user") || {}; const author = asObject(metadata.author, d, "author") || {};
  setIdentities(result, context, [{ path: "tweet_id", value: metadata.tweet_id }, { path: "id", value: metadata.id }], [{ path: "user.id", value: user.id }, { path: "author.id", value: author.id }]);
  result.work.publishedAtMs = selectField(result, "work.publishedAtMs", [{ path: "date", value: metadata.date }], parseTimestamp);
  result.work.language = selectField(result, "work.language", [{ path: "lang", value: metadata.lang }], asText);
  result.authorProfile.displayName = selectField(result, "authorProfile.displayName", [{ path: "user.name", value: user.name }, { path: "author.name", value: author.name }], asText);
  result.authorProfile.handle = selectField(result, "authorProfile.handle", [{ path: "user.nick", value: user.nick }, { path: "author.nick", value: author.nick }], asText);
  result.authorProfile.bio = selectField(result, "authorProfile.bio", [{ path: "user.description", value: user.description }, { path: "author.description", value: author.description }], asText);
  result.authorProfile.location = firstValid([{ path: "user.location", value: user.location }, { path: "author.location", value: author.location }], asText, d, "authorProfile.location");
  result.authorProfile.avatarUrl = httpUrl(user.profile_image || author.profile_image, d, user.profile_image ? "user.profile_image" : "author.profile_image");
  result.authorProfile.bannerUrl = httpUrl(user.profile_banner || author.profile_banner, d, user.profile_banner ? "user.profile_banner" : "author.profile_banner");
  result.authorProfile.profileUrl = httpUrl(user.url || author.url, d, user.url ? "user.url" : "author.url");
  result.authorProfile.language = asText(user.lang ?? author.lang, d, user.lang !== undefined ? "user.lang" : "author.lang");
  result.authorProfile.verified = asBoolean(user.verified ?? author.verified, d, user.verified !== undefined ? "user.verified" : "author.verified");
  result.authorProfile.followersCount = asInteger(user.followers_count ?? author.followers_count, d, user.followers_count !== undefined ? "user.followers_count" : "author.followers_count", { allowString: true });
  result.authorProfile.followingCount = asInteger(user.friends_count ?? author.friends_count, d, user.friends_count !== undefined ? "user.friends_count" : "author.friends_count", { allowString: true });
  result.authorProfile.statusesCount = asInteger(user.statuses_count ?? author.statuses_count, d, user.statuses_count !== undefined ? "user.statuses_count" : "author.statuses_count", { allowString: true });
  const content = asText(metadata.content, d, "content"); if (content !== null) setPrimaryRichText(result, richText("content", "plain", content));
  result.tags = normalizeTags(oneOrMany(metadata.hashtags, d, "hashtags").map((value, index) => asText(value, d, `hashtags[${index}]`)));
  result.work.flags.sensitive = asBoolean(metadata.sensitive, d, "sensitive");
  result.metrics.likes = asInteger(metadata.favorite_count, d, "favorite_count", { allowString: true });
  result.metrics.replies = asInteger(metadata.reply_count, d, "reply_count", { allowString: true });
  result.metrics.reposts = asInteger(metadata.retweet_count, d, "retweet_count", { allowString: true });
  result.metrics.views = asInteger(metadata.view_count, d, "view_count", { allowString: true });
  result.metrics.bookmarks = asInteger(metadata.bookmark_count, d, "bookmark_count", { allowString: true });
  result.relations = [relation(result, "reply", metadata.reply_id, "reply_id"), relation(result, "retweet", metadata.retweet_id, "retweet_id"), relation(result, "quote", metadata.quote_id, "quote_id"), relation(result, "conversation", metadata.conversation_id, "conversation_id")].filter(Boolean);
  return finalize(result);
}

const XAdapter = Object.freeze({ PLATFORM_ID, VERSION, adapt });
module.exports = XAdapter;
