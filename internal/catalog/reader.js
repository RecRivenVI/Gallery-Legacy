"use strict";
const Database = require("better-sqlite3");
const { verifyCatalogContract } = require("./writer.js");
const { normalizePhysicalRootKey } = require("../library/platforms.js");
class CatalogReader {
  constructor(file, generation, sources = null) {
    this.generation = generation;
    this.db = new Database(file, { readonly: true, fileMustExist: true });
    this.db.defaultSafeIntegers(true);
    try {
      verifyCatalogContract(this.db);
      if (sources)
        for (const row of this.db
          .prepare("SELECT platform_id,physical_root_key FROM platforms")
          .all()) {
          if (
            normalizePhysicalRootKey(sources[row.platform_id]) !==
            row.physical_root_key
          )
            throw Object.assign(
              new Error(
                "Instance source bindings differ from the published Catalog",
              ),
              { code: "SOURCE_BINDING_MISMATCH" },
            );
        }
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  close() {
    this.db.close();
  }
  url(kind, id) {
    return `/api/v1/${kind}/${id}?g=${encodeURIComponent(this.generation)}`;
  }
  mediaDto(m) {
    return {
      id: String(m.media_id),
      fileName: m.filesystem_file_name,
      relativePath: m.relative_path.replace(/\\/g, "/"),
      type: m.filesystem_media_type,
      size: Number(m.filesystem_size),
      url: this.url("media", m.media_id),
      thumbnailUrl: this.url("thumbnails", m.media_id),
    };
  }
  works(ids, mediaType = "all") {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT w.*,a.display_name author_name,a.source_author_id FROM works w JOIN authors a USING(author_id) WHERE w.work_id IN (${placeholders})`,
      )
      .all(...ids);
    const tags = this.db
      .prepare(
        `SELECT wt.work_id,t.tag_id,t.display_value FROM work_tags wt JOIN tags t USING(tag_id) WHERE wt.work_id IN (${placeholders}) ORDER BY wt.work_id,wt.ordinal`,
      )
      .all(...ids);
    const covers = this.db
      .prepare(
        `SELECT m.* FROM works w JOIN media m ON m.media_id=(SELECT c.media_id FROM media c WHERE c.work_id=w.work_id ORDER BY CASE WHEN c.filesystem_media_type=? THEN 0 ELSE 1 END,CASE WHEN c.metadata_ordinal IS NULL THEN 1 ELSE 0 END,c.metadata_ordinal,c.relative_path_key LIMIT 1) WHERE w.work_id IN (${placeholders})`,
      )
      .all(mediaType === "video" ? "video" : "image", ...ids);
    const byId = new Map(rows.map((w) => [w.work_id, w])),
      byCover = new Map(covers.map((m) => [m.work_id, m]));
    const byTags = new Map();
    for (const t of tags) {
      if (!byTags.has(t.work_id)) byTags.set(t.work_id, []);
      byTags
        .get(t.work_id)
        .push({ id: String(t.tag_id), label: t.display_value });
    }
    return ids
      .map((id) => {
        const w = byId.get(id);
        if (!w) return null;
        return {
          id: String(w.work_id),
          platformId: w.platform_id,
          authorId: String(w.author_id),
          sourceWorkId: w.source_work_id,
          title: w.title,
          authorName: w.author_name,
          publishedAtMs:
            w.published_at_ms === null ? null : Number(w.published_at_ms),
          sortAtMs: Number(w.sort_at_ms),
          metadataState: w.metadata_state,
          enrichmentState: w.enrichment_state,
          flags: {
            adult: w.is_adult === null ? null : w.is_adult === 1n,
            aiGenerated:
              w.is_ai_generated === null ? null : w.is_ai_generated === 1n,
          },
          counts: {
            images: Number(w.image_count),
            videos: Number(w.video_count),
            media: Number(w.media_count),
          },
          tags: byTags.get(id) || [],
          cover: byCover.has(id) ? this.mediaDto(byCover.get(id)) : null,
        };
      })
      .filter(Boolean);
  }
  work(id) {
    const item = this.works([id])[0];
    if (!item) return null;
    const media = this.db
      .prepare(
        "SELECT * FROM media WHERE work_id=? ORDER BY CASE WHEN metadata_ordinal IS NULL THEN 1 ELSE 0 END,metadata_ordinal,relative_path_key",
      )
      .all(id)
      .map((m) => this.mediaDto(m));
    return { ...item, media };
  }
  authors(ids) {
    const select = this.db.prepare("SELECT * FROM authors WHERE author_id=?"),
      cover = this.db.prepare(
        "SELECT m.* FROM works w JOIN media m USING(work_id) WHERE w.author_id=? ORDER BY w.sort_at_ms DESC,w.work_id DESC,CASE WHEN m.filesystem_media_type='image' THEN 0 ELSE 1 END,m.relative_path_key LIMIT 1",
      );
    return ids
      .map((id) => {
        const a = select.get(id);
        if (!a) return null;
        const c = cover.get(id);
        return {
          id: String(a.author_id),
          platformId: a.platform_id,
          sourceAuthorId: a.source_author_id,
          name: a.display_name,
          handle: a.handle,
          workCount: Number(a.work_count),
          latestAtMs:
            a.latest_work_at_ms === null ? null : Number(a.latest_work_at_ms),
          profileState: a.profile_state,
          cover: c ? this.mediaDto(c) : null,
        };
      })
      .filter(Boolean);
  }
  media(id) {
    return this.db
      .prepare(
        "SELECT m.*,w.platform_id,w.relative_path work_relative_path FROM media m JOIN works w USING(work_id) WHERE m.media_id=?",
      )
      .get(id);
  }
  stats() {
    return {
      works: Number(this.db.prepare("SELECT count(*) n FROM works").get().n),
      media: Number(this.db.prepare("SELECT count(*) n FROM media").get().n),
      authors: Number(
        this.db.prepare("SELECT count(*) n FROM authors").get().n,
      ),
      metadataStates: Object.fromEntries(
        this.db
          .prepare(
            "SELECT metadata_state,count(*) n FROM works GROUP BY metadata_state",
          )
          .all()
          .map((r) => [r.metadata_state, Number(r.n)]),
      ),
    };
  }
  platformStats() {
    return this.db
      .prepare(
        "SELECT platform_id,count(*) works,sum(media_count) media FROM works GROUP BY platform_id",
      )
      .all()
      .map((r) => ({
        id: r.platform_id,
        works: Number(r.works),
        media: Number(r.media),
      }));
  }
}
module.exports = { CatalogReader };
