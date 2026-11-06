import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright";
import { url, output, ready, tap, wait, report } from "./support.mjs";
const b = await chromium.launch({ headless: true });
const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
await c.addInitScript(() => localStorage.setItem("gallery_theme", "dark"));
const p = await c.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
const api = async (endpoint, input) => {
  const r =
    input === undefined
      ? await c.request.get(url + "/api/v1/" + endpoint)
      : await c.request.post(url + "/api/v1/" + endpoint, { data: input });
  const x = await r.json();
  assert(r.ok(), JSON.stringify(x));
  return x.data;
};
const a = (
  await api("accounts", {
    name: "访客登录回归",
    preferences: { theme: "dark" },
  })
).account;
const works = (await api("works?platform=pixiv&sort=name_asc")).items;
const book = works.find((w) => w.counts.media === 48),
  next = works[works.indexOf(book) + 1];
await api("personal", {
  accountId: a.id,
  work: next.stableId,
  action: "mode",
  text: "continuous",
  rtl: false,
  coverAlone: true,
});
await api("session", { action: "logout" });
try {
  await p.goto(
    url +
      "/#/@all/pixiv?sort=name_asc&view=" +
      encodeURIComponent(book.stableId) +
      "&index=0",
  );
  await ready(p);
  await p.getByRole("button", { name: "阅读方式", exact: true }).waitFor();
  await p.waitForTimeout(400);
  await tap(p.getByRole("button", { name: "收藏", exact: true }));
  await p.getByRole("dialog", { name: "账号", exact: true }).waitFor();
  await tap(p.getByRole("button", { name: a.name, exact: true }));
  await wait(
    async () => (await api("session")).account?.id === a.id,
    "login account",
  );
  await wait(
    async () =>
      (await api("summary?path=" + encodeURIComponent(book.stableId))).personal
        ?.favorite,
    "pending favorite",
  );
  await wait(
    async () => (await api("session")).counts.history > 0,
    "history starts after login",
  );
  await wait(
    async () =>
      (await p.getByRole("dialog", { name: "账号", exact: true }).count()) ===
      0,
    "account panel closes",
  );
  await p.waitForTimeout(250);
  await p.keyboard.press("Shift+ArrowLeft");
  await wait(
    () => p.url().includes("view=" + encodeURIComponent(next.stableId)),
    "next cached work",
  );
  await tap(p.getByRole("button", { name: "阅读方式", exact: true }));
  assert.equal(
    await p
      .getByRole("button", { name: "纵向连续", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await p.screenshot({
    path: path.join(output, "guest-login-restores-reading-dark-desktop.png"),
  });
  assert.deepEqual(errors, []);
  report("guest-login-results.json", {
    conclusion: "consistent",
    checks: [
      "guest favorite login",
      "history begins for selected account",
      "neighbor cache reloads account reading mode",
    ],
    errors,
  });
} catch (e) {
  await p.screenshot({ path: path.join(output, "guest-login-failure.png") });
  report("guest-login-results.json", {
    conclusion: "different",
    error: e.stack,
    errors,
    aria: await p.locator("body").ariaSnapshot(),
  });
  throw e;
} finally {
  await c.close();
  await b.close();
}
