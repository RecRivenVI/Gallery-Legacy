"use strict";
// Real-data checks report aggregates only. Never log requests, content or paths.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), vm = require("node:vm"), assert = require("node:assert/strict");
const { readRuntimeConfig } = require("../internal/instance/config.js");
const { writeJson } = require("../internal/instance/files.js");
const { compareNatural } = require("../internal/media/order.js");
const { accept } = require("./acceptance.js");
async function main() {
  const args = process.argv.slice(2), at = args.indexOf("--config"), prod = args.indexOf("--production-url");
  if (at < 0 || !args.includes("--confirm-private-read-only")) throw new Error("ACCEPTANCE_CONFIRMATION_REQUIRED");
  const config = readRuntimeConfig(path.resolve(args[at + 1]));
  const result = { state: "RUNNING", startedAtMs: Date.now(), checks: {}, stage: "existing-product", screenshots: 0, privateContentInReport: false };
  async function api(resource, parameters = {}) {
    const q = new URLSearchParams(parameters);
    const response = await fetch(config.url + "/api/v1/" + resource + (q.size ? "?" + q : ""), { signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 200); return (await response.json()).data;
  }
  function hostRequest(host, origin, method = "GET") {
    return new Promise((resolve, reject) => {
      const body = method === "POST" ? '{"confirmReadOnly":true}' : null;
      const req = http.request({ hostname: "127.0.0.1", port: config.port, path: method === "POST" ? "/api/v1/scans" : "/api/v1/health", method,
        headers: { Host: host, ...(origin ? { Origin: origin } : {}), ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}) } }, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode)); });
      req.setTimeout(30000, () => req.destroy()); req.once("error", reject); req.end(body);
    });
  }
  try {
    result.existingProduct = await accept(config);
    result.stage = "venera";
    const platform = (await api("platforms")).items.find((p) => p.id === "Venera");
    assert.ok(platform && platform.works > 0 && platform.media > 0);
    result.venera = { works: platform.works, media: platform.media };
    const text = await (await fetch(config.url + "/venera-source.js")).text();
    const Source = vm.runInNewContext(text + ";LocalGallery", { ComicSource: class { loadSetting() { return config.url; } }, fetch });
    const client = new Source(); assert.equal(client.key, "local_gallery");
    const works = await client.categoryComics.load("Venera", null, [], 1);
    assert.ok(works.comics.length > 0);
    const stable = works.comics[0].id;
    assert.ok((await client.comic.loadInfo(stable)).title);
    assert.ok((await client.comic.loadEp(stable, stable)).images.length > 0);
    const detail = (await api("resolve", { path: stable })).item;
    const names = detail.media.map((m) => m.relativePath);
    assert.deepEqual(names, [...names].sort(compareNatural));
    result.checks.veneraSourceDetailsChaptersNaturalPages = true;
    result.stage = "production-identities";
    if (prod >= 0) {
      const production = new URL(args[prod + 1]);
      assert.ok(["127.0.0.1", "localhost"].includes(production.hostname));
      assert.notEqual(production.port, String(config.port));
      let verified = 0;
      for (const p of config.platforms) {
        const q = new URLSearchParams({ platformPath: "/p/" + encodeURIComponent(p.id), page: "1", pageSize: "1" });
        const response = await fetch(production.origin + "/api/db-posts?" + q, { signal: AbortSignal.timeout(60000) });
        assert.equal(response.status, 200);
        const item = (await response.json()).items?.[0]; assert.ok(item);
        const id = String(item.parentPath || "") + "/" + String(item.name);
        const found = await api("resolve", { path: id });
        assert.equal(found.kind, "work"); assert.equal(found.item.platformId, p.id);
        await client.comic.loadInfo(id); verified++;
      }
      result.checks.productionPhysicalFavoriteIdentities = verified;
    }
    result.stage = "files";
    const roots = (await api("file-roots")).items; assert.equal(roots.length, config.fileBrowserRoots.length);
    for (const r of roots) assert.ok(Array.isArray((await api("files", { root: r.id })).items));
    result.checks.fileBrowserRoots = roots.length;
    result.stage = "shortlinks";
    let valid = 0, missing = 0;
    for (const [code, target] of Object.entries(config.shortLinks)) {
      const redirect = await fetch(config.url + "/s/" + code, { redirect: "manual" });
      assert.equal(redirect.status, 302); assert.equal(redirect.headers.get("location"), target);
      const hash = new URL(target, config.url).hash.slice(1), at = hash.indexOf("?");
      const route = decodeURIComponent(at < 0 ? hash : hash.slice(0, at)), query = new URLSearchParams(at < 0 ? "" : hash.slice(at + 1));
      const selected = query.get("media");
      if (!selected) continue;
      const full = route + "/" + selected;
      const head = await fetch(config.url + "/api/media?" + new URLSearchParams({ p: full }), { method: "HEAD", signal: AbortSignal.timeout(30000) });
      if (head.status === 404) missing++; else { assert.equal(head.status, 200); valid++; }
    }
    result.shortLinks = { mapped: Object.keys(config.shortLinks).length, valid, missing };
    result.stage = "public-read-local-admin";
    for (const host of config.allowedHosts.filter((h) => !config.localHosts.includes(h))) {
      assert.equal(await hostRequest(host, "http://" + host), 200);
      assert.equal(await hostRequest(host, "http://" + host, "POST"), 403);
    }
    assert.equal(await hostRequest("untrusted.example.invalid", null), 403);
    assert.equal(await hostRequest(new URL(config.url).host, "https://untrusted.example.invalid"), 403);
    result.checks.publicHostOriginAndLocalAdmin = true;
    result.stage = "runtime";
    const state = await api("status");
    assert.equal(state.sourceWriteAttempts, 0); assert.ok(state.managerPid > 0);
    assert.equal(state.deployment, "staging"); assert.equal(state.scan.state, "READY");
    result.sourceWriteAttempts = state.sourceWriteAttempts;
    result.generationId = state.loadedGenerationId;
    result.state = "PASS"; result.stage = "complete";
  } catch (error) { result.state = "FAIL"; result.code = /^[A-Z0-9_]+$/.test(error.code || "") ? error.code : "ACCEPTANCE_FAILED"; }
  result.finishedAtMs = Date.now();
  writeJson(path.join(config.reportsRoot, "production-acceptance.json"), result);
  console.log(JSON.stringify(result)); if (result.state !== "PASS") process.exitCode = 1;
}
main().catch(() => { console.error("ACCEPTANCE_FAILED"); process.exitCode = 1; });
