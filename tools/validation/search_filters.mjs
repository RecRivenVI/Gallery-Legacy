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
async function click(p, name) {
  let e = p
    .getByRole("button", { name, exact: true })
    .or(p.getByRole("radio", { name, exact: true }));
  await wait(async () => {
    const b = await e.first().boundingBox();
    return b?.width > 0 && b.height > 0;
  }, "layout " + name);
  const box = await e.first().boundingBox();
  if (box.y + box.height > p.viewportSize().height) {
    await p.mouse.move(
      p.viewportSize().width - 80,
      p.viewportSize().height - 160,
    );
    await p.mouse.wheel(0, 900);
    await p.waitForTimeout(300);
  }
  await tap(e.first());
}
async function shot(p, name) {
  await p.waitForLoadState("networkidle");
  await p.waitForTimeout(750);
  await p.screenshot({ path: path.join(output, name + ".png") });
  screenshots.push(name + ".png");
}
try {
  for (const theme of ["dark", "light"])
    for (const [device, width, height] of [
      ["desktop", 1440, 900],
      ["mobile", 393, 852],
    ]) {
      const c = await browser.newContext({
        viewport: { width, height },
        hasTouch: device === "mobile",
        isMobile: device === "mobile",
      });
      await c.addInitScript(
        (theme) => localStorage.setItem("gallery_theme", theme),
        theme,
      );
      const p = await c.newPage();
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(url + "/#/@all/pixiv?sort=name_asc&pageSize=24");
      await ready(p);
      await wait(
        () => p.getByRole("button", { name: /Abstract Study/ }).count(),
        "cards",
      );
      if (
        device === "mobile" &&
        (await p.getByRole("button", { name: "搜索", exact: true }).count())
      )
        await click(p, "搜索");
      const field = p.getByRole("textbox", {
        name: "搜索标题、作者、标签",
        exact: true,
      });
      await replaceText(field, "title:Abstract -tag:漫画 platform:p,f");
      await p.keyboard.press("Enter");
      await wait(() => p.url().includes("platform%3Ap%2Cf"), "syntax route");
      const count = (
        await (
          await c.request.get(
            url +
              "/api/v1/works?" +
              new URLSearchParams({
                q: "title:Abstract -tag:漫画 platform:p,f",
              }),
          )
        ).json()
      ).data.total;
      assert(count > 0);
      await shot(p, `search-mixed-${theme}-${device}`);
      if (
        device === "mobile" &&
        (await p.getByRole("button", { name: "搜索", exact: true }).count())
      )
        await click(p, "搜索");
      await click(p, "高级搜索");
      assert(
        (
          await p
            .getByRole("textbox", { name: "标题", exact: true })
            .textContent()
        ).includes("Abstract"),
      );
      await replaceText(
        p.getByRole("textbox", { name: "作者名", exact: true }),
        "Synthetic",
      );
      await shot(p, `search-advanced-${theme}-${device}`);
      await click(p, "搜索");
      await wait(
        () => p.url().includes("author%3ASynthetic"),
        "advanced to syntax",
      );
      await click(p, "筛选");
      await shot(p, `search-filters-${theme}-${device}`);
      const tag = p
        .getByRole("dialog", { name: "筛选", exact: true })
        .getByRole("button", { name: /a,b/ })
        .first();
      await tap(tag);
      await wait(
        () => decodeURIComponent(p.url()).includes('["a,b"]'),
        "comma tag filter",
      );
      await tap(
        p
          .getByRole("dialog", { name: "筛选", exact: true })
          .getByRole("button", { name: /a,b/ })
          .first(),
      );
      await wait(() => p.url().includes("excludeTags"), "excluded tag");
      await p.keyboard.press("Escape");
      await wait(
        () => p.getByText("没有符合条件的作品", { exact: true }).count(),
        "empty filtered state",
      );
      await shot(p, `search-filtered-empty-${theme}-${device}`);
      await p.reload();
      await ready(p);
      assert(p.url().includes("excludeTags"));
      checks.push(`syntax advanced filter URL ${theme} ${device}`);
      await c.close();
    }
  assert.deepEqual(errors, []);
  report("search-filter-results.json", {
    conclusion: "consistent",
    checks,
    screenshots,
    errors,
  });
} catch (e) {
  for (const c of browser.contexts())
    for (const p of c.pages()) {
      await p
        .screenshot({ path: path.join(output, "search-filter-failure.png") })
        .catch(() => {});
      report("search-filter-results.json", {
        conclusion: "different",
        checks,
        screenshots,
        errors,
        failure: e.stack,
        aria: await p.locator("body").ariaSnapshot(),
      });
    }
  throw e;
} finally {
  await browser.close();
}
