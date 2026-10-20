"use strict";
// Copies source bindings only. No production database/config/state/cache is moved.
const fs = require("node:fs"),
  path = require("node:path"),
  { prepare } = require("./prepare.cjs");
async function prepareProductionTrial({
  sourceConfig,
  root,
  port = 18250,
  listingSource = "filesystem",
}) {
  const value = JSON.parse(fs.readFileSync(sourceConfig));
  if (!value.sources || Object.keys(value.sources).length !== 9)
    throw Error("NINE_SOURCE_BINDINGS_REQUIRED");
  const trial = await prepare(root, {
    productionSources: value.sources,
    port,
    listingSource,
  });
  return {
    configPath: path.join(trial.config.instanceRoot, "config.json"),
    instanceRoot: trial.config.instanceRoot,
    testOnly: true,
    sourceCount: 9,
  };
}
module.exports = { prepareProductionTrial };
if (require.main === module) {
  const [sourceConfig, root] = process.argv.slice(2);
  if (!sourceConfig || !root)
    throw Error("SOURCE_CONFIG_AND_NEW_ROOT_REQUIRED");
  const option = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? fallback : process.argv[i + 1];
  };
  prepareProductionTrial({
    sourceConfig,
    root,
    port: Number(option("--port", 18250)),
    listingSource: option("--listing-source", "filesystem"),
  })
    .then((v) => console.log(JSON.stringify(v)))
    .catch(() => {
      console.error("TRIAL_PREPARATION_FAILED");
      process.exitCode = 1;
    });
}
