import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { recording } from "./recording.mjs";
import { createHash } from "node:crypto";
import {
  url,
  output,
  driver,
  tap,
  wait,
  ready,
  replaceText,
  report,
} from "./support.mjs";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
await context.addInitScript(() =>
  localStorage.setItem("gallery_theme", "dark"),
);
const page = await context.newPage(),
  checks = [],
  screenshots = [],
  recordings = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const shot = async (name) => {
  if (!name.includes("-loading-"))
    await page.waitForLoadState("networkidle", { timeout: 25000 });
  await page.screenshot({ path: path.join(output, name + ".png") });
  screenshots.push(name + ".png");
};
const control = (name) =>
  tap(
    page
      .getByRole("button", { name, exact: true })
      .or(page.getByRole("radio", { name, exact: true })),
  );
const card = () => page.getByRole("button", { name: /Abstract Study/ }).first();
async function grid() {
  await page.goto(url + "/#/@all/pixiv?sort=name_asc&pageSize=24");
  await ready(page);
  await wait(() => card().count(), "grid");
  await page.waitForTimeout(300);
}
const record = async (name, action) =>
  recordings.push(await recording(page, output, name, action));

try {
  await grid();
  await control("视频");
  await wait(
    () => page.getByRole("button", { name: "作品 1", exact: true }).count(),
    "video filter count",
  );
  assert.equal(
    await page.getByRole("button", { name: "作者", exact: true }).count(),
    1,
  );
  await control("全部");
  await wait(
    () => page.getByRole("button", { name: "作品 32", exact: true }).count(),
    "clear media filter",
  );
  checks.push("media filter updates work total and author count label");
  await control("下一页");
  await wait(() => page.url().includes("page=2"), "next page");
  await wait(
    () => page.getByRole("button", { name: /Abstract Study A000020/ }).count(),
    "second page content",
  );
  await control("跳到指定页");
  await replaceText(
    page.getByRole("textbox", { name: "跳到指定页", exact: true }),
    "1",
  );
  await page.keyboard.press("Enter");
  await wait(() => page.url().includes("page=1"), "jump page");
  checks.push("pagination and focused numeric jump");
  await shot("web-pagination-dark-desktop");
  await control("1:1");
  await control("4:3");
  await wait(
    () => page.getByRole("button", { name: "4:3", exact: true }).count(),
    "ratio",
  );
  checks.push("ratio presets");
  await record("navigation-theme-interrupt-dark", async () => {
    await control("收起侧边栏");
    await page.waitForTimeout(300);
    await control("展开侧边栏");
    await page.waitForTimeout(300);
    await control("设置");
    await control("浅色");
    await page.waitForTimeout(100);
    await control("深色");
    await page.waitForTimeout(400);
    await page.keyboard.press("Escape");
    await wait(
      () => page.getByRole("button", { name: "设置", exact: true }).count(),
      "theme panel closes",
    );
  });
  await record("viewer-interrupt-dark", async () => {
    await tap(card(), 50);
    await page.getByRole("dialog", { name: "看大图", exact: true }).waitFor();
    await page.waitForTimeout(100);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    await wait(
      () => page.getByRole("button", { name: "设置", exact: true }).count(),
      "interrupted close",
    );
  });
  await control("分栏");
  await tap(card(), 50);
  await wait(
    () => page.getByRole("button", { name: "完整看大图", exact: true }).count(),
    "split",
  );
  await page.waitForTimeout(600);
  await shot("web-split-dark-desktop");
  await page.setViewportSize({ width: 1180, height: 820 });
  await wait(
    () => page.getByRole("dialog", { name: "看大图", exact: true }).count(),
    "narrow full viewer",
  );
  assert.equal(
    await page.getByRole("button", { name: "分栏", exact: true }).count(),
    0,
  );
  await shot("web-split-narrow-dark-tablet");
  await control("关闭");
  await wait(
    () => page.getByRole("button", { name: "设置", exact: true }).count(),
    "narrow close",
  );
  checks.push("split enters and becomes full viewer below 1280");
  await page.setViewportSize({ width: 1440, height: 900 });
  await control("分栏");
  let releaseWorks;
  const heldWorks = new Promise((resolve) => {
    releaseWorks = resolve;
  });
  await page.route("**/api/v1/works?*", async (r) => {
    await heldWorks;
    await r.continue();
  });
  await page.reload();
  await ready(page);
  await shot("web-loading-dark-desktop");
  assert.equal(
    await page.getByRole("button", { name: "跳到指定页", exact: true }).count(),
    0,
  );
  releaseWorks();
  await wait(() => card().count(), "loading ends");
  await page.unrouteAll({ behavior: "wait" });
  const empty = (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        protocolVersion: 1,
        data: { items: [], total: 0, totalPages: 0, page: 1, pageSize: 24 },
      }),
    });
  await page.route("**/api/v1/works?*", empty);
  await page.reload();
  await ready(page);
  await page
    .getByText("这个平台还没有作品", { exact: true })
    .waitFor({ state: "attached" });
  await shot("web-platform-empty-dark-desktop");
  assert.equal(
    await page.getByRole("button", { name: "跳到指定页", exact: true }).count(),
    0,
  );
  await page.unroute("**/api/v1/works?*");
  await page.route("**/api/v1/files?*", empty);
  await page.goto(url + "/#/f/synthetic");
  await page
    .getByText("这个文件夹里没有图片或视频", { exact: true })
    .waitFor({ state: "attached" });
  await shot("web-folder-empty-dark-desktop");
  await page.unroute("**/api/v1/files?*");
  await page.reload();
  await ready(page);
  await wait(
    () =>
      page.getByRole("button", { name: "Unicode folder", exact: true }).count(),
    "file folder",
  );
  await control("Unicode folder");
  await wait(
    () => page.getByRole("button", { name: "1.png", exact: true }).count(),
    "file image",
  );
  await tap(page.getByRole("button", { name: "1.png", exact: true }), 50);
  await wait(
    () =>
      page
        .locator("[data-gallery-media] img")
        .evaluateAll((a) => a.some((i) => i.complete && i.naturalWidth > 0)),
    "file viewer",
  );
  await page.waitForTimeout(650);
  await shot("web-file-viewer-dark-desktop");
  await page.reload();
  await ready(page);
  await wait(
    () =>
      page
        .locator("[data-gallery-media] img")
        .evaluateAll((a) => a.some((i) => i.complete && i.naturalWidth > 0)),
    "file viewer reload",
  );
  assert.equal(await page.getByRole("button", { name: /查看全部/ }).count(), 0);
  await control("关闭");
  checks.push("file folder navigation, file viewer and saved URL reload");
  checks.push("true delayed loading and empty states have no pager");
  await grid();
  await page.route("**/api/v1/media/*", async (r) => {
    await page.waitForTimeout(1900);
    await r.continue();
  });
  await record("original-loading-dark", async () => {
    await tap(card(), 50);
    await page.waitForTimeout(1150);
    await shot("web-original-loading-dark-desktop");
    await wait(
      () =>
        page
          .locator("[data-gallery-media] img")
          .evaluateAll((a) => a.some((i) => i.complete && i.naturalWidth > 0)),
      "original loads",
    );
    await page.waitForTimeout(500);
  });
  await page.unroute("**/api/v1/media/*");
  const zoom = page.getByRole("slider", { name: "缩放", exact: true });
  await tap(zoom);
  await page.waitForTimeout(150);
  const zoomValue = Number(await zoom.getAttribute("aria-valuenow")),
    beforeZoomPage = page.url();
  await page.keyboard.press("ArrowLeft");
  await wait(
    async () => Number(await zoom.getAttribute("aria-valuenow")) < zoomValue,
    "focused slider handles arrows",
  );
  assert.equal(page.url(), beforeZoomPage);
  await shot("web-keyboard-focus-dark-desktop");
  await page.keyboard.press("0");
  await page.keyboard.press("Tab");
  checks.push("zoom keyboard input changes scale without turning pages");
  await record("viewer-controls-dark", async () => {
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(250);
    await page.keyboard.press("i");
    await page.keyboard.press("+");
    await page.waitForTimeout(250);
    await page.keyboard.press("0");
    await page.keyboard.press("h");
    await page.waitForTimeout(500);
    await page.keyboard.press("h");
    await page.waitForTimeout(500);
    await page.keyboard.press("i");
  });
  await control("关闭");
  await wait(
    () => page.getByRole("button", { name: "设置", exact: true }).count(),
    "close original",
  );
  await page.route("**/api/v1/media/*", (r) =>
    r.fulfill({ status: 503, body: "" }),
  );
  await tap(card(), 50);
  await wait(
    () => page.getByRole("button", { name: "重试", exact: true }).count(),
    "original fails",
  );
  await shot("web-original-error-dark-desktop");
  await page.unroute("**/api/v1/media/*");
  await control("重试");
  await wait(
    () =>
      page
        .locator("[data-gallery-media] img")
        .evaluateAll((a) => a.some((i) => i.complete && i.naturalWidth > 0)),
    "original retry",
  );
  await control("关闭");
  checks.push("original thumbnail wait, failure panel and retry");
  await grid();
  await control("设置");
  await control("作品图片");
  await page.waitForTimeout(350);
  await tap(
    page
      .getByRole("dialog", { name: "选择背景" })
      .getByRole("button", { name: /Abstract Study/ })
      .first(),
  );
  await wait(
    () => page.getByRole("slider", { name: "背景淡化", exact: true }).count(),
    "background dim",
  );
  await shot("web-image-background-dark-desktop");
  await control("纯色");
  await page.keyboard.press("Escape");
  await wait(
    () => page.getByRole("button", { name: "设置", exact: true }).count(),
    "background settings close",
  );
  checks.push("background choice, dimming and clearing");
  await page.setViewportSize({ width: 393, height: 852 });
  await grid();
  await record("drawer-dark-mobile", async () => {
    await control("展开侧边栏");
    await page.waitForTimeout(450);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  });
  await control("展开侧边栏");
  await wait(
    () => page.getByRole("dialog", { name: "导航" }).count(),
    "drawer",
  );
  await page.waitForTimeout(300);
  await shot("web-drawer-dark-mobile");
  await page.keyboard.press("Escape");
  await wait(
    async () => (await page.getByRole("dialog").count()) === 0,
    "drawer closes",
  );
  await tap(card(), 50);
  await page.waitForTimeout(700);
  if (await page.getByRole("button", { name: "收起", exact: true }).count()) {
    await control("收起");
    await page.waitForTimeout(300);
  }
  const box = await page.locator("[data-gallery-media]").boundingBox();
  const cdp = await context.newCDPSession(page);
  async function swipe(from, to) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from.x, y: from.y, id: 1 }],
    });
    for (let i = 1; i <= 8; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: from.x + ((to.x - from.x) * i) / 8,
            y: from.y + ((to.y - from.y) * i) / 8,
            id: 1,
          },
        ],
      });
      await page.waitForTimeout(20);
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });
  const middle = box.y + box.height / 2;
  await swipe({ x: 320, y: middle }, { x: 70, y: middle });
  await wait(() => page.url().includes("index=1"), "touch swipe flips");
  await swipe({ x: 190, y: middle + 130 }, { x: 190, y: middle - 130 });
  await wait(
    () => page.getByRole("button", { name: "收起", exact: true }).count(),
    "touch details",
  );
  assert.equal(
    await page.getByRole("button", { name: "上一页", exact: true }).count(),
    0,
  );
  await shot("web-touch-details-dark-mobile");
  await control("收起");
  await page.waitForTimeout(500);
  const original = page.locator("[data-gallery-media] img");
  const initialWidth = await original.evaluate(
    (e) => e.getBoundingClientRect().width,
  );
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: 140, y: middle, id: 1 },
      { x: 240, y: middle, id: 2 },
    ],
  });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: 140 - i * 8, y: middle, id: 1 },
        { x: 240 + i * 8, y: middle, id: 2 },
      ],
    });
    await page.waitForTimeout(25);
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await wait(
    async () =>
      (await original.evaluate((e) => e.getBoundingClientRect().width)) >
      initialWidth * 1.2,
    "pinch enlarges original",
  );
  checks.push("two-touch pinch changes real media scale");
  await page.keyboard.press("Escape");
  await cdp.detach();
  checks.push("mobile drawer and real CDP touch swipe/details");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await grid();
  await page.reload();
  await ready(page);
  await wait(() => card().count(), "reduced grid");
  await control("设置");
  assert.equal(
    await page
      .getByRole("switch", { name: "减少动态效果" })
      .getAttribute("aria-checked"),
    "true",
  );
  await page.keyboard.press("Escape");
  await wait(
    async () => (await page.getByRole("dialog").count()) === 0,
    "reduced panel closes",
  );
  await page.waitForTimeout(900);
  const bounds = await card().boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 50);
  await page.waitForTimeout(150);
  const beforeMotion = createHash("sha256")
    .update(await page.screenshot({ clip: bounds }))
    .digest("hex");
  await page.waitForTimeout(700);
  assert.equal(
    createHash("sha256")
      .update(await page.screenshot({ clip: bounds }))
      .digest("hex"),
    beforeMotion,
  );
  await shot("web-reduced-motion-dark-mobile");
  checks.push(
    "system reduced motion disables card fan and automatic text movement",
  );
  assert.deepEqual(errors, []);
  report("interaction-results.json", {
    conclusion: "consistent",
    checks,
    screenshots,
    recordings,
    errors,
  });
} catch (e) {
  await page.screenshot({ path: path.join(output, "interaction-failure.png") });
  fs.writeFileSync(
    path.join(output, "interaction-failure.txt"),
    page.url() + "\n" + (await page.locator("body").ariaSnapshot()),
  );
  report("interaction-results.json", {
    conclusion: "different",
    checks,
    screenshots,
    recordings,
    errors,
    failure: String(e.stack),
  });
  throw e;
} finally {
  await page.unrouteAll({ behavior: "wait" });
  await browser.close();
  await driver?.close();
}
