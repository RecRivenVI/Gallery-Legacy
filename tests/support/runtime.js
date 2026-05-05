"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { sources } = require("./sources.js");
const { normalizeRuntimeConfig, ensureLayout } = require("../../internal/instance/config.js");
const { buildGeneration, publishGeneration } = require("../../internal/publication/generations.js");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=", "base64");
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function fixture(t, { empty = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-test-"));
  const cleanup = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const bindings = sources(path.join(root, "sources"));
  for (const p of Object.values(bindings)) fs.mkdirSync(p, { recursive: true });
  const config = normalizeRuntimeConfig({ instanceRoot: path.join(root, "instance"), sources: bindings, port: await freePort() });
  ensureLayout(config);
  fs.writeFileSync(path.join(config.instanceRoot, "config.json"), JSON.stringify({ instanceRoot: config.instanceRoot, sources: bindings, port: config.port }));
  function work(name, metadata, files = { "cover.png": PNG }, author = "100", platform = "pixiv") {
    const dir = path.join(bindings[platform], author, name); fs.mkdirSync(dir, { recursive: true });
    if (metadata !== undefined) fs.writeFileSync(path.join(dir, "metadata.json"), typeof metadata === "string" ? metadata : JSON.stringify(metadata));
    for (const [file, value] of Object.entries(files)) { const dest = path.join(dir, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, value); }
    return dir;
  }
  if (!empty) {
    work("2026-01-01_00-00-00_1", { id: "same", title: "Alpha", user: { id: "100", name: "Sample author" }, caption: "<p>正文仅有短词 鱼猫 🧪</p>", tags: ["R-18", "Fixture"] });
    work("2026-01-02_00-00-00_2", { id: "same", title: "Beta R-18 title only", user: { id: "100", name: "Sample author" }, tags: ["Fixture"] }, { "clip.webm": "synthetic video bytes", "other.jpg": PNG });
    work("2026-01-03_00-00-00_3", "{", { "nested/file.PNG": PNG });
    work("2026-01-04_00-00-00_4", undefined);
    work("2026-01-05_00-00-00_5", "[]");
    work("freeform", { title: "Gamma", user: { name: "Empty IDs" } }, { "only.webm": "synthetic video bytes" }, "freeform-author");
  }
  function build(id = "first", options = {}) { return buildGeneration({ instanceRoot: config.instanceRoot, generationId: id, catalogOptions: { platformRoots: bindings, nestedSampleLimit: 8, ...options } }); }
  function publish(id = "first") { return publishGeneration(config.instanceRoot, id); }
  return { root, config, bindings, work, build, publish, PNG, cleanup };
}
module.exports = { fixture, freePort, PNG };
