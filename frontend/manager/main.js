import { request } from "../shared/api.js";
import { metrics, duration } from "./model.js";
import { initManagement } from "./admin.js";
const root = document.getElementById("root");
const management = initManagement();
let busy = false, refreshing = false, actionError = null;
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const number = (value) => value == null ? "—" : Number(value).toLocaleString();
const metadataSummary = (value) => Object.entries(value || {}).map(([key, count]) => `${key} ${number(count)}`).join(" · ") || "—";
function render(status, options = {}) {
  if (!management.isOverview()) { management.update(status); return; }
  const active = document.activeElement;
  if (!options.force && (busy || (active && root.contains(active) && active.matches("input,button,select,textarea")))) return;
  const m = metrics(status), scan = status.scan || {}, host = window.galleryHost;
  const blocked = busy || status.hostBusy;
  const applyError = status.applyError?.code || scan.applyError?.code;
  const liveCheckpointPending = status.liveCheckpointPending || scan.liveCheckpointPending;
  const applyNotice = status.applyingGeneration || scan.applyingGeneration
    ? '<p class="notice">扫描候选已完成，正在安全应用到当前实例；请查看扫描状态卡的应用阶段。</p>'
    : applyError
      ? '<p class="error">扫描结果未能应用：' + escape(applyError) + '。当前已发布版本保持不变，请查看诊断或重试接入。</p>'
      : liveCheckpointPending
        ? '<p class="notice">实时检查点待恢复；请到“数据版本”执行恢复并按该页提示重启。</p>'
      : scan.state === "READY" && scan.finishedAtMs && status.restartRequired === false
        ? '<p class="notice">扫描完成，结果已应用到当前实例；当前服务无需额外重启。</p>'
      : '';
  const cells = [
    ["扫描状态", m.state], ["当前平台", m.platform], ["已观察作品", number(m.observed)],
    ["已入库作品", number(m.indexed)], ["实际媒体", number(m.media)], ["耗时", duration(m.elapsed)],
    ["吞吐（作品/秒）", m.throughput == null ? "—" : m.throughput.toFixed(1)], ["RSS MiB", m.rss == null ? "—" : (m.rss / 1048576).toFixed(1)],
    ["协调器 Heap MiB", m.heap == null ? "—" : (m.heap / 1048576).toFixed(1)], ["诊断数量", number(m.diagnostics)],
    ["复用作品", number(scan.changes?.worksReused)], ["移除失效记录", number(scan.changes?.worksDeleted)],
    ["Search 构建", scan.search?.buildMode ?? "—"], ["Search 复用", number(scan.search?.reusedWorks)],
    ["Search 更新", number(scan.search?.updatedWorks)], ["Search 移除", number(scan.search?.removedWorks)],
  ];
  root.innerHTML = `<header><h1>Gallery 管理器</h1><div>
    <button id="open-gallery">打开画廊</button>
    <button id="start" ${!host || blocked || status.state === "READY" ? "disabled" : ""}>启动服务</button>
    <button id="stop" ${!host || blocked || status.state !== "READY" ? "disabled" : ""}>停止服务</button>
    <button id="restart" ${!host || blocked || status.state !== "READY" ? "disabled" : ""}>重启服务</button>
    </div></header><section class="panel"><h2>运行实例 · ${escape(status.state)} · ${status.deployment === "staging" ? "TEST INSTANCE" : escape(status.deployment || "")}</h2>
    <p>已加载 generation：<code>${escape(status.loadedGenerationId)}</code></p>
    <p>已发布 generation：<code>${escape(status.activeGenerationId)}</code></p>
    <p>当前作品 ${number(status.counts?.works)} · 实际媒体 ${number(status.counts?.media)}</p>
    ${status.libraryReady === false ? '<p class="notice">实例已就绪，但尚无已发布图库；可先打开画廊查看服务状态，首次扫描完成后才会显示内容。</p>' : ''}
    ${status.live?.enabled ? '<p class="notice">实时入库已启用 · 修订 '+number(status.live.revision)+'。完整作品分批可见；检查点失败不撤回已确认批次。</p>' : ''}
    <p>关窗隐藏到托盘；退出管理器不停止后台服务。停止服务请使用上方明确操作。</p>
    ${actionError || status.hostFailure ? '<p class="error">操作未完成：' + escape(actionError || status.hostFailure) + '。可重新连接、启动或检查实例配置。</p>' : ""}
    </section><section class="panel"><h2>图库更新 · ${scan.mode === "incremental" ? "增量" : "全量"}</h2>
    <p>平台选择、增量更新和高级范围操作统一在“扫描与检查”完成。${status.live?.enabled ? '完整作品与搜索同批提交，前端可持续看到已确认内容；扫描结束另存完整检查点。' : '静态 READY 结果由 Runtime 后台校验并接入；只有应用失败或实时检查点待恢复时才需要诊断/恢复。'}</p>
    ${applyNotice}
    ${scan.scope?.invalidatedPlatformIds?.length ? '<p class="notice">提取规则版本变化，已扩展刷新：'+escape(scan.scope.invalidatedPlatformIds.join("、"))+'</p>' : ""}
    <div class="notice">真实图库 · 严格只读。REAL LIBRARY — STRICT READ ONLY · 九平台；只写当前实例。</div>
    <p>扫描 generation：<code>${escape(m.generation)}</code></p>
    <div class="metrics">${cells.map(([k,v]) => '<div class="metric"><span>' + escape(k) + '</span><strong>' + escape(v) + '</strong></div>').join("")}</div>
    <p>Metadata：${Object.entries(m.metadata).map(([k,v]) => escape(k) + " " + number(v)).join(" · ") || "—"}</p>
    ${m.failure ? '<p class="error">' + (m.failure === "SCAN_CANCELLED" ? '已取消：' : '失败：') + escape(m.failure) + '；此前可用版本保持不变。</p>' : ""}
    <button id="scan" ${blocked || !host ? "disabled" : ""}>${scan.running ? "查看扫描进度" : "选择平台并更新图库"}</button>
    ${!host ? '<p>此页面只读；管理操作仅由本机 Gallery.exe 发起。</p>' : ""}
    </section><section class="panel"><h2>平台进度</h2><table><thead><tr>
    <th>平台</th><th>状态</th><th>作者</th><th>作品</th><th>实际媒体</th><th>Metadata / 诊断</th></tr></thead><tbody>
    ${(scan.platforms || []).map((p) => '<tr><td>' + escape(p.platformId) + '</td><td>' + escape(p.status || "") + '</td><td>' + number(p.authors) + '</td><td>' + number(p.indexedWorks) + '</td><td>' + number(p.actualMedia) + '</td><td>' + escape(metadataSummary(p.metadataStates)) + ' · 诊断 ' + number(p.diagnostics) + '</td></tr>').join("")}
    </tbody></table></section>`;
  for (const command of ["start", "stop", "restart"]) document.getElementById(command).onclick = async () => {
    busy = true; actionError = null; render(status, { force: true });
    try { await host[command](); }
    catch (error) { actionError = error.code || "HOST_REQUEST_FAILED"; }
    finally { busy = false; void refresh(); }
  };
  document.getElementById("scan").onclick = () => management.openScan();
  document.getElementById("open-gallery").onclick = () => host ? host.openGallery() : window.open("/", "_blank");
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try { render(window.galleryHost ? await window.galleryHost.status() : await request("status")); }
  catch (error) { render({ state: "STOPPED", hostFailure: error.code || "OFFLINE", scan: {} }); }
  finally { refreshing = false; }
}
await refresh();
setInterval(refresh, 1500);
