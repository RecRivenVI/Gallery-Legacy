"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  PLATFORM_REGISTRY,
  validatePlatformRegistry,
  bindSources,
} = require("../../internal/library/platforms.js");
const { sources } = require("../support/sources.js");

test("fixed platform identity is independent of the transitional rules bridge", () => {
  assert.deepEqual(
    PLATFORM_REGISTRY.map((p) => p.id),
    [
      "pixiv",
      "pixivFANBOX",
      "Gank",
      "Fantia",
      "Patreon",
      "Pawchive",
      "X",
      "微博",
    ],
  );
  assert.ok(
    PLATFORM_REGISTRY.every(
      (p) =>
        p.enabled && !Object.hasOwn(p, "physicalRoot") && Object.isFrozen(p),
    ),
  );
  assert.ok(
    bindSources(sources()).every((p) => path.isAbsolute(p.physicalRoot)),
  );
  assert.equal(validatePlatformRegistry(PLATFORM_REGISTRY), true);
  const duplicateId = PLATFORM_REGISTRY.map((p) => ({ ...p }));
  duplicateId[1].id = duplicateId[0].id;
  assert.throws(() => validatePlatformRegistry(duplicateId), /重复 id/);
  const duplicateRoot = sources();
  duplicateRoot.pixivFANBOX = duplicateRoot.pixiv.toUpperCase();
  assert.throws(() => bindSources(duplicateRoot));
  assert.throws(() =>
    bindSources({ ...sources(), extra: path.resolve("extra") }),
  );
  assert.throws(() => bindSources({ ...sources(), pixiv: "relative" }));
});
