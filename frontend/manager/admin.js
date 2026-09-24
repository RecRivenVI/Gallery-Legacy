// Privileged UI talks to local application use cases, never SQLite or shell commands.
import { renderValidation } from "./validation.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);
const number = (value) => value == null ? "—" : Number(value).toLocaleString("zh-CN");
const date = (value) => value ? new Date(value).toLocaleString("zh-CN") : "—";
const bytes = (value) => {
  if (value == null) return "—";
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
};
const size = (value) => bytes(value);
const json = (value) => JSON.stringify(value, null, 2);
const button = (id, label, className = "") => `<button id="${esc(id)}" class="${esc(className)}">${esc(label)}</button>`;
const section = (title, body, className = "") => `<section class="panel ${esc(className)}"><div class="panel-heading"><h2>${esc(title)}</h2></div>${body}</section>`;
const code = (value) => /^[A-Z][A-Z0-9_]{1,63}$/.test(String(value || "")) ? String(value) : "";
const SELECTED_PLATFORMS_STORAGE_KEY = "gallery_manager_selected_platforms";

function normalizedPlatformIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((platform) => typeof platform === "string" ? platform : platform?.id)
    .filter((platformId) => typeof platformId === "string" && platformId.length > 0))];
}

function readSelectedPlatformIds(validIds) {
  let stored = null;
  try {
    const raw = localStorage.getItem(SELECTED_PLATFORMS_STORAGE_KEY);
    if (raw !== null) stored = JSON.parse(raw);
  } catch {}
  if (!Array.isArray(stored)) return [...validIds];
  const allowed = new Set(validIds);
  return [...new Set(stored.filter((platformId) => allowed.has(platformId)))];
}

function saveSelectedPlatformIds(platformIds) {
  try { localStorage.setItem(SELECTED_PLATFORMS_STORAGE_KEY, JSON.stringify(platformIds)); } catch {}
}

const explain = (value) => ({
  CONFIG_REVISION_CHANGED: "配置已被其他操作修改，请重新读取后保存。",
  STOP_RUNTIME_BEFORE_CLEANUP: "请先停止服务和扫描，再清理。",
  SOURCE_BINDING_MISMATCH: "此版本的图库根与配置不匹配，请检查配置或重新全库构建。",
  SCAN_IN_USE: "已有扫描正在运行。",
  SCAN_NOT_RUNNING: "当前没有正在运行的扫描。",
  SCAN_COMMIT_IN_PROGRESS: "已经进入发布提交阶段，不能取消。",
  SCAN_PLATFORM_SELECTION_EMPTY: "至少选择一个平台后才能更新图库。",
  SCAN_SCOPE_EMPTY: "更新范围为空，请重新选择平台。",
  SCAN_BASELINE_REQUIRED: "指定范围的增量更新需要已有可用检查点，请先完成一次全库更新。",
  SCAN_MODE_INVALID: "更新方式无效，请重新选择。",
  INVALID_PLATFORM: "所选平台已不存在，请刷新配置后重试。",
  AUTHOR_DIRECTORY_INVALID: "作者目录名无效或不存在，请重新选择。",
  SCAN_AUTHOR_PLATFORM_REQUIRED: "作者范围只能选择一个平台。",
  LIVE_MODE_RESTART_REQUIRED: "实时提交模式变化后需要先重启服务。",
  RUNTIME_OFFLINE: "服务未启动，请先到概览启动服务。",
  INSTANCE_IN_USE: "同实例已有维护任务，请稍后再试。",
  FILE_ROOT_INVALID: "文件浏览根配置无效，请检查 ID 和绝对路径。",
  LISTEN_ADDRESS_FORBIDDEN: "监听配置不合法，请检查访问模式和 Host 列表。",
  INSTANCE_LAYOUT_CHANGE_REQUIRES_NEW_INSTANCE: "不能在此迁移实例目录，请使用独立的新实例。",
  VALIDATION_IN_USE: "验证正在运行，请等待完成或请求取消。",
  VALIDATION_NOT_RUNNING: "当前没有正在运行的验证。",
  VALIDATION_QUERY_INVALID: "验证结果筛选条件无效。",
  VALIDATION_FINDING_MISSING: "找不到该验证问题，可能报告已清理。",
  CACHE_ORPHANS_NOT_FOUND: "没有可清理的孤儿缓存。",
}[String(value || "")] || code(value) || "操作失败");

function stateLabel(value) {
  return ({
    PASS: "通过", ISSUES: "发现问题", READY: "就绪", FAILED: "失败", CANCELLED: "已取消",
    COMPLETED: "已完成", RUNNING: "运行中", IDLE: "空闲", STARTING: "启动中", STOPPING: "停止中",
    STOPPED: "已停止", SCANNING: "扫描中", BUILDING_SEARCH: "构建 Search", VALIDATING: "校验中",
    PUBLISHING: "发布中", PREPARING: "准备中",
  }[String(value || "")] || String(value || "—"));
}

function advanced(value, label = "查看高级数据") {
  return `<details class="advanced-data"><summary>${esc(label)}</summary><pre>${esc(json(value))}</pre></details>`;
}

function resultSummary(value, kind = "operation") {
  if (value == null) return `<div class="result-summary"><strong>没有返回结果</strong></div>`;
  if (kind === "diagnostics" || ["PASS", "ISSUES"].includes(value.state)) {
    const checks = Array.isArray(value.checks) ? value.checks.length : 0;
    const findings = Array.isArray(value.findings) ? value.findings.length : Object.values(value.counts || {}).reduce((a, b) => a + Number(b || 0), 0);
    return `<div class="result-summary"><strong class="status-${value.state === "PASS" ? "success" : "warning"}">诊断${stateLabel(value.state)}</strong><span>${checks ? `${number(checks)} 项检查` : "已完成检查"} · ${number(findings)} 项发现</span>${value.report ? `<span class="result-note">报告已保存：<code>${esc(value.report)}</code></span>` : ""}</div>`;
  }
  if (kind === "validation") {
    const total = Number(value.total || 0);
    return `<div class="result-summary"><strong>验证${stateLabel(value.state)}</strong><span>${number(value.works)} 件作品 · ${number(value.authors)} 位作者 · ${number(total)} 项发现</span></div>`;
  }
  if (kind === "scope" || Object.hasOwn(value, "catalogModified")) {
    return `<div class="result-summary"><strong>只读抽查完成</strong><span>${esc(value.platformId || "指定范围")} · ${number(value.works)} 件作品 · ${number(value.media)} 个实际媒体 · Catalog ${value.catalogModified ? "已修改" : "未修改"}</span>${value.truncated ? '<span class="result-note">已达到抽查上限，结果不代表完整性</span>' : ""}</div>`;
  }
  if (Object.hasOwn(value, "valid") || kind === "generation") {
    return `<div class="result-summary"><strong class="status-${value.valid === false ? "error" : "success"}">${value.valid === false ? "校验失败" : "校验通过"}</strong><span>${value.generationId ? `generation ${esc(value.generationId)}` : ""}${value.works != null ? ` · ${number(value.works)} 件作品` : ""}${value.published ? " · 已发布" : ""}</span></div>`;
  }
  if (value.requested) return `<div class="result-summary"><strong>已提交请求</strong><span>Runtime 将在安全检查点处理。</span></div>`;
  if (value.cleared) return `<div class="result-summary"><strong>清理完成</strong><span>${value.bytes ? `释放 ${bytes(value.bytes)}` : "实例缓存已更新"}</span></div>`;
  if (value.removed != null) return `<div class="result-summary"><strong>处理完成</strong><span>移除 ${number(value.removed)} 项${value.bytes ? ` · ${bytes(value.bytes)}` : ""}</span></div>`;
  if (Array.isArray(value.items)) return `<div class="result-summary"><strong>读取完成</strong><span>${number(value.items.length)} 项</span></div>`;
  const error = code(value.error?.code || value.error);
  return `<div class="result-summary"><strong>${error ? `返回 ${esc(error)}` : "操作完成"}</strong></div>`;
}

function scanSummary(scan = {}) {
  const metric = (label, value, formatter = number) => `<div class="scan-metric"><span>${esc(label)}</span><strong>${esc(value == null ? "—" : formatter(value))}</strong></div>`;
  const memory = scan.memory || {};
  const metadata = Object.entries(scan.metadataStates || {}).map(([key, value]) => `${key} ${number(value)}`).join(" · ") || "—";
  const duration = scan.elapsedMs == null ? "—" : `${(Number(scan.elapsedMs) / 1000).toFixed(1)} 秒`;
  const throughput = scan.throughput == null ? "—" : `${Number(scan.throughput).toFixed(1)} 件/秒`;
  const current = scan.progress?.current ?? scan.current ?? scan.observedWorks;
  const total = scan.progress?.total ?? scan.total ?? scan.expectedWorks;
  const progress = scan.running ? `<div class="scan-progress"><span>当前进度</span><progress ${total == null || Number(total) <= 0 ? "" : `value="${Math.max(0, Number(current) || 0)}" max="${Number(total)}"`}></progress><small>${current == null ? "—" : number(current)}${total == null || Number(total) <= 0 ? "" : ` / ${number(total)}`}</small></div>` : "";
  const active = scan.activePlatforms?.length
    ? scan.activePlatforms.join("、")
    : scan.currentPlatform
      || scan.scope?.platformIds?.length && scan.scope.platformIds.join("、")
      || scan.platformIds?.length && scan.platformIds.join("、")
      || "全部平台";
  const stageLabels = { preparing: "准备", catalog: "构建 Catalog", search: "构建 Search", validation: "校验", publication: "发布", complete: "完成" };
  const phase = scan.stage ? `阶段：${stageLabels[scan.stage] || scan.stage}` : scan.phase ? `阶段：${stateLabel(scan.phase)}` : scan.applyingGeneration ? "正在应用扫描结果" : "";
  const storage = (scan.platforms || []).filter(p=>p.storage).map(p=>`${p.platformId}: ${p.storage.type.toUpperCase()} · I/O ${p.storage.ioLimit} · 预取 ${p.storage.workWindow}`).join("；");
  const search = scan.search || {};
  const searchLine = search.buildMode
    ? `Search：${search.buildMode} · 复用 ${number(search.reusedWorks)} · 更新 ${number(search.updatedWorks)} · 移除 ${number(search.removedWorks)}${search.fallbackReason ? ` · 回退 ${search.fallbackReason}` : ""}`
    : "";
  return `<div class="scan-summary"><div class="result-summary"><strong>${esc(stateLabel(scan.state))}</strong><span>${esc(active)}</span>${phase ? `<span>${esc(phase)}</span>` : ""}${scan.failure?.code ? `<span class="status-error">${esc(scan.failure.code)}</span>` : ""}${scan.applyError?.code ? `<span class="status-error">应用失败：${esc(scan.applyError.code)}</span>` : ""}</div>${progress}<div class="scan-metrics">${metric("观察作品", scan.observedWorks)}${metric("已入库作品", scan.indexedWorks)}${metric("实际媒体", scan.actualMedia)}${metric("耗时", duration, String)}${metric("吞吐", throughput, String)}${metric("RSS", memory.rss == null ? null : bytes(memory.rss))}${metric("Heap", memory.heapUsed == null ? null : bytes(memory.heapUsed))}</div><p class="scan-metadata">Metadata：${esc(metadata)}</p>${searchLine ? `<p class="scan-search">${esc(searchLine)}</p>` : ""}${storage ? '<p class="scan-storage">'+esc(storage)+'</p>' : ''}</div>`;
}

function output(value, kind = "operation", label = "查看高级数据") {
  return `<div class="result-card">${resultSummary(value, kind)}${advanced(value, label)}</div>`;
}

function messageElement(notice, text, level = "info") {
  notice.className = `notice ${level}`;
  notice.textContent = text;
  notice.setAttribute("aria-live", level === "error" ? "assertive" : "polite");
}

function summaryEvents(events) {
  const rows = Array.isArray(events) ? events : [];
  const counts = rows.reduce((result, item) => {
    const key = `${item.resource || "请求"} · ${item.status || "—"}`;
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
  const list = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return `<div class="result-card"><div class="result-summary"><strong>最近活动</strong><span>${number(rows.length)} 条匿名事件</span></div>${list.length ? `<ul class="compact-list">${list.map(([key, count]) => `<li><span>${esc(key)}</span><strong>${number(count)}</strong></li>`).join("")}</ul>` : '<p class="muted">暂无活动事件。</p>'}${advanced(rows, "查看匿名事件明细")}</div>`;
}

function platformPicker(platformIds, selectedIds) {
  const selected = new Set(selectedIds);
  const allSelected = platformIds.length > 0 && platformIds.every((platformId) => selected.has(platformId));
  const options = platformIds.length
    ? platformIds.map((platformId) => `<label class="platform-option"><input type="checkbox" data-platform-id="${esc(platformId)}" ${selected.has(platformId) ? "checked" : ""}><span>${esc(platformId)}</span></label>`).join("")
    : '<p class="muted">当前配置没有可用平台。</p>';
  return `<fieldset class="platform-picker" id="scan-platform-picker"><legend>选择更新平台</legend><p class="form-help">日常更新只处理这里勾选的平台。选择会保存在本机；刷新配置后只保留仍然有效的 ID，不会把空选择静默扩大。</p><div class="platform-picker-toolbar"><button type="button" id="scan-platform-all" class="secondary" ${allSelected ? "disabled" : ""}>全选</button><button type="button" id="scan-platform-clear" class="secondary" ${selected.size ? "" : "disabled"}>清空</button><span id="scan-platform-count" class="selection-count">已选 ${number(selectedIds.length)} / ${number(platformIds.length)}</span></div><div class="platform-options" role="group" aria-label="更新平台">${options}</div><p id="scan-platform-empty" class="inline-message warning" ${selectedIds.length ? "hidden" : ""}>未选择平台，更新按钮已禁用。</p></fieldset>`;
}

export function initManagement() {
  const host = window.galleryHost;
  const overview = document.getElementById("root");
  const shell = document.createElement("section");
  shell.id = "management-shell";
  overview.before(shell);
  const tabs = {
    overview: "服务概览", config: "配置", scan: "扫描与检查", validation: "图库验证",
    generations: "数据版本", logs: "日志", access: "访问与客户端", storage: "存储", diagnostics: "诊断",
  };
  shell.innerHTML = `<aside class="manager-sidebar"><div class="manager-brand"><strong>Gallery</strong><span>管理中心</span></div><button type="button" id="manager-collapse" aria-label="折叠或展开导航" aria-expanded="true">☰</button><nav class="manager-nav" aria-label="管理器导航">${Object.entries(tabs).map(([id, label]) => `<button type="button" data-tab="${id}" title="${label}" aria-label="${label}" ${!host && id !== "overview" ? "disabled" : ""}><span class="nav-index">${Object.keys(tabs).indexOf(id) + 1}</span><b>${label}</b></button>`).join("")}</nav><p class="manager-sidebar-note">本机管理 · 图库只读</p></aside><div id="manager-notice" role="status"></div><div id="manager-panel"></div>`;
  let collapsed=false;
  try { collapsed=localStorage.getItem("gallery_manager_sidebar_collapsed")==="true"; } catch {}
  const collapse=shell.querySelector("#manager-collapse");
  function applySidebar(){document.body.classList.toggle("manager-collapsed",collapsed);collapse.setAttribute("aria-expanded",String(!collapsed));}
  applySidebar();collapse.onclick=()=>{collapsed=!collapsed;applySidebar();try{localStorage.setItem("gallery_manager_sidebar_collapsed",String(collapsed));}catch{}};
  const panel = shell.querySelector("#manager-panel");
  const notice = shell.querySelector("#manager-notice");
  let tab = "overview", busy = false, draft = null, revision = null, currentLog = null;
  let polling = false, configDirty = false, logQuery = "", logLevel = "", logFollow = true, logRaw = false, logText = "";
  let messageRevision = 0;
  let loadSerial = 0;
  let platformIds = [], selectedPlatformIds = [], scanSnapshot = {};

  function message(text, level = "info") { messageRevision += 1; messageElement(notice, text, level); }

  function setBusy(value) {
    shell.classList.toggle("is-busy", value);
    shell.setAttribute("aria-busy", String(value));
    if (value) {
      panel.querySelectorAll("button").forEach((buttonElement) => {
        if (!buttonElement.disabled) {
          buttonElement.dataset.managerEnabled = "1";
          buttonElement.disabled = true;
        }
      });
    } else {
      panel.querySelectorAll("button[data-manager-enabled]").forEach((buttonElement) => {
        buttonElement.disabled = false;
        delete buttonElement.dataset.managerEnabled;
      });
    }
  }

  function wire(id, handler) {
    const element = panel.querySelector(`#${id}`);
    if (element) element.onclick = handler;
  }

  const call = (operation, input = {}) => host.admin(operation, input);

  async function run(fn, done = null, success = "操作完成") {
    if (busy) {
      message("已有操作正在处理，请稍候。", "warning");
      return null;
    }
    busy = true;
    setBusy(true);
    message("正在处理…", "info");
    try {
      const result = await fn();
      if (done) {
        const before = messageRevision;
        await done(result);
        if (messageRevision === before) message(success, "success");
      } else message(success, "success");
      return result;
    } catch (error) {
      message(explain(error.code), "error");
      return null;
    } finally {
      busy = false;
      setBusy(false);
    }
  }

  function updateScanActionState() {
    const canStart = !busy && !scanSnapshot.running && Boolean(host) && selectedPlatformIds.length > 0;
    const start = panel.querySelector("#scan-start");
    const advancedStart = panel.querySelector("#scan-advanced-start");
    if (start) start.disabled = !canStart;
    if (advancedStart) advancedStart.disabled = !canStart;
    const all = panel.querySelector("#scan-platform-all");
    const clear = panel.querySelector("#scan-platform-clear");
    if (all) all.disabled = busy || platformIds.length === 0 || selectedPlatformIds.length === platformIds.length;
    if (clear) clear.disabled = busy || selectedPlatformIds.length === 0;
    const count = panel.querySelector("#scan-platform-count");
    if (count) count.textContent = `已选 ${number(selectedPlatformIds.length)} / ${number(platformIds.length)}`;
    const empty = panel.querySelector("#scan-platform-empty");
    if (empty) empty.hidden = selectedPlatformIds.length > 0;
  }

  function wirePlatformPicker() {
    panel.querySelectorAll("input[data-platform-id]").forEach((element) => {
      element.onchange = () => {
        selectedPlatformIds = [...panel.querySelectorAll("input[data-platform-id]:checked")].map((inputElement) => inputElement.dataset.platformId);
        saveSelectedPlatformIds(selectedPlatformIds);
        updateScanActionState();
      };
    });
    wire("scan-platform-all", () => {
      selectedPlatformIds = [...platformIds];
      saveSelectedPlatformIds(selectedPlatformIds);
      panel.querySelectorAll("input[data-platform-id]").forEach((element) => { element.checked = true; });
      updateScanActionState();
    });
    wire("scan-platform-clear", () => {
      selectedPlatformIds = [];
      saveSelectedPlatformIds(selectedPlatformIds);
      panel.querySelectorAll("input[data-platform-id]").forEach((element) => { element.checked = false; });
      updateScanActionState();
    });
    updateScanActionState();
  }

  const input = (label, field, value, type = "text", readonly = false) => `<label class="field-label"><span>${esc(label)}</span><input data-field="${esc(field)}" type="${type}" value="${esc(value)}" ${readonly ? "readonly" : ""}></label>`;

  function configForm() {
    let html = `<details class="form-section" open><summary>实例与网络</summary><div class="form-grid">${input("实例目录（布局固定）", "instanceRoot", draft.instanceRoot, "text", true)}${input("监听地址", "listenAddress", draft.listenAddress || draft.host || "127.0.0.1")}${input("端口", "port", draft.port || 18104, "number")}</div>`;
    html += `<label class="field-label"><span>访问模式</span><select data-field="mode">${["local", "lan", "public"].map((value) => `<option ${value === (draft.mode || "local") ? "selected" : ""}>${value}</option>`).join("")}</select></label>`;
    html += input("对外地址（Venera 默认地址）", "publicUrl", draft.publicUrl || "");
    html += `<label class="check-field"><input id="live-updates" type="checkbox" ${draft.liveUpdates ? "checked" : ""}><span>允许实时提交（完整作品分批入库并展示；更改后重启服务）</span></label>`;
    html += `<div class="form-grid"><label class="field-label"><span>允许的 Host（每行一项）</span><textarea data-lines="allowedHosts">${esc((draft.allowedHosts || []).join("\n"))}</textarea></label><label class="field-label"><span>允许的 Origin（每行一项）</span><textarea data-lines="allowedOrigins">${esc((draft.allowedOrigins || []).join("\n"))}</textarea></label></div></details>`;
    html += `<details class="form-section" open><summary>固定九平台物理根</summary><p class="form-help">只保存目录绑定；扫描和验证始终对真实源只读。</p>`;
    for (const id of Object.keys(draft.sources || {})) html += `<div class="path-setting">${input(id, `sources.${id}`, draft.sources[id])}<button type="button" data-pick="sources.${esc(id)}">选择目录</button></div>`;
    html += `</details><details class="form-section"><summary>独立文件浏览根</summary><p class="form-help">浏览根不进入九平台扫描，也不会被写入。</p>`;
    (draft.fileBrowserRoots || []).forEach((root, index) => { html += `<div class="root-setting"><div class="form-grid">${input("ID", `fileBrowserRoots.${index}.id`, root.id)}${input("名称", `fileBrowserRoots.${index}.name`, root.name)}${input("只读目录", `fileBrowserRoots.${index}.path`, root.path)}</div><button type="button" data-pick="fileBrowserRoots.${index}.path">选择目录</button><button type="button" class="danger" data-remove-root="${index}">移除配置</button></div>`; });
    html += `${button("add-root", "添加文件浏览根", "secondary")}</details><details class="form-section"><summary>短链与保留策略</summary><label class="field-label"><span>短链（每行：短码 = /#相对路由）</span><textarea id="short-links">${esc(Object.entries(draft.shortLinks || {}).map(([key, value]) => `${key} = ${value}`).join("\n"))}</textarea></label><div class="form-grid"><label class="check-field"><input id="retention-enabled" type="checkbox" ${draft.retention?.enabled !== false ? "checked" : ""}><span>启用保守 generation 清理</span></label>${input("未引用代最短保留小时数", "retentionHours", (draft.retention?.staleAfterMs || 86400000) / 3600000, "number")}</div></details>`;
    html += `<div class="form-actions"><p class="form-help">保存前会校验并创建私有备份；改变图库根需重新全库构建，不会修改源文件。</p>${button("config-validate", "校验", "secondary")}${button("config-save", "保存并备份", "primary")}${button("config-reload", "放弃更改 / 重新读取", "secondary")}${button("config-backups", "查看备份", "secondary")}${button("open-config", "打开配置目录", "secondary")}</div>`;
    panel.innerHTML = section("实例配置", html, "config-panel") + '<div id="config-results"></div>';
    panel.oninput = () => { configDirty = true; };

    const set = (field, value) => {
      const keys = field.split(".");
      let current = draft;
      for (const key of keys.slice(0, -1)) current = current[key] ?? (current[key] = {});
      current[keys.at(-1)] = value;
    };
    const collect = () => {
      draft.liveUpdates = panel.querySelector("#live-updates").checked;
      panel.querySelectorAll("[data-field]").forEach((element) => { if (element.dataset.field !== "retentionHours") set(element.dataset.field, element.type === "number" ? Number(element.value) : element.value); });
      delete draft.host;
      if (!draft.publicUrl) delete draft.publicUrl;
      panel.querySelectorAll("[data-lines]").forEach((element) => { const values = element.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); if (values.length) draft[element.dataset.lines] = values; else delete draft[element.dataset.lines]; });
      const links = {};
      for (const line of panel.querySelector("#short-links").value.split(/\r?\n/).filter((value) => value.trim())) {
        const at = line.indexOf("=");
        if (at < 1) throw Object.assign(new Error("Invalid link"), { code: "SHORT_LINK_INVALID" });
        links[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      }
      draft.shortLinks = links;
      draft.retention = { enabled: panel.querySelector("#retention-enabled").checked, staleAfterMs: Number(panel.querySelector('[data-field="retentionHours"]').value) * 3600000 };
    };
    panel.querySelectorAll("[data-pick]").forEach((element) => { element.onclick = () => void run(async () => { collect(); const value = await host.pickDirectory(); if (value) set(element.dataset.pick, value); configForm(); }, null, "目录已更新"); });
    panel.querySelectorAll("[data-remove-root]").forEach((element) => { element.onclick = () => { collect(); draft.fileBrowserRoots.splice(Number(element.dataset.removeRoot), 1); configForm(); message("文件浏览根已从草稿移除，请保存配置。", "info"); }; });
    wire("add-root", () => { collect(); (draft.fileBrowserRoots ??= []).push({ id: `files${draft.fileBrowserRoots.length + 1}`, name: "文件浏览", path: "" }); configForm(); message("已添加文件浏览根草稿，请选择目录并保存。", "info"); });
    wire("config-validate", () => void run(() => { collect(); return call("config.validate", { value: draft }); }, (result) => message(result.rebuildRequired ? "配置合法；图库根改变，需重新全库构建。" : "配置合法；保存后重启生效。", "success")));
    wire("config-save", () => { if (!confirm("保存并备份配置？不会修改图库；需要重启或重新构建才能生效。")) { message("已取消保存。", "info"); return; } void run(() => { collect(); return call("config.save", { value: draft, revision, confirm: true }); }, (result) => { draft = result.value; revision = result.revision; configDirty = false; message(result.rebuildRequired ? "已保存并备份；先重新全库构建，再重启服务。" : "已保存并备份；请重启服务应用配置。", "success"); }); });
    wire("config-reload", () => { if (!confirm("放弃未保存更改？")) { message("已取消，草稿仍保留。", "info"); return; } configDirty = false; void load({ force: true }); });
    wire("open-config", () => void run(() => host.openDirectory("config"), null, "已打开配置目录"));
    wire("config-backups", () => void run(() => call("config.backups"), (result) => { const element = panel.querySelector("#config-results"); element.innerHTML = section("配置备份", result.items?.length ? `<div class="backup-list">${result.items.map((backup) => `<div class="backup-row"><span><strong>${esc(backup.name)}</strong><small>${date(backup.mtimeMs)} · ${bytes(backup.size)}</small></span><button type="button" data-backup="${esc(backup.name)}">载入为草稿</button></div>`).join("")}</div>` : '<p class="muted">暂无私有备份。</p>', "sub-panel"); element.querySelectorAll("[data-backup]").forEach((backupButton) => { backupButton.onclick = () => void run(() => call("config.backup.read", { name: backupButton.dataset.backup }), (backup) => { draft = backup.value; configDirty = true; configForm(); message("备份已载入草稿，尚未保存。", "success"); }); }); }));
  }

  function filteredLogText() {
    return String(logText || "").split(/\r?\n/).filter((line) => {
      if (logQuery && !line.toLowerCase().includes(logQuery.toLowerCase())) return false;
      if (logLevel && !line.toLowerCase().includes(` ${logLevel.toLowerCase()} `)) return false;
      return true;
    }).join("\n");
  }

  async function logRefresh() {
    if (!currentLog || tab !== "logs" || polling) return;
    polling = true;
    try {
      const result = await call("logs.read", { name: currentLog, query: logQuery, level: logLevel, raw: logRaw });
      logText = result.text || "";
      const element = panel.querySelector("#log-text");
      if (element) { element.textContent = filteredLogText(); if (logFollow) element.scrollTop = element.scrollHeight; }
    } catch (error) { message(explain(error.code), "error"); }
    finally { polling = false; }
  }

  async function load(options = {}) {
    if (tab === "config" && configDirty && !options.force) { message("配置草稿未保存，已保留当前编辑内容。", "warning"); return; }
    const serial = ++loadSerial;
    if (tab === "overview") { panel.innerHTML = ""; return; }
    panel.innerHTML = section(tabs[tab], '<div class="loading-state"><span class="spinner" aria-hidden="true"></span>正在读取…</div>');
    try {
      if (tab === "validation") { await renderValidation(panel, host, { message }); return; }
      if (tab === "config") { const result = await call("config.read"); if (serial !== loadSerial || tab !== "config") return; draft = result.value; revision = result.revision; configDirty = false; configForm(); return; }
      if (tab === "scan") {
        const [config, reports, scan, runtimeStatus] = await Promise.all([
          call("config.read"),
          call("reports.list"),
          call("scan.status"),
          host.status ? host.status() : Promise.resolve(null),
        ]);
        if (serial !== loadSerial || tab !== "scan") return;
        platformIds = normalizedPlatformIds(config.platforms);
        selectedPlatformIds = readSelectedPlatformIds(platformIds);
        scanSnapshot = scan || {};
        const platformOptions = platformIds.map((platformId) => `<option value="${esc(platformId)}">${esc(platformId)}</option>`).join("");
        const baselineRequired = runtimeStatus?.libraryReady === false && !runtimeStatus.activeGenerationId;
        const baselineHelp = baselineRequired
          ? '<p class="notice scan-baseline-notice">实例尚无已发布基线；首次建库需全选九个平台，之后可多选更新。首次只选部分平台会返回基线不足，不会静默扩大范围。</p>'
          : "";
        panel.innerHTML = section("扫描与检查", `<p class="lead">日常更新按所选平台执行增量扫描；完成的批次按 Runtime 发布流程提交。全量重提取和作者范围属于高级操作，仍会生成新的完整数据版本。</p>${baselineHelp}<div class="notice scan-readonly-notice" id="scan-readonly-notice">图库源始终严格只读；所有写入只进入当前实例。日常更新已自动带上只读保护，无需重复勾选。</div>${platformPicker(platformIds, selectedPlatformIds)}<div class="action-row"><button type="button" id="scan-start" class="primary">更新图库</button>${button("scan-cancel", "请求取消", "danger")}${button("scan-refresh", "刷新进度", "secondary")}</div><details id="scan-advanced" class="form-section"><summary>高级更新：全量重提取 / 作者范围</summary><p class="form-help">高级更新会重新读取更多源内容；作者范围只允许一个平台。点击开始后仍需在页面内确认，避免误触。</p><div class="scan-controls"><label class="field-label"><span>更新方式</span><select id="scan-mode"><option value="incremental">增量（高级范围）</option><option value="full">全量重提取</option></select></label><label class="field-label"><span>高级范围</span><select id="scan-scope"><option value="all">已选平台</option><option value="platform">指定一个平台</option><option value="author">指定作者目录</option></select></label></div><div class="scope-fields"><label class="field-label"><span>高级平台</span><select id="scan-advanced-platform">${platformOptions}</select></label><label class="field-label"><span>作者目录名（仅作者范围）</span><input id="scan-advanced-author" placeholder="可填写作者目录名"></label></div><div class="action-row">${button("scan-advanced-start", "开始高级更新", "danger")}</div></details><div class="scan-status-card">${scanSummary(scan)}${advanced(scan, "查看扫描状态明细")}</div><section class="scope-check-panel"><h3>只读范围抽查</h3><p class="form-help">抽查最多 1000 个作品，不修改 Catalog；作者名是目录名，不是 source ID。</p><div class="scope-fields"><label class="field-label"><span>平台</span><select id="scope-platform">${platformOptions}</select></label><label class="field-label"><span>作者目录名（可空）</span><input id="scope-author" placeholder="可填写作者目录名"></label><button type="button" id="scope-authors" class="secondary">查找作者目录</button></div><div id="scope-author-list"></div>${button("scope-check", "只读抽查", "secondary")}<div id="scope-result"></div></section>`) + section("任务报告", reports.items?.length ? `<div class="report-list">${reports.items.map((report) => `<button type="button" class="report-row" data-report="${esc(report.name)}"><span><strong>${esc(report.name)}</strong><small>${date(report.mtimeMs)} · ${bytes(report.size)}</small></span><span>查看摘要</span></button>`).join("")}</div>` : '<p class="muted">暂无实例报告。</p>') + '<div id="report-result"></div>';
        const firstSelected = selectedPlatformIds[0] || platformIds[0] || "";
        const advancedPlatform = panel.querySelector("#scan-advanced-platform");
        const scopePlatform = panel.querySelector("#scope-platform");
        if (advancedPlatform) advancedPlatform.value = firstSelected;
        if (scopePlatform) scopePlatform.value = firstSelected;
        wirePlatformPicker();
        wire("scope-authors", () => void run(() => call("scope.authors", { platformId: panel.querySelector("#scope-platform").value, query: panel.querySelector("#scope-author").value }), (result) => { const list = panel.querySelector("#scope-author-list"); list.innerHTML = `<div class="result-card"><strong>${number(result.total)} 个匹配目录</strong><span class="muted">显示前 100 个，请继续缩小范围。</span><div class="chip-list">${(result.items || []).map((item) => `<button type="button" class="chip" data-author-directory="${esc(item.directoryName)}">${esc(item.directoryName)}</button>`).join("")}</div></div>`; list.querySelectorAll("[data-author-directory]").forEach((element) => { element.onclick = () => { panel.querySelector("#scope-author").value = element.dataset.authorDirectory; message("已选择作者目录，请确认范围后抽查。", "info"); }; }); }));
        const showAdvancedConfirmation = (inputValue) => {
          if (busy) { message("已有操作正在处理，请稍候。", "warning"); return; }
          const existing = panel.querySelector("#scan-confirmation");
          if (existing) { existing.scrollIntoView({ block: "nearest" }); return; }
          const confirmation = document.createElement("section");
          confirmation.id = "scan-confirmation";
          confirmation.className = "confirm-card";
          confirmation.setAttribute("role", "group");
          confirmation.setAttribute("aria-label", "确认高级图库更新");
          const scopeText = inputValue.authorDirectoryName ? `${(inputValue.platformIds || [])[0] || "指定平台"} · ${inputValue.authorDirectoryName}` : (inputValue.platformIds || []).join("、") || "指定范围";
          confirmation.innerHTML = `<h3>确认高级更新</h3><p class="eyebrow">REAL LIBRARY · STRICT READ ONLY</p><p><strong>${esc(inputValue.mode === "incremental" ? "增量高级更新" : "全量重提取")}</strong> · ${esc(scopeText)}</p><p class="form-help">此次操作会重新读取所选范围；源文件仍不会被修改，只写当前实例。</p><label class="check-field"><input id="scan-confirm-readonly" type="checkbox"><span>我确认上述高级范围及只读要求</span></label><div class="action-row"><button type="button" id="scan-confirm-start" class="primary" disabled>确认开始高级更新</button><button type="button" id="scan-confirm-cancel" class="secondary">取消</button></div>`;
          panel.querySelector("#scan-advanced").insertAdjacentElement("afterend", confirmation);
          const confirmButton = confirmation.querySelector("#scan-confirm-start");
          confirmation.querySelector("#scan-confirm-readonly").onchange = (event) => { confirmButton.disabled = !event.target.checked; };
          confirmation.querySelector("#scan-confirm-cancel").onclick = () => { confirmation.remove(); message("已取消，未启动高级更新。", "info"); };
          confirmButton.onclick = async () => { if (busy || !confirmation.querySelector("#scan-confirm-readonly").checked) return; confirmButton.disabled = true; await run(() => call("scan.start", inputValue), () => load({ force: true }), "高级更新已启动"); if (document.contains(confirmButton)) confirmButton.disabled = false; };
          message("请确认高级更新范围后再提交。", "info");
          confirmation.scrollIntoView({ block: "nearest" });
        };
        wire("scan-start", () => {
          if (!selectedPlatformIds.length) { message("至少选择一个平台后才能更新图库。", "warning"); return; }
          void run(() => call("scan.start", { platformIds: [...selectedPlatformIds], mode: "incremental", confirmReadOnly: true }), () => load({ force: true }), "增量更新已启动");
        });
        wire("scan-advanced-start", () => {
          const scope = panel.querySelector("#scan-scope").value;
          const mode = panel.querySelector("#scan-mode").value;
          const advancedPlatformId = panel.querySelector("#scan-advanced-platform").value;
          const authorDirectoryName = panel.querySelector("#scan-advanced-author").value.trim();
          const inputValue = { confirmReadOnly: true, mode, platformIds: [...selectedPlatformIds] };
          if (scope === "platform") inputValue.platformIds = advancedPlatformId ? [advancedPlatformId] : [];
          if (scope === "author") {
            if (!advancedPlatformId) { message("作者范围必须选择一个平台。", "error"); return; }
            if (!authorDirectoryName) { message("请填写作者目录名，再开始高级更新。", "error"); return; }
            inputValue.platformIds = [advancedPlatformId];
            inputValue.authorDirectoryName = authorDirectoryName;
          }
          if (!inputValue.platformIds.length) { message("至少选择一个平台后才能更新图库。", "warning"); return; }
          showAdvancedConfirmation(inputValue);
        });
        wire("scan-cancel", () => void run(() => call("scan.cancel"), () => message("已请求取消；将在安全检查点停止。", "success")));
        wire("scan-refresh", () => void load({ force: true }));
        wire("scope-check", () => void run(() => call("scope.check", { platformId: panel.querySelector("#scope-platform").value, authorDirectoryName: panel.querySelector("#scope-author").value, confirmReadOnly: true }), (result) => { panel.querySelector("#scope-result").innerHTML = output(result, "scope", "查看抽查明细"); message("只读抽查完成，Catalog 未被修改。", "success"); }));
        panel.querySelectorAll("[data-report]").forEach((element) => { element.onclick = () => void run(() => call("reports.read", { name: element.dataset.report }), (result) => { panel.querySelector("#report-result").innerHTML = output(result.value, "operation", "查看报告原始数据"); }); });
        updateScanActionState();
        return;
      }
      if (tab === "generations") {
        const generations = await call("generations.list");
        panel.innerHTML = section("Catalog / Search 数据版本", `<p class="lead">校验后才允许发布/回滚；静态 READY 结果由 Runtime 后台校验并接入，接入等待不要求重启。若状态显示应用失败或实时检查点待恢复，再按页面提示诊断/恢复。</p><div class="generation-table-wrap"><table class="data-table"><thead><tr><th>版本</th><th>状态</th><th>作品</th><th>大小</th><th>操作</th></tr></thead><tbody>${(generations.items || []).map((item) => `<tr><td><strong>${esc(item.id)}</strong>${item.id === generations.active ? '<span class="badge success">已发布</span>' : ""}${item.id === generations.loaded ? '<span class="badge">已加载</span>' : ""}</td><td>${esc(stateLabel(item.state))}</td><td>${number(item.works)}</td><td>${size(item.bytes)}</td><td class="table-actions">${["validate", "publish", "rollback"].map((operation, index) => `<button type="button" class="${operation === "validate" ? "secondary" : ""}" data-generation="${esc(item.id)}" data-operation="generation.${operation}">${["校验", "发布", "回滚到此版本"][index]}</button>`).join("")}</td></tr>`).join("")}</tbody></table></div><div class="action-row">${button("retention-plan", "预览清理计划", "secondary")}${button("retention-apply", "执行保守清理", "danger")}</div><div id="generation-result"></div>`);
        panel.querySelectorAll("[data-generation]").forEach((element) => { element.onclick = () => { if (element.dataset.operation !== "generation.validate" && !confirm("确认更改发布版本？Runtime 将后台校验并接入；若状态要求恢复再按提示处理。")) { message("已取消版本变更。", "info"); return; } void run(() => call(element.dataset.operation, { id: element.dataset.generation, confirm: true }), (result) => { panel.querySelector("#generation-result").innerHTML = output(result, "generation", "查看版本操作明细"); message(result.published ? "版本已发布；Runtime 将后台校验并接入。" : "generation 校验通过。", "success"); }); }; });
        panel.insertAdjacentHTML("beforeend", section("实时数据恢复", `<p class="form-help">仅在停服后使用：把当前实时库移入实例临时备份，下次启动从已发布检查点重建。</p><label class="check-field"><input id="live-reset-confirm" type="checkbox"><span>我确认恢复检查点（不修改源文件）</span></label>${button("live-reset", "重置实时库", "danger")}<div id="live-reset-result"></div>`));
        panel.querySelector("#live-reset").disabled = true;
        panel.querySelector("#live-reset-confirm").onchange = (event) => { panel.querySelector("#live-reset").disabled = !event.target.checked; };
        wire("live-reset", () => void run(() => call("live.reset", { confirm: true }), (result) => { panel.querySelector("#live-reset-result").innerHTML = output(result, "operation", "查看恢复明细"); message("实时库已请求从已发布检查点恢复。", "success"); }));
        wire("retention-plan", () => void run(() => call("retention.plan"), (result) => { panel.querySelector("#generation-result").innerHTML = output(result, "operation", "查看清理计划明细"); }));
        wire("retention-apply", () => { if (!confirm("清理未引用过期代？active、loaded、building、回滚代保留。")) { message("已取消清理。", "info"); return; } void run(() => call("retention.apply", { confirm: true }), (result) => { panel.querySelector("#generation-result").innerHTML = output(result, "operation", "查看清理明细"); }); });
        return;
      }
      if (tab === "logs") {
        const logs = await call("logs.list");
        currentLog = logs.items?.some((item) => item.name === currentLog) ? currentLog : logs.items?.[0]?.name;
        panel.innerHTML = section("运行日志", `<p class="lead">默认显示脱敏结构化日志；非结构化内容不会进入 Manager。需要时可打开本机日志目录查看原文件。</p><div class="log-toolbar"><label class="field-label"><span>日志文件</span><select id="log-file">${(logs.items || []).map((item) => `<option value="${esc(item.name)}" ${item.name === currentLog ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label><label class="field-label"><span>筛选关键词</span><input id="log-query" placeholder="事件码或关键字" value="${esc(logQuery)}"></label><label class="field-label"><span>级别</span><select id="log-level"><option value="">全部级别</option><option value="info" ${logLevel === "info" ? "selected" : ""}>信息</option><option value="warn" ${logLevel === "warn" ? "selected" : ""}>警告</option><option value="error" ${logLevel === "error" ? "selected" : ""}>错误</option></select></label></div><div class="action-row">${button("logs-open", "打开日志目录", "secondary")}${button("logs-clear", "清空当前日志（需停服）", "danger")}${button("log-follow", logFollow ? "停止跟随" : "继续跟随", "secondary")}</div><label class="check-field raw-log-toggle"><input id="log-raw" type="checkbox"><span>显示本机原始日志（可能含私有路径，仅限本机查看）</span></label><pre id="log-text" class="manager-output log-text" aria-live="polite"></pre>`);
        panel.querySelector("#log-file").onchange = (event) => { currentLog = event.target.value; logText = ""; void logRefresh(); };
        panel.querySelector("#log-query").oninput = (event) => { logQuery = event.target.value; const element = panel.querySelector("#log-text"); if (element) element.textContent = filteredLogText(); };
        panel.querySelector("#log-level").onchange = (event) => { logLevel = event.target.value; const element = panel.querySelector("#log-text"); if (element) element.textContent = filteredLogText(); };
        panel.querySelector("#log-raw").onchange = (event) => { if (event.target.checked && !confirm("原始日志可能包含私有路径，只应在本机查看。继续？")) { event.target.checked = false; return; } logRaw = event.target.checked; logText = ""; void logRefresh(); };
        wire("logs-open", () => void run(() => host.openDirectory("logs"), null, "已打开日志目录"));
        wire("logs-clear", () => { if (!currentLog) return; if (!confirm("清空当前日志？需要服务和扫描停止。")) { message("已取消清理日志。", "info"); return; } void run(() => call("logs.clear", { name: currentLog, confirm: true }), () => { logText = ""; void logRefresh(); message("当前日志已清空。", "success"); }); });
        wire("log-follow", () => { logFollow = !logFollow; const element = panel.querySelector("#log-follow"); if (element) element.textContent = logFollow ? "停止跟随" : "继续跟随"; message(logFollow ? "已继续跟随日志。" : "已停止跟随日志。", "info"); });
        await logRefresh();
        return;
      }
      if (tab === "access") {
        const access = await call("access.read");
        panel.innerHTML = section("客户端与最近访问", `<p class="lead">地址仅本机管理可见；不记录 URL、查询或正文。访问摘要持久保存在当前实例，最多保留 30 天、256 个客户端和 200 条事件；本机和代理连接不能封禁。</p><div class="action-row">${button("access-refresh", "刷新", "secondary")}${button("access-clear", "清理统计", "danger")}</div><div class="client-table-wrap"><table class="data-table"><thead><tr><th>客户端</th><th>类别</th><th>请求</th><th>错误</th><th>活动</th><th>最近</th><th>操作</th></tr></thead><tbody>${(access.clients || []).map((client) => `<tr><td><strong>${esc(client.address)}</strong><small>${esc(client.id)}</small></td><td>${client.local ? "本机 / 代理" : esc(client.agent)}</td><td>${number(client.requests)}</td><td>${number(client.errors)}</td><td>${number(client.active)}</td><td>${date(client.lastSeenAtMs)}</td><td><button type="button" class="${client.blocked ? "secondary" : "danger"}" data-client="${esc(client.id)}" data-blocked="${!client.blocked}" ${client.local ? "disabled" : ""}>${client.blocked ? "解除封禁" : "封禁客户端"}</button></td></tr>`).join("")}</tbody></table></div>${summaryEvents(access.events)}`);
        wire("access-refresh", () => void load({ force: true }));
        wire("access-clear", () => void run(() => call("access.clear"), () => { message("访问统计已清理。", "success"); void load({ force: true }); }));
        panel.querySelectorAll("[data-client]").forEach((element) => { element.onclick = () => void run(() => call("access.block", { id: element.dataset.client, blocked: element.dataset.blocked === "true" }), (result) => { message(result.blocked ? "客户端已封禁并写入实例访问记录。" : "已解除客户端封禁。", "success"); void load({ force: true }); }); });
        return;
      }
      if (tab === "storage") {
        const storage = await call("storage.read");
        panel.innerHTML = section("实例存储", `<p class="lead">只管理实例，不删除 source。缩略图可重建；清理前先停止 Runtime 和扫描。</p><table class="data-table storage-table"><thead><tr><th>目录</th><th>占用</th><th>文件</th></tr></thead><tbody>${Object.entries(storage).map(([key, value]) => `<tr><th>${esc(key)}</th><td>${size(value.bytes)}</td><td>${number(value.files)}</td></tr>`).join("")}</tbody></table><div class="action-row">${button("cache-clear", "清理缩略图缓存", "danger")}${button("storage-open", "打开实例目录", "secondary")}</div>`);
        wire("storage-open", () => void run(() => host.openDirectory("instance"), null, "已打开实例目录"));
        wire("cache-clear", () => { if (!confirm("删除可重建缩略图缓存？图库及 generation 不受影响。")) { message("已取消缓存清理。", "info"); return; } void run(() => call("cache.clear", { confirm: true }), (result) => { message(`缩略图缓存已清理${result.bytes ? `，释放 ${bytes(result.bytes)}。` : "。"}`, "success"); void load({ force: true }); }); });
        panel.insertAdjacentHTML("beforeend", section("孤儿缩略图", `<p class="form-help">仅删除已有来源记录且再次确认源文件消失的缓存；未知旧缓存保留。</p><div class="action-row">${button("cache-orphans", "检查孤儿缓存", "secondary")}${button("cache-orphans-clear", "仅清理孤儿缓存", "danger")}</div><div id="orphans-result"></div>`));
        wire("cache-orphans", () => void run(() => call("cache.orphans"), (result) => { panel.querySelector("#orphans-result").innerHTML = output(result, "operation", "查看孤儿缓存明细"); }));
        wire("cache-orphans-clear", () => { if (!confirm("再次确认源文件缺失后，仅删除孤儿缓存？需先停服。")) { message("已取消孤儿缓存清理。", "info"); return; } void run(() => call("cache.orphans.clear", { confirm: true }), (result) => { panel.querySelector("#orphans-result").innerHTML = output(result, "operation", "查看清理明细"); }); });
        return;
      }
      if (tab === "diagnostics") {
        panel.innerHTML = section("诊断与导出", `<p class="lead">检查九平台根、媒体工具、已发布 Catalog/Search 完整性与绑定。报告只含聚合事实并保存到实例 reports。</p><div class="action-row">${button("diagnose", "运行诊断并保存报告", "primary")}${button("reports-open", "打开报告目录", "secondary")}</div><div id="diagnostics-result"></div>`);
        wire("reports-open", () => void run(() => host.openDirectory("reports"), null, "已打开报告目录"));
        wire("diagnose", () => void run(() => call("diagnostics.run"), (result) => { panel.querySelector("#diagnostics-result").innerHTML = output(result, "diagnostics", "查看诊断原始数据"); message(result.state === "PASS" ? "诊断通过，聚合报告已保存。" : "诊断完成，请查看发现项。", result.state === "PASS" ? "success" : "warning"); }));
      }
    } catch (error) {
      panel.innerHTML = section(tabs[tab], `<div class="empty-state error"><strong>${esc(explain(error.code))}</strong><span>实时访问统计需要服务在线；其他功能可在停服时使用。</span></div>`);
      message(explain(error.code), "error");
    }
  }

  function openTab(nextTab) {
    const element = shell.querySelector(`[data-tab="${nextTab}"]`);
    if (!element || element.disabled) return;
    if (busy) { message("已有操作正在处理，请稍候。", "warning"); return; }
    if (tab === "config" && configDirty) {
      if (!confirm("离开配置页？未保存修改不会生效。")) return;
      configDirty = false;
    }
    tab = nextTab;
    shell.querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("active", item === element));
    void load({ force: true });
  }
  shell.querySelectorAll("[data-tab]").forEach((element) => { element.onclick = () => openTab(element.dataset.tab); });
  shell.querySelector('[data-tab="overview"]').classList.add("active");
  const timer = setInterval(() => { if (tab === "logs") void logRefresh(); }, 5000);
  window.addEventListener("beforeunload", () => clearInterval(timer), { once: true });
  function update(status) {
    if (tab !== "scan" || !status?.scan) return;
    scanSnapshot = { ...status.scan, applyingGeneration: status.applyingGeneration, applyError: status.applyError };
    updateScanActionState();
    const card = panel.querySelector(".scan-status-card");
    // Advanced details are a snapshot while being inspected, not a moving target.
    if (card?.querySelector("details[open]")) return;
    if (card) card.innerHTML = `${scanSummary(scanSnapshot)}${advanced(scanSnapshot, "查看扫描状态明细")}`;
  }
  return { update, isOverview: () => tab === "overview", openScan: () => openTab("scan") };
}
