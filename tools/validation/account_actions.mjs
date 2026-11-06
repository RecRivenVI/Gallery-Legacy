import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright";
import {
  url,
  output,
  ready,
  tap,
  tapPanelControl,
  wait,
  replaceText,
  report,
} from "./support.mjs";
const b = await chromium.launch({ headless: true }),
  c = await b.newContext({ viewport: { width: 1440, height: 900 } }),
  p = await c.newPage();
await c.addInitScript(() => localStorage.setItem("gallery_theme", "dark"));
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
const api = async (endpoint) => {
  const r = await c.request.get(url + "/api/v1/" + endpoint);
  assert(r.ok());
  return (await r.json()).data;
};
async function click(name) {
  await tapPanelControl(p.getByRole("button", { name, exact: true }));
}
try {
  await p.goto(url + "/#/@all/pixiv");
  await ready(p);
  await click("登录");
  await click("新建账号");
  const name = "账号操作 " + Date.now();
  await replaceText(
    p.getByRole("textbox", { name: "名称", exact: true }),
    name,
  );
  await replaceText(
    p.getByRole("textbox", { name: "密码（可选）", exact: true }),
    "first-password",
  );
  await click("创建");
  await wait(
    async () => (await api("session")).account?.name === name,
    "created account",
  );
  await wait(
    async () =>
      (await p.getByRole("dialog", { name: "账号", exact: true }).count()) ===
      0,
    "creation closes panel",
  );
  await click(name);
  await click("账号设置");
  await click("更换头像");
  const cover = p.getByRole("button", { name: /Abstract Study/ }).first();
  await wait(() => cover.count(), "avatar images");
  await tap(cover);
  await p.getByRole("textbox", { name: "名称", exact: true }).waitFor();
  await replaceText(
    p.getByRole("textbox", { name: "名称", exact: true }),
    name + " 改名",
  );
  await replaceText(
    p.getByRole("textbox", { name: "新密码", exact: true }),
    "changed-password",
  );
  await click("保存");
  await wait(async () => {
    const a = (await api("session")).account;
    return a?.name === name + " 改名" && a.avatar.length > 0 && a.hasPassword;
  }, "profile saved");
  await wait(
    async () =>
      (await p.getByRole("dialog", { name: "账号", exact: true }).count()) ===
      0,
    "profile closes",
  );
  await click(name + " 改名");
  await click("账号设置");
  await click("移除密码");
  await wait(
    async () => !(await api("session")).account.hasPassword,
    "password removed",
  );
  await wait(
    async () =>
      (await p.getByRole("dialog", { name: "账号", exact: true }).count()) ===
      0,
    "password update closes",
  );
  await click(name + " 改名");
  await click("账号设置");
  await click("删除账号");
  await p.mouse.move(800, 850);
  await p.screenshot({
    path: path.join(output, "account-delete-confirm-dark-desktop.png"),
  });
  assert((await api("session")).account);
  await click("删除");
  await wait(
    async () => (await api("session")).account === null,
    "deleted and logged out",
  );
  assert(!(await api("accounts")).items.some((a) => a.name.startsWith(name)));
  assert.deepEqual(errors, []);
  report("account-actions-results.json", {
    conclusion: "consistent",
    checks: [
      "UI account creation with password",
      "avatar selection rename and password update",
      "remove password",
      "inline delete confirmation and personal cascade",
    ],
    errors,
  });
} catch (e) {
  await p.screenshot({
    path: path.join(output, "account-actions-failure.png"),
  });
  report("account-actions-results.json", {
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
