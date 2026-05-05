"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { fixture } = require("../support/runtime.js");
const {
  createRuntimeBootstrap,
} = require("../../internal/runtime/bootstrap.js");
test("published Catalog cannot be paired with different configured source roots", async (t) => {
  const f = await fixture(t);
  f.build();
  f.publish();
  const config = {
    ...f.config,
    sources: { ...f.bindings, pixiv: path.join(f.root, "another-source") },
  };
  await assert.rejects(createRuntimeBootstrap({ config }).start(), {
    code: "SOURCE_BINDING_MISMATCH",
  });
  assert.equal(
    fs.existsSync(path.join(f.config.stateRoot, "runtime.lock")),
    false,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(f.config.statusPath)).state,
    "FAILED",
  );
});
