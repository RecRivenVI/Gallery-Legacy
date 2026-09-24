"use strict";
const { CatalogReader } = require("../catalog/reader.js");
const { QueryIndex } = require("../search/query.js");
const { createMediaService } = require("../media/service.js");

// A fresh instance serves an explicitly empty view, not a fabricated READY DB.
function emptyReader() {
  return {
    stats: () => ({ works: 0, authors: 0, media: 0, metadataStates: {} }),
    platformStats: () => [], works: () => [], authors: () => [],
    work: () => null, media: () => null, mediaIdentity: () => null,
    resolvePublicPath: () => null, chapters: () => null, mediaAtPublicPath: () => null,
    close() {},
  };
}
function openDataset(config, generation) {
  const api = config.liveUpdates && generation ? require("../catalog/live.js") : null;
  const live = api ? api.openLive(config, generation) : null;
  const epoch = live?.epoch || generation?.generationId || "empty";
  let reader, index, media;
  try {
    reader = generation ? new CatalogReader(live?.catalogPath || generation.catalogPath, epoch, config.sources,
      live ? { db: live.db, live: true, ownsDb: false } : {}) : emptyReader();
    index = !generation ? { workPage: () => ({ rows: [], total: 0 }), authorPage: () => ({ rows: [], total: 0 }), tagPage: () => ({ rows: [], total: 0 }), close() {} }
      : live ? new QueryIndex(null, null, { db: live.db, prefix: "live_", ownsDb: false, skipStaticBinding: true })
      : new QueryIndex(generation.searchIndexPath, { workCount: generation.catalogFacts.workCount, catalogSize: generation.catalogFacts.sizeBytes, catalogMtimeMs: generation.catalogFacts.mtimeMs, catalogSha256: generation.catalogFacts.sha256 });
    if (generation && !live) index.bindUnreadableWorks(reader.unreadableWorkIds());
    media = createMediaService(reader, config);
    let closePromise;
    const data = { generation, epoch, live, reader, index, media, counts: reader.stats(), platformStats: reader.platformStats(), statsRevision: -1, references: 0, retired: false,
      liveState: () => live ? api.getLiveState(live.db) : null,
      close: () => closePromise ||= (async () => { await media.close(); reader.close(); index.close(); live?.close(); })(),
    };
    return data;
  } catch (error) { reader?.close(); index?.close(); live?.close(); throw error; }
}
module.exports = { openDataset };
