import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { url, output, tap, ready, wait, report, driver } from "./support.mjs";

const browser = await chromium.launch({ headless: true });
const remote = [],
  errors = [],
  localFonts = new Set(),
  checks = [];
const sample =
  "离线繁體漢字 · العربية · हिन्दी · ગુજરાતી · ਪੰਜਾਬੀ · ភាសាខ្មែរ · ພາສາລາວ · မြန်မာ · ภาษาไทย · བོད་ཡིག · 🌈";
const data = async (endpoint) =>
  (await (await fetch(url + "/api/v1/" + endpoint)).json()).data;
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await context.route("**/*", (route) => {
    const target = new URL(route.request().url());
    if (
      ["blob:", "data:"].includes(target.protocol) ||
      target.hostname === "127.0.0.1"
    )
      return route.continue();
    remote.push(target.origin);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/misans/files/") && response.status() === 200)
      localFonts.add(response.url());
  });
  const authors = await data("authors?platform=pixiv&pageSize=24");
  const works = await data("works?platform=pixiv&pageSize=48&sort=name_asc");
  const work = works.items.find((row) => row.counts.media === 48);
  assert(work && authors.items.length);
  await page.goto(
    url + "/#/@author/pixiv/" + encodeURIComponent(authors.items[0].stableId),
  );
  await ready(page);
  await page
    .getByRole("button", { name: /Abstract Study/ })
    .first()
    .waitFor();
  checks.push(
    "legacy stable author alias opens the matching author collection",
  );
  const detail = (
    await data("resolve?path=" + encodeURIComponent(work.stableId))
  ).item;
  const selected = detail.media.filter(
    (row) => row.defaultVisible !== false,
  )[1];
  await page.goto(
    url +
      "/#" +
      work.stableId +
      "?media=" +
      encodeURIComponent(selected.relativePath),
  );
  await ready(page);
  await wait(
    () =>
      page
        .locator("[data-gallery-media] img")
        .evaluateAll(
          (images, source) =>
            images.some(
              (image) =>
                image.getAttribute("src") === source &&
                image.complete &&
                image.naturalWidth > 0,
            ),
          selected.url,
        ),
    "legacy selected media",
  );
  checks.push("legacy media query opens the selected original page");
  const third = detail.media.filter((row) => row.defaultVisible !== false)[2];
  await page.evaluate((relative) => {
    location.hash = location.hash.replace(
      /media=[^&]*/,
      "media=" + encodeURIComponent(relative),
    );
  }, third.relativePath);
  await wait(
    () =>
      page
        .locator("[data-gallery-media] img")
        .evaluateAll(
          (images, source) =>
            images.some(
              (image) => image.getAttribute("src") === source && image.complete,
            ),
          third.url,
        ),
    "existing viewer selected media",
  );
  checks.push("legacy media query also changes an already open viewer");
  await page.route("**/api/v1/resolve?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.data?.item?.stableId === work.stableId) {
      body.data.item.title = sample;
      body.data.item.description = {
        format: "html",
        text: "<p>离线简介<br>https://example.invalid/test</p>",
      };
    }
    return route.fulfill({ response, json: body });
  });
  await page.reload();
  await ready(page);
  await wait(() => localFonts.size === 9, "all nine local script fonts", 15000);
  await page.waitForLoadState("networkidle");
  await page.getByText(/离线简介/).waitFor();
  await page.screenshot({
    path: path.join(output, "web-offline-scripts-light-desktop.png"),
  });
  await tap(page.getByRole("button", { name: "关闭", exact: true }));
  await page.goto(url + "/#/@all/pixiv");
  await ready(page);
  await tap(page.getByRole("button", { name: "设置", exact: true }));
  await page.waitForLoadState("networkidle");
  await page.screenshot({
    path: path.join(output, "web-offline-settings-light-desktop.png"),
  });
  checks.push("offline Chinese, nine script families, Emoji and MiSans notice");
  assert.deepEqual(remote, []);
  assert.deepEqual(errors, []);
  report("compatibility-results.json", {
    conclusion: "consistent",
    checks,
    runtimeRemoteRequests: remote,
    pageErrors: errors,
    loadedLocalScriptFiles: [...localFonts].map((value) =>
      value.split("/").pop(),
    ),
  });
} catch (error) {
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      await page.screenshot({
        path: path.join(output, "compatibility-failure.png"),
      });
      fs.writeFileSync(
        path.join(output, "compatibility-failure.txt"),
        page.url() + "\n" + (await page.locator("body").ariaSnapshot()),
      );
    }
  report("compatibility-results.json", {
    conclusion: "different",
    checks,
    remote,
    errors,
    failure: String(error.stack),
  });
  throw error;
} finally {
  await browser.close();
  await driver?.close();
}
