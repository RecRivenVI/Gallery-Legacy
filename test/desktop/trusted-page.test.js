"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { trustedPage } = require("../../src/desktop/trusted-page.js");
test("Manager hash navigation stays in its exact document; other files, queries and origins do not", () => {
  const page = "file:///product/public/manager/index.html";
  for (const hash of ["", "#update", "#access", "#settings", "#diagnose"])
    assert.equal(trustedPage(page + hash, page), true);
  for (const url of [
    null,
    "https://example.invalid/#access",
    page + "?other=1",
    page.replace("manager", "gallery"),
    page + "/other#access",
  ])
    assert.equal(trustedPage(url, page), false);
});
