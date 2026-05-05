"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { noLinks } = require("../library/io-paths.js");
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw Object.assign(new Error("Invalid state file"), {
      code: "STATE_INVALID",
    });
  }
}
function writeJson(file, value, hooks = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file))
    throw new TypeError("JSON output must be an absolute path");
  noLinks(path.dirname(file));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp =
    file +
    "." +
    process.pid +
    "." +
    crypto.randomBytes(6).toString("hex") +
    ".tmp";
  let fd;
  try {
    const text = JSON.stringify(value, null, 2) + "\n";
    if (hooks.writeFile) {
      hooks.writeFile(tmp, text);
      fd = fs.openSync(tmp, "r+");
    } else {
      fd = fs.openSync(tmp, "wx");
      fs.writeFileSync(fd, text);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    (hooks.rename || fs.renameSync)(tmp, file);
  } finally {
    if (fd != null) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
module.exports = { readJson, writeJson };
