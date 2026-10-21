"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const load = () => import("../../public/gallery/interaction.js");
test("common card ratios preserve explicit choices, and touch sizes differ", async () => {
  const { aspectRatios, cardColumns } = await load();
  assert.deepEqual(
    Object.values(aspectRatios).map(([label]) => label),
    ["1:1", "4:3", "3:4", "16:9", "9:16"],
  );
  assert.equal(cardColumns(370, 1, true, true), 3);
  assert.equal(cardColumns(370, 3, true, true), 2);
  assert.equal(cardColumns(304, 3, true, true), 2);
  assert.equal(cardColumns(752, 3, true, true), 4);
  assert.ok(cardColumns(1600, 1, true, true) <= 4);
  assert.equal(cardColumns(1000, 0), 1);
});
test("loading and real cards share size, ratio and row spacing", async () => {
  const { cardGeometry } = await load();
  assert.deepEqual(cardGeometry(377, 3, true, true), {
    columns: 2,
    w: 184.5,
    h: 184.5,
    pitchX: 192.5,
    pitchY: 242.5,
  });
  const tall = cardGeometry(377, 3, true, true, 3 / 4);
  assert.equal(tall.h, 246);
  assert.equal(tall.pitchY, 304);
  assert.equal(cardGeometry(377, 0, true, true).h, 64);
});
test("zoom retains the image point under the pointer and limits pan", async () => {
  const { anchoredPan, boundedPan } = await load(),
    area = { x: 0, y: 0, w: 800, h: 400 };
  assert.deepEqual(
    anchoredPan(area, 1, 2, { x: 0, y: 0 }, { x: 600, y: 200 }),
    { x: -200, y: 0 },
  );
  assert.deepEqual(boundedPan(800, 400, area, 1, { x: 200, y: -500 }), {
    x: 0,
    y: 0,
  });
  assert.deepEqual(boundedPan(800, 400, area, 2, { x: 900, y: -500 }), {
    x: 400,
    y: -200,
  });
});
test("viewport anchors belong to current navigation, not browsing memory", async () => {
  const { viewportAnchor, restoredScroll } = await load();
  const tiles = new Map([
    [
      "a",
      { work: { key: "a" }, box: { y: { target: 104 }, h: { target: 220 } } },
    ],
    [
      "b",
      { work: { key: "b" }, box: { y: { target: 384 }, h: { target: 220 } } },
    ],
  ]);
  const anchor = viewportAnchor(tiles, 300);
  assert.deepEqual(anchor, { key: "b", offset: 84 });
  tiles.get("b").box.y.target = 600;
  assert.equal(restoredScroll(anchor, tiles), 516);
  assert.equal(restoredScroll({ key: "gone" }, tiles, 123), 123);
});
test("subtitle candidates preserve stable URL parameters and never invent media", async () => {
  const { subtitleCandidates } = await load();
  assert.equal(
    subtitleCandidates({ type: "image", url: "/api/v1/media/1" }).length,
    0,
  );
  const subtitles = subtitleCandidates({
    type: "video",
    url: "/api/v1/media/1?g=x&k=y&p=z",
  });
  assert.equal(subtitles[0].url, "/api/v1/subtitles/1?g=x&k=y&p=z&lang=zh-CN");
  assert.equal(
    subtitleCandidates({
      type: "video",
      url: "/api/v1/file-media?root=demo&path=movie.mp4",
    })[1].url,
    "/api/v1/file-subtitles?root=demo&path=movie.mp4&lang=en-US",
  );
});
test("MiSans original resources select scripts and preserve original styles", async () => {
  const { scriptFamily, originalFont } = await import(
    "../../public/platform/fonts.js"
  );
  for (const [text, key] of [
    ["画廊", "misans"],
    ["مرحبا", "misansarabic"],
    ["ภาษาไทย", "misansthai"],
    ["ગુજરાતી", "misansgujarati"],
    ["Gallery", "misanslatin"],
  ])
    assert.equal(scriptFamily(text), key);
  const regular = { name: "MiSans-Regular.ttf" },
    bold = { name: "MiSans-Semibold.ttf" };
  assert.equal(originalFont({ files: [regular, bold] }, "Semibold"), bold);
  assert.equal(originalFont({ files: [regular] }, "Heavy"), regular);
  const variable = { name: "MiSans Devanagari VF.ttf" },
    bare = { name: "MiSansDevanagari.ttf" };
  assert.equal(originalFont({ files: [variable, bare] }), bare);
  const l3 = { name: "MiSans L3.ttf" };
  assert.equal(originalFont({ files: [l3] }, "Semibold"), l3);
});
test("Fluent icon assets are official paths with compact default drawing", async () => {
  const { fluentIcons, iconSvg } = await import(
    "../../public/platform/fluent-icons.js"
  );
  assert.equal(Object.keys(fluentIcons).length, 20);
  assert.match(iconSvg("settings", 16), /width="16"/);
  assert.match(iconSvg("settings"), /fill="currentColor"/);
});
test("Manager counts individual edits and restart-sensitive settings", async () => {
  const m = await import("../../public/manager/model.js"),
    a = {
      sources: { pixiv: "a", Fantia: "b" },
      fileBrowserRoots: [{ name: "Demo", path: "c" }],
    },
    b = structuredClone(a);
  b.sources.pixiv = "x";
  b.sources.Fantia = "y";
  assert.equal(m.changes(a, b), 2);
  assert.equal(m.requiresRestart(a, b), true);
  const renamed = structuredClone(a);
  renamed.fileBrowserRoots[0].name = "Other";
  assert.equal(m.requiresRestart(a, renamed), true);
  assert.equal(m.requiresRestart(a, a), false);
  assert.equal(
    m.scanProgress({ observedWorks: 50, indexedWorks: 2, reusedWorks: 48 })
      .checked,
    50,
  );
  assert.equal(
    m.scanProgress({ observedWorks: 0, indexedWorks: 5 }).checked,
    0,
  );
  assert.equal(
    m.scanProgress({ indexedWorks: 2, reusedWorks: 48 }).checked,
    50,
  );
  assert.equal(m.scanProgress({ observedWorks: 50 }).percent, null);
});
test("Manager short durations and cache units do not add zero-minute noise", async () => {
  const { duration, cacheLabel } = await import(
    "../../public/manager/model.js"
  );
  assert.equal(duration(300), "不到 1 秒");
  assert.equal(duration(8000), "8 秒");
  assert.equal(duration(72000), "1 分 12 秒");
  assert.equal(cacheLabel(0), "没有缓存");
  assert.equal(cacheLabel(1), "缩略图缓存不到 1 MB");
  assert.equal(cacheLabel(1288490189), "缩略图缓存 1.2 GB");
});

test("rapid work navigation is ordered and closing invalidates a pending response", async () => {
  const { Viewer } = await import("../../public/gallery/viewer.js");
  let opened = [];
  const v = {
    opened: true,
    openToken: Symbol(),
    work: { index: 0 },
    direction: { x: 0, to() {} },
    host: {
      async adjacent(work, direction) {
        await new Promise((r) => setTimeout(r, 4));
        return { index: work.index + direction };
      },
      async align() {},
      historyReplace() {},
      request() {},
    },
    async open(work) {
      this.work = work;
      this.openToken = Symbol();
      opened.push(work.index);
    },
  };
  await Promise.all([
    Viewer.prototype.changeWork.call(v, 1),
    Viewer.prototype.changeWork.call(v, 1),
    Viewer.prototype.changeWork.call(v, 1),
  ]);
  assert.deepEqual(opened, [1, 2, 3]);
  assert.equal(v.work.index, 3);
  opened = [];
  const waiting = Viewer.prototype.changeWork.call(v, 1);
  v.opened = false;
  v.openToken = Symbol();
  await waiting;
  assert.deepEqual(opened, []);
});

test("native video controls retain keyboard ownership", async () => {
  const { Viewer } = await import("../../public/gallery/viewer.js");
  Viewer.prototype.key.call(
    { opened: true },
    {
      target: { tagName: "VIDEO" },
      key: "ArrowRight",
      preventDefault() {
        assert.fail("Do not flip pages while seeking video");
      },
    },
  );
});
