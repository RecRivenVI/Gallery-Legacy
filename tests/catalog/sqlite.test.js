"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("../support/sqlite.js").Database;

const bindingPackage = require("../support/sqlite.js").packageInfo;
const {
  configureCatalogConnection,
} = require("../../internal/catalog/schema.js");

test("当前better-sqlite3与SQLite runtime能力实测", () => {
  assert.equal(bindingPackage.version, "12.11.1");
  const db = new Database(":memory:");
  try {
    const sqliteVersion = db
      .prepare("SELECT sqlite_version() AS version")
      .get().version;
    assert.equal(sqliteVersion, "3.53.2");
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.doesNotThrow(() =>
      db.exec(
        "CREATE TABLE partial_probe(a INTEGER,b INTEGER); CREATE INDEX partial_probe_idx ON partial_probe(a) WHERE b=1",
      ),
    );
    assert.doesNotThrow(() =>
      db.exec(
        "CREATE TABLE generated_probe(a INTEGER,b INTEGER GENERATED ALWAYS AS (a+1) STORED)",
      ),
    );
    assert.doesNotThrow(() =>
      db.exec("CREATE TABLE strict_probe(a INTEGER) STRICT"),
    );
    assert.doesNotThrow(() =>
      db.exec("CREATE VIRTUAL TABLE fts_probe USING fts5(body)"),
    );
    assert.ok(
      db
        .pragma("compile_options")
        .some((row) => row.compile_options === "ENABLE_FTS5"),
    );
  } finally {
    db.close();
  }
});

test("Catalog连接强制safe integer模式并无损round-trip int64 mtime_ns", () => {
  const exact = 1700000000123456789n;
  const unsafeDb = new Database(":memory:");
  try {
    unsafeDb.exec("CREATE TABLE values_probe(value INTEGER)");
    unsafeDb.prepare("INSERT INTO values_probe(value) VALUES (?)").run(exact);
    const unsafe = unsafeDb
      .prepare("SELECT value FROM values_probe")
      .get().value;
    assert.equal(typeof unsafe, "number");
    assert.notEqual(
      BigInt(unsafe),
      exact,
      "默认Number读取必须被证明会损失精度",
    );
  } finally {
    unsafeDb.close();
  }

  const db = configureCatalogConnection(new Database(":memory:"));
  try {
    db.exec("CREATE TABLE values_probe(value INTEGER)");
    db.prepare("INSERT INTO values_probe(value) VALUES (?)").run(exact);
    const value = db.prepare("SELECT value FROM values_probe").get().value;
    assert.equal(typeof value, "bigint");
    assert.equal(value, exact);
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1n);
  } finally {
    db.close();
  }
});
