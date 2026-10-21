"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const fs = require("node:fs"),
  http = require("node:http");

test("Manager errors replace stale service/empty states and retain panel controls", async (t) => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--mute-audio"],
  });
  t.after(() => browser.close());
  const server = http.createServer((req, res) => {
    const file = path.join(
      path.resolve("public"),
      new URL(req.url, "http://localhost").pathname,
    );
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader(
      "Content-Type",
      {
        ".js": "application/javascript",
        ".css": "text/css",
        ".html": "text/html",
      }[path.extname(file)] || "application/octet-stream",
    );
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  await page.addInitScript(() => {
    const platforms = [
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
    window.backend = {};
    const fail = () => {
      throw Object.assign(Error("synthetic timeout"), {
        code: "CONTROL_TIMEOUT",
      });
    };
    window.galleryHost = {
      resourceBase: async () => null,
      status: async () =>
        window.backend.status
          ? fail()
          : {
              state: "READY",
              counts: { works: 71 },
              startedAtMs: Date.now() - 3000,
              scan: { state: "IDLE", running: false },
            },
      admin: async (op) => {
        if (op === "config.read")
          return {
            value: {
              sources: Object.fromEntries(
                platforms.map((p) => [p, "D:/Synthetic/" + p]),
              ),
              mode: "local",
              port: 18000,
            },
            revision: "synthetic",
          };
        if (op === "access.read")
          return window.backend.access
            ? fail()
            : { enabled: true, clients: [] };
        if (op === "logs.list")
          return window.backend.logs ? fail() : { items: [] };
        if (op === "validation.status") return { running: false };
        if (op === "storage.read") return { cache: { bytes: 0 } };
        if (op === "diagnostics.run")
          return new Promise((resolve) => {
            window.finishEnvironment = () =>
              resolve({
                checks: [
                  { tool: "magick", available: false },
                  { tool: "ffmpeg", available: true },
                  ...platforms.map((platform) => ({
                    platform,
                    available: true,
                  })),
                ],
              });
          });
        throw Error("Unexpected operation: " + op);
      },
    };
  });
  await page.goto(
    `http://127.0.0.1:${server.address().port}/manager/index.html`,
  );
  await page.waitForFunction(() => window.__managerCandidate);
  await page.evaluate(async () => {
    backend.status = true;
    await __managerCandidate.poll();
  });
  assert.equal(
    await page.locator("#side-status").textContent(),
    "服务状态无法读取",
  );
  assert.equal(
    await page
      .locator("#page")
      .textContent()
      .then((v) => v.includes("服务运行中")),
    false,
  );
  assert.match(await page.locator("#page").textContent(), /作品总数 71/);
  await page.evaluate(async () => {
    backend.status = false;
    await __managerCandidate.poll();
    backend.access = true;
    await __managerCandidate.go("access");
  });
  assert.equal(await page.locator("#blocking").count(), 1);
  assert.equal(await page.locator("[data-period]").count(), 3);
  assert.match(await page.locator("#page").textContent(), /读取访问记录失败/);
  assert.doesNotMatch(
    await page.locator("#page").textContent(),
    /这段时间没有访问记录/,
  );
  await page.evaluate(async () => {
    backend.access = false;
    await __managerCandidate.poll();
  });
  assert.match(
    await page.locator("#page").textContent(),
    /这段时间没有访问记录/,
  );
  await page.evaluate(async () => {
    backend.logs = true;
    await __managerCandidate.go("diagnose");
  });
  assert.match(await page.locator("#log-lines").textContent(), /读取日志失败/);
  assert.doesNotMatch(
    await page.locator("#log-lines").textContent(),
    /还没有日志/,
  );
  await page.evaluate(async () => {
    backend.logs = false;
    await __managerCandidate.refreshPage();
  });
  assert.equal(await page.locator(".environment-placeholder").count(), 11);
  assert.doesNotMatch(await page.locator(".environment").textContent(), /…/);
  await page.evaluate(() => finishEnvironment());
  await page.waitForFunction(
    () => !__managerCandidate.state.environmentLoading,
  );
  assert.equal(await page.locator(".environment .ok").count(), 10);
  assert.equal(await page.locator(".environment .err").count(), 1);
  assert.match(await page.locator("#page").textContent(), /没有缓存/);
  await page.evaluate(() => __managerCandidate.go("settings"));
  assert.equal(await page.locator("#public-url").isDisabled(), true);
  await page.selectOption("#network-mode", "lan");
  assert.equal(await page.locator("#public-url").isEnabled(), true);
});

test("Manager dates and subsecond results use the specified language", async () => {
  const { clock, duration, cacheLabel } = await import(
    pathToFileURL(path.resolve("public/manager/model.js"))
  );
  const now = new Date(2026, 9, 21, 9, 30).getTime();
  assert.equal(clock(now, now), "今天 09:30");
  assert.equal(
    clock(new Date(2026, 9, 20, 8, 15).getTime(), now),
    "10 月 20 日 08:15",
  );
  assert.equal(duration(0), "不到 1 秒");
  assert.equal(cacheLabel(0), "没有缓存");
  assert.equal(cacheLabel(50), "缩略图缓存不到 1 MB");
});
