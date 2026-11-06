import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright";
import {
  url,
  output,
  ready,
  tapPanelControl,
  wait,
  report,
} from "./support.mjs";
import { recording } from "./recording.mjs";
const b = await chromium.launch({ headless: true });
const checks = [],
  screenshots = [],
  recordings = [],
  errors = [];
try {
  for (const theme of ["dark", "light"])
    for (const [device, width, height] of [
      ["desktop", 1440, 900],
      ["mobile", 393, 852],
    ]) {
      const c = await b.newContext({
        viewport: { width, height },
        hasTouch: device === "mobile",
        isMobile: device === "mobile",
      });
      await c.addInitScript((theme) => {
        localStorage.setItem("gallery_theme", theme);
        localStorage.setItem("gallery_viewer_details", "false");
      }, theme);
      const p = await c.newPage();
      p.on("pageerror", (e) => errors.push(e.message));
      const api = async (endpoint, input) => {
        const r =
          input === undefined
            ? await c.request.get(url + "/api/v1/" + endpoint)
            : await c.request.post(url + "/api/v1/" + endpoint, {
                data: input,
              });
        const x = await r.json();
        assert(r.ok(), JSON.stringify(x));
        return x.data;
      };
      const a = (
        await api("accounts", {
          name: `${theme} ${device}`,
          preferences: { theme, expanded: true },
        })
      ).account;
      const works = (await api("works?platform=pixiv&sort=name_asc")).items;
      const book = works.find((w) => w.counts.media === 48),
        other = works.find((w) => w.counts.media === 1);
      const change = async (work, action, extra = {}) =>
        api("personal", {
          accountId: a.id,
          work: work.stableId,
          action,
          ...extra,
        });
      await change(book, "favorite", { value: true });
      await change(book, "rating", { number: 4 });
      await change(book, "tag.add", { text: "待读" });
      await change(book, "read", { number: 3 });
      await change(book, "mode", {
        text: "single",
        rtl: true,
        coverAlone: true,
      });
      await change(other, "read", { number: 1 });
      const collection = (
        await api("collections", { accountId: a.id, name: "我的画册" })
      ).items[0];
      await change(book, "collections", { values: [collection.id] });
      async function click(name) {
        await tapPanelControl(
          p
            .getByRole("button", { name, exact: true })
            .or(p.getByRole("radio", { name, exact: true }))
            .first(),
        );
      }
      async function go(hash) {
        await p.goto(url + "/#" + hash);
        await ready(p);
        await p.waitForTimeout(500);
      }
      async function shot(name) {
        await p.mouse.move(20, height - 20);
        await p.waitForLoadState("networkidle");
        await p.waitForTimeout(600);
        const f = `${name}-${theme}-${device}.png`;
        await p.screenshot({ path: path.join(output, f) });
        screenshots.push(f);
      }
      for (const [kind, name] of [
        ["favorites", "favorites"],
        ["collections", "collections"],
        ["history", "history"],
        ["continue", "continue"],
      ]) {
        await go(
          "/@my/" +
            kind +
            "?sort=" +
            (kind === "favorites" ? "favorite_desc" : "date_desc"),
        );
        await shot(name);
      }
      await go("/@collection/" + collection.id);
      await shot("collection");
      if (device === "mobile") await click("展开侧边栏");
      await click(a.name);
      await shot("account");
      await click("账号设置");
      await shot("account-settings");
      await click("更换头像");
      await wait(
        () => p.getByRole("button", { name: /Abstract Study/ }).count(),
        "avatar work picker",
      );
      await shot("avatar-picker");
      await p.keyboard.press("Escape");
      await wait(
        async () =>
          (await p
            .getByRole("dialog", { name: "账号", exact: true })
            .count()) === 0,
        "avatar panel closes",
      );
      await go(
        "/@all/pixiv?view=" + encodeURIComponent(book.stableId) + "&index=2",
      );
      await wait(
        () => p.getByRole("button", { name: "阅读方式", exact: true }).count(),
        "reader",
      );
      if (
        (await p
          .getByRole("button", { name: "详情栏", exact: true })
          .getAttribute("aria-pressed")) !== "true"
      )
        await click("详情栏");
      await p.getByRole("button", { name: "4 星", exact: true }).waitFor();
      await shot("personal-detail");
      await click("阅读方式");
      await shot("reading-menu");
      await click("双页");
      await shot("reader-double");
      await click("阅读方式");
      await click("纵向连续");
      await shot("reader-continuous");
      if (theme === "dark" && device === "desktop")
        recordings.push(
          await recording(p, output, "reader-mode-switch-dark", async () => {
            await click("阅读方式");
            await click("单页");
            await p.waitForTimeout(300);
            await click("阅读方式");
            await click("双页");
            await p.waitForTimeout(300);
            await click("阅读方式");
            await click("纵向连续");
            await p.mouse.move(700, 400);
            await p.mouse.wheel(0, 900);
            await p.waitForTimeout(500);
          }),
        );
      if (device === "mobile") {
        await click("阅读方式");
        await click("单页");
        if (await p.getByRole("button", { name: "收起", exact: true }).count())
          await click("收起");
        // New viewer at page zero, using a genuine emulated touch path rather than keys.
        await go(
          "/@all/pixiv?view=" + encodeURIComponent(book.stableId) + "&index=0",
        );
        await wait(
          () =>
            p.getByRole("button", { name: "阅读方式", exact: true }).count(),
          "mobile reader",
        );
        await p.waitForTimeout(500);
        const s = await c.newCDPSession(p);
        await s.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: 85, y: 350, id: 1 }],
        });
        for (let i = 1; i <= 7; i++) {
          await s.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: 85 + i * 26, y: 350, id: 1 }],
          });
          await p.waitForTimeout(20);
        }
        await s.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await wait(
          () => p.url().includes("index=1"),
          "RTL touch right swipe advances",
        );
        await s.detach();
        await shot("reader-rtl-touch");
      }
      const author = (await api("authors?platform=pixivFANBOX")).items[0];
      await go(author.stableId);
      await shot("author");
      checks.push(
        `${theme} ${device} personal pages avatar picker three reading modes and author header`,
      );
      await c.close();
    }
  assert.deepEqual(errors, []);
  report("personal-scenes-results.json", {
    conclusion: "consistent",
    checks,
    screenshots,
    recordings,
    errors,
  });
} catch (e) {
  for (const c of b.contexts())
    for (const p of c.pages()) {
      await p
        .screenshot({ path: path.join(output, "personal-scenes-failure.png") })
        .catch(() => {});
      report("personal-scenes-results.json", {
        conclusion: "different",
        checks,
        screenshots,
        recordings,
        errors,
        error: e.stack,
        aria: await p.locator("body").ariaSnapshot(),
      });
    }
  throw e;
} finally {
  await b.close();
}
