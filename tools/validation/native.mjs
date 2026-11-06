import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  config,
  url,
  output,
  driver,
  nativePage as page,
  invoke,
  admin,
  tap,
  wait,
  ready,
  replaceText,
  report,
} from "./support.mjs";
const checks = [],
  screenshots = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
async function shot(name) {
  await page.waitForLoadState("networkidle", { timeout: 25000 });
  await page.screenshot({ path: path.join(output, name + ".png") });
  screenshots.push(name + ".png");
}
async function control(name) {
  await tap(
    page
      .getByRole("button", { name, exact: true })
      .or(page.getByRole("radio", { name, exact: true })),
  );
}
async function scan(mode) {
  await admin("scan.start", {
    mode,
    platformIds: Object.keys(config.sources),
    confirmReadOnly: true,
    allowNative: true,
  });
  await wait(
    async () => !(await invoke("status")).scan.running,
    "synthetic scan",
    30000,
  );
  return (await invoke("status")).scan;
}
try {
  await ready(page);
  let current = await invoke("status");
  if (!current.counts?.works) {
    const result = await scan("full");
    assert.equal(result.failure, null);
    checks.push("nine-platform synthetic full scan");
  }
  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => {
      localStorage.setItem("gallery_theme", theme);
      location.reload();
    }, theme);
    await ready(page);
    await page.waitForTimeout(350);
    for (const [name, id] of [
      ["更新图库", "update"],
      ["访问", "access"],
      ["设置", "settings"],
      ["排查", "diagnose"],
    ]) {
      await control(name);
      await page.waitForTimeout(450);
      await shot(`admin-${id}-${theme}`);
      if (id !== "settings")
        assert.equal(
          await page
            .getByRole("button", { name: "保存并重启", exact: true })
            .count(),
          0,
        );
    }
  }
  await control("访问");
  await page.waitForTimeout(300);
  const before = (await admin("access.read")).enabled;
  await tap(page.getByRole("switch", { name: "封禁功能" }));
  await wait(
    async () => (await admin("access.read")).enabled !== before,
    "immediate access toggle",
  );
  assert.equal(
    await page.getByRole("button", { name: "保存并重启", exact: true }).count(),
    0,
  );
  await tap(page.getByRole("switch", { name: "封禁功能" }));
  await wait(
    async () => (await admin("access.read")).enabled === before,
    "restore access",
  );
  checks.push("access toggle applies immediately");
  await control("设置");
  await page.waitForTimeout(200);
  const field = page.getByRole("textbox", { name: "目录名称", exact: true });
  const targetName =
    (await admin("config.read")).value.fileBrowserRoots[0].name === "合成文件"
      ? "合成文件（已保存）"
      : "合成文件";
  await replaceText(field, targetName);
  await wait(
    () => page.getByRole("button", { name: "保存并重启", exact: true }).count(),
    "save bar",
  );
  await control("保存并重启");
  await wait(
    async () =>
      (await admin("config.read")).value.fileBrowserRoots[0].name ===
      targetName,
    "saved settings",
  );
  await wait(
    async () => (await invoke("status")).state.startsWith("READY"),
    "restart",
  );
  checks.push("settings save and restart preserve data");
  const incremental = await scan("incremental");
  assert.equal(incremental.failure, null);
  assert(incremental.reusedWorks > 0);
  checks.push("incremental reuses committed works");
  await control("更新图库");
  await control("停止");
  await wait(async () => (await invoke("status")).state === "STOPPED", "stop");
  await control("启动");
  await wait(
    async () => (await invoke("status")).state.startsWith("READY"),
    "start",
  );
  checks.push("service stop/start is owned by manager");
  // Mode/scope/fallback confirmation is exercised by scan_tasks.mjs.
  const env = await admin("diagnostics.run");
  assert.equal(env.checks.filter((c) => c.platform || c.tool).length, 11);
  checks.push("all environment rows are available");
  await admin("validation.start", { confirmReadOnly: true });
  await wait(
    async () => !(await admin("validation.status")).running,
    "validation",
  );
  const validation = await admin("validation.status");
  assert(validation.id);
  await admin("validation.findings", { id: validation.id });
  checks.push("inspection and findings");
  const db = new DatabaseSync(
    path.join(config.instanceRoot, "live/catalog.sqlite"),
    { readOnly: true },
  );
  try {
    assert.equal(
      db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    const facts = db.prepare("SELECT COUNT(*) AS count FROM works").get().count;
    assert.equal(facts, (await invoke("status")).counts.works);
    checks.push("SQLite integrity, foreign keys and aggregate count");
  } finally {
    db.close();
  }
  assert.deepEqual(errors, []);
  report("native-results.json", {
    conclusion: "consistent",
    checks,
    errors,
    screenshots,
    counts: (await invoke("status")).counts,
    scan: incremental,
  });
} catch (error) {
  report("native-results.json", {
    conclusion: "different",
    checks,
    errors,
    screenshots,
    failure: String(error.stack),
  });
  throw error;
} finally {
  await driver.close();
}
