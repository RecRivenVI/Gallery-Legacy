// Platform completion is a notification, never an automatic list reload.
// The reader applies it using the existing new-content action.
export function createStreamUpdates() {
  let initialized = false,
    epoch = null,
    completed = new Set();
  return {
    receive(status, platform) {
      const nextEpoch = status.live?.epoch || status.loadedGenerationId || null;
      const scan = status.scan || {},
        run = scan.startedAtMs || scan.startedAt || "";
      const results =
        scan.platformResults ||
        scan.progress?.platformResults ||
        scan.platforms ||
        [];
      const current = new Set(
        results
          .filter((p) =>
            ["COMPLETE", "INCREMENTAL_COMPLETE"].includes(p.status),
          )
          .map((p) => run + ":" + (p.platformId || p.id)),
      );
      let changed = initialized && epoch !== nextEpoch,
        added = 0;
      if (initialized)
        for (const p of results) {
          const id = p.platformId || p.id,
            key = run + ":" + id;
          if (
            current.has(key) &&
            !completed.has(key) &&
            (!platform || platform === "@all" || platform === id)
          ) {
            changed = true;
            added +=
              p.platformChanges?.worksAdded || p.changes?.worksAdded || 0;
          }
        }
      initialized = true;
      epoch = nextEpoch;
      completed = current;
      return { changed, added };
    },
  };
}
