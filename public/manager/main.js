import { patchHTML, serialPoll } from "./render.js";
import {
  pages,
  platformNames,
  n,
  changes,
  updateLabel,
  running,
  duration,
  clock,
  humanError,
  scanProgress,
  networkDraft,
  scanIssues,
  requiresRestart,
  scanPhase,
} from "./model.js";
import { theme } from "./theme.js";
import { logRows } from "./logs.js";
import { iconSvg } from "../platform/fluent-icons.js";
import { miSansManifest, installNativeMiSans } from "../platform/fonts.js";
miSansManifest()
  .then(installNativeMiSans)
  .catch(() => {});
const systemTheme = matchMedia("(prefers-color-scheme:dark)");
const applyTheme = () => {
  const saved = localStorage.getItem("gallery_theme");
  theme(
    saved === "light" || saved === "dark"
      ? saved
      : systemTheme.matches
        ? "dark"
        : "light",
  );
};
applyTheme();
systemTheme.addEventListener("change", applyTheme);
window.addEventListener("storage", applyTheme);
const $ = (id) => document.getElementById(id),
  esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const state = {
  page: pages.some(([id]) => id === location.hash.slice(1))
    ? location.hash.slice(1)
    : "update",
  status: { state: "STOPPED" },
  scan: { running: false },
  selected:
    JSON.parse(localStorage.getItem("manager_selected") || "null") ||
    platformNames,
  counts: {},
  period: 1,
  busy: false,
  errors: {},
  findings: null,
};
const reasons = {
  "filesystem.incomplete": "部分目录没有读取完",
  "filesystem.unreadable": "目录无法读取",
  "filesystem.ignored": "部分文件没有参与更新",
  "media.none": "作品没有图片或视频",
  "media.all_hidden": "作品的全部页已隐藏",
  "media.unknown_extension": "作品含有其他附件",
  "cover.multiple": "作品有多个封面",
  "cover.conflict": "作品的封面设置冲突",
  "metadata.missing": "作品没有说明文件",
  "metadata.unreadable": "作品说明无法读取",
  "metadata.invalid": "作品说明无法识别",
  "metadata.fields": "部分作品信息无法识别",
};
async function call(method, ...args) {
  const result = await window.galleryHost[method](...args);
  if (result?.ok === false)
    throw Object.assign(new Error(result.code), { code: result.code });
  return result?.ok === true ? result.data : result;
}
const admin = (op, input = {}) => call("admin", op, input);
function navIcon(id) {
  return iconSvg(id, 20);
}
$("brand-icon").innerHTML = iconSvg("gallery", 20);

function alignPaths() {
  for (const el of document.querySelectorAll(".path")) {
    const overflow = el.scrollWidth > el.clientWidth;
    el.classList.toggle("overflow", overflow);
    el.scrollLeft = overflow ? el.scrollWidth - el.clientWidth : 0;
  }
}
function overlappingPlatform() {
  const own = state.editedSource,
    normal = (v) =>
      String(v || "")
        .replaceAll("\\", "/")
        .replace(/\/$/, "")
        .toLowerCase(),
    a = normal(state.draft?.sources[own]);
  return (
    platformNames.find(
      (id) =>
        id !== own &&
        a &&
        normal(state.draft?.sources[id]) &&
        (a === normal(state.draft.sources[id]) ||
          a.startsWith(normal(state.draft.sources[id]) + "/") ||
          normal(state.draft.sources[id]).startsWith(a + "/")),
    ) || "其他平台"
  );
}
window.addEventListener("resize", alignPaths);
document.fonts.ready.then(alignPaths);
function button(id, label, primary = false, disabled = false) {
  return `<button id="${id}" ${primary ? 'class="primary"' : ""} ${disabled ? "disabled" : ""}>${label}</button>`;
}
function error(place) {
  return state.errors[place]
    ? `<p class="error" role="alert">${esc(state.errors[place])} ${button("retry-" + place, "重试")}</p>`
    : "";
}
async function action(place, label, fn, rerender = true) {
  if (state.busy) return;
  state.busy = true;
  state.errors[place] = "";
  (state.retries ||= {})[place] = () => action(place, label, fn, rerender);
  if (rerender) render();
  try {
    await fn();
  } catch (e) {
    const field =
      place === "settings"
        ? {
            PORT_INVALID: "network-port",
            PUBLIC_URL_INVALID: "public-url",
            LAN_URL_REQUIRED: "public-url",
            ALLOWED_HOST_INVALID: "hosts",
            ALLOWED_ORIGIN_INVALID: "origins",
            INSTANCE_SOURCE_OVERLAP: state.editedSource,
            SOURCE_ROOT_OVERLAP: state.editedSource,
          }[e.code]
        : null;
    if (field) {
      (state.fieldErrors ||= {})[field] = humanError(e, overlappingPlatform());
    } else state.errors[place] = label + "失败：" + humanError(e);
  } finally {
    state.busy = false;
    if (rerender) render();
  }
}
function bind(id, fn) {
  const el = $(id);
  if (el) el.onclick = fn;
}
function selectedChange() {
  state.selected = [
    ...document.querySelectorAll("[data-platform]:checked"),
  ].map((e) => e.dataset.platform);
  localStorage.setItem("manager_selected", JSON.stringify(state.selected));
  const b = $("update-start");
  b.textContent = updateLabel(state.selected);
  b.disabled = !state.selected.length || !running(state.status) || state.busy;
}
function summary() {
  const s = state.scan,
    c = s.changes || s.counts || s;
  return `新增 ${n(c.worksAdded || 0)} · 更新 ${n(c.worksUpdated || 0)} · 移除 ${n(c.worksDeleted || 0)} · 作品总数 ${n(state.status.counts?.works || 0)}`;
}
function update() {
  if (
    state.config &&
    !Object.values(state.config.value.sources || {}).some(Boolean)
  )
    return `<section><h2>先设置平台目录</h2><div class="actions">${button("go-settings", "去设置", true)}</div></section>`;
  const active = running(state.status),
    s = state.scan,
    p = scanProgress(s),
    uptime = duration(
      Math.max(0, Date.now() - (state.status.startedAtMs || Date.now())),
    );
  return `<section><div class="row between"><div class="row"><span class="${active ? "ok" : "faint"}">●</span><strong>${active ? "服务运行中" : "服务已停止"}</strong>${active ? `<span class="mono">${esc(state.config?.value.listenAddress || "127.0.0.1")}:${state.config?.value.port || ""}</span>${button("copy-address", "复制")}<span class="muted">已运行 ${uptime}</span>` : ""}</div><div class="row">${active ? button("restart", "重启", false, state.busy) + button("stop", "停止", false, state.busy) : button("start", "启动", true, state.busy)}</div></div>${error("service")}</section>
<section id="scan-section"><div class="row between"><h2>${s.running ? (state.cancelRequested ? "正在停止" : scanPhase(s)) : "更新图库"}</h2><span class="muted">${s.running ? "已用时 " + duration(Date.now() - s.startedAtMs) : s.finishedAtMs ? "上次更新 " + clock(s.finishedAtMs) + " · 用时 " + duration(s.elapsedMs || s.finishedAtMs - s.startedAtMs) : "还没有更新过"}</span></div>
${s.running ? `<div class="row between progress-summary"><span>${p.active.length > 1 ? "同时更新 " + p.active.length + " 个平台" : esc(p.current || "正在准备")} · 已完成 ${p.done.filter((v) => ["COMPLETE", "INCREMENTAL_COMPLETE"].includes(v.status)).length} / ${p.selected.length}</span><span>${p.percent === null ? "" : p.percent + "%"}</span></div><progress ${p.percent === null ? "" : `value="${p.percent}" max="100"`}></progress><div>已检查 ${n(p.checked)}${p.total ? " / " + n(p.total) : ""} · ${summary().split(" · ").slice(0, 3).join(" · ")}</div>` : `<div class="row select-actions">${button("select-all", "全选")}${button("select-none", "清空")}</div>`}
<div class="platforms">${platformNames.map((id) => `<label><input type="checkbox" data-platform="${id}" ${state.selected.includes(id) ? "checked" : ""} ${s.running || !active ? "disabled" : ""}><span>${id}</span><small>${s.running ? (p.done.some?.((v) => (v.platformId || v.id) === id && ["COMPLETE", "INCREMENTAL_COMPLETE"].includes(v.status)) ? "✓ +" + n(p.done.find((v) => (v.platformId || v.id) === id)?.platformChanges?.worksAdded || 0) : (s.activePlatforms || []).includes(id) ? "进行中" : p.selected.includes(id) ? "等待" : "未选择") : n(state.counts[id] || 0)}</small></label>`).join("")}</div>
<div class="actions">${s.running ? button("scan-stop", state.cancelRequested ? "正在停止" : "停止", false, state.busy || state.cancelRequested) : button("update-start", updateLabel(state.selected), true, state.busy || !active || !state.selected.length) + button("full-start", "全部重新扫描…", false, state.busy || !active)}</div>${error("scan")}</section>
<section><h2>上次结果</h2><p>${summary()}</p>${s.failure ? `<p class="error">更新没有完成：${humanError(s.failure)} ${button("issue-view", "查看 ›")}</p>` : ""}${scanIssues(
    s,
  )
    .map(
      (issue) =>
        `<div class="row between issue"><span>⚠ ${esc(issue.text)}</span><button data-issue="${issue.code}">查看 ›</button></div>`,
    )
    .join("")}</section>`;
}
function segment(key, items, value) {
  return `<div class="segment">${items.map(([v, l]) => `<button data-${key}="${v}" aria-pressed="${String(v) === String(value)}">${l}</button>`).join("")}</div>`;
}
function access() {
  const a = state.access;
  if (!a) return `<section aria-busy="true">${error("access")}</section>`;
  return `<section><div class="row between"><label class="row">封禁功能<input id="blocking" class="switch" type="checkbox" role="switch" ${a.enabled !== false ? "checked" : ""} ${state.busy ? "disabled" : ""}></label>${segment(
    "period",
    [
      [1, "今天"],
      [7, "7 天"],
      [30, "30 天"],
    ],
    state.period,
  )}</div>${a.clients.length ? "<table><thead>" : '<p class="muted">这段时间没有访问记录</p>'}${a.clients.length ? `<tr>${["地址", "客户端", "请求数", "错误数", "最近访问", "操作"].map((v) => "<th>" + v + "</th>").join("")}</tr></thead><tbody>${a.clients.map((c) => `<tr><td class="mono">${esc(c.address)}</td><td>${c.local ? "本机" : c.agent === "Venera" ? "Venera" : "浏览器"}</td><td>${n(c.requests)}</td><td class="${c.errors ? "err" : ""}">${n(c.errors)}</td><td>${clock(c.lastSeenAtMs)}</td><td>${c.local ? "本机" : `${c.blocked ? "<span>已封禁</span> " : ""}<button data-block="${c.id}" data-blocked="${!c.blocked}">${c.blocked ? "解除" : "封禁"}</button>`}</td></tr>`).join("")}</tbody></table>` : ""}${error("access")}</section>`;
}
function settings() {
  if (!state.draft)
    return `<section aria-busy="true">${error("settings")}</section>`;
  const c = state.draft;
  return `<section><h2>平台目录</h2>${platformNames.map((id) => `<div class="setting-row"><label>${id}</label><span class="path" title="${esc(c.sources[id])}">${esc(c.sources[id])}</span><button data-pick="${id}">更改…</button></div>${state.fieldErrors?.[id] ? '<p class="error">' + esc(state.fieldErrors[id]) + "</p>" : ""}`).join("")}</section>
<section><h2>全部文件</h2>${(c.fileBrowserRoots || []).map((r, i) => `<div class="setting-row"><input data-root-name="${i}" aria-label="目录名称" value="${esc(r.name)}"><span class="path">${esc(r.path)}</span><div class="row"><button data-root-pick="${i}">更改…</button><button data-root-remove="${i}">移除</button></div></div>`).join("")}<div class="actions">${button("root-add", "＋ 添加目录")}</div></section>
<section class="network"><h2>网络</h2><label><span>谁能访问</span><select id="network-mode"><option value="local" ${c.mode === "local" ? "selected" : ""}>仅本机</option><option value="lan" ${c.mode === "lan" ? "selected" : ""}>局域网</option><option value="public" ${c.mode === "public" ? "selected" : ""}>公网</option></select></label><label><span>端口</span><input id="network-port" type="number" min="1" max="65535" value="${c.port}"></label><label><span>对外地址</span><input id="public-url" type="url" value="${esc(c.publicUrl || "")}" style="flex:1"></label><details><summary>高级</summary><label for="hosts">允许的 Host</label><textarea id="hosts" rows="2">${esc((c.allowedHosts || []).join("\n"))}</textarea><label for="origins">允许的 Origin</label><textarea id="origins" rows="2">${esc((c.allowedOrigins || []).join("\n"))}</textarea><label for="short-links">短链</label><textarea id="short-links" rows="3">${esc(
    Object.entries(c.shortLinks || {})
      .map(([k, v]) => k + " " + v)
      .join("\n"),
  )}</textarea></details>${error("settings")}</section>`;
}
function findings() {
  const f = state.findings;
  if (!f) return "";
  return `<div class="actions"><select id="finding-type" aria-label="问题类型"><option value="">全部问题</option>${Object.entries(
    reasons,
  )
    .map(
      ([v, l]) =>
        `<option value="${v}" ${state.findingType === v ? "selected" : ""}>${l}</option>`,
    )
    .join(
      "",
    )}</select>${button("export-findings", "导出")}</div>${f.items.map((row) => `<div class="finding"><div>${esc(reasons[row.code] || "作品需要检查")}</div><div class="row"><span class="muted">${esc(row.platformId + " / " + row.relativePath.replaceAll("\\", " / ").replaceAll("/", " / "))}</span><button data-finding="${row.index}">在资源管理器中显示</button></div></div>`).join("")}${f.total > f.items.length ? '<p class="muted">共 ' + n(f.total) + " 个问题</p>" : ""}`;
}
function diagnose() {
  const v = state.validation || {};
  return `<div class="diagnose"><section><div class="row between"><h2>日志</h2>${button("logs-dir", "打开日志目录")}</div><div class="row log-actions">${segment(
    "level",
    [
      ["", "全部"],
      ["warn", "警告"],
      ["error", "错误"],
    ],
    state.logLevel || "",
  )}<input id="log-query" aria-label="搜索日志" placeholder="搜索日志" value="${esc(state.logQuery || "")}"></div><div id="log-lines" tabindex="0"></div>${error("logs")}</section><div class="tools"><section><h2>检查图库</h2><p class="muted">${v.finishedAtMs ? "上次检查 " + clock(v.finishedAtMs) + " · 发现 " + n(v.total || 0) + " 个问题" : v.running ? "正在检查 · 已检查 " + n(v.works || 0) + " 个作品" : "还没有检查过"}</p><div class="row">${button("validation-start", "开始检查", true, state.busy || v.running)}${button("validation-view", "查看问题", false, !v.id)}</div>${findings()}${error("validation")}</section><section><div class="row between"><h2>运行环境</h2>${button("environment-check", "重新检查", false, state.busy || state.environmentLoading)}</div><div class="environment">${[
    { tool: "magick" },
    { tool: "ffmpeg" },
    ...platformNames.map((platform) => ({ platform })),
  ]
    .map((x) => ({
      ...x,
      available: state.environment?.checks?.find(
        (c) => c.platform === x.platform && c.tool === x.tool,
      )?.available,
    }))
    .map(
      (x) =>
        `<div><span class="${x.available === undefined ? "faint" : x.available ? "ok" : "err"}">${x.available === undefined ? "…" : x.available ? "✓" : "×"}</span> ${esc(x.platform || { ffmpeg: "FFmpeg", magick: "ImageMagick" }[x.tool] || x.tool)}</div>`,
    )
    .join(
      "",
    )}</div>${error("environment")}</section><section><h2>缓存</h2><p class="muted">缩略图缓存 ${((state.storage?.cache.bytes || 0) / 1048576).toFixed(1)} MB，清理后会在浏览时重新生成</p>${button("cache-clear", "清理缓存…", false, state.busy)}${error("cache")}</section></div></div>`;
}
function saveBar() {
  const count =
    state.page === "settings" && state.draft && state.config
      ? changes(state.config.value, state.draft)
      : 0;
  const restart =
    count &&
    running(state.status) &&
    requiresRestart(state.config.value, state.draft);
  $("save-bar").hidden = !count;
  patchHTML(
    $("save-bar"),
    count
      ? `<div>${count} 项改动未保存${restart ? '<div class="muted">保存后会重启服务</div>' : ""}</div><div class="row">${button("discard", "放弃")}${button("save", restart ? "保存并重启" : "保存", true, state.busy)}</div>`
      : "",
  );
  bind("discard", () => {
    state.draft = structuredClone(state.config.value);
    state.fieldErrors = {};
    render();
  });
  bind("save", () => action("settings", "保存设置", save));
}
function confirm(text, actions) {
  const d = $("confirmation"),
    previous = document.activeElement;
  $("confirm-text").textContent = text;
  $("confirm-actions").replaceChildren();
  for (const [label, fn] of actions) {
    const b = document.createElement("button");
    b.textContent = label;
    if (label === "取消") b.autofocus = true;
    else if (label === "开始" || label === "清理" || label === "保存并重启")
      b.className = "primary";
    b.onclick = () => {
      d.close();
      previous?.focus();
      fn?.();
    };
    $("confirm-actions").append(b);
  }
  d.oncancel = () => previous?.focus();
  d.showModal();
  [...$("confirm-actions").children]
    .find((b) => b.textContent === "取消")
    ?.focus();
}
async function go(page) {
  if (page === state.page) return;
  if (state.page === "settings" && changes(state.config.value, state.draft)) {
    confirm(`有 ${changes(state.config.value, state.draft)} 项改动未保存。`, [
      [
        running(state.status) &&
        requiresRestart(state.config.value, state.draft)
          ? "保存并重启"
          : "保存",
        () =>
          action("settings", "保存设置", async () => {
            await save();
            state.page = page;
            await refreshPage();
          }),
      ],
      [
        "放弃改动",
        () => {
          state.draft = structuredClone(state.config.value);
          state.page = page;
          void refreshPage();
        },
      ],
      ["取消"],
    ]);
    return;
  }
  state.page = page;
  history.replaceState({}, "", "#" + page);
  render();
  await refreshPage();
}
async function save() {
  const restart =
    running(state.status) && requiresRestart(state.config.value, state.draft);
  state.fieldErrors = {};
  state.draft = networkDraft(state.draft);
  await admin("config.validate", { value: state.draft });
  await admin("config.save", {
    value: state.draft,
    revision: state.config.revision,
    confirm: true,
  });
  if (restart) await call("restart");
  state.config = await admin("config.read");
  state.draft = structuredClone(state.config.value);
  await refreshStatus();
}
async function refreshStatus() {
  state.status = await call("status");
  state.scan = await admin("scan.status");
  state.errors.service = "";
  if (!state.scan.running) state.cancelRequested = false;
  state.counts = Object.fromEntries(
    (
      state.status.generations?.find(
        (g) => g.id === state.status.loadedGenerationId,
      )?.platforms || []
    ).map((p) => [p.id, p.works]),
  );
  const counts = state.status.platforms;
  if (Array.isArray(counts))
    state.counts = Object.fromEntries(counts.map((p) => [p.id, p.works || 0]));
}
async function loadAccess() {
  state.access = await admin("access.read", { days: state.period });
}
function renderLogs() {
  const el = $("log-lines");
  if (!el) return;
  const rows = logRows(state.log, state.config?.value.sources);
  state.openLogs ||= new Set();
  patchHTML(
    el,
    rows.length
      ? rows
          .map(
            (r, i) =>
              `<details class="log-row" data-log="${i}" ${state.openLogs.has(r.raw) ? "open" : ""}><summary><time class="mono">${esc(r.time)}</time><span class="${r.level === "error" ? "err" : r.level === "warn" ? "warn" : "faint"}">${r.levelName}</span><span>${esc(r.summary)}</span></summary><pre>${esc(r.raw)}</pre></details>`,
          )
          .join("")
      : '<p class="muted">还没有日志</p>',
  );
  for (const d of el.querySelectorAll("[data-log]"))
    d.ontoggle = () => {
      const raw = rows[Number(d.dataset.log)].raw;
      if (d.open) state.openLogs.add(raw);
      else state.openLogs.delete(raw);
    };
  el.scrollTop =
    state.logFollow === false ? state.logScrollTop || 0 : el.scrollHeight;
  el.onscroll = () => {
    state.logScrollTop = el.scrollTop;
    state.logFollow = el.scrollHeight - el.clientHeight - el.scrollTop < 32;
  };
}
let logSerial = 0;
async function readLogs() {
  const serial = ++logSerial,
    query = state.logQuery || "",
    level = state.logLevel || "";
  const logs = await admin("logs.list"),
    texts = [];
  for (const item of logs.items.slice(0, 3))
    texts.push(
      (await admin("logs.read", { name: item.name, raw: true, query, level }))
        .text,
    );
  if (serial === logSerial) state.log = texts.join("\n");
}
async function refreshPage() {
  try {
    if (state.page === "access") await loadAccess();
    if (state.page === "diagnose") {
      state.validation = await admin("validation.status");
      state.storage = await admin("storage.read");
      await readLogs();
      if (!state.environment && !state.environmentLoading) {
        state.environmentLoading = true;
        admin("diagnostics.run")
          .then((value) => {
            state.environment = value;
            state.errors.environment = "";
          })
          .catch((e) => {
            state.errors.environment = "检查运行环境失败：" + humanError(e);
          })
          .finally(() => {
            state.environmentLoading = false;
            if (state.page === "diagnose") render();
          });
      }
    }
    render();
  } catch (e) {
    state.errors[state.page === "diagnose" ? "logs" : state.page] =
      humanError(e);
    render();
  }
}
async function viewFindings() {
  state.findings = await admin("validation.findings", {
    id: state.validation.id,
    check: state.findingType || undefined,
  });
  render();
}
function render() {
  const active = document.activeElement,
    focusId = active?.id,
    data = active?.dataset
      ? Object.entries(active.dataset).find(([k]) =>
          ["page", "platform", "level", "period", "block"].includes(k),
        )
      : null;
  const log = $("log-lines");
  if (log) {
    state.logScrollTop = log.scrollTop;
    state.logFollow = log.scrollHeight - log.clientHeight - log.scrollTop < 32;
  }
  patchHTML(
    document.querySelector("nav"),
    pages
      .map(
        ([id, label]) =>
          `<button data-page="${id}" ${state.page === id ? 'aria-current="page"' : ""}>${navIcon(id)}${label}</button>`,
      )
      .join(""),
  );
  document
    .querySelectorAll("[data-page]")
    .forEach((b) => (b.onclick = () => void go(b.dataset.page)));
  $("title").textContent = pages.find((p) => p[0] === state.page)[1];
  $("side-status").textContent = running(state.status)
    ? "服务运行中 · 端口 " + (state.config?.value.port || "")
    : "服务已停止";
  patchHTML($("page"), { update, access, settings, diagnose }[state.page](), {
    preserveChildren: ["log-lines"],
  });
  $("page").setAttribute("aria-busy", "false");
  if (state.page === "settings")
    for (const [id, message] of Object.entries(state.fieldErrors || {})) {
      const field = $(id);
      if (field)
        field
          .closest("label")
          ?.insertAdjacentHTML(
            "afterend",
            '<p class="error" role="alert">' + esc(message) + "</p>",
          );
    }
  saveBar();
  alignPaths();
  renderLogs();
  bind("go-settings", () => void go("settings"));
  bind("issue-view", () => void go("diagnose"));
  document.querySelectorAll("[data-issue]").forEach(
    (b) =>
      (b.onclick = () =>
        action("validation", "查看问题", async () => {
          state.findingType = b.dataset.issue;
          await go("diagnose");
          if (state.validation?.id) await viewFindings();
        })),
  );
  for (const method of ["start", "stop", "restart"])
    bind(method, () =>
      action(
        "service",
        { start: "启动", stop: "停止", restart: "重启" }[method],
        async () => {
          await call(method);
          await refreshStatus();
        },
      ),
    );
  bind("copy-address", () =>
    action("service", "复制地址", () =>
      navigator.clipboard.writeText(
        state.config.value.publicUrl ||
          "http://127.0.0.1:" + state.config.value.port,
      ),
    ),
  );
  bind("select-all", () => {
    state.selected = [...platformNames];
    localStorage.setItem("manager_selected", JSON.stringify(state.selected));
    render();
  });
  bind("select-none", () => {
    state.selected = [];
    localStorage.setItem("manager_selected", "[]");
    render();
  });
  document
    .querySelectorAll("[data-platform]")
    .forEach((b) => (b.onchange = selectedChange));
  bind("update-start", () =>
    action("scan", "更新图库", async () => {
      await admin("scan.start", {
        confirmReadOnly: true,
        mode: "incremental",
        platformIds: state.selected,
      });
      await refreshStatus();
    }),
  );
  bind("full-start", () =>
    confirm(
      "全部重新扫描会重新读取所有作品，通常需要几十分钟。期间画廊可以正常浏览。",
      [
        [
          "开始",
          () =>
            action("scan", "更新图库", async () => {
              await admin("scan.start", {
                confirmReadOnly: true,
                mode: "full",
              });
              await refreshStatus();
            }),
        ],
        ["取消"],
      ],
    ),
  );
  bind("scan-stop", () =>
    action("scan", "停止更新", async () => {
      await admin("scan.cancel");
      state.cancelRequested = true;
      await refreshStatus();
    }),
  );
  document.querySelectorAll("[data-period]").forEach(
    (b) =>
      (b.onclick = () =>
        action("access", "读取访问记录", async () => {
          state.period = Number(b.dataset.period);
          await loadAccess();
        })),
  );
  if ($("blocking"))
    $("blocking").onchange = (e) => {
      const enabled = e.target.checked;
      void action("access", "更改封禁功能", async () => {
        await admin("access.configure", { enabled });
        await loadAccess();
      });
    };
  document.querySelectorAll("[data-block]").forEach(
    (b) =>
      (b.onclick = () =>
        action(
          "access",
          b.dataset.blocked === "true" ? "封禁" : "解除",
          async () => {
            await admin("access.block", {
              id: b.dataset.block,
              blocked: b.dataset.blocked === "true",
            });
            await loadAccess();
          },
        )),
  );
  document.querySelectorAll("[data-pick]").forEach(
    (b) =>
      (b.onclick = () =>
        action("settings", "选择目录", async () => {
          const r = await call("pickDirectory");
          if (r) {
            state.draft.sources[b.dataset.pick] = r.path || r;
            state.editedSource = b.dataset.pick;
          }
        })),
  );
  document.querySelectorAll("[data-root-pick]").forEach(
    (b) =>
      (b.onclick = () =>
        action("settings", "选择目录", async () => {
          const r = await call("pickDirectory");
          if (r)
            state.draft.fileBrowserRoots[Number(b.dataset.rootPick)].path =
              r.path || r;
        })),
  );
  document.querySelectorAll("[data-root-remove]").forEach(
    (b) =>
      (b.onclick = () => {
        state.draft.fileBrowserRoots.splice(Number(b.dataset.rootRemove), 1);
        render();
      }),
  );
  document.querySelectorAll("[data-root-name]").forEach(
    (b) =>
      (b.oninput = () => {
        state.draft.fileBrowserRoots[Number(b.dataset.rootName)].name = b.value;
        saveBar();
      }),
  );
  bind("root-add", () =>
    action("settings", "添加目录", async () => {
      const r = await call("pickDirectory");
      if (r)
        (state.draft.fileBrowserRoots ||= []).push({
          id: "folder-" + Date.now(),
          name: "新目录",
          path: r.path || r,
        });
    }),
  );
  for (const [id, key] of [
    ["network-port", "port"],
    ["public-url", "publicUrl"],
    ["network-mode", "mode"],
  ])
    if ($(id))
      $(id).oninput = () => {
        state.draft[key] = key === "port" ? Number($(id).value) : $(id).value;
        if (key === "mode")
          state.draft.listenAddress =
            state.draft.mode === "local" ? "127.0.0.1" : "0.0.0.0";
        saveBar();
      };
  for (const [id, key] of [
    ["hosts", "allowedHosts"],
    ["origins", "allowedOrigins"],
  ])
    if ($(id))
      $(id).oninput = () => {
        state.draft[key] = $(id).value.split(/\r?\n/).filter(Boolean);
        saveBar();
      };
  if ($("short-links"))
    $("short-links").oninput = () => {
      state.draft.shortLinks = Object.fromEntries(
        $("short-links")
          .value.split(/\r?\n/)
          .filter(Boolean)
          .map((s) => {
            const i = s.indexOf(" ");
            return [s.slice(0, i), s.slice(i + 1)];
          }),
      );
      saveBar();
    };
  bind("logs-dir", () =>
    action("logs", "打开日志目录", () => call("openDirectory", "logs")),
  );
  document.querySelectorAll("[data-level]").forEach(
    (b) =>
      (b.onclick = () =>
        action("logs", "读取日志", async () => {
          state.logLevel = b.dataset.level;
          await readLogs();
        })),
  );
  if ($("log-query"))
    $("log-query").oninput = (e) => {
      state.logQuery = e.target.value;
      clearTimeout(state.logTimer);
      state.logTimer = setTimeout(async () => {
        try {
          await readLogs();
          renderLogs();
        } catch (error) {
          state.errors.logs = "读取日志失败：" + humanError(error);
          render();
        }
      }, 150);
    };
  bind("validation-start", () =>
    action("validation", "检查图库", async () => {
      state.validation = await admin("validation.start", {
        confirmReadOnly: true,
      });
    }),
  );
  bind("validation-view", () => action("validation", "查看问题", viewFindings));
  if ($("finding-type"))
    $("finding-type").onchange = (e) =>
      action("validation", "查看问题", async () => {
        state.findingType = e.target.value;
        await viewFindings();
      });
  document
    .querySelectorAll("[data-finding]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          action("validation", "显示问题", () =>
            call("openFinding", state.validation.id, Number(b.dataset.finding)),
          )),
    );
  bind("export-findings", () =>
    action("validation", "导出问题", async () => {
      await admin("validation.export", {
        id: state.validation.id,
        format: "csv",
      });
      await call("openDirectory", "reports");
    }),
  );
  bind("environment-check", () =>
    action("environment", "检查运行环境", async () => {
      state.environment = await admin("diagnostics.run");
    }),
  );
  bind("cache-clear", () =>
    confirm("缩略图缓存会被删除，浏览时会重新生成，这段时间图片加载会变慢。", [
      [
        "清理",
        () =>
          action("cache", "清理缓存", async () => {
            const was = running(state.status);
            if (was) await call("stop");
            await admin("cache.clear", { confirm: true });
            if (was) await call("start");
            await refreshStatus();
            state.storage = await admin("storage.read");
          }),
      ],
      ["取消"],
    ]),
  );
  for (const place of Object.keys(state.errors))
    bind("retry-" + place, () =>
      place === "service"
        ? action("service", "读取服务状态", refreshStatus)
        : state.retries?.[place]
          ? state.retries[place]()
          : void refreshPage(),
    );
  if (active?.isConnected) return;
  if (focusId) $(focusId)?.focus({ preventScroll: true });
  else if (data)
    document
      .querySelector(`[data-${data[0]}="${CSS.escape(data[1])}"]`)
      ?.focus({ preventScroll: true });
}
$("open-gallery").onclick = () =>
  action("service", "打开画廊", () => call("openGallery"));
const poll = serialPoll(async () => {
  if (
    state.busy ||
    state.page === "settings" ||
    $("confirmation").open ||
    document.activeElement?.closest("#log-lines")
  )
    return;
  try {
    await refreshStatus();
    if (state.page === "access") await loadAccess();
    if (state.page === "diagnose") {
      state.validation = await admin("validation.status");
      await readLogs();
    }
    render();
  } catch (e) {
    state.errors.service = "读取服务状态失败：" + humanError(e);
    render();
  }
});
async function boot() {
  state.config = await admin("config.read");
  state.draft = structuredClone(state.config.value);
  await refreshStatus();
  await refreshPage();
  render();
  setInterval(poll, 1500);
  window.__managerCandidate = {
    state,
    render,
    go,
    refreshStatus,
    refreshPage,
    theme,
    confirm,
    alignPaths,
    poll,
  };
}
boot().catch((e) => {
  state.errors.service = "读取服务状态失败：" + humanError(e);
  render();
});
