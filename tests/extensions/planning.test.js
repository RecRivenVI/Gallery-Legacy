"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fanbox = require("../../extensions/extractors/fanbox.js");
const gank = require("../../extensions/extractors/gank.js");
const pawchive = require("../../extensions/extractors/pawchive.js");
test("optional attachment plans preserve order and disambiguate filenames without IO", () => {
  const planned = fanbox.buildMediaList({
    coverImageUrl: "https://example.invalid/cover.jpeg",
    body: {
      blocks: [
        { type: "image", imageId: "a" },
        { type: "file", fileId: "b" },
      ],
      imageMap: {
        a: { extension: "png", originalUrl: "https://example.invalid/a.png" },
      },
      fileMap: {
        b: { extension: "zip", url: "https://example.invalid/b.zip" },
      },
    },
  });
  assert.deepEqual(
    planned.map((f) => f.name),
    ["cover.jpg", "1.png", "2.zip"],
  );
  assert.deepEqual(gank.buildFiles({}), []);
  const post = {
    attachments: [
      { path: "/00/00/" + "0".repeat(64) + ".png", name: "same.png" },
      { path: "/11/11/" + "1".repeat(64) + ".png", name: "same.png" },
    ],
  };
  const { files } = pawchive.buildFiles(post);
  assert.deepEqual(
    pawchive
      .buildPlanMedia(files, { post, service: "patreon" })
      .map((f) => f.name),
    ["same.png", "same_2.png"],
  );
});
