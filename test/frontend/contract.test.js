"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
test("query encoding keeps exact tags, Unicode and independent controls", async () => {
  const { hashFor, locationState } = await import(
    "../../public/gallery/data.js"
  );
  const encoded = hashFor({
    kind: "works",
    platform: "pixiv",
    q: "Alpha & Beta",
    tag: "R-18 || 字符 🧪",
    page: 1,
  });
  const params = new URLSearchParams(encoded.split("?")[1]);
  assert.equal(params.get("q"), "Alpha & Beta");
  assert.equal(params.get("tag"), "R-18 || 字符 🧪");
  const decoded = locationState({ hash: encoded });
  assert.equal(decoded.q, "Alpha & Beta");
  assert.equal(decoded.tag, "R-18 || 字符 🧪");
  assert.equal(
    locationState({ hash: "#/@all/pixiv?mediaType=bad&pageSize=-1" })
      .invalidFilter,
    true,
  );
  assert.equal(
    locationState({ hash: "#/@all/pixiv?pageSize=120" }).pageSize,
    120,
  );
});
test("API client rejects malformed response before UI and forwards cancellation", async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
  });
  const api = await import("../../public/platform/api.js");
  let url, signal;
  global.fetch = async (u, o) => {
    url = u;
    signal = o.signal;
    return {
      ok: true,
      json: async () => ({
        protocolVersion: 1,
        generationId: "test",
        data: {
          items: [],
          total: 0,
          page: 1,
          pageSize: 48,
          totalPages: 1,
          cursor: null,
        },
      }),
    };
  };
  const controller = new AbortController();
  await api.list("works", { q: "A", tag: "B" }, { signal: controller.signal });
  assert.equal(
    new URL(url, "http://example.invalid").searchParams.get("tag"),
    "B",
  );
  assert.equal(signal, controller.signal);
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      protocolVersion: 1,
      generationId: "test",
      data: {
        items: [{ id: 9007199254740992 }],
        total: 1,
        page: 1,
        pageSize: 48,
        totalPages: 1,
        cursor: null,
      },
    }),
  });
  await assert.rejects(api.list("works", {}), { code: "INVALID_RESPONSE" });
});
