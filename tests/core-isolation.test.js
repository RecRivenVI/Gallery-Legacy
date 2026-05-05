"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

test("filesystem observer remains generic, read-only, and independent from Catalog/Adapter/rules", () => {
  const observer = source("internal/library/observer.js");
  assert.doesNotMatch(
    observer,
    /better-sqlite3|catalog-next|adapterForPlatform|adaptJson|getEffectiveRules|gallery-rules|server\.js|electron|venera/i,
  );
  assert.doesNotMatch(
    observer,
    /writeFile|appendFile|rename|unlink|rmSync|mkdir|chmod|utimes|watch\(/,
  );
  assert.doesNotMatch(
    observer,
    /illust_ai_type|retweeted_status|postTags|fanclub_user_id|longText|tweet_id|platformId\s*===/,
  );
  assert.match(observer, /lstatSync/);
  assert.match(observer, /readdirSync/);
  assert.match(observer, /readFileSync/);
});

test("Writer accepts prepared physical facts without filesystem access or platform metadata hardcoding", () => {
  const writer = source("internal/catalog/writer.js");
  assert.doesNotMatch(
    writer,
    /require\(["']node:fs|observePlatform|adapterForPlatform|reconcileMedia|getEffectiveRules|illust_ai_type|retweeted_status|postTags|fanclub_user_id/i,
  );
  assert.match(writer, /relative_path_key/);
  assert.match(writer, /media_declarations/);
  assert.doesNotMatch(
    writer,
    /filesystem_source_present|metadata_source_present/,
  );
});

test("Formal runtime uses the single streaming builder and published generation", () => {
  const builder = source("internal/indexing/build.js"),
    runtime = source("internal/runtime/bootstrap.js");
  assert.match(builder, /observePlatformWorksStreaming/);
  assert.match(runtime, /resolveActiveGeneration/);
  assert.doesNotMatch(runtime, /tests\/|Gallery\/|preview/);
});

test("actual media and metadata declarations are structurally separate across schema and Adapter contract", () => {
  const schema = source("internal/catalog/schema.js");
  const adapter = source("internal/metadata/contract.js");
  assert.match(schema, /CREATE TABLE media \(/);
  assert.match(schema, /CREATE TABLE media_declarations \(/);
  assert.match(adapter, /mediaDeclarations/);
  assert.doesNotMatch(
    schema,
    /filesystem_source_present|metadata_source_present/,
  );
});
