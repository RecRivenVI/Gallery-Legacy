"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? files(path.join(dir, e.name))
        : [path.join(dir, e.name)],
    );
}
test("formal modules have one public source tree and no reverse dependency on tooling", () => {
  for (const file of files(path.join(root, "internal")).filter((f) =>
    f.endsWith(".js"),
  )) {
    for (const m of fs
      .readFileSync(file, "utf8")
      .matchAll(/require\(["']([^"']+)["']\)/g)) {
      const dependency = m[1];
      if (!dependency.startsWith(".")) {
        assert.ok(
          dependency.startsWith("node:") ||
            ["path", "better-sqlite3", "ws"].includes(dependency),
        );
        continue;
      }
      const target = path.resolve(path.dirname(file), dependency),
        relative = path.relative(root, target).replace(/\\/g, "/");
      assert.ok(
        relative.startsWith("internal/") ||
          relative.startsWith("protocol/") ||
          relative === "config/runtime.schema.json",
        relative,
      );
      assert.equal(fs.existsSync(target), true, relative);
    }
  }
  for (const area of ["frontend", "desktop"]) {
    for (const file of files(path.join(root, area)).filter((f) =>
      f.endsWith(".js"),
    )) {
      const source = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(
        source,
        /require\(["'].*internal\/|from ["'].*internal\/|better-sqlite3|SELECT .*FROM/,
      );
    }
  }
});
test("raw platform field knowledge cannot leak into generic production layers", () => {
  const forbidden =
    /\billust_ai_type\b|\bretweeted_status\b|\bpostTags\b|\bfanclub_user_id\b|\blongText\b|\btweet_id\b/;
  for (const area of [
    "library",
    "media",
    "catalog",
    "indexing",
    "search",
    "server",
    "runtime",
    "publication",
  ]) {
    for (const file of files(path.join(root, "internal", area)).filter((f) =>
      f.endsWith(".js"),
    )) {
      const source = fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      assert.doesNotMatch(source, forbidden, path.relative(root, file));
    }
  }
  assert.match("metadata.tweet_id", forbidden);
});
test("public corpus is synthetic, URLs use reserved domains, and all samples have snapshots", () => {
  const c = require("../fixtures/metadata/corpus.json"),
    s = require("../fixtures/metadata/shapes.json");
  assert.equal(c.synthetic, true);
  assert.equal(c.cases.length, 35);
  assert.equal(s.hashes.length, c.cases.length);
  for (const file of files(path.join(root, "fixtures"))) {
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      text,
      /[A-Za-z]:[\\\\/](?:Users|Gallery)|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|refresh_token|session_secret|password_hash/i,
    );
    for (const match of text.matchAll(/https?:\/\/([^\s"<>/\\]+)/g))
      assert.ok(
        /example\.(invalid|test|com)$/.test(match[1]),
        path.relative(root, file),
      );
  }
});
test("every current test is active; CLI help is thin and does not start a service", () => {
  const runner = fs.readFileSync(path.join(root, "tools/test.js"), "utf8");
  assert.doesNotMatch(runner, /obsolete\.has|excludeFiles|manifest\.obsolete/);
  const output = execFileSync(
    process.execPath,
    [path.join(root, "cmd/gallery/main.js"), "--help"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.match(output, /Gallery: serve/);
  assert.doesNotMatch(output, /"event":"ready"/);
});
