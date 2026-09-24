export function elapsed(scan, now = Date.now()) {
  return scan?.running && Number.isFinite(scan.startedAtMs)
    ? Math.max(0, now - scan.startedAtMs)
    : scan && Object.hasOwn(scan, "elapsedMs") && scan.elapsedMs != null ? scan.elapsedMs : null;
}
export function duration(ms) {
  if (ms == null) return "—";
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
export function metrics(status) {
  const scan = status.scan || {};
  return {
    state: scan.state === "PREPARING" ? "准备中（校验检查点／实时库）" : scan.state || "IDLE",
    platform: scan.activePlatforms?.length ? scan.activePlatforms.join("、") : scan.currentPlatform || "—",
    generation: scan.generationId || "—",
    observed: scan.observedWorks ?? null,
    indexed: scan.indexedWorks ?? null,
    media: scan.actualMedia ?? null,
    elapsed: elapsed(scan),
    throughput: scan.throughput ?? null,
    rss: scan.memory?.rss ?? null,
    heap: scan.memory?.heapUsed ?? null,
    diagnostics: scan.diagnosticCount ?? null,
    metadata: scan.metadataStates || {},
    failure: scan.failure?.code || null,
  };
}
