import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  url,
  output,
  tap,
  ready,
  wait,
  replaceText,
  report,
} from "./support.mjs";
import { recording } from "./recording.mjs";

const browser = await chromium.launch({
  headless: true,
  channel: process.env.GALLERY_TEST_BROWSER_CHANNEL || undefined,
});
const errors = [],
  checks = [],
  shots = [],
  recordings = [],
  requests = [];
const conditions = {
  q: "Abstract",
  tag: "synthetic",
  mediaType: "image",
  sort: "name_desc",
};
const mobileOnly = process.argv.includes("--mobile-only");
const pagerOnly = mobileOnly || process.argv.includes("--pager-only");
const resultFile = mobileOnly
  ? "mobile-results.json"
  : pagerOnly
    ? "pager-results.json"
    : "pagination-search-results.json";
let page, frameTimes, failurePage;
let beforeSearchURL;
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
await context.addInitScript(() =>
  localStorage.setItem("gallery_theme", "dark"),
);
await context.addInitScript(() => {
  window.__historyCalls = [];
  for (const name of ["pushState", "replaceState"]) {
    const original = history[name].bind(history);
    history[name] = (...args) => {
      window.__historyCalls.push({ method: name, url: args[2] });
      return original(...args);
    };
  }
});
await context.route("**/*", (route) => {
  const target = new URL(route.request().url());
  assert(
    ["127.0.0.1"].includes(target.hostname) ||
      ["blob:", "data:"].includes(target.protocol),
    "Unexpected external request",
  );
  return route.continue();
});
const parameters = () => new URLSearchParams(page.url().split("?")[1] || "");
const stateOf = (address) => {
  const [route, search] = new URL(address).hash.split("?");
  const p = new URLSearchParams(search || "");
  return JSON.stringify([
    route,
    p.get("q") || "",
    p.get("tag") || "",
    p.get("mediaType") || "all",
    p.get("sort") || "date_desc",
    p.get("page") || "1",
    p.get("pageSize") || "48",
  ]);
};
const verify = (expected, number) => {
  const actual = parameters();
  for (const [key, value] of Object.entries(expected))
    assert.equal(
      actual.get(key) ||
        (key === "mediaType" ? "all" : key === "sort" ? "date_desc" : ""),
      value,
      key,
    );
  assert.equal(actual.get("page") || "1", String(number));
};
const pager = () => page.getByRole("group", { name: "页码条", exact: true });
const band = () => page.getByRole("group", { name: "页码带", exact: true });
async function loaded(number) {
  await wait(
    async () =>
      (parameters().get("page") || "1") === String(number) &&
      (await pager().isVisible()),
    "page " + number,
  );
  await page
    .getByRole("button", { name: String(number), exact: true, pressed: true })
    .waitFor();
}
async function screenshot(name) {
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(output, name + ".png") });
  shots.push(name + ".png");
}
async function jump(number) {
  await tap(page.getByRole("button", { name: "跳到指定页", exact: true }));
  await replaceText(
    page.getByRole("textbox", { name: "跳到指定页", exact: true }),
    String(number),
  );
  await page.keyboard.press("Enter");
}
try {
  if (!mobileOnly) {
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/v1/works")
        requests.push({
          at: Date.now(),
          query: new URL(request.url()).searchParams.get("q") || "",
        });
    });
    await page.goto(url + "/#/@all/pixiv?pageSize=24");
    await ready(page);
    await loaded(1);
    await page.waitForLoadState("networkidle");
    const bounds = await pager().boundingBox();
    assert.equal(bounds.height, 42);
    assert(
      Math.abs(bounds.x + bounds.width / 2 - 840) <= 1,
      "Pager centers in the content area",
    );
    assert.equal(900 - bounds.y - bounds.height, 16);
    await screenshot("web-pager-few-dark-desktop");

    if (!pagerOnly) {
      const search = page.getByRole("textbox", { name: "搜索", exact: true });
      await page.mouse.click(500, 25);
      await page.keyboard.press("/");
      await wait(
        () =>
          page.evaluate(() => {
            let e = document.activeElement;
            while (e?.shadowRoot?.activeElement) e = e.shadowRoot.activeElement;
            return e?.tagName === "TEXTAREA" || e?.tagName === "INPUT";
          }),
        "/ focuses search",
      );
      await page.keyboard.press("/");
      await wait(
        () =>
          page.evaluate(() => {
            let e = document.activeElement;
            while (e?.shadowRoot?.activeElement) e = e.shadowRoot.activeElement;
            return e?.value === "/";
          }),
        "/ remains input text",
      );
      await replaceText(search, "");
      await page.keyboard.press("Enter");
      await wait(
        () => !parameters().get("q"),
        "slash query cleared before the next session",
      );
      await page.mouse.click(500, 25);
      const beforeUrl = page.url(),
        beforeHistory = await page.evaluate(() => history.length);
      beforeSearchURL = beforeUrl;
      await replaceText(search, "Ab");
      await wait(
        () => parameters().get("q") === "Ab",
        "first debounced search",
      );
      await replaceText(search, "Abst");
      await wait(
        () => parameters().get("q") === "Abst",
        "second debounced search",
      );
      await replaceText(search, "Abstract");
      const enter = Date.now();
      await page.keyboard.press("Enter");
      await wait(
        () => requests.some((r) => r.at >= enter && r.query === "Abstract"),
        "immediate Enter search",
      );
      const enterLatencyMs =
        requests.find((r) => r.at >= enter && r.query === "Abstract").at -
        enter;
      assert(enterLatencyMs < 220, `Enter waited ${enterLatencyMs}ms`);
      assert.equal(
        await page.evaluate(() => history.length),
        beforeHistory + 1,
      );
      await page.goBack();
      await wait(
        () => stateOf(page.url()) === stateOf(beforeUrl),
        "search history returns before focus",
      );
      await page.waitForTimeout(350);
      assert.equal(
        stateOf(page.url()),
        stateOf(beforeUrl),
        "No pending query overwrites back",
      );
      checks.push({
        name: "search session history, debounce, Enter and slash",
        enterLatencyMs,
      });

      await tap(search);
      const cdp = await context.newCDPSession(page),
        count = requests.length;
      await cdp.send("Input.imeSetComposition", {
        text: "zhongwen",
        selectionStart: 8,
        selectionEnd: 8,
      });
      await page.waitForTimeout(450);
      assert.equal(requests.length, count, "Composition must not search");
      await cdp.send("Input.insertText", { text: "中文" });
      await wait(
        () => parameters().get("q") === "中文",
        "composition commit searches",
      );
      await cdp.detach();
      checks.push("CDP composition waits for commit; real IME remains manual");

      for (let mask = 0; mask < 16; mask++) {
        const expected = {
          q: "",
          tag: "",
          mediaType: "all",
          sort: "date_desc",
        };
        Object.keys(conditions).forEach((key, index) => {
          if (mask & (1 << index)) expected[key] = conditions[key];
        });
        const query = new URLSearchParams({
          ...expected,
          page: "1",
          pageSize: "24",
        });
        await page.goto(url + "/#/@all/pixiv?" + query);
        await ready(page);
        await loaded(1);
        await tap(page.getByRole("button", { name: "下一页", exact: true }));
        await loaded(2);
        verify(expected, 2);
        await page.reload();
        await ready(page);
        await loaded(2);
        verify(expected, 2);
        await jump(1);
        await loaded(1);
        verify(expected, 1);
        await page.goBack();
        await loaded(2);
        verify(expected, 2);
      }
      checks.push(
        "all 16 condition combinations survive page, jump, reload and back",
      );
      await page.goto(
        url +
          "/#/@all/pixiv?" +
          new URLSearchParams({ ...conditions, page: "9999", pageSize: "24" }),
      );
      await ready(page);
      await loaded(2);
      verify(conditions, 2);
      await screenshot("web-page-clamped-dark-desktop");
      checks.push("out-of-range URL clamps to last real page");

      report("search-results.json", {
        conclusion: "consistent",
        checks: [...checks],
        pageErrors: errors,
      });
    }

    await page.route("**/api/v1/works?*", async (route) => {
      const target = new URL(route.request().url());
      target.searchParams.set("page", "1");
      const response = await route.fetch({ url: target.href });
      const json = await response.json();
      json.data.total = 25920;
      json.data.totalPages = 1080;
      await route.fulfill({ response, json });
    });
    await page.goto(url + "/#/@all/pixiv?page=1&pageSize=24");
    await page.reload();
    await ready(page);
    await loaded(1);
    await page.waitForLoadState("networkidle");
    const prefix = page.getByText("第", { exact: true }),
      suffix = page.getByText("/ 1,080 页", { exact: true });
    const numberSlot = await page
      .getByRole("button", { name: "跳到指定页", exact: true })
      .boundingBox();
    const a = await prefix.boundingBox(),
      b = await suffix.boundingBox();
    await tap(page.getByRole("button", { name: "跳到指定页", exact: true }));
    const aa = await prefix.boundingBox(),
      bb = await suffix.boundingBox();
    assert(
      Math.abs(a.x - aa.x) <= 0.5 && Math.abs(b.x - bb.x) <= 0.5,
      "Only the number changes to input",
    );
    const editable = await page
      .getByRole("textbox", { name: "跳到指定页", exact: true })
      .boundingBox();
    // Compose exposes editable content bounds; its surrounding field has 4px vertical padding.
    assert.equal(numberSlot.height, 28);
    assert.equal(editable.y - numberSlot.y, 4);
    assert.equal(editable.height + 8, numberSlot.height);
    await screenshot("web-pager-jump-dark-desktop");
    await replaceText(
      page.getByRole("textbox", { name: "跳到指定页", exact: true }),
      "540",
    );
    await page.keyboard.press("Enter");
    await loaded(540);
    await page.waitForTimeout(700);
    let box = await band().boundingBox(),
      current = await page
        .getByRole("button", { name: "540", exact: true, pressed: true })
        .boundingBox();
    assert(
      Math.abs(current.x + current.width / 2 - box.x - box.width / 2) <= 3,
      "Current page centers",
    );
    assert(
      (await band().getByRole("button").count()) < 14,
      "Only visible pages exist",
    );
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await band()
      .getByRole("button", { name: "向右滚动", exact: true })
      .waitFor();
    await page.waitForTimeout(700);
    const points = {};
    for (const name of ["向左滚动", "向右滚动"]) {
      const rect = await band()
        .getByRole("button", { name, exact: true })
        .boundingBox();
      points[name] = {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      };
      await page.mouse.move(points[name].x, points[name].y);
      await page.waitForTimeout(600);
      await page.waitForLoadState("networkidle");
    }
    await page.evaluate(() => {
      window.__galleryFrames = [];
      window.__galleryMeasuring = true;
      let last;
      const run = (at) => {
        if (last !== undefined) window.__galleryFrames.push(at - last);
        last = at;
        if (window.__galleryMeasuring) requestAnimationFrame(run);
      };
      requestAnimationFrame(run);
    });
    for (const name of ["向右滚动", "向右滚动", "向左滚动", "向右滚动"]) {
      await page.mouse.click(points[name].x, points[name].y);
      await page.waitForTimeout(140);
    }
    await page.waitForTimeout(700);
    frameTimes = await page.evaluate(() => {
      window.__galleryMeasuring = false;
      return window.__galleryFrames;
    });
    const renderer = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      if (!gl) return "unavailable";
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const value = info
        ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return value;
    });
    const sorted = [...frameTimes].sort((x, y) => x - y),
      median = sorted[Math.floor(sorted.length / 2)],
      missed = frameTimes.reduce(
        (n, t) => n + Math.max(0, Math.round(t / (1000 / 60)) - 1),
        0,
      );
    const performance = {
      browser: browser.version(),
      channel: process.env.GALLERY_TEST_BROWSER_CHANNEL || "headless-shell",
      frameBudgetMs: 1000 / 60,
      renderer,
      samples: frameTimes.length,
      medianMs: median,
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      maxMs: Math.max(...frameTimes),
      missedFrames: missed,
      intervalsMs: frameTimes,
      criterionMet: missed <= 2 && Math.max(...frameTimes) <= 50,
    };
    report("pager-frame-times.json", performance);
    assert(
      performance.criterionMet,
      JSON.stringify({ ...performance, intervalsMs: undefined }),
    );
    await screenshot("web-pager-1080-middle-dark-desktop");
    await jump(1);
    await loaded(1);
    await page.waitForTimeout(700);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    assert.equal(
      await band()
        .getByRole("button", { name: "向左滚动", exact: true })
        .count(),
      0,
    );
    assert(
      await page
        .getByRole("button", { name: "第一页", exact: true })
        .isDisabled(),
    );
    await jump(1080);
    await loaded(1080);
    await page.waitForTimeout(700);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    assert.equal(
      await band()
        .getByRole("button", { name: "向右滚动", exact: true })
        .count(),
      0,
    );
    current = await page
      .getByRole("button", { name: "1080", exact: true, pressed: true })
      .boundingBox();
    assert(current.x + current.width >= box.x + box.width - 1);
    await screenshot("web-pager-last-dark-desktop");
    recordings.push(
      await recording(page, output, "pagination-direction-dark", async () => {
        await tap(page.getByRole("button", { name: "上一页", exact: true }));
        await loaded(1079);
        await page.waitForTimeout(650);
        await tap(page.getByRole("button", { name: "下一页", exact: true }));
        await loaded(1080);
        await page.waitForTimeout(650);
      }),
    );
    checks.push(
      "1080 continuous band, center/endpoints, hovered arrows, fixed jump geometry and frame time",
    );

    report("band-results.json", {
      conclusion: "consistent",
      checks: [...checks],
      screenshots: [...shots],
      recordings: [...recordings],
      pageErrors: errors,
    });
  }

  for (const theme of ["light", "dark"]) {
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    await mobile.addInitScript(
      (t) => localStorage.setItem("gallery_theme", t),
      theme,
    );
    const m = await mobile.newPage();
    failurePage = m;
    m.on("pageerror", (e) => errors.push(e.message));
    await m.goto(url + "/#/@all/pixiv?pageSize=24");
    await ready(m);
    await m.getByRole("group", { name: "页码条", exact: true }).waitFor();
    await tap(m.getByRole("button", { name: "搜索", exact: true }));
    await m.getByRole("textbox", { name: "搜索", exact: true }).waitFor();
    await replaceText(
      m.getByRole("textbox", { name: "搜索", exact: true }),
      "Abstract",
    );
    await m.keyboard.press("Enter");
    await wait(() => m.url().includes("q=Abstract"), "mobile search");
    await tap(m.getByRole("button", { name: "收起搜索", exact: true }));
    await wait(
      async () =>
        (await m
          .getByRole("textbox", { name: "搜索", exact: true })
          .count()) === 0,
      "mobile search collapsed",
    );
    assert(m.url().includes("q=Abstract"));
    const snapshot = await m
      .getByRole("group", { name: "页码条", exact: true })
      .ariaSnapshot();
    assert(!/text:.*[第页]/.test(snapshot));
    await m.waitForLoadState("networkidle");
    const name = `web-pager-search-${theme}-mobile.png`;
    await m.screenshot({ path: path.join(output, name) });
    shots.push(name);
    await mobile.close();
  }
  checks.push(
    "mobile search collapses without clearing and pager has no 第/页 text",
  );
  assert.deepEqual(errors, []);
  report(resultFile, {
    conclusion: "consistent",
    checks,
    screenshots: shots,
    recordings,
    pageErrors: errors,
  });
} catch (error) {
  page = failurePage && !failurePage.isClosed() ? failurePage : page;
  if (page && !page.isClosed()) {
    await page.screenshot({
      path: path.join(output, "pagination-search-failure.png"),
    });
    fs.writeFileSync(
      path.join(output, "pagination-search-failure.txt"),
      page.url() + "\n" + (await page.locator("body").ariaSnapshot()),
    );
  }
  report(resultFile, {
    conclusion: "different",
    checks,
    pageErrors: errors,
    frameTimes,
    beforeSearchURL,
    historyCalls:
      page && !page.isClosed()
        ? await page.evaluate(() => window.__historyCalls)
        : [],
    failure: String(error.stack),
  });
  throw error;
} finally {
  await browser.close();
}
