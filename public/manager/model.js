export const pages = [
  ["update", "更新图库"],
  ["access", "访问"],
  ["settings", "设置"],
  ["diagnose", "排查"],
];
export const platformNames = [
  "pixiv",
  "pixivFANBOX",
  "Gank",
  "Fantia",
  "Patreon",
  "Pawchive",
  "X",
  "微博",
  "Venera",
];
export const n = (v) => new Intl.NumberFormat("en-US").format(v);
export function changePaths(a, b, prefix = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object")
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) =>
      changePaths(a[k], b[k], prefix ? prefix + "." + k : k),
    );
  return [prefix];
}
export function changes(a, b) {
  return changePaths(a, b).length;
}
export function requiresRestart(a, b) {
  return changePaths(a, b).length > 0;
}
export function scanPhase(s) {
  if (s.state === "CANCELLED") return "更新已停止";
  if (s.state === "FAILED") return "更新没有完成";
  if (s.state === "READY" && !s.running) return "更新完成";
  if (s.phase === "SEARCH_BUILD_START" || s.phase === "SEARCH_PROGRESS")
    return "整理搜索";
  if (
    [
      "CATALOG_FINALIZE",
      "SEARCH_FINALIZE",
      "VALIDATING",
      "PUBLISHING",
    ].includes(s.phase) ||
    ["VALIDATING", "PUBLISHING"].includes(s.state)
  )
    return "保存结果";
  return "读取作品";
}
export function updateLabel(selected) {
  return !selected.length
    ? "先选择平台"
    : selected.length === 9
      ? "更新全部平台"
      : `更新所选的 ${selected.length} 个平台`;
}
export function running(s) {
  return (
    s.state === "READY" || s.state === "STARTING" || s.state === "READY_LIVE"
  );
}
export function duration(ms) {
  const m = Math.floor(ms / 60000);
  return m >= 60
    ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`
    : `${m} 分 ${Math.floor(ms / 1000) % 60} 秒`;
}
export function clock(ms) {
  return new Date(ms).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function scanIssues(scan) {
  const rows = [],
    states = scan.metadataStates || {};
  for (const [key, code, text] of [
    ["missing", "metadata.missing", "个作品没有说明文件"],
    ["invalid", "metadata.invalid", "个作品说明无法识别"],
    ["unreadable", "metadata.unreadable", "个作品说明无法读取"],
    ["partial", "metadata.fields", "个作品信息不完整"],
  ])
    if (states[key]) rows.push({ code, text: n(states[key]) + " " + text });
  if (scan.diagnosticCount)
    rows.push({
      code: "",
      text: "有 " + n(scan.diagnosticCount) + " 个问题需要检查",
    });
  return rows;
}
export function networkDraft(value) {
  const config = structuredClone(value);
  if (
    config.port !== undefined &&
    (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
  )
    throw Object.assign(Error("PORT_INVALID"), { code: "PORT_INVALID" });
  config.mode ||= "local";
  if (config.mode === "local") config.listenAddress = "127.0.0.1";
  else if (config.mode === "public") config.listenAddress = "0.0.0.0";
  else {
    let host;
    try {
      host = new URL(config.publicUrl).hostname;
    } catch {
      throw Object.assign(Error("LAN_URL_REQUIRED"), {
        code: "LAN_URL_REQUIRED",
      });
    }
    if (
      !/^(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
        host,
      )
    )
      throw Object.assign(Error("LAN_URL_REQUIRED"), {
        code: "LAN_URL_REQUIRED",
      });
    config.listenAddress = host;
  }
  return config;
}
export function humanError(e, platform = "其他平台") {
  return (
    {
      LAN_URL_REQUIRED: "请在对外地址里填写局域网地址",
      PORT_INVALID: "端口需要是 1–65535 之间的数字",
      PUBLIC_URL_INVALID: "对外地址需要包含在允许的 Origin 中",
      ALLOWED_HOST_INVALID: "Host 格式无法识别，请填写主机名和端口",
      ALLOWED_ORIGIN_INVALID: "Origin 格式无法识别，请填写完整地址",
      INSTANCE_SOURCE_OVERLAP: "这个目录和程序数据目录重叠了，请换一个目录",
      SOURCE_ROOT_OVERLAP: `这个目录和 ${platform} 的目录重叠了，请换一个目录`,
      SCAN_IN_USE: "已有更新正在进行，请稍后重试",
      SCAN_START_TIMEOUT: "更新没有启动，请重试",
      INSTANCE_IN_USE: "服务正在处理其他操作，请稍后重试",
      CONFIG_REVISION_CHANGED: "设置已改变，请重新打开设置",
      SOURCE_UNAVAILABLE: "目录无法读取，请检查目录",
      STOP_RUNTIME_BEFORE_CLEANUP: "服务仍在运行，请重试",
      DEMO_CONFIG_REJECTED: "演示地址不可用，请保留本机地址",
      ACCESS_PERIOD_INVALID: "时间范围无法识别，请重新选择",
      LIVE_SOURCE_CHANGE_REQUIRES_CHECKPOINT: "更改目录前需要完成当前更新",
      OWNER_UNVERIFIABLE: "无法确认服务状态，请重新检查",
      CLIENT_CONTROL_FORBIDDEN: "本机地址不能封禁",
    }[e.code] || "服务没有响应，请重试"
  );
}
export function scanProgress(s) {
  const selected =
    s.scope?.effectivePlatformIds ||
    s.scope?.requestedPlatformIds ||
    s.scope?.platformIds ||
    s.platformIds ||
    platformNames;
  const done = s.platforms || s.platformResults || [];
  const current = s.currentPlatform || s.platformId;
  const index = Math.max(0, selected.indexOf(current));
  const total =
      s.preflight?.totalWorks ?? s.estimatedWorks ?? s.totalWorks ?? 0,
    checked =
      s.observedWorks ??
      s.works ??
      (s.indexedWorks || 0) + (s.reusedWorks || 0);
  const active = s.activePlatforms || [];
  return {
    selected,
    current,
    index: index + 1,
    total,
    checked,
    percent: total ? Math.min(100, Math.floor((checked / total) * 100)) : null,
    done,
    active,
  };
}
