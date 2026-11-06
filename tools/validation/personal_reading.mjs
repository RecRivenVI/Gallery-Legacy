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
const checks = [],
  screenshots = [],
  errors = [];
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
await context.addInitScript(() =>
  localStorage.setItem("gallery_theme", "dark"),
);
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
async function api(endpoint, input) {
  const r =
    input === undefined
      ? await context.request.get(url + "/api/v1/" + endpoint)
      : await context.request.post(url + "/api/v1/" + endpoint, {
          data: input,
        });
  const value = await r.json();
  assert(r.ok(), JSON.stringify(value));
  return value.data;
}
async function click(name) {
  const target = page
    .getByRole("button", { name, exact: true })
    .or(page.getByRole("radio", { name, exact: true }));
  await wait(async () => {
    const b = await target.first().boundingBox();
    return b?.width > 0 && b.height > 0;
  }, "layout " + name);
  await tap(target.first());
}
async function shot(name) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(750);
  await page.screenshot({ path: path.join(output, name + ".png") });
  screenshots.push(name + ".png");
}
async function go(hash) {
  await page.goto(url + "/#" + hash);
  await ready(page);
  await page.waitForTimeout(500);
}
const works = (await api("works?platform=pixiv&sort=name_asc&pageSize=48"))
  .items;
const book = works.find((w) => w.counts.media === 48);
assert(book?.details?.seriesId);
const first = (
  await api("accounts", {
    name: "读者甲 " + Date.now(),
    preferences: { theme: "dark" },
  })
).account;
const second = (
  await api("accounts", {
    name: "读者乙 " + Date.now(),
    password: "sample",
    preferences: { theme: "light" },
  })
).account;
await api("session", { id: first.id, password: "" });
try {
  await go("/@all/pixiv?sort=name_asc&pageSize=24");
  // UI favorite and history, without modifying the catalog fixture.
  await tap(
    page
      .getByRole("button", {
        name: new RegExp(book.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      })
      .first(),
    40,
  );
  await wait(
    () => page.getByRole("button", { name: "阅读方式", exact: true }).count(),
    "viewer",
  );
  await click("收藏");
  await wait(
    async () =>
      (await api("summary?path=" + encodeURIComponent(book.stableId))).personal
        ?.favorite,
    "favorite persisted",
  );
  await click("4 星");
  await click("添加我的标签");
  await replaceText(
    page.getByRole("textbox", { name: "我的标签", exact: true }),
    "读过,a",
  );
  await page.keyboard.press("Enter");
  await wait(
    async () =>
      (
        await api("summary?path=" + encodeURIComponent(book.stableId))
      ).personal?.tags.includes("读过,a"),
    "personal comma tag",
  );
  checks.push("viewer favorite rating and private comma tag");
  await shot("personal-details-dark-desktop");
  await click("阅读方式");
  await click("双页");
  await wait(
    async () =>
      (await api("summary?path=" + encodeURIComponent(book.stableId))).personal
        ?.readingMode === "double",
    "double mode saved",
  );
  await page.keyboard.press("ArrowLeft");
  await wait(() => page.url().includes("index=1"), "RTL next spread");
  await shot("reader-double-rtl-dark-desktop");
  await click("阅读方式");
  await click("纵向连续");
  const before = page.url();
  await page.mouse.move(700, 450);
  await page.mouse.wheel(0, 1400);
  await wait(() => page.url() !== before, "continuous page follows scroll");
  await shot("reader-continuous-dark-desktop");
  await click("阅读方式");
  await click("单页");
  await wait(
    async () =>
      (await api("summary?path=" + encodeURIComponent(book.stableId))).personal
        ?.readingMode === "single",
    "reading option persisted",
  );
  await page.keyboard.press("Escape");
  await wait(() => !page.url().includes("view="), "close");
  checks.push("single double continuous and RTL");
  await go("/@my/favorites?sort=favorite_desc");
  await wait(
    () => page.getByRole("button", { name: /Abstract Study/ }).count(),
    "favorites grid",
  );
  await shot("favorites-dark-desktop");
  const collection = (
    await api("collections", { accountId: first.id, name: "我的合成收藏" })
  ).items.at(-1);
  await api("personal", {
    accountId: first.id,
    work: book.stableId,
    action: "collections",
    values: [collection.id],
  });
  await go("/@my/collections");
  await shot("collections-dark-desktop");
  await tap(page.getByRole("button", { name: /我的合成收藏/ }).first());
  await wait(
    () => page.getByRole("button", { name: /Abstract Study/ }).count(),
    "collection contents",
  );
  checks.push("favorites and collections navigation");
  await go("/@my/history");
  await wait(
    () => page.getByRole("button", { name: /Abstract Study/ }).count(),
    "history grid",
  );
  await shot("history-dark-desktop");
  await go("/@my/continue");
  await wait(
    () => page.getByRole("button", { name: /Abstract Study/ }).count(),
    "continue grid",
  );
  await shot("continue-dark-desktop");
  checks.push("history and continue pages");
  await click(first.name);
  await click(second.name);
  await replaceText(
    page.getByRole("textbox", { name: "密码", exact: true }),
    "sample",
  );
  await click("登录");
  await wait(
    async () => (await api("session")).account.id === second.id,
    "account switched",
  );
  await wait(
    () => page.getByText("没有看到一半的作品", { exact: true }).count(),
    "second account isolation",
  );
  await shot("account-isolation-light-desktop");
  await click(second.name);
  await click(first.name);
  await wait(
    async () => (await api("session")).account.id === first.id,
    "switch back",
  );
  checks.push("password account switch and preferences isolation");
  // Only the exact Fanbox/pixiv key is automatic.
  const author = (await api("authors?platform=pixivFANBOX")).items[0];
  await go(author.stableId);
  const linked = (await api("author-pages/" + author.id)).linked;
  assert(linked.every((a) => a.platformId === "pixiv"));
  await click(new RegExp("^全部平台 "));
  await wait(() => page.url().includes("linkedAuthor"), "linked scope");
  await shot("author-linked-dark-desktop");
  checks.push("Fanbox exact key and merged linked-author scope");
  assert.deepEqual(errors, []);
  report("personal-reading-results.json", {
    conclusion: "consistent",
    checks,
    screenshots,
    errors,
  });
} catch (e) {
  await page
    .screenshot({ path: path.join(output, "personal-reading-failure.png") })
    .catch(() => {});
  report("personal-reading-results.json", {
    conclusion: "different",
    checks,
    screenshots,
    errors,
    failure: e.stack,
    aria: await page.locator("body").ariaSnapshot(),
  });
  throw e;
} finally {
  await context.close();
  await browser.close();
}
