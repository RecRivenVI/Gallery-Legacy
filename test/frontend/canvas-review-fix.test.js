"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
test("viewer titles wrap at word boundaries and preserve explicit line breaks", async () => {
  const { wrapWords } = await import("../../public/gallery/content-layout.js");
  assert.deepEqual(
    wrapWords("Abstract Study", 11, (s) => s.length),
    ["Abstract", "Study"],
  );
  assert.deepEqual(
    wrapWords("Link https://example.invalid/a", 10, (s) => s.length),
    ["Link", "https://example.invalid/a"],
  );
  assert.deepEqual(
    wrapWords("超长标题中文\nA verylongword", 4, (s) => s.length),
    ["超长标题", "中文", "A", "verylongword"],
  );
});
test("author collage reserves two thirds for the first work, without overlap", async () => {
  const { authorCollage } = await import(
      "../../public/gallery/content-layout.js"
    ),
    area = { x: 10, y: 20, w: 302, h: 302 };
  assert.deepEqual(authorCollage(area, 0), []);
  assert.deepEqual(authorCollage(area, 1), [area]);
  const [a, b, c] = authorCollage(area, 3);
  assert.equal(a.w, 200);
  assert.equal(b.x - a.x - a.w, 2);
  assert.equal(c.y - b.y - b.h, 2);
  assert.equal(c.y + c.h, 322);
  assert.equal(b.x + b.w, 312);
  const [d, e] = authorCollage(area, 2);
  assert.equal(d.w, 150);
  assert.equal(e.x - d.x - d.w, 2);
});
test("light status colors match v1.6 and remain theme-local", async () => {
  const { themes } = await import("../../public/gallery/tokens.js");
  assert.deepEqual(
    [themes.light.ok, themes.light.warn, themes.light.err, themes.light.info],
    ["#1B7A43", "#8F6200", "#C4362C", "#1F66C2"],
  );
  assert.notEqual(themes.dark.ok, themes.light.ok);
});
test("directory errors use the approved actionable copy", async () => {
  const { humanError } = await import("../../public/manager/model.js");
  assert.equal(
    humanError({ code: "INSTANCE_SOURCE_OVERLAP" }),
    "这个目录和程序数据目录重叠了，请换一个目录",
  );
  assert.equal(
    humanError({ code: "SOURCE_ROOT_OVERLAP" }, "pixiv"),
    "这个目录和 pixiv 的目录重叠了，请换一个目录",
  );
});
test("original loading bar starts after one second, stays two pixels high and does not fake percent complete", async () => {
  const { originalProgress } = await import(
      "../../public/gallery/content-layout.js"
    ),
    area = { x: 10, y: 50, w: 1000, h: 700 };
  assert.equal(originalProgress(area, 999), null);
  assert.deepEqual(originalProgress(area, 1600), {
    x: 360,
    y: 748,
    w: 300,
    h: 2,
  });
  assert.ok(originalProgress(area, 2199).x <= 1010);
  assert.equal(originalProgress(area, 2200).w, 0);
});
