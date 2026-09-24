"use strict";

const {
  RUNTIME_BACKEND_IDENTITY,
  emptyMediaStats,
  executeCatalogBuild,
  sourceCollisionStats,
} = require("./engine.js");

async function buildCatalog(options = {}) {
  if (options.baseCatalogPath) {
    throw new TypeError("Full Catalog build cannot use a baseline");
  }
  return executeCatalogBuild({ ...options, strategy: "full", mode: "full" });
}

module.exports = {
  RUNTIME_BACKEND_IDENTITY,
  buildCatalog,
  emptyMediaStats,
  sourceCollisionStats,
};
