"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const Database = require("better-sqlite3");
const { hashDatabaseFile } = require("../catalog/file-hash.js");
const { noLinks } = require("../library/io-paths.js");

const RUNTIME_SEARCH_INDEX_VERSION = 5;

function decodeEntities(value) {
  return value
    .replace(
      /&(?:amp|lt|gt|quot|apos|#39);/gi,
      (entity) =>
        ({
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
          "&#39;": "'",
        })[entity.toLowerCase()] || " ",
    )
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_match, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      try {
        return Number.isInteger(codePoint) &&
          codePoint >= 0 &&
          codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : " ";
      } catch {
        return " ";
      }
    });
}

function normalizeSearchText(value, maximumCodePoints = null) {
  let text = String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/<[^>]{0,2048}>/g, " ");
  text = decodeEntities(text).toLowerCase().replace(/\s+/g, " ").trim();
  if (maximumCodePoints !== null)
    text = [...text].slice(0, maximumCodePoints).join("");
  return text;
}

function shortGrams(values) {
  const grams = new Set();
  for (const value of values)
    for (const character of normalizeSearchText(value))
      if (character !== " ") grams.add(character);
  return [...grams];
}

function buildSearchIndex({
  catalogPath,
  searchIndexPath,
  reportPath = null,
  log = () => {},
  nowMs = () => Date.now(),
} = {}) {
  if (typeof catalogPath !== "string" || !path.isAbsolute(catalogPath))
    throw new TypeError("catalogPath must be an absolute path");
  if (typeof searchIndexPath !== "string" || !path.isAbsolute(searchIndexPath))
    throw new TypeError("searchIndexPath must be an absolute path");
  if (
    reportPath !== null &&
    (typeof reportPath !== "string" || !path.isAbsolute(reportPath))
  )
    throw new TypeError("reportPath must be an absolute path or null");
  noLinks(searchIndexPath);
  // Search is built once into a new candidate. No rebuild-in-place entry exists.
  if (
    fs.existsSync(searchIndexPath) ||
    ["-wal", "-shm", "-journal"].some((suffix) =>
      fs.existsSync(searchIndexPath + suffix),
    )
  ) {
    throw Object.assign(new Error("Search output already exists"), {
      code: "SEARCH_OUTPUT_EXISTS",
    });
  }
  if (path.resolve(searchIndexPath) === path.resolve(catalogPath))
    throw new TypeError("Catalog and Search paths must differ");
  let catalog = null;
  let search = null;
  const started = performance.now();
  try {
    fs.mkdirSync(path.dirname(searchIndexPath), { recursive: true });
    catalog = new Database(catalogPath, {
      readonly: true,
      fileMustExist: true,
    });
    catalog.defaultSafeIntegers(true);
    search = new Database(searchIndexPath);
    search.defaultSafeIntegers(true);
    search.pragma("journal_mode = DELETE");
    search.pragma("synchronous = NORMAL");
    search.exec(`
      CREATE TABLE index_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        version INTEGER NOT NULL,
        catalog_work_count INTEGER NOT NULL,
        catalog_sha256 TEXT NOT NULL,
        catalog_size INTEGER NOT NULL,
        catalog_mtime_ms INTEGER NOT NULL,
        built_at_ms INTEGER NOT NULL
      );
      CREATE TABLE work_sort (
        work_id INTEGER PRIMARY KEY,
        platform_id TEXT NOT NULL,
        author_id INTEGER NOT NULL,
        published_sort INTEGER NOT NULL,
        title_key TEXT NOT NULL,
        name_key TEXT NOT NULL,
        has_image INTEGER NOT NULL,
        has_video INTEGER NOT NULL
      );
      CREATE TABLE search_docs (
        work_id INTEGER PRIMARY KEY,
        platform_id TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        tags TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE work_tags (
        work_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        PRIMARY KEY(work_id,tag_id)
      ) WITHOUT ROWID;
      CREATE VIRTUAL TABLE work_fts USING fts5(
        title, author, tags, body,
        content='search_docs', content_rowid='work_id', tokenize='trigram'
      );
      CREATE VIRTUAL TABLE short_fts USING fts5(terms,content='',detail='none',columnsize=0);
      CREATE TABLE authors (
        author_id INTEGER PRIMARY KEY,
        platform_id TEXT NOT NULL,
        author_key TEXT NOT NULL,
        source_author_id TEXT,
        identity_key TEXT NOT NULL,
        name_key TEXT NOT NULL,
        latest_sort INTEGER NOT NULL,
        work_count INTEGER NOT NULL
      );
      CREATE TABLE tags (
        tag_id INTEGER PRIMARY KEY,
        display_value TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        work_count INTEGER NOT NULL
      );
    `);

    const insertSort = search.prepare(`INSERT INTO work_sort
      (work_id,platform_id,author_id,published_sort,title_key,name_key,has_image,has_video)
      VALUES (?,?,?,?,?,?,?,?)`);
    const insertDoc = search.prepare(
      "INSERT INTO search_docs(work_id,platform_id,title,author,tags,body) VALUES (?,?,?,?,?,?)",
    );
    const insertWorkTag = search.prepare(
      "INSERT INTO work_tags(work_id,tag_id) VALUES (?,?)",
    );
    const insertShort = search.prepare(
      "INSERT INTO short_fts(rowid,terms) VALUES (?,?)",
    );
    const source =
      catalog.prepare(`SELECT w.work_id,w.platform_id,w.source_work_id,w.author_id,w.sort_at_ms,w.title,w.relative_path,
      EXISTS(SELECT 1 FROM media mi WHERE mi.work_id=w.work_id AND mi.filesystem_media_type='image') AS has_filesystem_image,
      EXISTS(SELECT 1 FROM media mv WHERE mv.work_id=w.work_id AND mv.filesystem_media_type='video') AS has_filesystem_video,
      a.source_author_id,a.display_name,a.handle,COALESCE(x.source_text,'') AS body,
      COALESCE((SELECT group_concat(display_value,char(31)) FROM (SELECT t.display_value FROM work_tags wt JOIN tags t USING(tag_id)
        WHERE wt.work_id=w.work_id ORDER BY wt.ordinal,wt.tag_id)),'') AS tags,
      COALESCE((SELECT group_concat(tag_id,',') FROM (SELECT wt.tag_id FROM work_tags wt
        WHERE wt.work_id=w.work_id ORDER BY wt.ordinal,wt.tag_id)),'') AS tag_ids
      FROM works w JOIN authors a USING(author_id) LEFT JOIN work_text x USING(work_id) ORDER BY w.work_id`);
    let workCount = 0;
    search.exec("BEGIN");
    for (const row of source.iterate()) {
      const title = String(row.title || "");
      const author = [row.display_name, row.handle, row.source_author_id]
        .filter(Boolean)
        .join(" ");
      const tags = String(row.tags || "")
        .split("\u001f")
        .filter(Boolean);
      const body = normalizeSearchText(row.body);
      const name = path.win32.basename(String(row.relative_path || ""));
      insertSort.run(
        row.work_id,
        row.platform_id,
        row.author_id,
        row.sort_at_ms,
        normalizeSearchText(title),
        normalizeSearchText(name),
        row.has_filesystem_image > 0n ? 1 : 0,
        row.has_filesystem_video > 0n ? 1 : 0,
      );
      insertDoc.run(
        row.work_id,
        row.platform_id,
        normalizeSearchText(`${title} ${row.source_work_id || ""}`),
        normalizeSearchText(author),
        normalizeSearchText(tags.join(" ")),
        body,
      );
      for (const rawTagId of String(row.tag_ids || "")
        .split(",")
        .filter(Boolean)) {
        insertWorkTag.run(row.work_id, BigInt(rawTagId));
      }
      insertShort.run(
        row.work_id,
        shortGrams([title, author, tags.join(" "), row.source_work_id, body])
          .map((character) => "u" + character.codePointAt(0).toString(16))
          .join(" "),
      );
      workCount++;
      if (workCount % 1000 === 0) {
        search.exec("COMMIT; BEGIN");
        if (workCount % 10000 === 0) log(`SEARCH_INDEX_WORKS ${workCount}`);
      }
    }
    search.exec("COMMIT");
    log(`SEARCH_INDEX_WORKS_DONE ${workCount}`);

    const insertAuthor = search.prepare(
      "INSERT INTO authors(author_id,platform_id,author_key,source_author_id,identity_key,name_key,latest_sort,work_count) VALUES (?,?,?,?,?,?,?,?)",
    );
    search.transaction(() => {
      for (const row of catalog
        .prepare(
          "SELECT author_id,platform_id,relative_path_key,source_author_id,display_name,handle,latest_work_at_ms,work_count FROM authors ORDER BY author_id",
        )
        .iterate()) {
        const name = [row.display_name, row.handle, row.source_author_id]
          .filter(Boolean)
          .join(" ");
        insertAuthor.run(
          row.author_id,
          row.platform_id,
          row.relative_path_key,
          row.source_author_id,
          row.source_author_id || row.relative_path_key,
          normalizeSearchText(name),
          row.latest_work_at_ms ?? -9223372036854775808n,
          row.work_count,
        );
      }
    })();

    const insertTag = search.prepare(
      "INSERT INTO tags(tag_id,display_value,normalized_key,work_count) VALUES (?,?,?,?)",
    );
    search.transaction(() => {
      for (const row of catalog
        .prepare(
          "SELECT tag_id,display_value,work_count FROM tags ORDER BY tag_id",
        )
        .iterate()) {
        insertTag.run(
          row.tag_id,
          row.display_value,
          normalizeSearchText(row.display_value),
          row.work_count,
        );
      }
    })();

    search.exec(`
      CREATE INDEX idx_search_sort_platform_date ON work_sort(platform_id,published_sort DESC,work_id DESC);
      CREATE INDEX idx_search_sort_platform_title ON work_sort(platform_id,title_key,work_id);
      CREATE INDEX idx_search_sort_platform_name ON work_sort(platform_id,name_key,work_id);
      CREATE INDEX idx_search_sort_author_date ON work_sort(author_id,published_sort DESC,work_id DESC);
      CREATE INDEX idx_search_sort_author_title ON work_sort(author_id,title_key,work_id);
      CREATE INDEX idx_search_sort_author_name ON work_sort(author_id,name_key,work_id);
      CREATE INDEX idx_search_sort_platform_image_date ON work_sort(platform_id,has_image,published_sort DESC,work_id DESC);
      CREATE INDEX idx_search_sort_platform_video_date ON work_sort(platform_id,has_video,published_sort DESC,work_id DESC);
      CREATE INDEX idx_authors_platform_name ON authors(platform_id,name_key,author_id);
      CREATE INDEX idx_authors_platform_latest ON authors(platform_id,latest_sort DESC,author_id DESC);
      CREATE INDEX idx_authors_platform_works ON authors(platform_id,work_count DESC,author_id DESC);
      CREATE INDEX idx_tags_normalized ON tags(normalized_key,tag_id);
      CREATE INDEX idx_tags_count ON tags(work_count DESC,tag_id DESC);
      CREATE INDEX idx_work_tags_tag_work ON work_tags(tag_id,work_id);
      INSERT INTO work_fts(work_fts) VALUES('rebuild');
    `);
    const catalogStat = fs.statSync(catalogPath);
    search
      .prepare(
        `INSERT INTO index_state(singleton,version,catalog_work_count,catalog_size,catalog_mtime_ms,built_at_ms,catalog_sha256)
      VALUES (1,?,?,?,?,?,?)`,
      )
      .run(
        RUNTIME_SEARCH_INDEX_VERSION,
        workCount,
        catalogStat.size,
        Math.trunc(catalogStat.mtimeMs),
        nowMs(),
        hashDatabaseFile(catalogPath),
      );
    const report = {
      reportVersion: 1,
      version: RUNTIME_SEARCH_INDEX_VERSION,
      measurement: "MEASURED",
      workCount,
      authorCount: Number(
        search.prepare("SELECT count(*) AS count FROM authors").get().count,
      ),
      tagCount: Number(
        search.prepare("SELECT count(*) AS count FROM tags").get().count,
      ),
      shortSearch: "complete-character-fts-with-exact-residual",
      durationMs: performance.now() - started,
      sizeBytes: fs.statSync(searchIndexPath).size,
      note: "Search v5: complete character postings across title, author, tags and body. Two-character candidates are checked for exact adjacent text; no per-work truncation.",
    };
    if (reportPath) {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(
        reportPath,
        JSON.stringify(report, null, 2) + "\n",
        "utf8",
      );
    }
    return report;
  } finally {
    try {
      catalog?.close();
    } catch {}
    try {
      search?.close();
    } catch {}
  }
}

module.exports = {
  RUNTIME_SEARCH_INDEX_VERSION,
  buildSearchIndex,
  normalizeSearchText,
  shortGrams,
};
