"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { physicalPath } = require("./io-paths.js");

const BLOCK_CODE = "WRITE_OUTSIDE_INSTANCE_BLOCKED";

function pathValue(value) {
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString();
  return typeof value === "string" ? value : null;
}

function writeFlags(flags) {
  if (typeof flags === "number") {
    const mask =
      fs.constants.O_WRONLY |
      fs.constants.O_RDWR |
      fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC;
    return (flags & mask) !== 0;
  }
  return /[wa+]/.test(String(flags || "r"));
}

function installWriteGuard({
  instanceRoot,
  protectedRoots = [],
  auditPath = null,
} = {}) {
  if (typeof instanceRoot !== "string" || !path.isAbsolute(instanceRoot))
    throw new TypeError("Gallery firewall requires an absolute instanceRoot");
  const root = physicalPath(instanceRoot);
  const protectedResolved = protectedRoots.map((value) =>
    physicalPath(typeof value === "string" ? value : value.physicalRoot),
  );
  const originals = new Map();
  const fdPaths = new Map();
  const blocked = [];
  let restored = false;

  const originalMkdirSync = fs.mkdirSync.bind(fs);
  const originalAppendFileSync = fs.appendFileSync.bind(fs);
  if (auditPath)
    originalMkdirSync(path.dirname(auditPath), { recursive: true });

  function resolvedPath(value) {
    if (typeof value === "number") return fdPaths.get(value) || null;
    const text = pathValue(value);
    if (text === null) return null;
    return physicalPath(text);
  }

  function inside(target) {
    const relative = path.relative(root, target);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  }

  function record(operation, targets) {
    const item = {
      code: BLOCK_CODE,
      operation,
      targetCount: targets.length,
      protectedRootHit: targets.some((target) =>
        protectedResolved.some((protectedRoot) => {
          const relative = path.relative(protectedRoot, target);
          return (
            relative === "" ||
            (!relative.startsWith("..") && !path.isAbsolute(relative))
          );
        }),
      ),
      at: new Date().toISOString(),
    };
    blocked.push(item);
    if (auditPath)
      originalAppendFileSync(auditPath, JSON.stringify(item) + "\n", "utf8");
    const error = new Error(`${BLOCK_CODE}: ${operation}`);
    error.code = BLOCK_CODE;
    error.details = item;
    throw error;
  }

  function assertTargets(operation, values) {
    const targets = values.map(resolvedPath).filter(Boolean);
    if (
      targets.length !== values.length ||
      targets.some(
        (target) =>
          !inside(target) ||
          protectedResolved.some((source) => {
            const r = path.relative(source, target);
            return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
          }),
      )
    )
      record(operation, targets.length ? targets : ["<non-path>"]);
    return targets;
  }

  function remember(object, name) {
    if (!originals.has(object)) originals.set(object, new Map());
    originals.get(object).set(name, object[name]);
  }

  function patch(object, name, wrapper) {
    if (typeof object[name] !== "function") return;
    remember(object, name);
    object[name] = wrapper(object[name].bind(object));
  }

  for (const name of [
    "writeFile",
    "appendFile",
    "truncate",
    "chmod",
    "chown",
    "utimes",
    "unlink",
    "rm",
    "rmdir",
    "mkdir",
    "mkdtemp",
  ]) {
    patch(
      fs,
      name,
      (original) =>
        function patchedPathMutation(target, ...args) {
          assertTargets(`fs.${name}`, [target]);
          return original(target, ...args);
        },
    );
  }
  for (const name of [
    "writeFileSync",
    "appendFileSync",
    "truncateSync",
    "chmodSync",
    "chownSync",
    "utimesSync",
    "unlinkSync",
    "rmSync",
    "rmdirSync",
    "mkdirSync",
    "mkdtempSync",
  ]) {
    patch(
      fs,
      name,
      (original) =>
        function patchedPathMutationSync(target, ...args) {
          assertTargets(`fs.${name}`, [target]);
          return original(target, ...args);
        },
    );
  }
  for (const name of ["rename", "renameSync"]) {
    patch(
      fs,
      name,
      (original) =>
        function patchedRename(source, destination, ...args) {
          assertTargets(`fs.${name}`, [source, destination]);
          return original(source, destination, ...args);
        },
    );
  }
  for (const name of [
    "copyFile",
    "copyFileSync",
    "cp",
    "cpSync",
    "link",
    "linkSync",
    "symlink",
    "symlinkSync",
  ]) {
    patch(
      fs,
      name,
      (original) =>
        function patchedDestination(source, destination, ...args) {
          assertTargets(
            `fs.${name}`,
            name.includes("link") ? [source, destination] : [destination],
          );
          return original(source, destination, ...args);
        },
    );
  }
  patch(
    fs,
    "createWriteStream",
    (original) =>
      function patchedCreateWriteStream(target, ...args) {
        assertTargets("fs.createWriteStream", [target]);
        return original(target, ...args);
      },
  );

  patch(
    fs,
    "openSync",
    (original) =>
      function patchedOpenSync(target, flags, ...args) {
        const resolved = resolvedPath(target);
        if (writeFlags(flags)) assertTargets("fs.openSync", [target]);
        const fd = original(target, flags, ...args);
        if (resolved) fdPaths.set(fd, resolved);
        return fd;
      },
  );
  patch(
    fs,
    "open",
    (original) =>
      function patchedOpen(target, flags, ...args) {
        const resolved = resolvedPath(target);
        if (writeFlags(flags)) assertTargets("fs.open", [target]);
        const callbackIndex = args.findIndex(
          (value) => typeof value === "function",
        );
        if (callbackIndex >= 0) {
          const callback = args[callbackIndex];
          args[callbackIndex] = function trackedOpen(error, fd, ...rest) {
            if (!error && resolved) fdPaths.set(fd, resolved);
            return callback(error, fd, ...rest);
          };
        }
        return original(target, flags, ...args);
      },
  );
  patch(
    fs,
    "closeSync",
    (original) =>
      function patchedCloseSync(fd, ...args) {
        try {
          return original(fd, ...args);
        } finally {
          fdPaths.delete(fd);
        }
      },
  );
  patch(
    fs,
    "close",
    (original) =>
      function patchedClose(fd, ...args) {
        const callbackIndex = args.findIndex(
          (value) => typeof value === "function",
        );
        if (callbackIndex >= 0) {
          const callback = args[callbackIndex];
          args[callbackIndex] = (...values) => {
            fdPaths.delete(fd);
            return callback(...values);
          };
        }
        return original(fd, ...args);
      },
  );

  for (const name of [
    "ftruncate",
    "fchmod",
    "fchown",
    "futimes",
    "ftruncateSync",
    "fchmodSync",
    "fchownSync",
    "futimesSync",
  ]) {
    patch(
      fs,
      name,
      (original) =>
        function patchedFdMutation(fd, ...args) {
          const target = fdPaths.get(fd);
          if (!target || !inside(target))
            record(`fs.${name}`, [target || `<fd:${fd}>`]);
          return original(fd, ...args);
        },
    );
  }
  for (const name of ["write", "writeSync"]) {
    patch(
      fs,
      name,
      (original) =>
        function patchedFdWrite(fd, ...args) {
          // stdout/stderr may be a console, pipe, or a launcher-redirected file.
          // They are process communication channels, not caller-selected paths.
          if (fd === 1 || fd === 2) return original(fd, ...args);
          const target = fdPaths.get(fd);
          if (!target || !inside(target))
            record(`fs.${name}`, [target || `<fd:${fd}>`]);
          return original(fd, ...args);
        },
    );
  }

  const promises = fs.promises;
  for (const name of [
    "writeFile",
    "appendFile",
    "truncate",
    "chmod",
    "chown",
    "utimes",
    "unlink",
    "rm",
    "rmdir",
    "mkdir",
    "mkdtemp",
  ]) {
    patch(
      promises,
      name,
      (original) =>
        async function patchedPromisePath(target, ...args) {
          assertTargets(`fs.promises.${name}`, [target]);
          return original(target, ...args);
        },
    );
  }
  for (const name of ["rename"]) {
    patch(
      promises,
      name,
      (original) =>
        async function patchedPromiseRename(source, destination, ...args) {
          assertTargets(`fs.promises.${name}`, [source, destination]);
          return original(source, destination, ...args);
        },
    );
  }
  for (const name of ["copyFile", "cp", "link", "symlink"]) {
    patch(
      promises,
      name,
      (original) =>
        async function patchedPromiseDestination(source, destination, ...args) {
          assertTargets(
            `fs.promises.${name}`,
            name.includes("link") ? [source, destination] : [destination],
          );
          return original(source, destination, ...args);
        },
    );
  }
  patch(
    promises,
    "open",
    (original) =>
      async function patchedPromiseOpen(target, flags, ...args) {
        if (writeFlags(flags)) assertTargets("fs.promises.open", [target]);
        const handle = await original(target, flags, ...args);
        const resolved = resolvedPath(target);
        if (resolved) fdPaths.set(handle.fd, resolved);
        return handle;
      },
  );

  function restore() {
    if (restored) return;
    restored = true;
    for (const [object, values] of originals)
      for (const [name, original] of values) object[name] = original;
    fdPaths.clear();
  }

  return Object.freeze({
    code: BLOCK_CODE,
    instanceRoot: root,
    protectedRoots: [...protectedResolved],
    blockedAttempts() {
      return blocked.map((value) => structuredClone(value));
    },
    blockedCount() {
      return blocked.length;
    },
    restore,
  });
}

module.exports = { BLOCK_CODE, installWriteGuard, writeFlags };
