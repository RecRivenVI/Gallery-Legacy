"use strict";

// Explicit private-data acceptance. No screenshots, traces, HAR, recordings,
// source text, filenames, author identities or media bytes are written to reports.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { readRuntimeConfig } = require("../internal/instance/config.js");
const { writeJson } = require("../internal/instance/files.js");
const { normalizeSearchText } = require("../internal/search/build.js");
async function accept(config) {
  const result = {
    version: 1,
    startedAtMs: Date.now(),
    checks: {},
    counts: {},
    stage: "runtime",
    privacy: { screenshots: 0, recordings: 0, privateContentInReport: false },
  };
  async function api(resource, params = {}) {
    const q = new URLSearchParams(params),
      r = await fetch(
        config.url + "/api/v1/" + resource + (q.size ? "?" + q : ""),
        { signal: AbortSignal.timeout(60000) },
      );
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.protocolVersion, 1);
    return body;
  }
  try {
    const health = await api("health"),
      status = (await api("status")).data;
    assert.equal(health.data.instanceId, config.instanceId);
    assert.equal(health.data.schemaVersion, 4);
    assert.equal(status.loadedGenerationId, status.activeGenerationId);
    result.generationId = status.loadedGenerationId;
    result.counts = status.counts;
    result.checks.runtime = status.state === "READY";
    result.checks.manager =
      Number.isSafeInteger(status.managerPid) && status.managerPid > 0;
    assert.equal(result.checks.runtime, true);
    assert.equal(result.checks.manager, true);
    assert.equal((await api("platforms")).data.items.length, 8);
    result.stage = "short-search";
    for (const q of ["R", "R-"]) {
      const data = (await api("works", { q, pageSize: "20" })).data;
      assert.ok(data.total > 0);
      result.checks["shortSearch" + [...q].length] = true;
    }
    result.stage = "exact-tag";
    const tagged = (await api("works", { tag: "R-18", pageSize: "100" })).data;
    assert.ok(tagged.total > 0);
    assert.ok(
      tagged.items.every((w) => w.tags.some((t) => t.label === "R-18")),
    );
    result.checks.exactTag = true;
    result.counts.exactTagWorks = tagged.total;
    result.stage = "authors";
    const authors = (await api("authors", { pageSize: "100" })).data;
    const author = authors.items.find((a) => a.workCount > 0);
    assert.ok(author);
    const byAuthor = (await api("works", { author: author.id, pageSize: "20" }))
      .data;
    assert.ok(byAuthor.total > 0);
    assert.ok(byAuthor.items.every((w) => w.authorId === author.id));
    result.checks.author = true;
    assert.equal(
      typeof (await api("authors", { q: "a" })).data.total,
      "number",
    );
    assert.ok((await api("tags")).data.total > 0);
    result.checks.tags = true;
    for (const sort of [
      "date_desc",
      "date_asc",
      "title_asc",
      "title_desc",
      "name_asc",
      "name_desc",
    ]) {
      result.stage = "sort-" + sort;
      const data = (
        await api("works", { platform: "pixiv", sort, pageSize: "30" })
      ).data;
      assert.ok(data.items.length > 0);
      if (sort.startsWith("date"))
        for (let i = 1; i < data.items.length; i++)
          assert.ok(
            sort.endsWith("asc")
              ? data.items[i - 1].sortAtMs <= data.items[i].sortAtMs
              : data.items[i - 1].sortAtMs >= data.items[i].sortAtMs,
          );
      if (sort.startsWith("title"))
        for (let i = 1; i < data.items.length; i++) {
          const a = normalizeSearchText(data.items[i - 1].title),
            b = normalizeSearchText(data.items[i].title);
          assert.ok(sort.endsWith("asc") ? a <= b : a >= b);
        }
    }
    result.checks.sort = true;
    result.stage = "pagination";
    const first = (await api("works", { platform: "pixiv", pageSize: "30" }))
      .data;
    const next = (
      await api("works", {
        platform: "pixiv",
        pageSize: "30",
        cursor: first.cursor,
      })
    ).data;
    assert.equal(
      new Set([...first.items, ...next.items].map((w) => w.id)).size,
      first.items.length + next.items.length,
    );
    result.checks.pagination = true;
    result.stage = "media-filters";
    const images = (await api("works", { mediaType: "image", pageSize: "30" }))
      .data;
    const videos = (
      await api("works", {
        platform: "pixiv",
        mediaType: "video",
        pageSize: "30",
      })
    ).data;
    assert.ok(
      images.items.every((w) => w.counts.images > 0 && w.counts.videos === 0),
    );
    assert.ok(videos.items.every((w) => w.counts.videos > 0));
    result.checks.mediaFilters = true;
    for (const work of [
      images.items.find((w) => w.cover),
      videos.items.find((w) => w.cover),
    ]) {
      assert.ok(work);
      result.stage = "cover-" + work.cover.type;
      const r = await fetch(config.url + work.cover.thumbnailUrl, {
        signal: AbortSignal.timeout(60000),
      });
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type"), /image\/webp/);
      assert.ok((await r.arrayBuffer()).byteLength > 0);
    }
    result.checks.covers = true;
    result.checks.videoFirstFrame = true;
    result.stage = "video-sample";
    let sample, workId;
    for (const work of videos.items.slice(0, 10)) {
      const detail = (await api("works/" + work.id, { g: result.generationId }))
        .data;
      sample = detail.media.find(
        (m) => m.type === "video" && m.fileName.toLowerCase().endsWith(".webm"),
      );
      if (sample) {
        workId = work.id;
        break;
      }
    }
    assert.ok(sample);
    result.stage = "media-head-range";
    const head = await fetch(config.url + sample.url, {
      method: "HEAD",
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type"), /video\/webm/);
    const range = await fetch(config.url + sample.url, {
      headers: { Range: "bytes=0-31" },
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 32);
    result.checks.headAndRange = true;
    result.stage = "browser-launch";
    const { chromium } = require("playwright");
    process.env.TEMP = config.tempRoot;
    process.env.TMP = config.tempRoot;
    const context = await chromium.launchPersistentContext(
      path.join(config.tempRoot, "acceptance-browser"),
      {
        headless: true,
        downloadsPath: path.join(config.tempRoot, "acceptance-downloads"),
        viewport: { width: 1440, height: 1000 },
        env: { ...process.env },
      },
    );
    try {
      const page = await context.newPage();
      let errors = 0;
      page.on("pageerror", () => errors++);
      result.stage = "web-exact-tag";
      await page.goto(config.url + "/#/@all/pixiv?tag=R-18");
      await page.waitForFunction(
        () => document.querySelectorAll("#content .card").length > 0,
      );
      const tags = await page
        .locator("#content .card")
        .evaluateAll((cards) =>
          cards.every((c) =>
            Array.from(c.querySelectorAll("[data-tag]")).some(
              (t) => t.getAttribute("data-tag") === "R-18",
            ),
          ),
        );
      assert.ok(tags);
      result.checks.webExactTag = true;
      result.stage = "web-video";
      await page.goto(
        config.url + "/#/work/" + workId + "?g=" + result.generationId,
      );
      await page.waitForSelector("#content .card.img");
      await page
        .locator("#content .card.img")
        .first()
        .locator(".media-cover")
        .click();
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll(".lb-slide video")).some(
          (v) => v.readyState >= 2,
        ),
      );
      result.checks.webmPlayback = await page
        .locator(".lb-slide video")
        .first()
        .evaluate(async (v) => {
          v.muted = true;
          await v.play();
          await new Promise((r) => setTimeout(r, 250));
          return !v.error && !v.paused && v.currentTime > 0;
        });
      assert.ok(result.checks.webmPlayback);
      result.stage = "manager-dom";
      await page.goto(config.url + "/manage");
      await page.waitForSelector("#scan");
      result.checks.managerDom = await page
        .locator("#root")
        .evaluate((el, g) => el.textContent.includes(g), result.generationId);
      assert.ok(result.checks.managerDom);
      result.stage = "web-errors";
      assert.equal(errors, 0);
    } finally {
      await context.close();
    }
    result.finishedAtMs = Date.now();
    result.state = "PASS";
    result.stage = "complete";
    return result;
  } catch (error) {
    error.acceptanceResult = {
      ...result,
      state: "FAIL",
      code: error.code || "ACCEPTANCE_FAILED",
      finishedAtMs: Date.now(),
    };
    throw error;
  }
}
async function main() {
  const args = process.argv.slice(2),
    index = args.indexOf("--config");
  if (index < 0 || !args.includes("--confirm-private-read-only"))
    throw Object.assign(
      new Error("Explicit private read-only acceptance confirmation required"),
      { code: "ACCEPTANCE_CONFIRMATION_REQUIRED" },
    );
  const config = readRuntimeConfig(path.resolve(args[index + 1]));
  let result;
  try {
    result = await accept(config);
  } catch (e) {
    result = e.acceptanceResult || {
      state: "FAIL",
      code: e.code || "ACCEPTANCE_FAILED",
    };
  }
  writeJson(path.join(config.reportsRoot, "acceptance.json"), result);
  console.log(JSON.stringify(result));
  if (result.state !== "PASS") process.exitCode = 1;
}
if (require.main === module)
  main().catch((e) => {
    console.error(e.code || "ACCEPTANCE_FAILED");
    process.exitCode = 1;
  });
module.exports = { accept };
