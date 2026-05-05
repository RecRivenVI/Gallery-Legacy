"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  selectLatestAuthorProfile,
} = require("../../internal/metadata/latest-author-profile.js");

function candidate({
  id,
  publishedAtMs = null,
  directoryTimestampMs = null,
  valid = true,
  displayName = null,
  bio = null,
  directoryName = null,
}) {
  return {
    valid,
    work: { sourceWorkId: id, publishedAtMs },
    sourceContext: {
      directoryTimestampMs,
      workDirectoryName: directoryName || id,
    },
    authorProfile: { sourceAuthorId: "author", displayName, bio },
  };
}

test("作者资料严格来自publishedAtMs最新作品", () => {
  const older = candidate({
    id: "1",
    publishedAtMs: 100,
    displayName: "旧名",
    bio: "旧简介",
  });
  const latest = candidate({
    id: "2",
    publishedAtMs: 200,
    displayName: "新名",
    bio: "新简介",
  });
  const result = selectLatestAuthorProfile([latest, older]);
  assert.equal(result.valid, true);
  assert.equal(result.sourceWorkId, "2");
  assert.deepEqual(result.profile, latest.authorProfile);
});

test("metadata时间缺失时使用目录时间fallback", () => {
  const older = candidate({
    id: "1",
    publishedAtMs: 100,
    directoryTimestampMs: 900,
    displayName: "metadata较旧",
  });
  const fallbackLatest = candidate({
    id: "2",
    directoryTimestampMs: 200,
    displayName: "目录较新",
  });
  const result = selectLatestAuthorProfile([older, fallbackLatest]);
  assert.equal(result.sourceWorkId, "2");
  assert.equal(result.sourcePublishedAtMs, null);
  assert.equal(result.sourceDirectoryTimestampMs, 200);
});

test("时间相同时按sourceWorkId和目录名稳定决胜", () => {
  const a = candidate({
    id: "a",
    publishedAtMs: 100,
    displayName: "A",
    directoryName: "dir-z",
  });
  const b = candidate({
    id: "b",
    publishedAtMs: 100,
    displayName: "B",
    directoryName: "dir-a",
  });
  const first = selectLatestAuthorProfile([b, a]);
  const second = selectLatestAuthorProfile([a, b]);
  assert.deepEqual(first, second);
  assert.equal(first.sourceWorkId, "b");
});

test("最新作品缺字段时不从旧作品回填", () => {
  const older = candidate({
    id: "1",
    publishedAtMs: 100,
    displayName: "旧名",
    bio: "旧简介",
  });
  const latest = candidate({
    id: "2",
    publishedAtMs: 200,
    displayName: "新名",
    bio: null,
  });
  const result = selectLatestAuthorProfile([older, latest]);
  assert.equal(result.profile.displayName, "新名");
  assert.equal(result.profile.bio, null);
});

test("最新作品metadata invalid时明确失败且不回退次新作品", () => {
  const older = candidate({
    id: "1",
    publishedAtMs: 100,
    displayName: "可用旧资料",
  });
  const invalidLatest = candidate({
    id: "2",
    publishedAtMs: 200,
    valid: false,
    displayName: null,
  });
  const result = selectLatestAuthorProfile([older, invalidLatest]);
  assert.deepEqual(result, {
    valid: false,
    profile: null,
    sourceWorkId: "2",
    sourceWorkDirectoryName: "2",
    reason: "latest_metadata_invalid",
  });
});

test("无候选时明确返回invalid", () => {
  assert.deepEqual(selectLatestAuthorProfile([]), {
    valid: false,
    profile: null,
    sourceWorkId: null,
    sourceWorkDirectoryName: null,
    reason: "no_candidates",
  });
});
