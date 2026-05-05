"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { fixture } = require("../support/runtime.js");
const {
  installWriteGuard,
  BLOCK_CODE,
} = require("../../internal/library/write-guard.js");
test("instance-only write guard covers path, descriptors and async writes", async (t) => {
  const f = await fixture(t, { empty: true });
  const sourceFile = path.join(f.bindings.pixiv, "source.txt");
  fs.writeFileSync(sourceFile, "synthetic");
  const guard = installWriteGuard({
    instanceRoot: f.config.instanceRoot,
    protectedRoots: f.config.platforms,
  });
  try {
    const allowed = path.join(f.config.tempRoot, "allowed.txt"),
      outside = path.join(f.bindings.pixiv, "blocked.txt");
    fs.writeFileSync(allowed, "safe");
    const fd = fs.openSync(allowed, "r+");
    fs.writeFileSync(fd, "okay");
    fs.closeSync(fd);
    assert.throws(() => fs.writeFileSync(outside, "no"), { code: BLOCK_CODE });
    assert.throws(() => fs.mkdirSync(path.join(f.bindings.pixiv, "bad")), {
      code: BLOCK_CODE,
    });
    await assert.rejects(fs.promises.writeFile(outside, "no"), {
      code: BLOCK_CODE,
    });
    assert.equal(fs.existsSync(outside), false);
    assert.throws(
      () => fs.linkSync(sourceFile, path.join(f.config.tempRoot, "alias.txt")),
      { code: BLOCK_CODE },
    );
    assert.equal(fs.statSync(sourceFile).nlink, 1);
    assert.equal(guard.blockedCount(), 4);
  } finally {
    guard.restore();
  }
});
