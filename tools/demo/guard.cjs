"use strict";
// Additional test-process protection. Product configuration remains unmodified.
const fs = require("node:fs"),
  path = require("node:path"),
  net = require("node:net");
const { ROOT, REPO, OUTPUT, PORTS, within } = require("./paths.cjs");
if (process.env.GALLERY_DEMO_ROOT !== ROOT)
  throw new Error("DEMO_ROOT_REQUIRED");
const readRoots = [
  "src",
  "public",
  "bin",
  "api",
  "node_modules",
  "tools/demo",
].map((p) => path.join(REPO, p));
// Explicit build smoke reads code only from this repository's generated artifact.
// Writable paths and all library sources retain the same sandbox boundary.
if (process.env.GALLERY_DEMO_BUILD_ROOT)
  readRoots.push(path.resolve(process.env.GALLERY_DEMO_BUILD_ROOT));
const readFiles = [
  path.join(REPO, "package.json"),
  path.join(REPO, "package-lock.json"),
  process.env.GALLERY_DEMO_BROWSER_EXE,
]
  .filter(Boolean)
  .map((p) => path.resolve(p));
const originalExists = fs.existsSync.bind(fs),
  originalLstat = fs.lstatSync.bind(fs);
const counters = { readRejected: 0, writeRejected: 0, networkRejected: 0 };
function filename(p) {
  return p instanceof URL
    ? require("node:url").fileURLToPath(p)
    : Buffer.isBuffer(p)
      ? p.toString()
      : p;
}
function check(p, writing = false, metadata = false) {
  p = filename(p);
  if (typeof p === "number" || p === undefined) return;
  if (typeof p !== "string") return;
  if (/^\\\\\.\\pipe\\gallery-[a-f0-9]+$/.test(p)) return;
  const absolute = path.resolve(p);
  const owned = within(ROOT, absolute),
    output = within(OUTPUT, absolute);
  const approvedRead =
    readFiles.includes(absolute) || readRoots.some((r) => within(r, absolute));
  const ancestor =
    metadata && [ROOT, REPO, ...readRoots].some((r) => within(absolute, r));
  if (writing ? !(owned || output) : !(owned || approvedRead || ancestor)) {
    counters[writing ? "writeRejected" : "readRejected"]++;
    throw Object.assign(new Error("Sandbox filesystem boundary"), {
      code: "DEMO_IO_REJECTED",
    });
  }
  if (!metadata && owned) {
    let cur = absolute;
    while (within(ROOT, cur)) {
      if (originalExists(cur) && originalLstat(cur).isSymbolicLink())
        throw Object.assign(new Error("Sandbox link not followed"), {
          code: "DEMO_IO_REJECTED",
        });
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
}
for (const name of [
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "opendir",
  "opendirSync",
  "createReadStream",
  "access",
  "accessSync",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "realpath",
  "realpathSync",
  "existsSync",
]) {
  if (!fs[name]) continue;
  const original = fs[name];
  const metadata = /^(stat|lstat|realpath|access|exists)/.test(name);
  const wrapped = function (p, ...args) {
    check(p, false, metadata);
    return original.call(this, p, ...args);
  };
  if (original.native)
    wrapped.native = function (p, ...args) {
      check(p, false, true);
      return original.native.call(this, p, ...args);
    };
  fs[name] = wrapped;
}
for (const name of [
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "mkdir",
  "mkdirSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "unlink",
  "unlinkSync",
  "chmod",
  "chmodSync",
  "utimes",
  "utimesSync",
  "createWriteStream",
  "truncate",
  "truncateSync",
]) {
  const original = fs[name];
  if (original)
    fs[name] = function (p, ...args) {
      check(p, true);
      return original.call(this, p, ...args);
    };
}
for (const name of [
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "rename",
  "renameSync",
  "link",
  "linkSync",
  "symlink",
  "symlinkSync",
]) {
  const original = fs[name];
  if (original)
    fs[name] = function (a, b, ...args) {
      check(a, /^(rename|link|symlink)/.test(name));
      check(b, true);
      return original.call(this, a, b, ...args);
    };
}
for (const name of ["open", "openSync"]) {
  const original = fs[name];
  fs[name] = function (p, flags, ...args) {
    check(
      p,
      typeof flags === "number" ? flags !== 0 : /[wa+]/.test(String(flags)),
    );
    return original.call(this, p, flags, ...args);
  };
}
for (const name of [
  "readFile",
  "readdir",
  "opendir",
  "stat",
  "lstat",
  "realpath",
  "access",
  "writeFile",
  "appendFile",
  "mkdir",
  "rm",
  "rmdir",
  "unlink",
  "chmod",
  "utimes",
  "truncate",
  "copyFile",
  "rename",
  "open",
]) {
  const original = fs.promises[name];
  if (!original) continue;
  fs.promises[name] = async function (p, ...args) {
    const writing =
      /^(write|append|mkdir|rm|unlink|chmod|utimes|truncate|rename)/.test(name);
    check(p, writing, /^(stat|lstat|realpath|access)/.test(name));
    if (name === "copyFile" || name === "rename") check(args[0], true);
    if (name === "open")
      check(
        p,
        typeof args[0] === "number"
          ? args[0] !== 0
          : /[wa+]/.test(String(args[0])),
      );
    return original.call(this, p, ...args);
  };
}
function network(host, port) {
  if (
    typeof host === "string" &&
    /^\\\\\.\\pipe\\gallery-[a-f0-9]+$/.test(host)
  )
    return;
  const tooling =
    process.env.GALLERY_DEMO_INSTRUMENTATION === "1" &&
    Number(port) >= 1024 &&
    Number(port) !== 8081;
  if (
    !["127.0.0.1", "localhost", "::1", undefined].includes(host) ||
    (port !== undefined &&
      !Object.values(PORTS).includes(Number(port)) &&
      !tooling)
  ) {
    counters.networkRejected++;
    throw Object.assign(new Error("Sandbox network boundary"), {
      code: "DEMO_NETWORK_REJECTED",
    });
  }
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0];
  if (typeof a === "object") network(a.path || a.host, a.port);
  else if (typeof a === "string" && !/^\d+$/.test(a)) network(a);
  else network(typeof args[1] === "string" ? args[1] : undefined, a);
  return connect.apply(this, args);
};
const nativeFetch = global.fetch;
global.fetch = function (input, options) {
  const u = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  network(u.hostname, u.port || (/https:/.test(u.protocol) ? 443 : 80));
  return nativeFetch(input, options);
};
for (const protocol of ["http", "https"]) {
  const mod = require("node:" + protocol);
  for (const name of ["request", "get"]) {
    const original = mod[name];
    mod[name] = function (input, ...args) {
      if (typeof input === "string" || input instanceof URL) {
        const u = new URL(input);
        network(u.hostname, u.port || (protocol === "https" ? 443 : 80));
      } else
        network(
          input.hostname || input.host,
          input.port || (protocol === "https" ? 443 : 80),
        );
      return original.call(this, input, ...args);
    };
  }
}
global.__galleryDemoGuard = counters;
