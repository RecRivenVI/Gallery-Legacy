"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
test("candidate logs summarize synthetic updates and retain exact raw details", async () => {
  const { logRows } = await import("../../public/manager/logs.js");
  const raw = JSON.stringify({
    timestamp: "2026-10-03T01:00:00Z",
    level: "info",
    event: "scan.complete",
    platformId: "Fantia",
    mode: "incremental",
    elapsedMs: 8000,
    changes: { worksAdded: 0, worksUpdated: 0, worksDeleted: 0 },
  });
  const [row] = logRows(raw);
  assert.equal(
    row.summary,
    "Fantia 增量更新完成：新增 0 · 更新 0 · 移除 0 · 用时 8 秒",
  );
  assert.equal(row.raw, raw);
  assert.equal(row.levelName, "信息");
  assert.match(row.time, /\d{2}:\d{2}:\d{2}/);
});
test("log display uses logical source paths without changing raw content", async () => {
  const { logRows } = await import("../../public/manager/logs.js");
  const raw = JSON.stringify({
    level: "warn",
    message: "目录无法读取：C:\\Demo\\pixiv\\Author\\Work",
  });
  const [row] = logRows(raw, { pixiv: "C:\\Demo\\pixiv" });
  assert.equal(row.summary, "目录无法读取：pixiv / Author / Work");
  assert.equal(row.raw, raw);
  assert.equal(row.levelName, "警告");
});
test("logs handle ready, empty, malformed lines and missing timestamps honestly", async () => {
  const { logRows } = await import("../../public/manager/logs.js");
  assert.deepEqual(logRows("\n"), []);
  const rows = logRows('{"event":"ready"}\n目录无法读取\nnull');
  assert.equal(rows[0].summary, "服务已启动");
  assert.equal(rows[0].time, "—");
  assert.equal(rows[1].summary, "目录无法读取");
  assert.equal(rows[2].summary, "服务记录");
});
