"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), vm = require("node:vm");
const { fixture } = require("../support/runtime.js");
const { normalizeRuntimeConfig } = require("../../internal/instance/config.js");
const { createRuntimeBootstrap } = require("../../internal/runtime/bootstrap.js");
async function start(f, config = f.config) { const r = createRuntimeBootstrap({ config }); f.cleanup.push(() => r.close()); await r.start(); return r; }
function hostRequest(port, host, route, { origin, method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: route, method, headers: { Host: host, ...(origin ? { Origin: origin } : {}), ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}) } }, (res) => {
      let data = ""; res.on("data", (b) => data += b); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }); req.on("error", reject); req.end(body);
  });
}
test("explicit production Host/Origin permits reads but never grants public or proxied admin", async (t) => {
  const f = await fixture(t); await f.build(); f.publish();
  const host = "gallery.example.invalid:" + f.config.port, origin = "http://" + host;
  const config = normalizeRuntimeConfig({ ...f.config, mode: "public", host: "0.0.0.0", allowedHosts: [host], allowedOrigins: [origin, f.config.url], publicUrl: origin });
  await start(f, config);
  assert.equal((await hostRequest(config.port, host, "/api/v1/works", { origin })).status, 200);
  assert.equal((await hostRequest(config.port, "localhost:" + config.port, "/api/v1/works")).status, 200);
  assert.equal((await hostRequest(config.port, "attacker.invalid", "/api/v1/health")).status, 403);
  assert.equal((await hostRequest(config.port, host, "/api/v1/works", { origin: "https://attacker.invalid" })).status, 403);
  for (const h of [host, "localhost:" + config.port]) {
    const response = await hostRequest(config.port, h, "/api/v1/scans", { method: "POST", body: JSON.stringify({ confirmReadOnly: true }) });
    assert.equal(response.status, 403); assert.match(response.body, /LOCAL_CONTROL_REQUIRED/);
  }
  const crossOrigin = await hostRequest(config.port, "localhost:" + config.port, "/api/v1/works", { origin });
  assert.equal(crossOrigin.headers["access-control-allow-origin"], origin);
  assert.equal(JSON.parse((await hostRequest(config.port, host, "/api/v1/status")).body).data.localControl, false);
});
test("configured file browser is read-only, naturally ordered and blocks traversal, links and non-media", async (t) => {
  const f = await fixture(t); await f.build(); f.publish();
  const fileRoot = path.join(f.root, "files"), outside = path.join(f.root, "outside"); fs.mkdirSync(fileRoot); fs.mkdirSync(outside);
  for (const n of ["10.png", "2.png", "1.png"]) fs.writeFileSync(path.join(fileRoot, n), f.PNG);
  fs.writeFileSync(path.join(fileRoot, "metadata.json"), "private synthetic text");
  fs.symlinkSync(outside, path.join(fileRoot, "link"), "junction");
  const config = normalizeRuntimeConfig({ ...f.config, fileBrowserRoots: [{ id: "files", path: fileRoot }] });
  await start(f, config);
  const list = await (await fetch(config.url + "/api/v1/files?root=files")).json();
  assert.deepEqual(list.data.items.map((x) => x.name), ["1.png", "2.png", "10.png"]);
  assert.equal(list.data.diagnostics.length, 1);
  assert.ok(!JSON.stringify(list).includes(fileRoot));
  const media = list.data.media[0];
  assert.equal((await fetch(config.url + media.url, { method: "HEAD" })).status, 200);
  const range = await fetch(config.url + media.url, { headers: { Range: "bytes=0-3" } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 4);
  for (const p of ["../outside", "C:/outside", "1.png:stream", "link", "..\\outside"]) {
    assert.ok((await fetch(config.url + "/api/v1/files?root=files&path=" + encodeURIComponent(p))).status >= 400);
  }
  assert.equal((await fetch(config.url + "/api/v1/file-media?root=files&path=metadata.json")).status, 404);
  assert.equal((await fetch(config.url + "/api/v1/files?root=unknown")).status, 404);
  assert.equal((await fetch(config.url + "/api/v1/files?root=files", { method: "DELETE" })).status, 404);
});
test("Venera installed favorites and source update survive generation-local integer changes", async (t) => {
  const f = await fixture(t, { empty: true });
  f.work("chapter 2", undefined, { "10.jpg": f.PNG, "2.jpg": f.PNG, "1.jpg": f.PNG }, "Book", "Venera");
  await f.build(); f.publish(); let r = await start(f);
  const stable = "/p/Venera/Book/chapter 2";
  const sourceText = await (await fetch(f.config.url + "/venera-source.js")).text();
  const Source = vm.runInNewContext(sourceText + ";LocalGallery", { ComicSource: class { loadSetting() { return f.config.url; } }, fetch, URLSearchParams });
  const client = new Source();
  assert.equal(client.key, "local_gallery"); assert.ok(client.version !== "10.3.0");
  const list = await client.categoryComics.load("Venera", null, [], 1);
  assert.equal(list.comics[0].id, stable);
  assert.equal((await client.comic.loadInfo(stable)).title, "Book");
  assert.equal((await client.comic.loadEp(stable, stable)).images.length, 3);
  const legacy = await (await fetch(f.config.url + "/api/list?p=" + encodeURIComponent(stable))).json();
  assert.deepEqual(legacy.items.map((m) => m.name), ["1.jpg", "2.jpg", "10.jpg"]);
  const oldDetails = await (await fetch(f.config.url + "/api/db-entry?p=" + encodeURIComponent(stable))).json();
  assert.equal(oldDetails.item.parentPath + "/" + oldDetails.item.name, stable);
  assert.equal((await fetch(f.config.url + "/api/media?p=" + encodeURIComponent(stable + "/1.jpg"), { method: "HEAD" })).status, 200);
  const before = await (await fetch(f.config.url + "/api/v1/resolve?path=" + encodeURIComponent(stable))).json();
  f.work("000", undefined, { "1.png": f.PNG }, "A", "Venera");
  await f.build("next"); f.publish("next"); await r.close(); r = await start(f);
  const after = await (await fetch(f.config.url + "/api/v1/resolve?path=" + encodeURIComponent(stable))).json();
  assert.notEqual(before.data.item.id, after.data.item.id);
  assert.equal(after.data.item.stableId, stable);
  assert.equal((await client.comic.loadEp(stable, stable)).images.length, 3);
});
test("private shortcode targets are local redirects, never public config or open redirects", async (t) => {
  const f = await fixture(t); await f.build(); f.publish();
  await start(f, normalizeRuntimeConfig({ ...f.config, shortLinks: { sample: "/#/p/pixiv/100/2026-01-01_00-00-00_1?media=1.png" } }));
  const res = await fetch(f.config.url + "/s/sample", { redirect: "manual" });
  assert.equal(res.status, 302); assert.match(res.headers.get("location"), /^\/#\/p\//);
  assert.equal((await fetch(f.config.url + "/s/missing")).status, 404);
  assert.equal((await fetch(f.config.url + "/s/toString")).status, 404);
  assert.throws(() => normalizeRuntimeConfig({ ...f.config, shortLinks: { x: "https://attacker.invalid" } }));
  assert.throws(() => normalizeRuntimeConfig({ ...f.config, shortLinks: { x: "/\\attacker.invalid" } }));
});
