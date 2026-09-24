"use strict";

const path = require("node:path");
const { normalizeSearchText, shortGrams } = require("./build.js");
const { presentation } = require("../media/presentation.js");

function createLiveSearchSchema(db) {
  db.exec(`
    CREATE TABLE live_work_sort(work_id INTEGER PRIMARY KEY,platform_id TEXT NOT NULL,author_id INTEGER NOT NULL,published_sort INTEGER NOT NULL,title_key TEXT NOT NULL,name_key TEXT NOT NULL,has_image INTEGER NOT NULL,has_video INTEGER NOT NULL,has_readable INTEGER NOT NULL);
    CREATE TABLE live_search_docs(work_id INTEGER PRIMARY KEY,platform_id TEXT NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL,tags TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE live_work_tags(work_id INTEGER NOT NULL,tag_id INTEGER NOT NULL,PRIMARY KEY(work_id,tag_id)) WITHOUT ROWID;
    CREATE VIRTUAL TABLE live_work_fts USING fts5(title,author,tags,body,tokenize='trigram');
    CREATE VIRTUAL TABLE live_short_fts USING fts5(terms,detail='none',columnsize=0);
    CREATE TABLE live_authors(author_id INTEGER PRIMARY KEY,platform_id TEXT NOT NULL,author_key TEXT NOT NULL,source_author_id TEXT,identity_key TEXT NOT NULL,name_key TEXT NOT NULL,latest_sort INTEGER NOT NULL,work_count INTEGER NOT NULL);
    CREATE TABLE live_tags(tag_id INTEGER PRIMARY KEY,display_value TEXT NOT NULL,normalized_key TEXT NOT NULL,work_count INTEGER NOT NULL);
    CREATE INDEX live_idx_sort_platform_date ON live_work_sort(platform_id,published_sort DESC,work_id DESC);
    CREATE INDEX live_idx_sort_platform_title ON live_work_sort(platform_id,title_key,work_id);
    CREATE INDEX live_idx_sort_platform_name ON live_work_sort(platform_id,name_key,work_id);
    CREATE INDEX live_idx_sort_author_date ON live_work_sort(author_id,published_sort DESC,work_id DESC);
    CREATE INDEX live_idx_sort_author_title ON live_work_sort(author_id,title_key,work_id);
    CREATE INDEX live_idx_sort_author_name ON live_work_sort(author_id,name_key,work_id);
    CREATE INDEX live_idx_sort_media_image ON live_work_sort(platform_id,has_image,published_sort DESC,work_id DESC);
    CREATE INDEX live_idx_sort_media_video ON live_work_sort(platform_id,has_video,published_sort DESC,work_id DESC);
    CREATE INDEX live_idx_authors_name ON live_authors(platform_id,name_key,author_id);
    CREATE INDEX live_idx_authors_latest ON live_authors(platform_id,latest_sort DESC,author_id DESC);
    CREATE INDEX live_idx_authors_works ON live_authors(platform_id,work_count DESC,author_id DESC);
    CREATE INDEX live_idx_tags_normalized ON live_tags(normalized_key,tag_id);
    CREATE INDEX live_idx_tags_count ON live_tags(work_count DESC,tag_id DESC);
    CREATE INDEX live_idx_work_tags_tag ON live_work_tags(tag_id,work_id);
    CREATE INDEX live_idx_relation_target_all ON social_relations(target_platform_id,target_source_work_id);
  `);
}

function workSource(db, workId) {
  return db.prepare(`SELECT w.work_id,w.platform_id,w.source_work_id,w.author_id,w.sort_at_ms,w.title,w.relative_path,
    EXISTS(SELECT 1 FROM media mi WHERE mi.work_id=w.work_id AND mi.filesystem_media_type='image') has_image,
    EXISTS(SELECT 1 FROM media mv WHERE mv.work_id=w.work_id AND mv.filesystem_media_type='video') has_video,
    a.source_author_id,a.display_name,a.handle,COALESCE(x.source_text,'') body,
    COALESCE((SELECT group_concat(display_value,char(31)) FROM (SELECT t.display_value FROM work_tags wt JOIN tags t USING(tag_id) WHERE wt.work_id=w.work_id ORDER BY wt.ordinal,wt.tag_id)),'') tags,
    COALESCE((SELECT group_concat(tag_id,',') FROM (SELECT wt.tag_id FROM work_tags wt WHERE wt.work_id=w.work_id ORDER BY wt.ordinal,wt.tag_id)),'') tag_ids
    FROM works w JOIN authors a USING(author_id) LEFT JOIN work_text x USING(work_id) WHERE w.work_id=?`).get(workId);
}

function replaceWork(db, workId) {
  for (const table of ["live_work_sort", "live_search_docs", "live_work_tags", "live_work_fts", "live_short_fts"])
    db.prepare(`DELETE FROM ${table} WHERE ${table.endsWith("fts") ? "rowid" : "work_id"}=?`).run(workId);
  const row = workSource(db, workId);
  if (!row) return;
  const title = String(row.title || "");
  const author = [row.display_name, row.handle, row.source_author_id].filter(Boolean).join(" ");
  const tags = String(row.tags || "").split("\u001f").filter(Boolean);
  const body = normalizeSearchText(row.body);
  const doc = [normalizeSearchText(`${title} ${row.source_work_id || ""}`), normalizeSearchText(author), normalizeSearchText(tags.join(" ")), body];
  const extracted = !!db.prepare("SELECT 1 FROM field_sources WHERE work_id=? AND field='media.extractedPreviews'").get(workId);
  const hasReadable = db.prepare("SELECT filesystem_file_name FROM media WHERE work_id=?").all(workId)
    .some((media) => presentation(media.filesystem_file_name, extracted).defaultVisible);
  db.prepare("INSERT INTO live_work_sort VALUES (?,?,?,?,?,?,?,?,?)").run(row.work_id,row.platform_id,row.author_id,row.sort_at_ms,normalizeSearchText(title),normalizeSearchText(path.win32.basename(String(row.relative_path || ""))),row.has_image > 0n ? 1 : 0,row.has_video > 0n ? 1 : 0,hasReadable ? 1 : 0);
  db.prepare("INSERT INTO live_search_docs VALUES (?,?,?,?,?,?)").run(row.work_id,row.platform_id,...doc);
  // Author text is queried through live_authors so a profile change never
  // requires rewriting every historical work owned by a large author.
  db.prepare("INSERT INTO live_work_fts(rowid,title,author,tags,body) VALUES (?,?,?,?,?)").run(row.work_id,doc[0],"",doc[2],doc[3]);
  db.prepare("INSERT INTO live_short_fts(rowid,terms) VALUES (?,?)").run(row.work_id,shortGrams([title,tags.join(" "),row.source_work_id,body]).map((c) => "u" + c.codePointAt(0).toString(16)).join(" "));
  for (const raw of String(row.tag_ids || "").split(",").filter(Boolean)) db.prepare("INSERT INTO live_work_tags VALUES (?,?)").run(row.work_id,BigInt(raw));
}

function replaceAuthor(db, authorId) {
  db.prepare("DELETE FROM live_authors WHERE author_id=?").run(authorId);
  const row = db.prepare("SELECT author_id,platform_id,relative_path_key,source_author_id,display_name,handle,latest_work_at_ms,work_count FROM authors WHERE author_id=?").get(authorId);
  if (!row) return;
  const name = [row.display_name,row.handle,row.source_author_id].filter(Boolean).join(" ");
  db.prepare("INSERT INTO live_authors VALUES (?,?,?,?,?,?,?,?)").run(row.author_id,row.platform_id,row.relative_path_key,row.source_author_id,row.source_author_id || row.relative_path_key,normalizeSearchText(name),row.latest_work_at_ms ?? -9223372036854775808n,row.work_count);
}

function replaceTag(db, tagId) {
  db.prepare("DELETE FROM live_tags WHERE tag_id=?").run(tagId);
  const row = db.prepare("SELECT tag_id,display_value,work_count FROM tags WHERE tag_id=?").get(tagId);
  if (row) db.prepare("INSERT INTO live_tags VALUES (?,?,?,?)").run(row.tag_id,row.display_value,normalizeSearchText(row.display_value),row.work_count);
}

function refreshLiveSearch(db, { workIds = [], authorIds = [], tagIds = [] } = {}) {
  if (!db.inTransaction) throw new Error("Live search refresh requires transaction");
  for (const id of new Set(workIds)) replaceWork(db, id);
  for (const id of new Set(authorIds)) replaceAuthor(db, id);
  for (const id of new Set(tagIds)) replaceTag(db, id);
}

function rebuildLiveSearch(db) {
  if (!db.inTransaction) throw new Error("Live search rebuild requires transaction");
  for (const table of ["live_work_sort","live_search_docs","live_work_tags","live_work_fts","live_short_fts","live_authors","live_tags"]) db.exec(`DELETE FROM ${table}`);
  for (const [table,id,replace] of [["works","work_id",replaceWork],["authors","author_id",replaceAuthor],["tags","tag_id",replaceTag]]) {
    let after = 0n;
    while (true) {
      const rows = db.prepare(`SELECT ${id} value FROM ${table} WHERE ${id}>? ORDER BY ${id} LIMIT 500`).all(after);
      if (!rows.length) break;
      for (const row of rows) replace(db,row.value);
      after = rows.at(-1).value;
    }
  }
}

module.exports = { createLiveSearchSchema, rebuildLiveSearch, refreshLiveSearch };
