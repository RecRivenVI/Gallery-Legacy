"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..", "internal", "library");

function productionSource() {
  return [
    "observer.js",
    "observation.js",
    "observation-contract.js",
    "observation-source.js",
  ]
    .sort()
    .map((name) => fs.readFileSync(path.join(ROOT, name), "utf8"))
    .join("\n");
}

test("Filesystem Observation只依赖registry、pure path contract和Node只读filesystem", () => {
  const source = productionSource();
  assert.match(source, /platforms\.js/);
  assert.match(source, /paths\.js/);
  assert.match(source, /node:fs/);
  assert.match(source, /node:path/);
  const imports = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map(
    (match) => match[1],
  );
  const forbiddenImport =
    /(?:^|\/)(?:better-sqlite3|catalog-store|catalog-scanner|scan-host|server\.js|electron|frontend|manager|venera)(?:\/|$)|catalog-next\/(?:builder|candidate-file|mapping|queries|schema|validation|writer)\.js$/i;
  assert.deepEqual(
    imports.filter((value) => forbiddenImport.test(value)),
    [],
  );
  assert.doesNotMatch(source, /getEffectiveRules/i);
  assert.doesNotMatch(
    source,
    /require\(["']\.\.\/adapters|adaptJson|adapterForPlatform|metadataShapeForPlatform/i,
  );
  assert.doesNotMatch(source, /[FG]:\\Gallery\\gallery-dl/i);
});

test("生产Observer没有write/watch/hash API且媒体内容唯一read只针对metadata", () => {
  const observer = fs.readFileSync(path.join(ROOT, "observer.js"), "utf8");
  assert.doesNotMatch(
    observer,
    /fs\.(?:writeFile|appendFile|rename|unlink|rm|mkdir|chmod|utimes|watch|createWriteStream)Sync?\b/,
  );
  assert.doesNotMatch(observer, /node:crypto|createHash|\b(?:sha256|md5)\b/i);
  assert.deepEqual(
    [...observer.matchAll(/io\.readFile\(([^)]+)\)/g)].map((match) => match[1]),
    ["absolutePath"],
  );
  assert.match(
    observer,
    /const metadataPath = path\.join\(absoluteWork, "metadata\.json"\)/,
  );
  assert.doesNotMatch(
    observer,
    /Date\.now\(|localeCompare\(|\b(?:watch|cache|memo|tombstone|scanId|publicationRevision)\b/,
  );
});

test("generic filesystem层不含8平台metadata知识或平台特判", () => {
  const source = productionSource()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(
    source,
    /\billust_ai_type\b|\bretweeted_status\b|\bpostTags\b|\bfanclub_user_id\b|\blongText\b|\btweet_id\b/,
  );
  assert.doesNotMatch(
    source,
    /platformId\s*===?\s*["']|switch\s*\(\s*platformId\s*\)/,
  );
});

test("Bridge只搬运observation facts且Builder仍不读取source filesystem", () => {
  const bridge = fs.readFileSync(
    path.join(ROOT, "observation-source.js"),
    "utf8",
  );
  assert.doesNotMatch(
    bridge,
    /require\(["']node:fs|require\(["']\.\.\/adapters|adaptJson|adapterForPlatform|metadataShapeForPlatform|better-sqlite3/i,
  );
  assert.doesNotMatch(
    bridge,
    /JSON\.parse|JSON\.stringify|Date\.now|localeCompare/,
  );
  const builder = fs.readFileSync(
    path.resolve(ROOT, "..", "indexing", "prepare.js"),
    "utf8",
  );
  assert.doesNotMatch(
    builder,
    /require\(["']node:fs["']\)|\b(?:readFile|readdir|stat|lstat|realpath|watch)Sync?\b/,
  );
  assert.doesNotMatch(builder, /filesystem-observation/);
});
