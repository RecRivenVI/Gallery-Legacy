import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright";
import {
  url,
  output,
  ready,
  tap,
  wait,
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
  errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
async function click(locator) {
  await wait(async () => {
    const box = await locator.first().boundingBox();
    return box && box.width > 0 && box.height > 0;
  }, "laid out control");
  await tap(locator);
}
async function check(name, action) {
  await action();
  checks.push(name);
}
const session = async () =>
  (await (await context.request.get(url + "/api/v1/session")).json()).data;
try {
  await page.goto(url + "/#/@all/pixiv?sort=name_asc&pageSize=24");
  await ready(page);
  await wait(
    () => page.getByRole("button", { name: /Abstract Study/ }).count(),
    "synthetic cards",
  );
  await check("create-and-login", async () => {
    await click(page.getByRole("button", { name: "登录", exact: true }));
    await click(page.getByRole("button", { name: "新建账号", exact: true }));
    await replaceText(
      page.getByRole("textbox", { name: "名称", exact: true }),
      "自动验收 " + Date.now(),
    );
    await click(page.getByRole("button", { name: "创建", exact: true }));
    await wait(async () => !!(await session()).account, "account cookie");
    assert.equal((await session()).preferences.theme, "dark");
  });
  await check("advanced-fields-and-platforms", async () => {
    await click(page.getByRole("button", { name: "高级搜索", exact: true }));
    await replaceText(
      page.getByRole("textbox", { name: "标题", exact: true }),
      "Abstract",
    );
    await click(
      page.getByRole("button", { name: "f pixivFANBOX", exact: true }),
    );
    await click(page.getByRole("button", { name: "搜索", exact: true }));
    await wait(
      () =>
        page.url().includes("title%3AAbstract") &&
        page.url().includes("pixivFANBOX"),
      "query URL",
    );
    await wait(
      async () =>
        (await page.getByRole("button", { name: /Abstract Study/ }).count()) >
        1,
      "mixed search results",
    );
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: path.join(output, "search-personal-first-dark-desktop.png"),
    });
  });
  assert.deepEqual(errors, []);
  report("search-personal-results.json", {
    conclusion: "consistent",
    scope: "initial account and advanced-search browser integration",
    checks,
    errors,
  });
} catch (error) {
  await page
    .screenshot({ path: path.join(output, "search-personal-failure.png") })
    .catch(() => {});
  report("search-personal-results.json", {
    conclusion: "different",
    checks,
    errors,
    failure: error.stack,
    aria: await page.locator("body").ariaSnapshot(),
  });
  throw error;
} finally {
  await context.close();
  await browser.close();
}
