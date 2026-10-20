"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const {
  createGalleryReviewHost,
} = require("../../tools/validation/gallery-host.cjs");
const { createManagerTestHost } = require("../../tools/manager/server.cjs");
const { normalizeRuntimeConfig } = require("../../src/instance/config.js");
const { PLATFORM_REGISTRY } = require("../../src/library/platforms.js");
const { fixture, freePort } = require("../support/runtime.js");
test("review gallery host requires validation and never accepts a production listener", async () => {
  await assert.rejects(
    createGalleryReviewHost({
      port: 18232,
      backend: 8081,
      configPath: "unused",
      validateConfig() {},
    }),
  );
  await assert.rejects(
    createGalleryReviewHost({
      port: 18232,
      backend: 18230,
      configPath: "unused",
    }),
  );
  await assert.rejects(
    createGalleryReviewHost({
      port: 18232,
      backend: 18232,
      configPath: "unused",
      validateConfig() {},
    }),
  );
});
test("review gallery rejects non-sandbox bindings before starting its synthetic listener", async (t) => {
  const f = await fixture(t),
    file = path.join(f.config.instanceRoot, "config.json"),
    port = await freePort();
  const { assertConfig } = require("../../tools/demo/paths.cjs");
  await assert.rejects(
    createGalleryReviewHost({
      port,
      backend: f.config.port,
      configPath: file,
      validateConfig: assertConfig,
    }),
  );
});
test("test Manager gallery links remain explicit loopback-only staging links", async (t) => {
  const f = await fixture(t),
    file = path.join(f.config.instanceRoot, "config.json");
  const raw = JSON.parse(fs.readFileSync(file));
  raw.deployment = "staging";
  fs.writeFileSync(file, JSON.stringify(raw));
  for (const galleryUrl of [
    "https://example.invalid/",
    "http://127.0.0.1:8081/",
    "http://127.0.0.1/",
    "http://user:pass@127.0.0.1:18232/",
    "http://127.0.0.1:18232/path",
  ]) {
    await assert.rejects(
      createManagerTestHost(file, { port: await freePort(), galleryUrl }),
      { code: "TEST_GALLERY_URL_INVALID" },
    );
  }
  const host = await createManagerTestHost(file, {
    port: await freePort(),
    ui: "manager/candidate",
    galleryUrl: "http://127.0.0.1:18232/",
  });
  t.after(() => host.close());
  const response = await fetch(host.url),
    cookie = response.headers.get("set-cookie").split(";")[0];
  const bridge = await fetch(host.url + "/test-host.js", {
    headers: { Cookie: cookie },
  }).then((r) => r.text());
  assert.ok(bridge.includes('window.open("http://127.0.0.1:18232/"'));
});
test("test Manager caches validated status configuration but revalidates changed files and mutations", async (t) => {
  const f = await fixture(t),
    file = path.join(f.config.instanceRoot, "config.json"),
    raw = JSON.parse(fs.readFileSync(file));
  raw.deployment = "staging";
  fs.writeFileSync(file, JSON.stringify(raw));
  let validations = 0;
  const host = await createManagerTestHost(file, {
    port: await freePort(),
    validateConfig() {
      validations++;
    },
    control: async () => ({ state: "READY" }),
  });
  t.after(() => host.close());
  const page = await fetch(host.url),
    html = await page.text(),
    cookie = page.headers.get("set-cookie").split(";")[0],
    token = html.match(/name="test-csrf" content="([^"]+)"/)[1];
  const call = (method, args = []) =>
    fetch(host.url + "/test-control", {
      method: "POST",
      headers: {
        Origin: host.url,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-Gallery-Test": token,
      },
      body: JSON.stringify({ method, args }),
    });
  for (let i = 0; i < 5; i++) {
    assert.equal((await call("status")).status, 200);
    assert.equal((await call("admin", ["scan.status"])).status, 200);
  }
  assert.equal(
    validations,
    1,
    "read polls must not repeat source-root validation",
  );
  fs.writeFileSync(file, JSON.stringify(raw) + "\n");
  assert.equal((await call("status")).status, 200);
  assert.equal(validations, 2);
  assert.equal((await call("start")).status, 200);
  assert.equal(validations, 3, "mutation still validates paths");
  fs.writeFileSync(file, JSON.stringify({ ...raw, port: 8081 }));
  assert.equal((await call("status")).status, 403);
});
