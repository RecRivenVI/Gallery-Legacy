import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright";
import {
  driver,
  invoke,
  nativePage,
  output,
  ready,
  report,
  tap,
  url,
  wait,
} from "./support.mjs";

assert(nativePage, "A synthetic native instance is required");
const status = async () => (await invoke("status")).metadataRefresh;
const browser = await chromium.launch({ headless: true });
const shots = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.goto(
    url +
      "/#/@all/" +
      encodeURIComponent("微博") +
      "?sort=name_asc&pageSize=24",
  );
  await ready(page);
  await page
    .getByRole("button", { name: /Abstract Study/ })
    .first()
    .waitFor();
  assert.equal((await status()).state, "PAUSED");

  await ready(nativePage);
  await tap(nativePage.getByRole("button", { name: "更新图库", exact: true }));
  const stop = nativePage.getByRole("button", {
    name: "停止升级",
    exact: true,
  });
  await stop.waitFor();
  await nativePage.screenshot({
    path: path.join(output, "metadata-paused.png"),
  });
  shots.push("metadata-paused.png");
  await tap(stop);
  await wait(
    async () => (await status()).state === "CANCELLED",
    "metadata cancelled",
  );
  await tap(nativePage.getByRole("button", { name: "继续升级", exact: true }));
  await wait(
    async () => (await status()).state === "COMPLETE",
    "metadata complete",
    30000,
  );

  const result = await status();
  assert.equal(result.titleTotal, 1);
  assert.equal(result.titleRead, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  await nativePage
    .getByText("已完成 · 已更新 1 / 1", { exact: true })
    .waitFor();
  await nativePage.screenshot({
    path: path.join(output, "metadata-complete.png"),
  });
  shots.push("metadata-complete.png");

  await invoke("restart");
  await wait(
    async () => (await status()).state === "COMPLETE",
    "metadata resumed after restart",
    30000,
  );
  assert.deepEqual(await status(), result);
  report("metadata-refresh-results.json", {
    conclusion: "consistent",
    scope: "isolated SSD synthetic fixture indexed by 13.1.0",
    galleryAvailableBeforeResume: true,
    stoppedAndResumed: true,
    noDuplicateRefreshAfterRestart: true,
    result,
    screenshots: shots,
  });
} finally {
  await browser.close();
  await driver.close();
}
