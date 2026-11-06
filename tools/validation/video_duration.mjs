import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  config,
  url,
  output,
  nativePage as manager,
  driver,
  admin,
  tap,
  ready,
  wait,
  replaceText,
  report,
} from "./support.mjs";
const fixture = path.join(config.sources.pixiv, "700", "VideoDuration");
fs.mkdirSync(fixture, { recursive: true });
fs.copyFileSync(
  path.join(
    config.sources.pixiv,
    "700",
    "2026-01-02_00-00-00_0002",
    "video.mp4",
  ),
  path.join(fixture, "video.mp4"),
);
fs.writeFileSync(
  path.join(fixture, "metadata.json"),
  JSON.stringify({
    id: "900001",
    title: "Video Duration Fixture",
    user: { id: "700", name: "Synthetic Author" },
    media: [{ name: "wrong.mp4", duration: 999999, size: 999999 }],
  }),
);
const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  await admin("scan.start", {
    mode: "full",
    platformIds: ["pixiv"],
    allowNative: true,
    confirmReadOnly: true,
  });
  await wait(
    async () => !(await admin("scan.status")).running,
    "video fixture scan",
    60000,
  );
  const payload = await fetch(
    url + "/api/v1/works?platform=pixiv&q=Video%20Duration&pageSize=48",
  ).then((r) => r.json());
  const work = payload.data.items.find(
    (x) => x.title === "Video Duration Fixture",
  );
  assert(work?.cover?.type === "video", JSON.stringify(work));
  const response = await fetch(url + work.cover.thumbnailUrl);
  assert(response.ok);
  assert.equal(Number(response.headers.get("X-Gallery-Duration")), 3000);
  await response.arrayBuffer();
  const shots = [];
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.addInitScript(
      (t) => localStorage.setItem("gallery_theme", t),
      theme,
    );
    let release;
    const coverPending = new Promise((r) => (release = r));
    let intercepted = false;
    await page.route("**/api/v1/thumbnails/**", async (route) => {
      intercepted = true;
      await coverPending;
      await route.continue();
    });
    await page.goto(url + "/#/@all/pixiv?q=Video%20Duration&pageSize=48");
    await ready(page);
    await wait(() => intercepted, "video cover request");
    assert(
      !(await page.locator("body").ariaSnapshot()).includes("0:03"),
      "duration visible before cover",
    );
    assert(
      (await page.getByText("视频", { exact: true }).count()) >= 1,
      "video badge must be present while cover waits",
    );
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(output, `video-waiting-${theme}.png`),
    });
    release();
    await wait(
      async () => (await page.locator("body").ariaSnapshot()).includes("0:03"),
      "duration with cover",
    );
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(output, `video-duration-${theme}-settled.png`),
    });
    shots.push(`video-duration-${theme}-settled.png`);
    await page.close();
  }
  await tap(manager.getByRole("button", { name: "访问", exact: true }));
  const old = (await admin("access.read", { days: 1 })).autoBan;
  await tap(manager.getByRole("switch", { name: "自动封禁", exact: true }));
  await replaceText(manager.getByRole("textbox").nth(1), "777");
  await tap(manager.getByRole("button", { name: "应用", exact: true }));
  await wait(
    async () =>
      (await admin("access.read", { days: 1 })).autoBan.maxRequests === 777,
    "auto ban applied",
  );
  const state = await admin("access.read", { days: 1 });
  assert(state.autoBan.enabled);
  assert(state.clients.every((c) => !c.local || !c.blocked));
  await admin("access.autoban", old);
  report("video-access-results.json", {
    conclusion: "consistent",
    durationMs: 3000,
    durationHiddenUntilCover: true,
    metadataDurationIgnored: true,
    autoBanAppliedImmediately: true,
    localExempt: true,
    screenshots: shots,
  });
} finally {
  await browser.close();
  await driver.close();
}
