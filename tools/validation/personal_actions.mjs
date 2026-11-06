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
const b = await chromium.launch({ headless: true });
const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await c.newPage();
const checks = [],
  errors = [];
p.on("pageerror", (e) => errors.push(e.message));
const api = async (endpoint, input) => {
  const r =
    input === undefined
      ? await c.request.get(url + "/api/v1/" + endpoint)
      : await c.request.post(url + "/api/v1/" + endpoint, { data: input });
  const value = await r.json();
  assert(r.ok(), JSON.stringify(value));
  return value.data;
};
const a = (
  await api("accounts", { name: "动作验收", preferences: { theme: "dark" } })
).account;
const book = (await api("works?platform=pixiv&sort=name_asc")).items.find(
  (w) => w.counts.media === 48,
);
const state = () => api("summary?path=" + encodeURIComponent(book.stableId));
const click = (name) =>
  tap(p.getByRole("button", { name, exact: true }).first());
async function shot(name) {
  await p.waitForLoadState("networkidle");
  await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(output, name + ".png") });
}
try {
  await p.goto(
    url +
      "/#/@all/pixiv?view=" +
      encodeURIComponent(book.stableId) +
      "&index=0",
  );
  await ready(p);
  await p.getByRole("button", { name: "阅读方式", exact: true }).waitFor();
  await click("收藏");
  await wait(async () => (await state()).personal.favorite, "favorite");
  const heart = p.getByRole("button", { name: "取消收藏", exact: true });
  const box = await heart.boundingBox();
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
    button: "right",
  });
  await p.getByRole("dialog", { name: "添加到收藏夹", exact: true }).waitFor();
  await replaceText(
    p.getByRole("textbox", { name: "新建收藏夹", exact: true }),
    "动作收藏夹",
  );
  await click("创建");
  await wait(
    () => p.getByRole("switch", { name: "动作收藏夹", exact: true }).count(),
    "created collection",
  );
  await tap(p.getByRole("switch", { name: "动作收藏夹", exact: true }));
  await wait(
    async () => (await state()).personal.collections.length === 1,
    "collection assigned",
  );
  await shot("collection-assignment-dark-desktop");
  await p.keyboard.press("Escape");
  await wait(
    async () =>
      (await p
        .getByRole("dialog", { name: "添加到收藏夹", exact: true })
        .count()) === 0,
    "collection panel closed",
  );
  await p.keyboard.press("f");
  await wait(
    async () => !(await state()).personal.favorite,
    "F removes favorite",
  );
  assert.equal((await state()).personal.collections.length, 0);
  await p.keyboard.press("f");
  await wait(
    async () => (await state()).personal.favorite,
    "F favorites again",
  );
  await click("5 星");
  await wait(async () => (await state()).personal.rating === 5, "rating");
  await click("5 星");
  await wait(async () => (await state()).personal.rating === 0, "rating clear");
  await click("添加我的标签");
  await replaceText(
    p.getByRole("textbox", { name: "我的标签", exact: true }),
    "暂存",
  );
  await p.keyboard.press("Enter");
  await wait(
    async () => (await state()).personal.tags.includes("暂存"),
    "tag added",
  );
  await click("暂存 ×");
  await wait(
    async () => !(await state()).personal.tags.includes("暂存"),
    "tag removed",
  );
  checks.push(
    "right click collection create assign and favorite removal clears membership; rating and personal tag remove",
  );
  // Series edge opens a chapter card before entering the next chapter.
  await p.goto(
    url +
      "/#/@all/pixiv?view=" +
      encodeURIComponent(book.stableId) +
      "&index=47",
  );
  await ready(p);
  await wait(
    () => p.getByRole("button", { name: "阅读方式", exact: true }).count(),
    "edge viewer",
  );
  await click("阅读方式");
  await click("单页");
  await wait(
    async () => (await state()).personal.readingMode === "single",
    "single saved",
  );
  await p.waitForTimeout(200);
  await p.keyboard.press("ArrowLeft");
  await wait(
    () => p.getByRole("button", { name: /^下一话：/ }).count(),
    "next episode card",
  );
  await shot("reader-next-chapter-dark-desktop");
  await tap(p.getByRole("button", { name: /^下一话：/ }).first());
  await wait(
    () => !p.url().includes("view=" + encodeURIComponent(book.stableId)),
    "next chapter opened",
  );
  checks.push("series last-page card and next chapter");
  await p.goto(url + "/#/@my/history");
  await ready(p);
  await click("清空历史");
  await click("清空");
  await wait(
    async () => (await api("session")).counts.history === 0,
    "clear history",
  );
  await shot("history-empty-dark-desktop");
  checks.push("clear history inline confirmation");
  await p.goto(url + "/#/@my/collections");
  await ready(p);
  await tap(p.getByRole("button", { name: "编辑 动作收藏夹", exact: true }));
  await replaceText(
    p.getByRole("textbox", { name: "收藏夹名称", exact: true }),
    "改名收藏夹",
  );
  await click("保存");
  await wait(
    async () =>
      (await api("collections")).items.some((x) => x.name === "改名收藏夹"),
    "collection renamed",
  );
  await tap(p.getByRole("button", { name: "编辑 改名收藏夹", exact: true }));
  await click("删除收藏夹");
  await click("删除");
  await wait(
    async () => (await api("collections")).items.length === 0,
    "collection deleted",
  );
  checks.push("rename and inline-delete collection");
  assert.deepEqual(errors, []);
  report("personal-actions-results.json", {
    conclusion: "consistent",
    checks,
    errors,
  });
} catch (e) {
  await p.screenshot({
    path: path.join(output, "personal-actions-failure.png"),
  });
  report("personal-actions-results.json", {
    conclusion: "different",
    checks,
    errors,
    error: e.stack,
    aria: await p.locator("body").ariaSnapshot(),
  });
  throw e;
} finally {
  await c.close();
  await b.close();
}
