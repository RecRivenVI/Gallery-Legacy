import assert from "node:assert/strict";
import path from "node:path";
import {
  output,
  nativePage as manager,
  invoke,
  admin,
  tap,
  wait,
  ready,
  replaceText,
  report,
  driver,
} from "./support.mjs";

assert(manager, "This scenario requires its own Tauri instance");
const checks = [],
  errors = [],
  shots = [];
manager.on("pageerror", (e) => errors.push(e.message));
const status = () => invoke("status");
async function shot(name) {
  await manager.waitForTimeout(250);
  await manager.screenshot({ path: path.join(output, name + ".png") });
  shots.push(name + ".png");
}
async function confirmScan() {
  const before = (await status()).scan.finishedAtMs || 0;
  await tap(manager.getByRole("button", { name: "开始扫描", exact: true }));
  await wait(
    async () => {
      const buttons = await manager.getByRole("button").allTextContents();
      if (
        buttons.includes("继续") &&
        (await manager.getByRole("dialog").count())
      ) {
        await tap(
          manager
            .getByRole("dialog")
            .getByRole("button", { name: "继续", exact: true }),
        );
      }
      const s = (await status()).scan;
      return !s.running && (s.finishedAtMs || 0) > before;
    },
    "confirmed scan",
    60000,
  );
  let s = (await status()).scan;
  if (s.failure?.code === "EVERYTHING_CONFIRMATION_REQUIRED") {
    await tap(
      manager.getByRole("button", { name: "遍历目录并继续", exact: true }),
    );
    await tap(manager.getByRole("button", { name: "开始扫描", exact: true }));
    await wait(
      async () => !(await status()).scan.running,
      "confirmed native fallback",
      60000,
    );
    s = (await status()).scan;
  }
  assert.equal(s.state, "READY", JSON.stringify(s.failure));
  return s;
}

try {
  await manager.evaluate(() => localStorage.setItem("gallery_theme", "dark"));
  await manager.reload();
  await ready(manager);
  await tap(manager.getByRole("button", { name: "更新图库", exact: true }));
  await tap(manager.getByRole("button", { name: "清空", exact: true }));
  await tap(manager.getByRole("button", { name: /^pixiv\s*\d/ }));
  await tap(
    manager.getByRole("button", { name: "全量扫描所选平台…", exact: true }),
  );
  const confirmation = await manager.getByRole("dialog").ariaSnapshot();
  assert(confirmation.includes("全量") && confirmation.includes("pixiv"));
  assert(!confirmation.includes("pixivFANBOX"));
  await shot("manager-scan-confirm-dark");
  let s = await confirmScan();
  assert.deepEqual(s.scope.effectivePlatformIds, ["pixiv"]);
  checks.push("selected full scan matches confirmation and backend scope");
  await manager.reload();
  await ready(manager);
  assert(
    (await manager
      .getByRole("button", { name: /^pixiv\s*\d/ })
      .getAttribute("aria-checked")) !== "false",
  );
  await tap(manager.getByRole("button", { name: /更新所选的 1 个平台/ }));
  s = await confirmScan();
  assert.equal(s.counts.worksCommitted, 0);
  assert(s.counts.worksReused > 0);
  checks.push(
    "incremental reuses committed inventory and selection survives reload",
  );

  await tap(manager.getByRole("button", { name: "作者扫描", exact: true }));
  assert.equal(
    await manager.getByRole("button", { name: "Venera", exact: true }).count(),
    0,
  );
  await replaceText(manager.getByRole("textbox").first(), "700");
  await tap(
    manager.getByRole("button", { name: "确认并开始扫描", exact: true }),
  );
  s = await confirmScan();
  assert.equal(s.scope.authorScoped, true);
  assert.equal(s.progress.platformProgress[0].totalAuthors, 1);
  assert.equal(s.counts.worksCommitted, 0);
  checks.push("author task is separate and excludes Venera");
  await replaceText(manager.getByRole("textbox").first(), "invalid/name");
  await tap(
    manager.getByRole("button", { name: "确认并开始扫描", exact: true }),
  );
  await tap(
    manager
      .getByRole("dialog")
      .getByRole("button", { name: "开始扫描", exact: true }),
  );
  await wait(
    async () =>
      (await manager.locator("body").ariaSnapshot()).includes(
        "作者目录名不正确",
      ),
    "native error visible and busy cleared",
  );
  await replaceText(manager.getByRole("textbox").first(), "700");
  checks.push("native string errors are visible and leave controls usable");

  await tap(manager.getByRole("button", { name: "封面生成", exact: true }));
  await replaceText(manager.getByRole("textbox").first(), "pixiv/700");
  await tap(
    manager.getByRole("button", { name: "生成新增或变化的封面", exact: true }),
  );
  let acceptedCoverFallback = false;
  await wait(
    async () => {
      const dialog = manager.getByRole("dialog");
      if (!acceptedCoverFallback && (await dialog.count())) {
        acceptedCoverFallback = true;
        await tap(dialog.getByRole("button", { name: "继续", exact: true }));
      }
      const current = await status();
      return current.thumbnails.total > 0 || current.thumbnails.failure;
    },
    "manual cover task",
    60000,
  );
  let covers = (await status()).thumbnails;
  if (covers.failure?.includes("EVERYTHING_CONFIRMATION_REQUIRED")) {
    await tap(
      manager.getByRole("button", { name: "遍历目录并继续", exact: true }),
    );
  }
  await wait(
    async () => {
      covers = (await status()).thumbnails;
      return !covers.running && !covers.planning;
    },
    "covers complete",
    60000,
  );
  assert.equal(covers.failed, 0, JSON.stringify(covers));
  assert(covers.completed > 0);
  assert.deepEqual(covers.platformIds, ["pixiv"]);
  checks.push(
    "manual independent cover task uses selected platform and author",
  );

  for (const theme of ["dark", "light"]) {
    await manager.evaluate(
      (theme) => localStorage.setItem("gallery_theme", theme),
      theme,
    );
    await manager.reload();
    await ready(manager);
    for (const [name, key] of [
      ["更新图库", "scan"],
      ["作者扫描", "author"],
      ["封面生成", "covers"],
      ["访问", "access"],
    ]) {
      await tap(manager.getByRole("button", { name, exact: true }));
      await manager.waitForTimeout(300);
      await shot(`manager-${key}-${theme}`);
    }
  }
  assert.deepEqual(errors, []);
  report("scan-tasks-results.json", {
    conclusion: "consistent",
    checks,
    shots,
    errors,
    scope: "SSD synthetic Tauri and local Go runtime; no real-library scan",
  });
} finally {
  await driver.close();
}
