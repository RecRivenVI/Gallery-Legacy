"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const root = path.resolve(__dirname, "../..");
function resourceFile(relative, supplied = process.env.GALLERY_ASSETS_ROOT) {
  const localFile = path.join(root, "tools/build/paths.local.json");
  const local =
    !supplied && fs.existsSync(localFile)
      ? JSON.parse(fs.readFileSync(localFile))
      : {};
  const directory = supplied || local.resources || path.join(root, "resources");
  const target = path.resolve(directory, relative);
  if (!target.startsWith(path.resolve(directory) + path.sep)) return null;
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  if (
    relative === "vendor/canvaskit.js" ||
    relative === "vendor/canvaskit.wasm"
  )
    return path.join(
      path.dirname(require.resolve("canvaskit-wasm")),
      path.basename(relative),
    );
  return null;
}
module.exports = { resourceFile };
