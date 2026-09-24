"use strict";
const Database = require("better-sqlite3");
const crypto = require("node:crypto");
const { verifyCatalogContract } = require("./writer.js");
const { normalizePhysicalRootKey } = require("../library/platforms.js");
const { naturalKey } = require("../media/order.js");
const { presentation, coverRank } = require("../media/presentation.js");
const { publicPath, parsePublicPath } = require("../library/public-path.js");
class CatalogReader {
  constructor(file, generation, sources = null, options = {}) {
    this.generation = generation;
    this.live = options.live === true;
    this.ownsDb = options.ownsDb !== false;
    this.db = options.db || new Database(file, { readonly: true, fileMustExist: true });
    this.db.defaultSafeIntegers(true);
    this.db.function("gallery_natural_key", { deterministic: true }, naturalKey);
    this.db.function("gallery_cover_rank", { deterministic: true }, (name, preview) => coverRank(name, Number(preview) === 1));
    try {
      verifyCatalogContract(this.db, { allowLive: this.live });
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
      if(this.ownsDb)this.db.close();
      throw e;
    }
    if(this.live)for(const name of ["works","work","authors","resolvePublicPath","chapters","mediaAtPublicPath","media","stats","platformStats"]){
      const method=this[name].bind(this);const tx=this.db.transaction((...args)=>method(...args));this[name]=(...args)=>tx(...args);
    }
  }
  close() {
    if(this.ownsDb)this.db.close();
  }
  unreadableWorkIds() {
    // Derived once per immutable generation; reuse the viewer's presentation rule.
    this.db.function("gallery_visible_media", { deterministic: true },
      (name, preview) => presentation(name, Number(preview) === 1).defaultVisible ? 1 : 0);
    const ids = new Set();
    for (const row of this.db.prepare(`SELECT w.work_id FROM works w
      WHERE NOT EXISTS(SELECT 1 FROM media m WHERE m.work_id=w.work_id
        AND gallery_visible_media(m.filesystem_file_name,
          EXISTS(SELECT 1 FROM field_sources f WHERE f.work_id=w.work_id
            AND f.field='media.extractedPreviews'))=1)`).iterate())
      ids.add(row.work_id);
    return ids;
  }
  url(kind, id) {
    return `/api/v1/${kind}/${id}?g=${encodeURIComponent(this.generation)}`;
  }
  mediaDto(m, extractedPreviews = false) {
    const identity = this.media(m.media_id);
    const key = this.mediaIdentity(m.media_id);
    const stable = identity ? publicPath(identity.platform_id, identity.work_relative_path + "/" + identity.relative_path.replace(/\\/g, "/")) : null;
    const suffix = (key ? "&k=" + key : "") + (stable ? "&p=" + encodeURIComponent(stable) : "");
    return {
      id: String(m.media_id),
      fileName: m.filesystem_file_name,
      relativePath: m.relative_path.replace(/\\/g, "/"),
      type: m.filesystem_media_type,
      size: Number(m.filesystem_size),
      url: this.url("media", m.media_id) + suffix,
      thumbnailUrl: this.url("thumbnails", m.media_id) + suffix,
      ...presentation(m.filesystem_file_name, extractedPreviews),
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
        `SELECT m.* FROM works w JOIN media m ON m.media_id=(SELECT c.media_id FROM media c WHERE c.work_id=w.work_id
          AND NOT EXISTS(SELECT 1 FROM field_sources f WHERE f.work_id=c.work_id AND f.field='media.coverDisabled')
          ORDER BY CASE WHEN c.filesystem_media_type=? THEN 0 ELSE 1 END,
          gallery_cover_rank(c.filesystem_file_name,EXISTS(SELECT 1 FROM field_sources f WHERE f.work_id=c.work_id AND f.field='media.extractedPreviews')),
          gallery_natural_key(c.relative_path),c.relative_path LIMIT 1) WHERE w.work_id IN (${placeholders})`,
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
          stableId: publicPath(w.platform_id, w.relative_path),
          platformId: w.platform_id,
          authorId: String(w.author_id),
          sourceWorkId: w.source_work_id,
          sourceUrl: this.db.prepare("SELECT source_text FROM work_text_sources WHERE work_id=? AND role='source_link' AND source_format='plain' ORDER BY ordinal LIMIT 1").get(w.work_id)?.source_text || null,
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
    const previews = !!this.db.prepare("SELECT 1 FROM field_sources WHERE work_id=? AND field='media.extractedPreviews'").get(id);
    const media = this.db
      .prepare(
        "SELECT * FROM media WHERE work_id=? ORDER BY gallery_natural_key(relative_path),relative_path",
      )
      .all(id)
      .map((m) => this.mediaDto(m, previews));
    const text = this.db.prepare("SELECT source_format,source_text FROM work_text WHERE work_id=?").get(id);
    return { ...item, media, description: text ? { format: text.source_format, text: text.source_text } : null };
  }
  resolvePublicPath(value) {
    const parsed = parsePublicPath(value);
    if (!parsed) return null;
    const work = this.db.prepare("SELECT work_id FROM works WHERE platform_id=? AND relative_path_key=?").get(parsed.platformId, parsed.relativePathKey);
    if (work) return { kind: "work", item: this.work(work.work_id) };
    const author = this.db.prepare("SELECT author_id FROM authors WHERE platform_id=? AND relative_path_key=?").get(parsed.platformId, parsed.relativePathKey);
    return author ? { kind: "author", item: this.authors([author.author_id])[0] } : null;
  }
  chapters(value) {
    const resolved = this.resolvePublicPath(value);
    if (!resolved) return null;
    if (resolved.kind === "work") return [resolved.item];
    const rows = this.db.prepare("SELECT work_id FROM works WHERE author_id=? ORDER BY gallery_natural_key(relative_path),relative_path").all(BigInt(resolved.item.id));
    return this.works(rows.map((r) => r.work_id));
  }
  mediaAtPublicPath(value) {
    const parsed = parsePublicPath(value);
    if (!parsed) return null;
    const parts = parsed.relativePathKey.split("\\");
    if (parts.length < 3) return null;
    return this.db.prepare("SELECT m.media_id FROM works w JOIN media m USING(work_id) WHERE w.platform_id=? AND w.relative_path_key=? AND m.relative_path_key=?")
      .get(parsed.platformId, parts.slice(0, 2).join("\\"), parts.slice(2).join("\\"))?.media_id || null;
  }
  authors(ids) {
    const select = this.db.prepare("SELECT * FROM authors WHERE author_id=?"),
      cover = this.db.prepare(
        "SELECT work_id FROM works WHERE author_id=? ORDER BY sort_at_ms DESC,work_id DESC LIMIT 1",
      );
    return ids
      .map((id) => {
        const a = select.get(id);
        if (!a) return null;
        const latest = cover.get(id);
        return {
          id: String(a.author_id),
          stableId: publicPath(a.platform_id, a.relative_path),
          platformId: a.platform_id,
          sourceAuthorId: a.source_author_id,
          name: a.display_name,
          handle: a.handle,
          workCount: Number(a.work_count),
          latestAtMs:
            a.latest_work_at_ms === null ? null : Number(a.latest_work_at_ms),
          profileState: a.profile_state,
          cover: latest ? this.works([latest.work_id])[0].cover : null,
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
  mediaIdentity(id) {
    const row=this.media(id);if(!row)return null;
    return crypto.createHash("sha256").update(JSON.stringify([row.platform_id,row.work_relative_path.toLowerCase(),row.relative_path_key])).digest("hex").slice(0,32);
  }
  stats() {
    if (this.live) {
      const totals=this.db.prepare("SELECT works,media,authors FROM live_stats WHERE singleton=1").get();
      if(!totals)throw Object.assign(new Error("Live aggregate totals missing"),{code:"LIVE_STATS_INVALID"});
      return {works:Number(totals.works),media:Number(totals.media),authors:Number(totals.authors),metadataStates:Object.fromEntries(this.db.prepare("SELECT metadata_state,count FROM live_metadata_stats WHERE count>0 ORDER BY metadata_state").all().map(row=>[row.metadata_state,Number(row.count)]))};
    }
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
    if(this.live)return this.db.prepare("SELECT platform_id,count_works,count_media FROM live_platform_stats ORDER BY platform_id").all().map(row=>({id:row.platform_id,works:Number(row.count_works),media:Number(row.count_media)}));
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
