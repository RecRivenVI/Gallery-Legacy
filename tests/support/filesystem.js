"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function createTempRoot(t, prefix = "gallery-fs-observation-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFile(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function createWork(root, authorName, workName, options = {}) {
  const workPath = path.join(root, authorName, workName);
  fs.mkdirSync(workPath, { recursive: true });
  if (Object.hasOwn(options, "metadata")) writeFile(path.join(workPath, "metadata.json"), options.metadata);
  for (const [relative, content] of Object.entries(options.files || {})) writeFile(path.join(workPath, ...relative.split("/")), content);
  return workPath;
}

function codeUnitSort(values) {
  return values.slice().sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function treeState(root) {
  const result = [];
  function visit(directory, relativeDirectory = "") {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute, { bigint: true });
      if (stat.isSymbolicLink()) {
        result.push({ relative, type: "symlink", mtimeNs: stat.mtimeNs.toString() });
      } else if (stat.isDirectory()) {
        result.push({ relative, type: "directory", mtimeNs: stat.mtimeNs.toString() });
        visit(absolute, relative);
      } else if (stat.isFile()) {
        result.push({
          relative,
          type: "file",
          size: stat.size.toString(),
          mtimeNs: stat.mtimeNs.toString(),
          sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"),
        });
      }
    }
  }
  visit(root);
  return result;
}

module.exports = { codeUnitSort, createTempRoot, createWork, treeState, writeFile };
