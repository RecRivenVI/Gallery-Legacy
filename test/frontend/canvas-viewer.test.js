"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const load = () => import("../../public/gallery/viewer.js");
test("Viewer fitting preserves complete aspect ratio with pan and zoom", async () => {
  const { imageFit } = await load();
  assert.deepEqual(imageFit(200, 400, { x: 0, y: 50, w: 1200, h: 786 }), {
    x: 403.5,
    y: 50,
    w: 393,
    h: 786,
  });
  const r = imageFit(400, 200, { x: 0, y: 0, w: 800, h: 400 }, 2, {
    x: 10,
    y: 20,
  });
  assert.deepEqual(r, { x: -390, y: -180, w: 1600, h: 800 });
});
test("Viewer initial crop is centered without changing media identity", async () => {
  const { coverCrop } = await load();
  assert.deepEqual(coverCrop(1000, 500), { x: 250, y: 0, w: 500, h: 500 });
  assert.deepEqual(coverCrop(500, 1000), { x: 0, y: 250, w: 500, h: 500 });
});
test("Viewer split, hidden chrome and mobile details preserve stage bounds", async () => {
  const { viewerGeometry } = await load();
  const full = viewerGeometry(1440, 900, false, 1, 1);
  assert.equal(full.stage.w, 1200);
  assert.equal(full.stage.h, 786);
  assert.deepEqual(viewerGeometry(1440, 900, true, 1, 1).stage, {
    x: 720,
    y: 50,
    w: 720,
    h: 786,
  });
  assert.deepEqual(viewerGeometry(1440, 900, false, 1, 0).stage, {
    x: 0,
    y: 0,
    w: 1440,
    h: 900,
  });
  assert.equal(viewerGeometry(393, 852, false, 1, 1).stage.w, 393);
});
test("Viewer touch interaction differentiates page swipe, pan and tap", async () => {
  const { gestureResult } = await load(),
    a = { x: 200, y: 200 };
  assert.equal(gestureResult(a, { x: 120, y: 205 }, 1), "next");
  assert.equal(gestureResult(a, { x: 280, y: 205 }, 1), "previous");
  assert.equal(gestureResult(a, { x: 202, y: 202 }, 1), "tap");
  assert.equal(gestureResult(a, { x: 120, y: 200 }, 2), "pan");
  assert.equal(gestureResult(a, { x: 201, y: 300 }, 1), "none");
});
test("Connection copy follows v1.4 elapsed and calendar rules", async () => {
  const { connectionTime } = await import("../../public/gallery/data.js");
  const now = new Date(2026, 9, 3, 12).getTime();
  assert.equal(connectionTime(now, now), "刚刚更新");
  assert.equal(connectionTime(now - 10 * 60000, now), "10 分钟前更新");
  assert.equal(connectionTime(now - 2 * 3600000, now), "2 小时前更新");
  assert.equal(
    connectionTime(new Date(2026, 9, 1).getTime(), now),
    "10 月 1 日更新",
  );
});

test("Viewer range participates in modal keyboard focus wrap", async () => {
  const { Viewer } = await load(),
    previous = global.document;
  const first = {
    focus() {
      global.document.activeElement = this;
    },
    getClientRects: () => [1],
  };
  const range = {
    tagName: "INPUT",
    focus() {
      global.document.activeElement = this;
    },
    getClientRects: () => [1],
  };
  const hidden = { hidden: true, getClientRects: () => [] };
  const viewer = {
    opened: true,
    split: false,
    root: { querySelectorAll: () => [first, range, hidden] },
  };
  let prevented = false;
  global.document = { activeElement: range };
  try {
    Viewer.prototype.key.call(viewer, {
      target: range,
      key: "Tab",
      shiftKey: false,
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    assert.equal(global.document.activeElement, first);
    prevented = false;
    Viewer.prototype.key.call(viewer, {
      target: first,
      key: "Tab",
      shiftKey: true,
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    assert.equal(global.document.activeElement, range);
  } finally {
    global.document = previous;
  }
});

test("Split viewer does not trap the gallery keyboard focus", async () => {
  const { Viewer } = await load();
  Viewer.prototype.key.call(
    { opened: true, split: true },
    {
      target: { tagName: "BUTTON" },
      key: "Tab",
      preventDefault() {
        assert.fail("Split is not a modal");
      },
    },
  );
});

test("Viewer only restores connected return focus after the gallery unlocks", async () => {
  const { Viewer } = await load(),
    previous = global.requestAnimationFrame;
  let callback,
    focused = 0;
  global.requestAnimationFrame = (fn) => {
    callback = fn;
  };
  const viewer = {
    opened: true,
    work: {},
    progress: { to() {} },
    alpha: { to() {} },
    video: { pause() {} },
    host: { card: () => ({}), selected() {}, historyClose() {}, request() {} },
    returnFocus: {
      isConnected: true,
      focus() {
        focused++;
      },
    },
  };
  try {
    Viewer.prototype.close.call(viewer);
    assert.equal(focused, 0);
    callback();
    assert.equal(focused, 1);
    viewer.opened = true;
    callback();
    assert.equal(focused, 1);
    viewer.opened = false;
    viewer.returnFocus.isConnected = false;
    callback();
    assert.equal(focused, 1);
  } finally {
    global.requestAnimationFrame = previous;
  }
});

test("Phone loading and retry remain above an expanded details sheet", async () => {
  const { viewerGeometry, viewerFeedbackArea } = await load();
  const phone = viewerGeometry(393, 852, false, 1, 1);
  const visible = viewerFeedbackArea(phone, true);
  assert.equal(visible.y + visible.h, phone.info.y);
  assert.equal(visible.h, 318);
  assert.equal(viewerFeedbackArea(phone, false), phone.stage);
  const desktop = viewerGeometry(1440, 900, false, 1, 1);
  assert.equal(viewerFeedbackArea(desktop, true), desktop.stage);
});
