import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "../.."),
  reference = process.env.GALLERY_NODE_REFERENCE_ROOT || repo;
const { normalizeRuntimeConfig, readRuntimeConfig } = require(
  path.join(reference, "src/instance/config.js"),
);
const candidate = require("../../src/instance/config.js");
function capture(fn) {
  try {
    const expected = { ...fn() };
    delete expected.everything;
    return { expected, code: "" };
  } catch (e) {
    return { expected: null, code: e.code || e.message };
  }
}
const platforms = require("../../api/catalog.json").platforms;
const out = fs.mkdtempSync(
  path.join(process.env.GALLERY_TEST_ROOT || os.tmpdir(), "Config-"),
);
const instance = path.join(out, "Instance"),
  sources = Object.fromEntries(
    platforms.map((p) => [p.id, path.join(out, "Source", p.id)]),
  );
for (const dir of [instance, ...Object.values(sources)])
  fs.mkdirSync(dir, { recursive: true });
const cases = [];
function add(name, patch = {}) {
  const source = { instanceRoot: instance, sources, ...patch };
  assert.deepEqual(
    capture(() => candidate.normalizeRuntimeConfig(source)),
    capture(() => normalizeRuntimeConfig(source)),
    "candidate Node " + name,
  );
  try {
    const expected = { ...normalizeRuntimeConfig(source) };
    // Everything is retired by the current project scope. Neither implementation
    // contacts it here; the remaining Node null property is not a runtime input.
    if (expected.everything !== null)
      throw new Error("fixture enables retired Everything");
    delete expected.everything;
    cases.push({ name, source, expected, code: "" });
  } catch (e) {
    cases.push({ name, source, expected: null, code: e.code || e.message });
  }
}
add("defaults");
add("live", { liveUpdates: true });
add("null live", { liveUpdates: null });
add("string live", { liveUpdates: "true" });
for (const deployment of ["production", "staging", "", null, "bad"])
  add("deployment " + deployment, { deployment });
for (const host of [
  "::1",
  "localhost",
  "0.0.0.0",
  "192.168.5.6",
  "172.16.0.3",
  "172.32.0.3",
  "10.1.2.3",
  "2001:db8::1",
  "::ffff:192.168.5.6",
]) {
  add("local " + host, { host });
  add("lan " + host, { host, mode: "lan" });
  add("public " + host, {
    host,
    mode: "public",
    allowedHosts: ["demo.test:18104"],
  });
}
for (const port of [1, 80, 443, 65535, 0, 65536, 1.5, "18104", null])
  add("port " + port, { port });
add("listenAddress override", { host: "0.0.0.0", listenAddress: "::1" });
for (const value of [
  "Example.TEST:18104",
  "localhost:80",
  "例子.测试:18104",
  "127.1:18104",
  "0x7f000001:18104",
  "[2001:0db8::1]:18104",
  "[::ffff:127.0.0.1]:18104",
  "bad host",
  "user@demo.test",
  "demo.test/path",
  "demo.test:65536",
  "",
  null,
  "demo_test:123",
])
  add("authority " + value, { allowedHosts: [value] });
for (const allowedHosts of [
  null,
  "x",
  [],
  ["demo.test:18104", "demo.test:18104"],
])
  add("hosts " + JSON.stringify(allowedHosts), { allowedHosts });
for (const origin of [
  "http://demo.test:18104",
  "https://demo.test:18104",
  "http://demo.test:18104/",
  "HTTP://demo.test:18104",
  "http://demo.test:18104?x",
  "http://user@demo.test:18104",
  "http://other.test:18104",
])
  add("origin " + origin, {
    allowedHosts: ["demo.test:18104"],
    allowedOrigins: [origin],
    publicUrl: origin,
  });
add("null origins", { allowedOrigins: null });
add("empty origins", { allowedOrigins: [] });
add("wrong origins", { allowedOrigins: "bad" });
add("wrong public URL", { publicUrl: "http://other.test:18104" });
for (const shortLinks of [
  {},
  { hi: "/p/pixiv/虚构/作品" },
  { hi: "//outside" },
  { hi: "/\\outside" },
  { hi: "/a\n" },
  { "bad key": "/a" },
  { hi: 1 },
  [],
  null,
])
  add("shortlinks " + JSON.stringify(shortLinks), { shortLinks });
for (const retention of [
  {},
  { enabled: false },
  { staleAfterMs: 3600000 },
  { staleAfterMs: 3599999 },
  { staleAfterMs: "3600000" },
  { staleAfterMs: 1.1 },
  { staleAfterMs: null },
  null,
])
  add("retention " + JSON.stringify(retention), { retention });
add("no root", { instanceRoot: null });
add("relative root", { instanceRoot: "relative" });
add("direct DB", { catalogPath: "x" });
add("missing sources", { sources: {} });
add("relative source", { sources: { ...sources, pixiv: "relative" } });
add("source inside instance", {
  sources: { ...sources, pixiv: path.join(instance, "input") },
});
add("source overlap", { sources: { ...sources, pixiv: sources.Fantia } });
const file = path.join(out, "Files");
fs.mkdirSync(file);
for (const fileBrowserRoots of [
  [{ id: "files", path: file }],
  [{ id: "files", path: file, name: "合成文件" }],
  null,
  {},
  [{ id: "!", path: file }],
  [{ id: "files", path: instance }],
  [{ id: "files", path: sources.pixiv }],
  [
    { id: "files", path: file },
    { id: "files", path: path.join(out, "OtherFiles") },
  ],
  [
    { id: "one", path: file },
    { id: "two", path: path.join(file, "child") },
  ],
])
  add("files " + JSON.stringify(fileBrowserRoots), { fileBrowserRoots });
for (const key of [
  "generationsRoot",
  "cacheRoot",
  "logsRoot",
  "tempRoot",
  "stateRoot",
  "reportsRoot",
  "desktopDataRoot",
]) {
  add(key + " override", { [key]: path.join(instance, "custom-" + key) });
  add(key + " escape", { [key]: out });
  add(key + " relative", { [key]: "relative" });
}
add("writable overlaps generation", {
  cacheRoot: path.join(instance, "generations", "cache"),
});
add("writable overlap", { cacheRoot: path.join(instance, "state", "cache") });
add("live overlap", {
  liveUpdates: true,
  cacheRoot: path.join(instance, "live", "cache"),
});
add("live overlap wins before writable overlap", {
  liveUpdates: true,
  cacheRoot: path.join(instance, "live/cache"),
  logsRoot: path.join(instance, "live/cache/logs"),
});
const alias = path.join(out, "Alias");
fs.symlinkSync(sources.pixiv, alias, "junction");
add("linked instance", { instanceRoot: alias });
add("linked source", { sources: { ...sources, pixiv: alias } });
fs.symlinkSync(sources.pixiv, path.join(instance, "alias"), "junction");
add("linked cache existing", { cacheRoot: path.join(instance, "alias") });
for (const [name, text] of [
  ["missing", null],
  ["syntax", "{broken"],
  ["null", "null"],
  ["false", "false"],
  ["empty object", "{}"],
  ["array", "[1]"],
  ["empty array", "[]"],
  ["string", '"x"'],
  ["number", "1"],
  ["valid", JSON.stringify({ instanceRoot: instance, sources })],
  [
    "unknown key",
    JSON.stringify({ instanceRoot: instance, sources, extra: true }),
  ],
]) {
  const file = path.join(out, "Load-" + cases.length + ".json");
  if (text !== null) fs.writeFileSync(file, text);
  assert.deepEqual(
    capture(() => candidate.readRuntimeConfig(file)),
    capture(() => readRuntimeConfig(file)),
    "candidate Node load " + name,
  );
  try {
    const expected = { ...readRuntimeConfig(file) };
    delete expected.everything;
    cases.push({ name: "load " + name, file, expected, code: "" });
  } catch (e) {
    if (e.code === "ERR_ASSERTION") throw e;
    cases.push({
      name: "load " + name,
      file,
      expected: null,
      code: e.code || e.message,
    });
  }
}
const golden = path.join(out, "golden.json");
fs.writeFileSync(golden, JSON.stringify(cases, null, 2));
const args = [
  path.join(repo, "tools/go/run.cjs"),
  "test",
  ...(process.argv.includes("--race") ? ["-race"] : []),
  "./internal/instance/...",
  "-run",
  "TestNodeConfiguration",
  "-count=1",
  "-v",
];
const run = spawnSync(process.execPath, args, {
  cwd: repo,
  env: { ...process.env, GALLERY_CONFIG_GOLDEN: golden },
  encoding: "utf8",
});
fs.writeFileSync(path.join(out, "go-test.log"), run.stdout + run.stderr);
fs.writeFileSync(
  path.join(out, "result.json"),
  JSON.stringify(
    {
      conclusion: run.status === 0 ? "一致" : "有差异",
      cases: cases.length,
      reference,
      exitCode: run.status,
    },
    null,
    2,
  ),
);
process.stdout.write(run.stdout + run.stderr);
console.log(out);
process.exitCode = run.status ?? 1;
