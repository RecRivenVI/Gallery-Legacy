export function elapsed(scan, now = Date.now()) {
  return scan?.running && Number.isFinite(scan.startedAtMs)
    ? Math.max(0, now - scan.startedAtMs)
    : scan?.elapsedMs || 0;
}
export function duration(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
export function metrics(status) {
  const scan = status.scan || {};
  return {
    state: scan.state || "IDLE",
    platform: scan.currentPlatform || "—",
    generation: scan.generationId || "—",
    observed: scan.observedWorks || 0,
    indexed: scan.indexedWorks || 0,
    media: scan.actualMedia || 0,
    elapsed: elapsed(scan),
    throughput: scan.throughput || 0,
    rss: scan.memory?.rss || 0,
    heap: scan.memory?.heapUsed || 0,
    diagnostics: scan.diagnosticCount || 0,
    metadata: scan.metadataStates || {},
    failure: scan.failure?.code || null,
  };
}
