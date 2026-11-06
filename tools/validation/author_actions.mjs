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
await c.addInitScript(() => localStorage.setItem("gallery_theme", "dark"));
const p = await c.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
const api = async (endpoint) =>
  (await (await c.request.get(url + "/api/v1/" + endpoint)).json()).data;
const author = (await api("authors?platform=pixivFANBOX")).items[0];
try {
  await p.goto(url + "/#" + author.stableId);
  await ready(p);
  assert.equal(
    await p.getByRole("button", { name: "确认", exact: true }).count(),
    0,
  );
  await p.waitForTimeout(250);
  await tap(p.getByRole("button", { name: "＋ 关联其他作者", exact: true }));
  await replaceText(
    p.getByRole("textbox", { name: "搜索名称、账号", exact: true }),
    "Synthetic X",
  );
  await wait(
    () => p.getByRole("button", { name: /^X ·/ }).count(),
    "manual candidate",
  );
  await tap(p.getByRole("button", { name: /^X ·/ }).first());
  await wait(
    async () =>
      (await api("author-pages/" + author.id)).linked.some(
        (a) => a.platformId === "X",
      ),
    "manual author linked",
  );
  await p.waitForLoadState("networkidle");
  await p.waitForTimeout(600);
  await p.screenshot({
    path: path.join(output, "author-manual-link-dark-desktop.png"),
  });
  await tap(
    p.getByRole("button", { name: "取消关联 Synthetic X", exact: true }),
  );
  await wait(
    async () =>
      !(await api("author-pages/" + author.id)).linked.some(
        (a) => a.platformId === "X",
      ),
    "unlink author",
  );
  assert.deepEqual(errors, []);
  report("author-actions-results.json", {
    conclusion: "consistent",
    checks: [
      "no automatic association candidates",
      "manual search and link",
      "manual unlink",
    ],
    errors,
  });
} catch (e) {
  await p.screenshot({ path: path.join(output, "author-actions-failure.png") });
  report("author-actions-results.json", {
    conclusion: "different",
    error: e.stack,
    aria: await p.locator("body").ariaSnapshot(),
    errors,
  });
  throw e;
} finally {
  await c.close();
  await b.close();
}
