"use strict";

const fs = require("node:fs");
const path = require("node:path");

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative))
  );
}
function overlap(a, b) {
  return inside(a, b) || inside(b, a);
}
function physicalPath(target) {
  let current = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  if (fs.existsSync(current)) current = fs.realpathSync.native(current);
  return path.resolve(current, ...suffix);
}
function noLinks(target) {
  let current = path.resolve(target);
  for (;;) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw Object.assign(new Error("Reparse paths are not allowed"), {
          code: "PATH_REPARSE",
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
module.exports = { inside, overlap, physicalPath, noLinks };
