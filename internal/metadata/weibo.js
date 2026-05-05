"use strict";

const { beginAdapt, finalize, richText, selectField, setIdentities, setPrimaryRichText } = require("./contract.js");
const { asBoolean, asId, asInteger, asObject, asText, fallback, firstValid, httpUrl, normalizeTags, oneOrMany, parseTimestamp, stableObjectEntries } = require("./helpers.js");

const PLATFORM_ID = "微博";
const VERSION = 2;

function bodySource(metadata, result) {
  const diagnostics = result.diagnostics;
  const longText = asObject(metadata.longText, diagnostics, "longText");
  const candidates = [
    { path: "longText.content", value: longText?.content, defaultFormat: "html", markdown: longText?.isMarkdown ?? metadata.isMarkdown },
    { path: "text_raw", value: metadata.text_raw, defaultFormat: "plain", markdown: metadata.isMarkdown },
    { path: "text", value: metadata.text, defaultFormat: "html", markdown: metadata.isMarkdown },
  ];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]; const text = asText(candidate.value, diagnostics, candidate.path);
    if (text !== null) {
      if (index > 0) fallback(diagnostics, "richText.primary", candidate.path);
      const value = richText(candidate.path, candidate.markdown === true ? "markdown" : candidate.defaultFormat, text);
      setPrimaryRichText(result, value, index + 1);
      return value;
    }
  }
  return null;
}

function topics(metadata, primaryText, diagnostics) {
  const values = [];
  oneOrMany(metadata.topic_struct, diagnostics, "topic_struct", { allowObject: true }).forEach((item, index) => {
    const value = asObject(item, diagnostics, `topic_struct[${index}]`) || {}; values.push(asText(value.topic_title, diagnostics, `topic_struct[${index}].topic_title`));
  });
  if (typeof primaryText === "string") {
    const regex = /#([^#\r\n]+)#/g; let match;
    while ((match = regex.exec(primaryText)) !== null) values.push(match[1]);
  }
  // url_struct is intentionally excluded: targeted real samples only showed
  // ordinary link titles and no stable topic discriminator.
  return normalizeTags(values);
}

function adapt(context) {
  const { result, metadata } = beginAdapt(WeiboAdapter, context);
  if (!metadata) return finalize(result);
  const d = result.diagnostics; const user = asObject(metadata.user, d, "user") || {};
  // idstr和目录身份优先；unsafe number只用于诊断，绝不stringify。
  setIdentities(result, context, [{ path: "idstr", value: metadata.idstr }, { path: "mid", value: metadata.mid }, { path: "id", value: metadata.id }], [{ path: "user.idstr", value: user.idstr }, { path: "user.id", value: user.id }]);
  result.work.publishedAtMs = selectField(result, "work.publishedAtMs", [{ path: "date", value: metadata.date }, { path: "created_at", value: metadata.created_at }], parseTimestamp);
  result.work.language = selectField(result, "work.language", [{ path: "lang", value: metadata.lang }], asText);
  result.authorProfile.displayName = selectField(result, "authorProfile.displayName", [{ path: "user.screen_name", value: user.screen_name }], asText);
  result.authorProfile.handle = selectField(result, "authorProfile.handle", [{ path: "user.domain", value: user.domain }, { path: "user.weihao", value: user.weihao }], asText);
  result.authorProfile.bio = selectField(result, "authorProfile.bio", [{ path: "user.description", value: user.description }], asText);
  result.authorProfile.avatarUrl = httpUrl(user.avatar_hd || user.avatar_large || user.profile_image_url, d, user.avatar_hd ? "user.avatar_hd" : user.avatar_large ? "user.avatar_large" : "user.profile_image_url");
  result.authorProfile.profileUrl = asText(user.profile_url, d, "user.profile_url");
  result.authorProfile.location = asText(user.location, d, "user.location");
  result.authorProfile.language = asText(user.lang, d, "user.lang");
  result.authorProfile.verified = asBoolean(user.verified, d, "user.verified");
  result.authorProfile.verificationType = asInteger(user.verified_type, d, "user.verified_type", { allowString: true });
  result.authorProfile.verificationReason = asText(user.verified_reason, d, "user.verified_reason");
  result.authorProfile.followersCount = asInteger(user.followers_count, d, "user.followers_count", { allowString: true });
  result.authorProfile.followingCount = asInteger(user.follow_count ?? user.friends_count, d, user.follow_count !== undefined ? "user.follow_count" : "user.friends_count", { allowString: true });
  result.authorProfile.statusesCount = asInteger(user.statuses_count, d, "user.statuses_count", { allowString: true });
  result.richText.primary = bodySource(metadata, result);
  result.tags = topics(metadata, result.richText.primary?.sourceText, d);
  result.work.flags.advertisement = asBoolean(metadata.isAd, d, "isAd", { allowNumeric: true });
  result.metrics.likes = asInteger(metadata.attitudes_count, d, "attitudes_count", { allowString: true });
  result.metrics.comments = asInteger(metadata.comments_count, d, "comments_count", { allowString: true });
  result.metrics.reposts = asInteger(metadata.reposts_count, d, "reposts_count", { allowString: true });
  // retweeted_status has a real corpus fixture. No reply/comment/conversation
  // field is mapped without equivalent source evidence.
  const repost = asObject(metadata.retweeted_status, d, "retweeted_status"); const repostId = repost ? selectField(result, "relations.repost", [{ path: "retweeted_status.idstr", value: repost.idstr }, { path: "retweeted_status.mid", value: repost.mid }, { path: "retweeted_status.id", value: repost.id }], asId) : null;
  if (repostId) {
    result.relations.push({ type: "repost", sourceWorkId: repostId });
  }
  const media = [];
  for (const [key, item] of stableObjectEntries(metadata.pic_infos)) {
    const value = asObject(item, d, `pic_infos.${key}`) || {}; const large = asObject(value.largest || value.large || value.original, d, `pic_infos.${key}.image`) || {};
    media.push({ sourceId: key, kind: "image", name: null, url: httpUrl(large.url, d, `pic_infos.${key}.image.url`), hash: null, size: null, durationMs: null });
  }
  const mixed = asObject(metadata.mix_media_info, d, "mix_media_info");
  oneOrMany(mixed?.items, d, "mix_media_info.items", { allowObject: true }).forEach((item, index) => { const value = asObject(item, d, `mix_media_info.items[${index}]`) || {}; const data = asObject(value.data, d, `mix_media_info.items[${index}].data`) || {}; media.push({ sourceId: asId(data.pic_id || data.object_id, d, `mix_media_info.items[${index}].data.id`), kind: asText(value.type || data.type, d, `mix_media_info.items[${index}].type`), name: null, url: null, hash: null, size: null, durationMs: null }); });
  result.mediaDeclarations = media;
  return finalize(result);
}

const WeiboAdapter = Object.freeze({ PLATFORM_ID, VERSION, adapt });
module.exports = WeiboAdapter;
