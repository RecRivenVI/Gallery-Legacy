"use strict";

const { executeCatalogBuild } = require("./engine.js");
const { scanPlatforms } = require("./scope.js");

async function updateCatalog(options = {}) {
  scanPlatforms(options);
  if (!options.baseCatalogPath) {
    throw new TypeError("Incremental Catalog update requires baseCatalogPath");
  }
  return executeCatalogBuild({ ...options, strategy: "incremental" });
}

module.exports = { updateCatalog };
