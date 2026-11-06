import assert from "node:assert/strict";
import { chromium } from "playwright";
import { url, output, tap, ready, wait, report } from "./support.mjs";
import { recording } from "./recording.mjs";

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() =>
    localStorage.setItem("gallery_theme", "dark"),
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url + "/#/@all/pixiv?sort=name_asc&pageSize=24");
  await ready(page);
  const card = page.getByRole("button", { name: /Abstract Study/ }).first();
  await card.waitFor();
  await page.waitForLoadState("networkidle");
  const file = await recording(
    page,
    output,
    "viewer-visible-interrupt-dark",
    async () => {
      await tap(card, 50);
      await page.getByRole("dialog", { name: "看大图", exact: true }).waitFor();
      await page.waitForTimeout(100);
      await page.keyboard.press("Escape");
      await wait(
        async () => (await page.getByRole("dialog").count()) === 0,
        "viewer closes from its visible opening",
      );
      await page.waitForTimeout(500);
    },
  );
  assert.deepEqual(errors, []);
  report("viewer-interrupt-results.json", {
    conclusion: "consistent",
    recording: file,
    visibleViewerBeforeCancel: true,
    pageErrors: errors,
  });
} finally {
  await browser.close();
}
