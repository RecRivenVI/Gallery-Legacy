"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
test("Canvas edge masks allocate a layer only for a visible fade", async () => {
  const { Paint } = await import("../../public/gallery/paint.js");
  const events = [],
    p = Object.create(Paint.prototype);
  p.c = {
    saveLayer: () => events.push("layer"),
    restore: () => events.push("restore"),
  };
  p.clipped = (fn, area) => {
    assert.equal(area.w, 100);
    fn();
  };
  p.edges = (area, l, r) => events.push([l, r]);
  p.faded(() => events.push("text"), { w: 100 }, 0, -1);
  assert.deepEqual(events, ["text"]);
  events.length = 0;
  p.faded(() => events.push("text"), { w: 100 }, 0, 1);
  assert.deepEqual(events, ["layer", "text", [0, 1], "restore"]);
});
test("Canvas UI targets are reused but snapshots remain separately owned", async () => {
  const { Paint } = await import("../../public/gallery/paint.js");
  let allocations = 0,
    snapshots = 0,
    cleared = 0;
  const canvas = {
      clear: () => cleared++,
      save() {},
      scale() {},
      restore() {},
    },
    main = { restore() {} };
  const target = {
    getCanvas: () => canvas,
    flush() {},
    makeImageSnapshot: () => ({ id: ++snapshots }),
  };
  const p = Object.create(Paint.prototype);
  Object.assign(p, {
    ck: {
      MakeRenderTarget: () => {
        allocations++;
        return target;
      },
      TRANSPARENT: 0,
    },
    layers: [],
    el: { width: 1440, height: 900 },
    dpr: 1,
    layerCursor: 0,
    c: main,
  });
  const first = p.layer(() => assert.equal(p.c, canvas));
  assert.equal(p.c, main);
  p.layerCursor = 0;
  const second = p.layer(() => {});
  assert.equal(allocations, 1);
  assert.equal(cleared, 2);
  assert.notEqual(first, second);
});
test("Canvas DPR1 backdrop snapshots do not allocate a scaled duplicate", async () => {
  const { Paint } = await import("../../public/gallery/paint.js");
  const image = { id: 1 },
    p = Object.create(Paint.prototype);
  Object.assign(p, {
    dpr: 1,
    surface: { makeImageSnapshot: () => image },
    temps: [],
  });
  assert.equal(p.snapshot(), image);
  assert.deepEqual(p.temps, [image]);
});
