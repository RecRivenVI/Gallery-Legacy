"use strict";

const fs = require("node:fs");
const path = require("node:path");
const contract = require("../../api/catalog.json");
const CATALOG_SCHEMA_VERSION = contract.schemaVersion;
const TABLE_NAMES = Object.freeze(contract.tables);
const INDEX_NAMES = Object.freeze(contract.indexes);
const SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, "../../api/catalog.sql"),
  "utf8",
);

function configureCatalogConnection(db) {
  if (
    !db ||
    typeof db.exec !== "function" ||
    typeof db.pragma !== "function" ||
    typeof db.defaultSafeIntegers !== "function"
  )
    throw new TypeError(
      "Catalog requires a better-sqlite3 Database connection",
    );
  db.defaultSafeIntegers(true);
  db.pragma("foreign_keys = ON");
  const enabled = db.pragma("foreign_keys", { simple: true });
  if (enabled !== 1 && enabled !== 1n)
    throw new Error("Catalog requires SQLite foreign_keys=ON");
  return db;
}

function createCatalogSchema(db) {
  configureCatalogConnection(db);
  db.exec(SCHEMA_SQL);
  return db;
}

module.exports = {
  CATALOG_SCHEMA_VERSION,
  INDEX_NAMES,
  SCHEMA_SQL,
  TABLE_NAMES,
  configureCatalogConnection,
  createCatalogSchema,
};
