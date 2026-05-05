import { request } from "../shared/api.js";
import { metrics, duration } from "./model.js";
const root = document.getElementById("root");
let confirmed = false,
  busy = false;
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const number = (value) => Number(value || 0).toLocaleString();
function render(status) {
  const m = metrics(status),
    scan = status.scan || {};
  const cells = [
    ["扫描状态", m.state],
    ["当前平台", m.platform],
    ["已观察作品", number(m.observed)],
    ["已入库作品", number(m.indexed)],
    ["实际媒体", number(m.media)],
    ["耗时", duration(m.elapsed)],
    ["吞吐（作品/秒）", m.throughput.toFixed(1)],
    ["RSS MiB", (m.rss / 1048576).toFixed(1)],
    ["Heap MiB", (m.heap / 1048576).toFixed(1)],
    ["诊断数量", number(m.diagnostics)],
  ];
  root.innerHTML = `<header><h1>Gallery 管理器</h1><div><button id="open-gallery">打开画廊</button> <button id="restart" ${!window.galleryHost || !status.restartRequired ? "disabled" : ""}>重启本机服务以加载新版本</button></div></header><section class="panel"><h2>运行实例 · ${escape(status.state)}</h2><p>已加载 generation：<code>${escape(status.loadedGenerationId)}</code></p><p>已发布 generation：<code>${escape(status.activeGenerationId)}</code></p><p>当前作品 ${number(status.counts?.works)} · 实际媒体 ${number(status.counts?.media)}</p>${status.restartRequired ? '<div class="notice">新数据已发布，当前服务继续使用已加载版本。重启后生效。</div>' : ""}</section><section class="panel"><h2>全库扫描</h2><div class="notice">真实图库 · 严格只读。只在本机实例创建新 generation。</div><p>扫描 generation：<code>${escape(m.generation)}</code></p><div class="metrics">${cells.map(([k, v]) => `<div class="metric"><span>${escape(k)}</span><strong>${escape(v)}</strong></div>`).join("")}</div><p>Metadata：${
    Object.entries(m.metadata)
      .map(([k, v]) => `${escape(k)} ${number(v)}`)
      .join(" · ") || "—"
  }</p>${m.failure ? `<p class="error">失败：${escape(m.failure)}；此前发布版本保持可用。</p>` : ""}<label><input id="confirm" type="checkbox" ${confirmed ? "checked" : ""}> 我确认只读扫描真实图库，写入当前实例</label><button id="scan" ${!confirmed || scan.running || busy || !status.localControl ? "disabled" : ""}>开始全库扫描</button></section><section class="panel"><h2>平台进度</h2><table><thead><tr><th>平台</th><th>状态</th><th>作者</th><th>作品</th><th>实际媒体</th></tr></thead><tbody>${(scan.platforms || []).map((p) => `<tr><td>${escape(p.platformId)}</td><td>${escape(p.status || "")}</td><td>${number(p.authors)}</td><td>${number(p.indexedWorks)}</td><td>${number(p.actualMedia)}</td></tr>`).join("")}</tbody></table></section>`;
  document.getElementById("confirm").onchange = (e) => {
    confirmed = e.target.checked;
    render(status);
  };
  document.getElementById("scan").onclick = async () => {
    busy = true;
    try {
      await request(
        "scans",
        {},
        { method: "POST", body: JSON.stringify({ confirmReadOnly: true }) },
      );
    } catch (e) {
      alert(e.code || "操作失败");
    } finally {
      busy = false;
      refresh();
    }
  };
  document.getElementById("open-gallery").onclick = () =>
    window.galleryHost
      ? window.galleryHost.openGallery()
      : window.open("/", "_blank");
  document.getElementById("restart").onclick = async () => {
    try {
      await window.galleryHost?.restart();
    } catch (e) {
      alert(e.code || "重启失败");
    }
  };
}
async function refresh() {
  try {
    render(await request("status"));
  } catch (e) {
    root.innerHTML = `<section class="panel error">连接不可用：${escape(e.code || "OFFLINE")}</section>`;
  }
}
await refresh();
setInterval(refresh, 1500);
