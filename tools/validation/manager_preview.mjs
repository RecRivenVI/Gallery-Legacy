import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  url,
  output,
  config,
  tap,
  ready,
  wait,
  report,
  replaceText,
} from "./support.mjs";

// Browser component verification of the manager's wire consumers. This does not
// launch Tauri or claim native lifecycle/control integration verification.
const assets = path.resolve(process.env.GALLERY_TEST_ASSETS || "");
assert(process.env.GALLERY_TEST_ASSETS);
const browser = await chromium.launch({ headless: true });
const errors = [],
  operations = [],
  shots = [];
try {
  for (const theme of ["dark", "light"]) {
    let current = structuredClone(config),
      revision = 1;
    let accounts = [
      { id: "one", name: "合成读者", avatar: "", hasPassword: true },
      { id: "two", name: "合成备用", avatar: "", hasPassword: false },
    ];
    const progress = {
      total: 288,
      completed: 120,
      failed: 0,
      paused: false,
      running: true,
    };
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await context.route("http://gallery-font.localhost/**", async (route) => {
      const target = new URL(route.request().url());
      const response = await fetch(
        url + "/frontend/assets/canvas" + target.pathname,
      );
      await route.fulfill({
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.exposeFunction("managerPreviewCall", async (method, input) => {
      if (method === "resource" || method === "resourceText") {
        const file = path.resolve(assets, input.path);
        assert(file.startsWith(assets + path.sep));
        const bytes = fs.readFileSync(file);
        return method === "resource"
          ? bytes.toString("base64")
          : bytes.toString("utf8");
      }
      if (method === "status")
        return {
          state: "READY_LIVE",
          counts: { works: 288, media: 731, authors: 9 },
          platforms: Object.keys(config.sources).map((id) => ({
            id,
            works: 32,
          })),
          scan: {
            running: false,
            state: "COMPLETE",
            finishedAtMs: Date.now() - 60000,
            elapsedMs: 2300,
            changes: { worksAdded: 288 },
          },
          thumbnails: progress,
        };
      if (method === "restart") return { state: "READY_LIVE" };
      assert.equal(method, "admin");
      const op = input.operation,
        value = input.input;
      operations.push(op);
      switch (op) {
        case "accounts.list":
          return { items: accounts };
        case "accounts.reset":
          accounts = accounts.map((a) =>
            a.id === value.id ? { ...a, hasPassword: !!value.password } : a,
          );
          return { items: accounts };
        case "accounts.delete":
          accounts = accounts.filter((a) => a.id !== value.id);
          return { items: accounts };
        case "config.read":
          return { revision: String(revision), value: current };
        case "config.validate":
          return { valid: true };
        case "config.save":
          current = value.value;
          revision++;
          return { saved: true };
        case "thumbnails.pause":
          progress.paused = value.paused;
          progress.running = !value.paused;
          return progress;
        case "validation.status":
          return { running: false };
        case "storage.read":
          return { cache: { bytes: 12345678 } };
        case "logs.list":
          return { items: [] };
        case "diagnostics.run":
          return {
            checks: ["libvips", "ffmpeg"]
              .map((tool) => ({ tool, available: true }))
              .concat(
                Object.keys(config.sources).map((platform) => ({
                  platform,
                  available: true,
                })),
              ),
          };
        case "access.read":
          return { enabled: true, clients: [] };
        default:
          throw Error("Unexpected preview operation: " + op);
      }
    });
    await page.addInitScript((theme) => {
      localStorage.setItem("gallery_theme", theme);
      globalThis.__TAURI_INTERNALS__ = {
        invoke: (_, args) =>
          globalThis.managerPreviewCall(args.method, args.input),
      };
    }, theme);
    await page.goto(url + "/#update");
    await ready(page);
    await page.getByText("封面预生成", { exact: true }).waitFor();
    await tap(page.getByRole("button", { name: "暂停", exact: true }));
    await wait(() => progress.paused, "pause wire operation");
    await page.getByRole("button", { name: "继续", exact: true }).waitFor();
    await tap(page.getByRole("button", { name: "继续", exact: true }));
    await wait(() => !progress.paused, "resume wire operation");
    for (const [label, id] of [
      ["更新图库", "update"],
      ["访问", "access"],
      ["设置", "settings"],
      ["排查", "diagnose"],
    ]) {
      await tap(page.getByRole("button", { name: label, exact: true }));
      await page.waitForLoadState("networkidle");
      if (id === "settings") {
        await page
          .getByRole("textbox", { name: "FFmpeg 路径", exact: true })
          .waitFor();
        await page.mouse.move(1100, 700);
        await page.mouse.wheel(0, 700);
        await wait(
          async () =>
            (await page
              .getByRole("textbox", { name: "缓存上限", exact: true })
              .textContent()) === "20",
          "rendered cache capacity",
        );
      }
      if (id === "settings") {
        for (let i = 0; i < 8; i++) {
          const box = await page
            .getByRole("button", { name: "重设密码", exact: true })
            .first()
            .boundingBox()
            .catch(() => null);
          if (box && box.y > 0 && box.y + box.height < 900) break;
          await page.mouse.move(1100, 700);
          await page.mouse.wheel(0, 700);
          await page.waitForTimeout(120);
        }
        await tap(
          page.getByRole("button", { name: "重设密码", exact: true }).first(),
        );
        await tap(page.getByRole("button", { name: "移除密码", exact: true }));
        await wait(
          () => accounts.find((a) => a.id === "one").hasPassword === false,
          "manager reset account password",
        );
        await page.screenshot({
          path: path.join(output, `manager-accounts-${theme}-desktop.png`),
        });
        shots.push(`manager-accounts-${theme}-desktop.png`);
        await tap(
          page.getByRole("button", { name: "删除", exact: true }).last(),
        );
        await page.mouse.move(1100, 700);
        await page.mouse.wheel(0, 500);
        await page.waitForTimeout(250);
        await tap(
          page.getByRole("button", { name: "删除", exact: true }).last(),
        );
        await wait(() => accounts.length === 1, "manager delete account");
      }
      if (id === "diagnose")
        await wait(
          async () =>
            await page
              .getByRole("button", { name: "重新检查", exact: true })
              .isEnabled(),
          "diagnostics resolved",
        );
      await page.waitForTimeout(500);
      const name = `manager-${id}-${theme}-desktop.png`;
      await page.screenshot({ path: path.join(output, name) });
      shots.push(name);
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  report("manager-preview-results.json", {
    conclusion: "consistent",
    scope:
      "headless browser component test with an explicit in-memory manager protocol; not a Tauri/native integration result",
    checks: [
      "typed four-page data",
      "thumbnail progress pause/resume",
      "FFmpeg/cache-limit settings",
      "account reset/delete in the component protocol",
    ],
    operations: [...new Set(operations)],
    screenshots: shots,
    pageErrors: errors,
  });
} catch (error) {
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      await page.screenshot({
        path: path.join(output, "manager-preview-failure.png"),
      });
      fs.writeFileSync(
        path.join(output, "manager-preview-failure.json"),
        JSON.stringify(
          {
            error: String(error),
            tree: await page.locator("body").ariaSnapshot(),
            boxes: await page.getByRole("textbox").evaluateAll((nodes) =>
              nodes.map((e) => ({
                name: e.getAttribute("aria-label"),
                rect: e.getBoundingClientRect().toJSON(),
                text: e.textContent,
                attrs: [...e.attributes].map((x) => [x.name, x.value]),
              })),
            ),
          },
          null,
          2,
        ),
      );
    }
  throw error;
} finally {
  await browser.close();
}
