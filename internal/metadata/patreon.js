"use strict";

const { beginAdapt, finalize, richText, selectField, setIdentities, setPrimaryRichText } = require("./contract.js");
const { asBoolean, asId, asInteger, asObject, asText, httpUrl, normalizeTags, oneOrMany, parseTimestamp, stableObjectEntries } = require("./helpers.js");

const PLATFORM_ID = "Patreon";
const VERSION = 2;

function adapt(context) {
  const { result, metadata } = beginAdapt(PatreonAdapter, context);
  if (!metadata) return finalize(result);
  const d = result.diagnostics; const creator = asObject(metadata.creator, d, "creator") || {}; const campaign = asObject(metadata.campaign, d, "campaign") || {};
  setIdentities(result, context, [{ path: "id", value: metadata.id }], [{ path: "creator.id", value: creator.id }]);
  result.work.title = selectField(result, "work.title", [{ path: "title", value: metadata.title }], asText);
  result.work.publishedAtMs = selectField(result, "work.publishedAtMs", [{ path: "published_at", value: metadata.published_at }, { path: "date", value: metadata.date }], parseTimestamp);
  result.authorProfile.displayName = selectField(result, "authorProfile.displayName", [{ path: "creator.full_name", value: creator.full_name }, { path: "creator.first_name", value: creator.first_name }, { path: "campaign.name", value: campaign.name }], asText);
  result.authorProfile.handle = selectField(result, "authorProfile.handle", [{ path: "creator.vanity", value: creator.vanity }], asText);
  result.authorProfile.bio = selectField(result, "authorProfile.bio", [{ path: "creator.about", value: creator.about }], asText);
  result.authorProfile.avatarUrl = httpUrl(creator.image_url || creator.thumb_url, d, creator.image_url ? "creator.image_url" : "creator.thumb_url");
  result.authorProfile.profileUrl = httpUrl(creator.url || campaign.url, d, creator.url ? "creator.url" : "campaign.url");
  for (const [service, value] of stableObjectEntries(creator.social_connections)) {
    if (!value) continue;
    const url = typeof value === "string"
      ? httpUrl(value, d, `creator.social_connections.${service}`)
      : httpUrl(asObject(value, d, `creator.social_connections.${service}`)?.url, d, `creator.social_connections.${service}.url`);
    if (url) result.authorProfile.profileLinks.push(url);
  }
  const content = asText(metadata.content, d, "content"); if (content !== null) setPrimaryRichText(result, richText("content", "html", content));
  result.tags = normalizeTags(oneOrMany(metadata.tags, d, "tags").map((value, index) => asText(value, d, `tags[${index}]`)));
  result.work.flags.paid = asBoolean(metadata.is_paid, d, "is_paid");
  result.work.access.currentUserCanView = selectField(result, "work.access.currentUserCanView", [{ path: "current_user_can_view", value: metadata.current_user_can_view }], asBoolean);
  result.work.access.minimumCentsPledgedToView = selectField(result, "work.access.minimumCentsPledgedToView", [{ path: "min_cents_pledged_to_view", value: metadata.min_cents_pledged_to_view }], asInteger);
  // current_user_can_view describes one downloader session, not a stable public/member/tier category.
  result.work.flags.restricted = null;
  result.work.flags.sensitive = asBoolean(campaign.is_nsfw, d, "campaign.is_nsfw");
  result.metrics.likes = asInteger(metadata.like_count, d, "like_count", { allowString: true });
  result.metrics.comments = asInteger(metadata.comment_count, d, "comment_count", { allowString: true });
  const media = [];
  oneOrMany(metadata.images, d, "images").forEach((item, index) => { const value = asObject(item, d, `images[${index}]`) || {}; const urls = asObject(value.image_urls, d, `images[${index}].image_urls`) || {}; media.push({ sourceId: asId(value.id, d, `images[${index}].id`), kind: "image", name: asText(value.file_name, d, `images[${index}].file_name`), url: httpUrl(urls.original || urls.default || urls.url, d, `images[${index}].image_urls`), hash: null, size: null, durationMs: null }); });
  for (const [field, kind] of [["attachments", "attachment"], ["attachments_media", "attachment_media"]]) oneOrMany(metadata[field], d, field).forEach((item, index) => { const value = asObject(item, d, `${field}[${index}]`) || {}; media.push({ sourceId: asId(value.id, d, `${field}[${index}].id`), kind, name: asText(value.name || value.file_name, d, `${field}[${index}].name`), url: httpUrl(value.url || value.download_url, d, `${field}[${index}].url`), hash: null, size: asInteger(value.size, d, `${field}[${index}].size`, { allowString: true }), durationMs: null }); });
  result.mediaDeclarations = media;
  return finalize(result);
}

const PatreonAdapter = Object.freeze({ PLATFORM_ID, VERSION, adapt });
module.exports = PatreonAdapter;
