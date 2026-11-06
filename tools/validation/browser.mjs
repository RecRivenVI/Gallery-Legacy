import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { url, output, driver, tap, ready, wait, report } from "./support.mjs";
const browser = await chromium.launch({ headless: true });
const errors = [],
  external = [],
  checks = [],
  screenshots = [];
async function shot(page, name) {
  await page.waitForLoadState("networkidle", { timeout: 25000 });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.screenshot({ path: path.join(output, name + ".png") });
  screenshots.push(name + ".png");
}
async function check(name, action) {
  await action();
  checks.push(name);
}
const works = (
  await fetch(
    url + "/api/v1/works?platform=pixiv&pageSize=48&sort=name_asc",
  ).then((r) => r.json())
).data.items;
const pagesWork = works.find((w) => w.counts.media === 48);
const motionWork = works.find((w) => w.counts.media === 5);
assert(
  pagesWork && motionWork,
  "Use at least two generated works with motion fixtures",
);
try {
  if (process.env.GALLERY_BROWSER_PART !== "additional")
    for (const theme of ["dark", "light"]) {
      for (const [device, width, height] of [
        ["desktop", 1440, 900],
        ["tablet", 1180, 820],
        ["mobile", 393, 852],
      ]) {
        const context = await browser.newContext({
          viewport: { width, height },
          deviceScaleFactor: device === "mobile" ? 2 : 1,
          hasTouch: device !== "desktop",
          isMobile: device === "mobile",
        });
        await context.addInitScript(
          (theme) => localStorage.setItem("gallery_theme", theme),
          theme,
        );
        await context.route("**/*", (route) => {
          const request = route.request(),
            target = new URL(request.url());
          if (
            ["data:", "blob:"].includes(target.protocol) ||
            target.hostname === "127.0.0.1"
          )
            return route.continue();
          external.push(target.origin);
          return route.abort();
        });
        const page = await context.newPage();
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(url + "/#/@all/pixiv?sort=name_asc&pageSize=24");
        await ready(page);
        await wait(
          () => page.getByRole("button", { name: /Abstract Study/ }).count(),
          "cards",
        );
        await shot(page, `web-works-${theme}-${device}`);
        await check(`viewer-${theme}-${device}`, async () => {
          await tap(
            page.getByRole("button", { name: new RegExp(pagesWork.title) }),
            50,
          );
          await wait(
            () =>
              page.getByRole("button", { name: "关闭", exact: true }).count(),
            "viewer",
          );
          await page.waitForTimeout(500);
          await shot(page, `web-viewer-${theme}-${device}`);
          // The fixture is now a manga: RTL, with the first cover alone.
          await page.keyboard.press("ArrowLeft");
          await wait(() => page.url().includes("index=1"), "manga next page");
          await page.keyboard.press("h");
          await wait(
            async () =>
              (await page
                .getByRole("button", { name: "关闭", exact: true })
                .count()) === 0,
            "hide tools",
          );
          await page.keyboard.press("h");
          await wait(
            () =>
              page.getByRole("button", { name: "关闭", exact: true }).count(),
            "restore tools",
          );
          await page.keyboard.press("+");
          await page.keyboard.press("0");
          await page.keyboard.press("i");
          await page.keyboard.press("i");
          await page.keyboard.press("Escape");
          await wait(() => !page.url().includes("&view="), "viewer close");
          assert(
            new URL(page.url()).pathname === "/",
            "History must not navigate to the asset base",
          );
        });
        await page.goto(url + "/#/@authors/pixiv");
        await ready(page);
        await page.waitForTimeout(450);
        await shot(page, `web-authors-${theme}-${device}`);
        await tap(
          page.getByRole("button", { name: "Synthetic Author", exact: true }),
          50,
        );
        await wait(
          () => page.url().includes("/p/pixiv/700"),
          "author navigation",
        );
        await page.waitForTimeout(400);
        await shot(page, `web-author-works-${theme}-${device}`);
        await page.goto(url + "/#" + pagesWork.stableId);
        await ready(page);
        await page.waitForTimeout(500);
        await shot(page, `web-pages-${theme}-${device}`);
        await page.goto(url + "/#/f/synthetic");
        await ready(page);
        await page.waitForTimeout(300);
        await shot(page, `web-files-${theme}-${device}`);
        await page.goto(url + "/#/@all/pixiv");
        await ready(page);
        await tap(page.getByRole("button", { name: "设置", exact: true }));
        await page.waitForTimeout(250);
        await shot(page, `web-settings-${theme}-${device}`);
        await page.keyboard.press("Escape");
        await context.close();
      }
    }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    hasTouch: true,
  });
  await context.addInitScript(() =>
    localStorage.setItem("gallery_theme", "dark"),
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url + "/#/@all/pixiv?sort=name_asc&pageSize=24");
  await ready(page);
  await page.waitForTimeout(250);
  await check("search and filters", async () => {
    await tap(
      page.getByRole("textbox", { name: "搜索标题、作者、标签", exact: true }),
    );
    await page.keyboard.insertText("不存在的合成作品");
    await wait(
      () => decodeURIComponent(page.url()).includes("不存在的合成作品"),
      "search query",
    );
    await page.getByRole("button", { name: "清除筛选", exact: true }).waitFor();
    await wait(
      async () =>
        (await page.getByRole("button", { name: /Abstract Study/ }).count()) ===
        0,
      "empty search completed",
    );
    await shot(page, "web-search-empty-dark-desktop");
    await tap(page.getByRole("button", { name: "清除筛选", exact: true }));
    await wait(
      () => page.getByRole("button", { name: /Abstract Study/ }).count(),
      "clear search",
    );
    await tap(page.getByRole("button", { name: "筛选", exact: true }));
    await page.waitForTimeout(350);
    await shot(page, "web-filters-dark-desktop");
    await page.keyboard.press("Escape");
  });
  await check("background, privacy and theme", async () => {
    await tap(page.getByRole("button", { name: "设置", exact: true }));
    await tap(page.getByRole("radio", { name: "浅色", exact: true }));
    await tap(page.getByRole("switch", { name: "隐私模糊" }));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    await shot(page, "web-privacy-light-desktop");
    await tap(page.getByRole("button", { name: "设置", exact: true }));
    await tap(page.getByRole("switch", { name: "隐私模糊" }));
    await tap(page.getByRole("radio", { name: "作品图片", exact: true }));
    await page.waitForTimeout(500);
    await shot(page, "web-background-picker-light-desktop");
    await page.keyboard.press("Escape");
    await wait(
      () => page.getByRole("dialog", { name: "设置", exact: true }).count(),
      "background returns to settings",
    );
    await page.keyboard.press("Escape");
    await wait(
      async () => (await page.getByRole("dialog").count()) === 0,
      "settings dismissed",
    );
  });
  await check("video playback and animated image", async () => {
    await page.goto(url + "/#/@all/pixiv?sort=name_asc");
    await ready(page);
    await page.waitForTimeout(250);
    await tap(
      page.getByRole("button", { name: new RegExp(motionWork.title) }),
      50,
    );
    await page.waitForTimeout(700);
    for (let i = 0; i < 6 && !(await page.locator("video").count()); i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(250);
    }
    await wait(() => page.locator("video").count(), "video element");
    const video = page.locator("video");
    await wait(() => video.evaluate((v) => v.readyState >= 2), "video data");
    await video.evaluate((v) => {
      v.muted = true;
      return v.play();
    });
    await page.waitForTimeout(300);
    assert(await video.evaluate((v) => v.currentTime > 0));
    await shot(page, "web-video-light-desktop");
    await page.keyboard.press("Escape");
    await wait(() => !page.url().includes("&view="), "video close");
    assert.equal(await page.locator("video").count(), 0);
  });
  await check("invalid URL and API failure", async () => {
    await page.goto(url + "/#/@all/pixiv?sort=invalid");
    await ready(page);
    await page.waitForTimeout(200);
    await shot(page, "web-invalid-light-desktop");
    await page.route("**/api/v1/works?*", (r) =>
      r.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          protocolVersion: 1,
          error: { code: "SERVICE_UNAVAILABLE" },
        }),
      }),
    );
    await page.goto(url + "/#/@all/pixiv");
    await ready(page);
    await wait(
      () => page.getByRole("button", { name: "重试", exact: true }).count(),
      "service error",
    );
    await shot(page, "web-error-light-desktop");
    await page.unroute("**/api/v1/works?*");
    await tap(page.getByRole("button", { name: "重试", exact: true }));
    await wait(
      () => page.getByRole("button", { name: /Abstract Study/ }).count(),
      "retry",
    );
  });
  await context.close();
  assert.deepEqual(errors, []);
  assert.deepEqual([...new Set(external)], []);
  report("browser-results.json", {
    conclusion: "consistent",
    checks,
    errors,
    external,
    screenshots,
  });
} catch (error) {
  for (const c of browser.contexts())
    for (const p of c.pages()) {
      await p.screenshot({ path: path.join(output, "browser-failure.png") });
      fs.writeFileSync(
        path.join(output, "browser-failure.txt"),
        p.url() + "\n" + (await p.locator("body").ariaSnapshot()),
      );
    }
  report("browser-results.json", {
    conclusion: "different",
    checks,
    errors,
    external,
    screenshots,
    failure: String(error.stack),
  });
  throw error;
} finally {
  await browser.close();
  await driver?.close();
}
