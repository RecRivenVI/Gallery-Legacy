import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";

export const configFile = path.resolve(process.env.GALLERY_TEST_CONFIG || "");
assert(
  process.env.GALLERY_TEST_CONFIG,
  "Set GALLERY_TEST_CONFIG to a generated synthetic config",
);
export const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
export const root = path.dirname(path.dirname(configFile));
const marker = JSON.parse(
  fs.readFileSync(path.join(root, ".gallery-synthetic.json"), "utf8"),
);
assert.equal(marker.kind, "gallery-synthetic");
for (const file of [
  config.instanceRoot,
  ...Object.values(config.sources),
  ...config.fileBrowserRoots.map((r) => r.path),
]) {
  const relative = path.relative(root, fs.realpathSync(file));
  assert(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Synthetic paths must stay within their root",
  );
}
assert.notEqual(config.port, 8081);
assert.equal(config.listenAddress, "127.0.0.1");
export const url = `http://127.0.0.1:${config.port}`;
export const output = path.resolve(process.env.GALLERY_REVIEW_OUTPUT || "");
const repository = path.resolve(import.meta.dirname, "../..");
const relativeOutput = path.relative(repository, output);
assert(
  process.env.GALLERY_REVIEW_OUTPUT &&
    relativeOutput.startsWith("..") &&
    !path.isAbsolute(relativeOutput),
  "Review output must be outside the repository",
);
fs.mkdirSync(output, { recursive: true });
export const driver = process.env.GALLERY_TEST_CDP
  ? await chromium.connectOverCDP(process.env.GALLERY_TEST_CDP)
  : null;
export const nativePage = driver?.contexts()[0].pages()[0];
if (nativePage) {
  await nativePage.waitForURL(/^https?:\/\/tauri\.localhost\//, {
    timeout: 12000,
  });
  assert(
    /^https?:\/\/tauri\.localhost\//.test(nativePage.url()),
    "The driver must be the Tauri manager",
  );
}
export async function invoke(method, input = {}) {
  assert(nativePage, "Native validation requires a Tauri CDP connection");
  return nativePage.evaluate(
    ({ method, input }) =>
      window.__TAURI_INTERNALS__.invoke("host_call", { method, input }),
    { method, input },
  );
}
export async function admin(operation, input = {}) {
  return invoke("admin", { operation, input });
}
if (nativePage) {
  const actual = await admin("config.read");
  assert.equal(
    path.resolve(actual.value.instanceRoot),
    path.resolve(config.instanceRoot),
  );
  const state = await invoke("status");
  const response = await fetch(url + "/api/v1/status").then((r) => r.json());
  assert.equal(response.data.instanceId, state.instanceId);
}

export async function tap(locator, y = null) {
  await wait(() => locator.first().isEnabled(), "control enabled");
  let box;
  await wait(async () => {
    if (!(await locator.first().count())) return false;
    box = await locator.first().boundingBox();
    return box && box.width > 0 && box.height > 0;
  }, "control laid out");
  assert(
    box && box.width > 0 && box.height > 0,
    "The control must be laid out",
  );
  await locator
    .page()
    .mouse.click(box.x + box.width / 2, box.y + (y ?? box.height / 2));
  await locator
    .page()
    .evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
}
export async function wait(check, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error("Timed out: " + label);
}
export async function tapPanelControl(locator) {
  const page = locator.page();
  await wait(() => locator.count(), "panel control exists");
  for (let attempt = 0; attempt < 20; attempt++) {
    const box = await locator.first().boundingBox();
    const viewport = page.viewportSize();
    if (
      box?.width > 0 &&
      box.height > 0 &&
      box.y >= 0 &&
      box.y + box.height <= viewport.height
    ) {
      await tap(locator.first());
      return;
    }
    await page.mouse.move(viewport.width - 80, viewport.height - 180);
    await page.mouse.wheel(0, 360);
    await page.waitForTimeout(100);
  }
  throw Error("Panel control did not scroll into view");
}
export async function ready(page) {
  await wait(
    async () => (await page.getByRole("button").count()) > 5,
    "Compose controls",
  );
}
export async function replaceText(locator, value) {
  await tap(locator);
  const page = locator.page();
  await page.keyboard.press("Control+A");
  await wait(
    () =>
      page.evaluate(() => {
        let e = document.activeElement;
        while (e?.shadowRoot?.activeElement) e = e.shadowRoot.activeElement;
        return e?.selectionStart === 0 && e.selectionEnd === e.value?.length;
      }),
    "text selection",
  );
  await page.keyboard.insertText(value);
}
export function report(name, value) {
  fs.writeFileSync(
    path.join(output, name),
    JSON.stringify(value, null, 2) + "\n",
  );
}
