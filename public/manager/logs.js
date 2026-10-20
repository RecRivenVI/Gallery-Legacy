const levels = {
  info: "信息",
  warn: "警告",
  warning: "警告",
  error: "错误",
  debug: "调试",
};
export function logicalLogPath(value, sources = {}) {
  let text = String(value || "");
  for (const [platform, root] of Object.entries(sources)) {
    if (!root) continue;
    const escaped = root
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\\\/]");
    text = text.replace(
      new RegExp(escaped + "(?=[\\\\/]|$)[\\\\/]?", "gi"),
      platform + " / ",
    );
  }
  return text.replace(/\\/g, " / ");
}
export function logRows(text, sources = {}) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((raw) => {
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        entry = { message: raw };
      }
      if (!entry || typeof entry !== "object") entry = {};
      const level = String(
        entry.level || (/ERROR|FAILED/.test(raw) ? "error" : "info"),
      ).toLowerCase();
      const date =
        entry.timestamp ||
        entry.time ||
        entry.at ||
        entry.finishedAtMs ||
        entry.startedAtMs;
      const parsed = date ? new Date(date) : null;
      const time =
        parsed && Number.isFinite(parsed.getTime())
          ? new Intl.DateTimeFormat("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
            }).format(parsed)
          : "—";
      const changes =
        entry.changes || entry.platformChanges || entry.counts || entry;
      const platform = entry.platformId || entry.platform;
      let summary = entry.message || entry.summary;
      if (
        entry.event === "scan.complete" ||
        (platform &&
          (entry.state === "COMPLETE" ||
            entry.status === "INCREMENTAL_COMPLETE"))
      ) {
        const kind = entry.mode === "full" ? "重新扫描" : "增量更新";
        const seconds = Math.round(
          (entry.elapsedMs || entry.timings?.wallMs || 0) / 1000,
        );
        summary = `${platform || "图库"} ${kind}完成：新增 ${changes.worksAdded || 0} · 更新 ${changes.worksUpdated || 0} · 移除 ${changes.worksDeleted || 0} · 用时 ${seconds} 秒`;
      } else if (entry.event === "ready") summary = "服务已启动";
      else if (entry.event === "stopped") summary = "服务已停止";
      else if (entry.event === "scan.start")
        summary = `${platform || "图库"} 更新开始`;
      else if (entry.event === "scan.cancelled") summary = "更新已停止";
      else if (entry.event === "scan.failed")
        summary = "更新没有完成，请查看详细日志";
      else if (entry.event === "validation.complete")
        summary = `图库检查完成：发现 ${entry.total || 0} 个问题`;
      summary = logicalLogPath(
        summary && /\p{Script=Han}/u.test(summary) ? summary : "服务记录",
        sources,
      ).split(/\r?\n/)[0];
      return { raw, time, level, levelName: levels[level] || "信息", summary };
    });
}
