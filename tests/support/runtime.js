"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { sources } = require("./sources.js");
const { normalizeRuntimeConfig, ensureLayout } = require("../../internal/instance/config.js");
const { buildGeneration, publishGeneration } = require("../../internal/publication/generations.js");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=", "base64");
const FETCH_BLOCKED_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
async function freePort({ createServer = () => net.createServer() } = {}) {
  // Windows may allocate a low ephemeral port that Fetch/Chromium refuses
  // (for example 6000 or 10080). Other non-privileged low ports remain valid.
  for (let attempt = 0; attempt < 32; attempt++) {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    if (port >= 1024 && !FETCH_BLOCKED_PORTS.has(port)) return port;
  }
  throw new Error("No browser-safe ephemeral port available");
}
async function fixture(t, { empty = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-test-"));
  const cleanup = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const bindings = sources(path.join(root, "sources"));
  for (const p of Object.values(bindings)) fs.mkdirSync(p, { recursive: true });
  const config = normalizeRuntimeConfig({ instanceRoot: path.join(root, "instance"), sources: bindings, port: await freePort() });
  ensureLayout(config);
  fs.writeFileSync(path.join(config.instanceRoot, "config.json"), JSON.stringify({ instanceRoot: config.instanceRoot, sources: bindings, port: config.port }));
  function work(name, metadata, files = { "1.png": PNG }, author = "100", platform = "pixiv") {
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
  async function build(id = "first", options = {}) { return await buildGeneration({ instanceRoot: config.instanceRoot, generationId: id, catalogOptions: { platformRoots: bindings, nestedSampleLimit: 8, ...options } }); }
  function publish(id = "first") { return publishGeneration(config.instanceRoot, id); }
  return { root, config, bindings, work, build, publish, PNG, cleanup };
}
module.exports = { fixture, freePort, PNG };
