"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const { ROOT, REPO, PORTS, assertConfig, environment } = require("./paths.cjs");
const env = environment();
for (const [k, v] of Object.entries(env))
  if (
    [
      "TEMP",
      "TMP",
      "APPDATA",
      "LOCALAPPDATA",
      "USERPROFILE",
      "HOME",
      "MAGICK_TEMPORARY_PATH",
      "GALLERY_DEMO_ROOT",
      "GALLERY_ASSETS_ROOT",
      "NODE_OPTIONS",
    ].includes(k)
  )
    process.env[k] = v;
require("./guard.cjs");
const kind = process.argv[2];
if (!["full", "empty"].includes(kind))
  throw new Error("Explicit full or empty instance required");
const file = path.join(ROOT, kind, "instance/config.json");
assertConfig(JSON.parse(fs.readFileSync(file)));
process.argv = [
  process.execPath,
  path.join(REPO, "bin/gallery.cjs"),
  "serve",
  "--config",
  file,
];
require(path.join(REPO, "bin/gallery.cjs"))
  .main()
  .catch((e) => {
    console.error(e.code || e.message);
    process.exitCode = 1;
  });
