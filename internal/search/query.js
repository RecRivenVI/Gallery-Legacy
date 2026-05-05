"use strict";
const fs = require("node:fs"),
  Database = require("better-sqlite3");
const {
  normalizeSearchText,
  RUNTIME_SEARCH_INDEX_VERSION,
} = require("./build.js");
const WORK_SORTS = Object.freeze({
  date_desc: {
    column: "published_sort",
    direction: "DESC",
    operator: "<",
    initial: 9223372036854775807n,
  },
  date_asc: {
    column: "published_sort",
    direction: "ASC",
    operator: ">",
    initial: -9223372036854775808n,
  },
  title_asc: {
    column: "title_key",
    direction: "ASC",
    operator: ">",
    initial: "",
  },
  title_desc: {
    column: "title_key",
    direction: "DESC",
    operator: "<",
    initial: "\uffff",
  },
  name_asc: {
    column: "name_key",
    direction: "ASC",
    operator: ">",
    initial: "",
  },
  name_desc: {
    column: "name_key",
    direction: "DESC",
    operator: "<",
    initial: "\uffff",
  },
});
const AUTHOR_SORTS = Object.freeze({
  name_asc: {
    column: "name_key",
    direction: "ASC",
    operator: ">",
    initial: "",
  },
  name_desc: {
    column: "name_key",
    direction: "DESC",
    operator: "<",
    initial: "\uffff",
  },
  latest_desc: {
    column: "latest_sort",
    direction: "DESC",
    operator: "<",
    initial: 9223372036854775807n,
  },
  latest_asc: {
    column: "latest_sort",
    direction: "ASC",
    operator: ">",
    initial: -9223372036854775808n,
  },
  posts_desc: {
    column: "work_count",
    direction: "DESC",
    operator: "<",
    initial: 9223372036854775807n,
  },
  posts_asc: {
    column: "work_count",
    direction: "ASC",
    operator: ">",
    initial: -1n,
  },
});
function mediaFilterConditions(type, alias = "") {
  const p = alias ? alias + "." : "";
  if (type === "all") return [];
  if (type === "image") return [p + "has_image=1", p + "has_video=0"];
  if (type === "video") return [p + "has_video=1"];
  throw Object.assign(new Error("Unsupported media filter"), {
    code: "INVALID_MEDIA_FILTER",
  });
}
class QueryIndex {
  constructor(file, facts) {
    if (!fs.existsSync(file))
      throw Object.assign(new Error("Search index missing"), {
        code: "SEARCH_MISSING",
      });
    this.db = new Database(file, { readonly: true, fileMustExist: true });
    this.db.defaultSafeIntegers(true);
    try {
      const s = this.db
        .prepare("SELECT * FROM index_state WHERE singleton=1")
        .get();
      if (
        !s ||
        s.catalog_sha256 !== facts.catalogSha256 ||
        s.version !== BigInt(RUNTIME_SEARCH_INDEX_VERSION) ||
        s.catalog_work_count !== BigInt(facts.workCount) ||
        s.catalog_size !== BigInt(facts.catalogSize) ||
        s.catalog_mtime_ms !== BigInt(Math.trunc(facts.catalogMtimeMs))
      )
        throw Object.assign(new Error("Search binding mismatch"), {
          code: "SEARCH_BINDING_MISMATCH",
        });
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  close() {
    this.db.close();
  }
  workPage({
    platformId = null,
    authorId = null,
    query = "",
    tag = null,
    sort = "date_desc",
    mediaType = "all",
    cursor = null,
    limit = 48,
    offset = 0,
  } = {}) {
    const order = WORK_SORTS[sort];
    if (!order)
      throw Object.assign(new Error("Invalid sort"), { code: "INVALID_SORT" });
    let from = "work_sort s";
    const conditions = [],
      args = [];
    let mode = "browse";
    if (platformId !== null) {
      conditions.push("s.platform_id=?");
      args.push(platformId);
    }
    if (authorId !== null) {
      conditions.push("s.author_id=?");
      args.push(authorId);
    }
    conditions.push(...mediaFilterConditions(mediaType, "s"));
    if (tag !== null) {
      conditions.push(
        "EXISTS(SELECT 1 FROM work_tags wt JOIN tags t USING(tag_id) WHERE wt.work_id=s.work_id AND t.display_value=?)",
      );
      args.push(tag);
      mode = "tag_exact";
    }
    const text = normalizeSearchText(query);
    if (text) {
      from += " JOIN search_docs d ON d.work_id=s.work_id";
      if ([...text].length <= 2) {
        from += " JOIN short_fts sf ON sf.rowid=s.work_id";
        const first = [...text].find((c) => c !== " ") || text;
        conditions.push("short_fts MATCH ?");
        args.push("u" + first.codePointAt(0).toString(16));
        conditions.push(
          "(instr(d.title,?)>0 OR instr(d.author,?)>0 OR instr(d.tags,?)>0 OR instr(d.body,?)>0)",
        );
        args.push(text, text, text, text);
        mode = "short_exact";
      } else {
        from += " JOIN work_fts f ON f.rowid=s.work_id";
        conditions.push("work_fts MATCH ?");
        args.push('"' + text.replace(/"/g, '""') + '"');
        mode = "trigram_fts";
      }
    }
    const filter = conditions.length
      ? " WHERE " + conditions.join(" AND ")
      : "";
    const total = Number(
      this.db.prepare("SELECT count(*) n FROM " + from + filter).get(...args).n,
    );
    if (cursor) {
      conditions.push(
        "(s." +
          order.column +
          " " +
          order.operator +
          " ? OR (s." +
          order.column +
          "=? AND s.work_id " +
          order.operator +
          " ?))",
      );
      args.push(cursor.value, cursor.value, cursor.workId);
    }
    if (!conditions.length) conditions.push("1");
    const rows = this.db
      .prepare(
        "SELECT s.work_id,s." +
          order.column +
          " sort_value FROM " +
          from +
          " WHERE " +
          conditions.join(" AND ") +
          " ORDER BY s." +
          order.column +
          " " +
          order.direction +
          ",s.work_id " +
          order.direction +
          " LIMIT ? OFFSET ?",
      )
      .all(...args, limit, offset);
    const last = rows.at(-1);
    return {
      rows,
      total,
      mode,
      nextCursor: last
        ? { value: last.sort_value, workId: last.work_id }
        : null,
    };
  }
  authorPage({
    platformId = null,
    sort = "name_asc",
    query = "",
    cursor = null,
    limit = 48,
    offset = 0,
  } = {}) {
    const order = AUTHOR_SORTS[sort];
    if (!order)
      throw Object.assign(new Error("Invalid sort"), { code: "INVALID_SORT" });
    const conditions = [],
      args = [];
    if (platformId) {
      conditions.push("platform_id=?");
      args.push(platformId);
    }
    const text = normalizeSearchText(query);
    if (text) {
      conditions.push("instr(name_key,?)>0");
      args.push(text);
    }
    const filter = conditions.length
      ? " WHERE " + conditions.join(" AND ")
      : "";
    const total = Number(
      this.db.prepare("SELECT count(*) n FROM authors" + filter).get(...args).n,
    );
    if (cursor) {
      conditions.push(
        "(" +
          order.column +
          " " +
          order.operator +
          " ? OR (" +
          order.column +
          "=? AND author_id " +
          order.operator +
          " ?))",
      );
      args.push(cursor.value, cursor.value, cursor.authorId);
    }
    if (!conditions.length) conditions.push("1");
    const rows = this.db
      .prepare(
        "SELECT author_id," +
          order.column +
          " sort_value FROM authors WHERE " +
          conditions.join(" AND ") +
          " ORDER BY " +
          order.column +
          " " +
          order.direction +
          ",author_id " +
          order.direction +
          " LIMIT ? OFFSET ?",
      )
      .all(...args, limit, offset);
    const last = rows.at(-1);
    return {
      rows,
      total,
      nextCursor: last
        ? { value: last.sort_value, authorId: last.author_id }
        : null,
    };
  }
  tagPage({
    platformId = null,
    query = "",
    cursor = null,
    limit = 48,
    offset = 0,
  } = {}) {
    const conditions = [],
      args = [],
      text = normalizeSearchText(query);
    if (platformId) {
      conditions.push("s.platform_id=?");
      args.push(platformId);
    }
    if (text) {
      conditions.push("instr(t.normalized_key,?)>0");
      args.push(text);
    }
    const from =
      "tags t JOIN work_tags wt USING(tag_id) JOIN work_sort s USING(work_id)";
    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const total = Number(
      this.db
        .prepare("SELECT count(DISTINCT t.tag_id) n FROM " + from + where)
        .get(...args).n,
    );
    conditions.push("t.tag_id>?");
    args.push(cursor?.tagId ?? 0n);
    const rows = this.db
      .prepare(
        "SELECT t.tag_id,t.display_value,count(*) work_count FROM " +
          from +
          " WHERE " +
          conditions.join(" AND ") +
          " GROUP BY t.tag_id ORDER BY t.tag_id LIMIT ? OFFSET ?",
      )
      .all(...args, limit, offset);
    return {
      rows,
      total,
      nextCursor: rows.length ? { tagId: rows.at(-1).tag_id } : null,
    };
  }
}
module.exports = {
  QueryIndex,
  WORK_SORTS,
  AUTHOR_SORTS,
  mediaFilterConditions,
};
