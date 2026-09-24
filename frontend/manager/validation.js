const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);
const number = (value) => Number(value || 0).toLocaleString("zh-CN");
const json = (value) => JSON.stringify(value, null, 2);
const advanced = (value, label = "查看验证状态明细") => `<details class="advanced-data"><summary>${esc(label)}</summary><pre>${esc(json(value))}</pre></details>`;
const stateLabel = (value) => ({ IDLE: "空闲", RUNNING: "运行中", COMPLETED: "已完成", CANCELLED: "已取消", FAILED: "失败" }[String(value || "")] || String(value || "—"));
const severityLabel = (value) => ({ error: "错误", warning: "警告", info: "提示" }[String(value || "")] || String(value || "—"));

function statusSummary(state) {
  const counts = Object.values(state?.counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  const level = state?.state === "COMPLETED" ? "success" : state?.state === "FAILED" ? "error" : state?.state === "CANCELLED" ? "warning" : "info";
  return `<div class="validation-summary"><strong class="status-${level}">验证${esc(stateLabel(state?.state))}</strong><span>${number(state?.authors)} 位作者 · ${number(state?.works)} 件作品 · ${number(counts)} 项发现</span>${state?.platformId ? `<span>当前平台：${esc(state.platformId)}</span>` : ""}${state?.error ? `<span class="status-error">${esc(state.error)}</span>` : ""}</div>`;
}

export async function renderValidation(panel, host, options = {}) {
  const notify = options.message || (() => {});
  const checks = (await host.admin("validation.checks")).items || [];
  const config = await host.admin("config.read");
  panel.innerHTML = `<section class="panel validation-panel" id="validation-panel"><div class="panel-heading"><div><p class="eyebrow">只读诊断 · 私有实例报告</p><h2>图库验证</h2></div><span class="muted">缺 metadata 不会删除物理作品</span></div><div class="validation-layout"><div class="validation-options"><label class="field-label"><span>验证范围</span><select id="validation-platform"><option value="">全部平台</option>${(config.platforms || []).map((platform) => `<option value="${esc(platform)}">${esc(platform)}</option>`).join("")}</select></label><details class="check-list" open><summary>检查项 <span id="validation-check-count"></span></summary><div class="check-grid">${checks.map((check) => `<label class="check-option"><input type="checkbox" data-check="${esc(check.id)}" checked><span><strong>${esc(check.label)}</strong><small>${esc(severityLabel(check.severity))}</small></span></label>`).join("")}</div></details><div class="action-row"><button id="validation-start" class="primary" type="button">开始验证</button><button id="validation-cancel" class="danger" type="button" disabled>请求取消</button></div></div><div class="validation-status" id="validation-status-card"><div id="validation-status-summary"><div class="loading-state">尚未读取状态</div></div><div id="validation-status"></div></div></div><div class="validation-results"><div class="panel-heading"><h3>问题结果</h3><span id="validation-page" class="muted">尚未查询</span></div><div class="finding-toolbar"><input id="validation-query" placeholder="搜索相对路径"><select id="validation-check"><option value="">全部检查项</option>${checks.map((check) => `<option value="${esc(check.id)}">${esc(check.label)}</option>`).join("")}</select><select id="validation-severity"><option value="">全部级别</option><option value="error">错误</option><option value="warning">警告</option><option value="info">提示</option></select><button id="validation-results" class="secondary" type="button">查看结果</button></div><div class="action-row"><button id="validation-prev" class="secondary" type="button" disabled>上一页</button><button id="validation-next" class="secondary" type="button" disabled>下一页</button><button id="validation-json" class="secondary" type="button">导出 JSON</button><button id="validation-csv" class="secondary" type="button">导出 CSV</button><button id="validation-purge" class="danger" type="button">清除本次报告</button></div><div id="validation-findings" class="finding-list"><p class="muted">运行验证后查看逐项问题。</p></div><p id="validation-message" class="inline-message" role="status"></p></div></section>`;
  const scope = panel.querySelector("#validation-panel");
  const el = (id) => scope.querySelector(`#${id}`);
  let state = {}, page = 1, busy = false;

  const localMessage = (text, level = "info") => {
    const target = el("validation-message");
    target.textContent = text;
    target.className = `inline-message ${level}`;
    notify(text, level);
  };
  const setBusy = (value) => {
    busy = value;
    scope.classList.toggle("is-busy", value);
    scope.querySelectorAll("button").forEach((button) => {
      if (button.id === "validation-cancel") return;
      if (value) {
        if (!button.disabled) button.dataset.validationEnabled = "1";
        button.disabled = true;
      } else if (button.dataset.validationEnabled) {
        button.disabled = false;
        delete button.dataset.validationEnabled;
      }
    });
  };
  async function act(fn, success = "操作完成") {
    if (busy) { localMessage("验证操作正在处理，请稍候。", "warning"); return null; }
    setBusy(true);
    localMessage("正在处理…", "info");
    try { const result = await fn(); if (result !== null) localMessage(success, "success"); return result; }
    catch (error) { localMessage(error.code || "操作失败", "error"); return null; }
    finally { setBusy(false); }
  }
  function renderState() {
    if (!document.contains(scope)) return;
    el("validation-status-summary").innerHTML = statusSummary(state);
    el("validation-status").innerHTML = advanced(state);
    el("validation-start").disabled = !!state.running;
    el("validation-cancel").disabled = !state.running || busy;
    el("validation-check-count").textContent = `${scope.querySelectorAll("[data-check]:checked").length}/${checks.length} 已选`;
  }
  async function refresh() {
    try {
      state = await host.admin("validation.status");
      renderState();
    } catch (error) {
      localMessage(error.code || "验证状态读取失败", "error");
    }
  }
  async function findings() {
    if (!state.id) { el("validation-findings").innerHTML = '<p class="muted">尚未生成验证报告。</p>'; return; }
    const result = await host.admin("validation.findings", { id: state.id, page, query: el("validation-query").value, check: el("validation-check").value, severity: el("validation-severity").value });
    const pages = Math.max(1, Math.ceil(result.total / 100));
    el("validation-page").textContent = `${page} / ${pages} · ${number(result.total)} 项`;
    el("validation-findings").innerHTML = result.items?.length ? result.items.map((item) => `<div class="finding-row"><span class="severity ${esc(item.severity)}">${esc(severityLabel(item.severity))}</span><span><strong>${esc(item.code)}</strong><small>${esc(item.platformId)}</small></span><code>${esc(item.relativePath)}</code><button type="button" class="secondary" data-finding="${esc(item.index)}">定位文件</button></div>`).join("") : '<p class="muted">当前筛选没有问题。</p>';
    scope.querySelectorAll("[data-finding]").forEach((button) => { button.onclick = () => void act(() => host.openFinding(state.id, Number(button.dataset.finding)), "已打开问题位置"); });
    el("validation-next").disabled = page >= pages;
    el("validation-prev").disabled = page <= 1;
  }
  scope.querySelectorAll("[data-check]").forEach((input) => { input.onchange = () => { el("validation-check-count").textContent = `${scope.querySelectorAll("[data-check]:checked").length}/${checks.length} 已选`; }; });
  el("validation-start").onclick = () => void act(async () => {
    if (!confirm("只读验证所选范围并在当前实例保存私有报告？")) { localMessage("已取消验证。", "info"); return null; }
    const selected = [...scope.querySelectorAll("[data-check]:checked")].map((input) => input.dataset.check);
    if (!selected.length) throw Object.assign(new Error("VALIDATION_CHECK_INVALID"), { code: "VALIDATION_CHECK_INVALID" });
    state = await host.admin("validation.start", { confirmReadOnly: true, platformId: el("validation-platform").value || null, checks: selected });
    page = 1;
    await findings();
    return state;
  }, "验证已启动，状态会自动更新");
  el("validation-cancel").onclick = () => void act(() => host.admin("validation.cancel"), "已请求取消，将在安全检查点停止");
  el("validation-results").onclick = () => void act(async () => { page = 1; await findings(); }, "结果已刷新");
  el("validation-prev").onclick = () => void act(async () => { page = Math.max(1, page - 1); await findings(); }, "已显示上一页");
  el("validation-next").onclick = () => void act(async () => { page += 1; await findings(); }, "已显示下一页");
  for (const format of ["json", "csv"]) el(`validation-${format}`).onclick = () => void act(async () => { const result = await host.admin("validation.export", { id: state.id, format }); localMessage(`已导出 ${number(result.count)} 项到实例报告目录：${result.file}`, "success"); return result; });
  el("validation-purge").onclick = () => void act(async () => { if (!confirm("删除本次私有验证报告？不删除图库文件。")) { localMessage("已取消清除。", "info"); return null; } const result = await host.admin("validation.purge", { id: state.id, confirm: true }); state = { state: "IDLE", running: false }; el("validation-findings").innerHTML = '<p class="muted">报告已清除。</p>'; return result; }, "验证报告已清除");
  await refresh();
  await findings();
  const timer = setInterval(() => { if (!document.contains(scope)) clearInterval(timer); else void refresh(); }, 1500);
}
