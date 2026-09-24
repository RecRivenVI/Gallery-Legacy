"use strict";

const { PLATFORM_REGISTRY } = require("./platforms.js");

const TIMESTAMPED_WORK = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_(.+)$/;
const DIGITS = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function timestampedWork(name) {
  if (typeof name !== "string") return { sourceWorkId: null, timestampMs: null, displayTitle: null };
  const match = name.match(TIMESTAMPED_WORK);
  if (!match) return { sourceWorkId: null, timestampMs: null, displayTitle: null };
  const timestampMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  return {
    sourceWorkId: match[7] || null,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
    displayTitle: match[7] || null,
  };
}

function numericAuthor(name) {
  return typeof name === "string" && DIGITS.test(name) ? { sourceAuthorId: name, displayName: name } : { sourceAuthorId: null, displayName: null };
}

function uuidAuthor(name) {
  return typeof name === "string" && UUID.test(name) ? { sourceAuthorId: name, displayName: name } : { sourceAuthorId: null, displayName: null };
}

function pawchiveAuthor(name) {
  const match = typeof name === "string" ? name.match(/^([^_]+)_(.+)$/) : null;
  if (!match || !match[1] || !match[2]) return { sourceAuthorId: null, displayName: null, service: null, user: null };
  return { sourceAuthorId: `${match[1]}:${match[2]}`, displayName: name, service: match[1], user: match[2] };
}

const AUTHOR_PARSERS = Object.freeze({
  pixiv: numericAuthor,
  pixivFANBOX: numericAuthor,
  Gank: uuidAuthor,
  Fantia: numericAuthor,
  Patreon: numericAuthor,
  Pawchive: pawchiveAuthor,
  X: numericAuthor,
  "微博": numericAuthor,
  Venera: (name) => ({ sourceAuthorId: null, displayName: typeof name === "string" ? name : null }),
});

function parsePlatformDirectoryIdentity(platformId, authorDirectoryName, workDirectoryName) {
  if (!PLATFORM_REGISTRY.some(platform => platform.id === platformId)) throw new Error(`Unknown platformId: ${platformId || "(missing)"}`);
  const author = AUTHOR_PARSERS[platformId](authorDirectoryName);
  const work = platformId === "Venera"
    ? { sourceWorkId: null, timestampMs: null, displayTitle: authorDirectoryName || workDirectoryName || null, displayTitleSourcePath: "authorDirectoryName" }
    : timestampedWork(workDirectoryName);
  if (["X", "微博"].includes(platformId) && work.timestampMs !== null) {
    // Preserve the observed timestamp text; directory timestamps do not prove a timezone.
    work.displayTitle = workDirectoryName.slice(0, 19).replace("_", " ").replace(/ (\d{2})-(\d{2})-(\d{2})$/, " $1:$2:$3");
    work.displayTitleSourcePath = "workDirectoryName.timestamp";
  }
  return Object.freeze({ platformId, author: Object.freeze(author), work: Object.freeze(work) });
}

module.exports = { AUTHOR_PARSERS, TIMESTAMPED_WORK, parsePlatformDirectoryIdentity, timestampedWork };
