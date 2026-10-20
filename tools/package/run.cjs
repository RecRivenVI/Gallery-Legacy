"use strict";
// A portable Windows staging distribution; no installer, updater or service.
const fs = require("node:fs"),
  path = require("node:path");
const { noLinks, overlap } = require("../../src/library/io-paths.js");
const { readRuntimeConfig } = require("../../src/instance/config.js");
function option(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
}
const root = path.resolve(__dirname, "../..");
const localFile = path.join(root, "tools/build/paths.local.json");
const local = fs.existsSync(localFile)
  ? JSON.parse(fs.readFileSync(localFile))
  : {};
const built = process.env.GALLERY_BUILD_ROOT || local.output;
if (!built || !path.isAbsolute(built))
  throw Error("Choose the external build in tools/build/paths.local.json");
const output = option("--out"),
  configPath = option("--config");
const nodeLicense =
  option("--node-license") ||
  path.join(path.dirname(process.execPath), "LICENSE");
if (!fs.existsSync(nodeLicense))
  throw new Error("Provide --node-license from the same official Node release");
if (!output || !path.isAbsolute(output))
  throw new Error("Explicit absolute --out required");
const out = path.resolve(output);
noLinks(out);
if (
  fs.existsSync(out) ||
  overlap(out, built) ||
  overlap(out, path.join(root, "internal"))
)
  throw new Error("Package output must be a new independent directory");
let config = null;
if (configPath) {
  config = readRuntimeConfig(path.resolve(configPath));
  if (
    config.protectedRoots.some((p) => overlap(out, p.physicalRoot)) ||
    overlap(out, config.instanceRoot)
  )
    throw new Error("Package overlaps source/instance");
}
if (!fs.existsSync(path.join(built, "node_modules/better-sqlite3")))
  throw new Error("Run npm run build first");
const electronDist = path.dirname(require("electron"));
fs.cpSync(electronDist, out, {
  recursive: true,
  filter: (file) => path.basename(file) !== "default_app.asar",
});
fs.renameSync(path.join(out, "electron.exe"), path.join(out, "Gallery.exe"));
fs.cpSync(built, path.join(out, "resources/runtime"), { recursive: true });
fs.mkdirSync(path.join(out, "resources/node"), { recursive: true });
fs.copyFileSync(process.execPath, path.join(out, "resources/node/node.exe"));
fs.copyFileSync(nodeLicense, path.join(out, "resources/node/LICENSE"));
fs.mkdirSync(path.join(out, "resources/app"), { recursive: true });
fs.writeFileSync(
  path.join(out, "resources/app/package.json"),
  JSON.stringify({
    name: require("../../package.json").name,
    productName: "Gallery",
    version: require("../../package.json").version,
    main: "../runtime/src/desktop/main.js",
  }),
);
if (config)
  fs.writeFileSync(
    path.join(out, "gallery.instance.json"),
    JSON.stringify({ configPath: path.resolve(configPath) }, null, 2),
  );
console.log(
  JSON.stringify({
    state: "PACKAGED",
    executable: path.join(out, "Gallery.exe"),
    node: process.version,
    electron: require("electron/package.json").version,
    configAttached: !!config,
  }),
);
