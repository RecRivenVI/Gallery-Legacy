"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { spawn } = require("node:child_process"),
  Database = require("better-sqlite3");
const { fixture } = require("../support/runtime.js");
const {
  finalizeSqliteFile,
} = require("../../internal/publication/generations.js");
test("crashed writer leaves committed WAL; finalization recovers all committed contents", async (t) => {
  const f = await fixture(t, { empty: true }),
    file = path.join(f.config.tempRoot, "crashed.sqlite");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const Database=require('better-sqlite3');const db=new Database(process.argv[1]);db.pragma('journal_mode=WAL');db.pragma('wal_autocheckpoint=0');db.exec("CREATE TABLE sample(v TEXT); INSERT INTO sample VALUES('synthetic')");console.log('ready');setInterval(()=>{},1000);`,
      file,
    ],
    {
      cwd: path.resolve(__dirname, "../.."),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    },
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("writer exited before signal")));
    child.stdout.once("data", resolve);
  });
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
  });
  assert.ok(fs.statSync(file + "-wal").size > 0);
  finalizeSqliteFile(file);
  const db = new Database(file, { readonly: true });
  try {
    assert.equal(db.prepare("SELECT v FROM sample").get().v, "synthetic");
  } finally {
    db.close();
  }
  for (const suffix of ["-wal", "-shm", "-journal"])
    assert.equal(fs.existsSync(file + suffix), false);
});
