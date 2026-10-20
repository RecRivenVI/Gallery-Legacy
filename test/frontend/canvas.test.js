"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const load = (file) => import("../../public/gallery/" + file);
test("Canvas semantic projection only writes changed owned state", async () => {
  const { property, attribute, style } = await load("projection.js");
  const written = { property: 0, attribute: 0, style: 0 },
    actual = {},
    attrs = {};
  const element = {
    style: new Proxy(
      {},
      {
        set(target, key, value) {
          written.style++;
          target[key] = value;
          return true;
        },
      },
    ),
    setAttribute(key, value) {
      written.attribute++;
      attrs[key] = value;
    },
  };
  Object.defineProperty(element, "hidden", {
    set(value) {
      written.property++;
      actual.hidden = value;
    },
    get() {
      return actual.hidden;
    },
  });
  for (let i = 0; i < 120; i++) {
    property(element, "hidden", false);
    attribute(element, "aria-label", "作品");
    style(element, { left: "8px", top: "12px" });
  }
  assert.deepEqual(written, { property: 1, attribute: 1, style: 2 });
  property(element, "hidden", true);
  attribute(element, "aria-label", "作者");
  style(element, { left: "8px", top: "16px" });
  assert.deepEqual(written, { property: 2, attribute: 2, style: 3 });
  assert.equal(actual.hidden, true);
  assert.equal(attrs["aria-label"], "作者");
  assert.equal(element.style.top, "16px");
});
test("Canvas native bridges use scene intersections without a DOM layout read", async () => {
  const { intersects } = await load("projection.js");
  const panel = { x: 100, y: 100, w: 200, h: 200 };
  assert.equal(intersects({ x: 0, y: 0, w: 100, h: 34 }, panel), false);
  assert.equal(intersects({ x: 90, y: 110, w: 40, h: 34 }, panel), true);
  assert.equal(intersects({ x: 300, y: 110, w: 40, h: 34 }, panel), false);
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../public/gallery/app.js"),
    "utf8",
  );
  assert.ok(!source.includes("getBoundingClientRect"));
});
test("Canvas settled motion stays settled and restarting retains targets", async () => {
  const { Spring, Fade } = await load("motion.js");
  const spring = new Spring(10),
    fade = new Fade(1);
  for (let i = 0; i < 120; i++) {
    assert.equal(spring.tick(1 / 60), false);
    assert.equal(fade.tick(1 / 60), false);
  }
  assert.equal(spring.x, 10);
  assert.equal(spring.v, 0);
  assert.equal(fade.x, 1);
  spring.to(20);
  fade.to(0);
  assert.equal(spring.tick(1 / 60), true);
  assert.equal(fade.tick(1 / 60), true);
  assert.ok(spring.x > 10 && spring.x < 20);
  assert.ok(fade.x > 0 && fade.x < 1);
});
test("Canvas opaque color reuse never mutates the palette when alpha changes", async () => {
  const { Paint } = await load("paint.js"),
    color = new Float32Array([0.3, 0.4, 0.5, 0.8]);
  assert.equal(Paint.prototype.color.call({}, color), color);
  const faded = Paint.prototype.color.call({}, color, 0.5);
  assert.notEqual(faded, color);
  assert.equal(faded[3], Math.fround(0.4));
  assert.equal(color[3], Math.fround(0.8));
});
test("Canvas theme v1.1 faint, muted and chip meet contrast against default and glass surfaces", async () => {
  const { themes, t } = await load("tokens.js");
  const lum = (rgb) =>
    rgb
      .map((v) => {
        v /= 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      })
      .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
  const rgb = (hex) =>
    hex
      .slice(1)
      .match(/../g)
      .map((v) => parseInt(v, 16));
  const ratio = (a, b) => {
    a = lum(a);
    b = lum(b);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  for (const theme of Object.values(themes)) {
    const bg = rgb(theme.bg),
      glass = theme.glass
        .slice(0, 3)
        .map((v, i) => v * theme.glass[3] + bg[i] * (1 - theme.glass[3]));
    for (const name of ["fg", "fg2", "faint", "muted"])
      for (const surface of [bg, glass])
        assert.ok(ratio(rgb(theme[name]), surface) >= 4.5, name);
  }
  assert.ok(ratio([255, 255, 255], [102, 102, 102]) >= 5.7);
  assert.equal(t.chip[3], 0.6);
});
test("Canvas URL state keeps independent search/tag/filter/sort and has no transient data version", async () => {
  const { hashFor, locationState } = await load("data.js");
  const state = {
    platform: "pixivFANBOX",
    kind: "works",
    q: "<& 雨",
    tag: "风景",
    mediaType: "video",
    sort: "date_asc",
    page: 7,
    pageSize: 120,
  };
  const hash = hashFor(state),
    parsed = locationState({ hash });
  for (const key of Object.keys(state)) assert.equal(parsed[key], state[key]);
  assert.doesNotMatch(hash, /[?&](?:g|rev|cursor)=/);
});
test("Canvas spring retarget retains current position and velocity", async () => {
  const { Spring } = await load("motion.js"),
    s = new Spring(240);
  s.to(50);
  s.tick(0.11);
  const { x, v } = s;
  s.to(240);
  assert.equal(s.x, x);
  assert.equal(s.v, v);
  s.tick(0.01);
  assert.ok(Number.isFinite(s.x));
});
test("Canvas shell uses offscreen snapshots, keyboard-only focus and saved theme before bootstrap", () => {
  const fs = require("node:fs"),
    path = require("node:path"),
    root = path.resolve(__dirname, "../../public/gallery");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8"),
    paint = fs.readFileSync(path.join(root, "paint.js"), "utf8"),
    html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(paint, /MakeRenderTarget/);
  assert.match(app, /state\.keyboard\s*&&\s*state\.focus/);
  assert.match(app, /state\.keyboard\s*=\s*false/);
  assert.ok(html.indexOf("theme-init.js") < html.indexOf("style.css"));
  assert.doesNotMatch(html, /正在打开/);
  assert.doesNotMatch(app, /control\(\s*["']menu-close["']/);
});
test("Canvas shared text retains unchanged glyphs and fades only replaced glyphs", async () => {
  const { SharedText } = await load("motion.js"),
    text = new SharedText(),
    shape = (ids) => ({
      width: ids.length * 10,
      runs: [
        {
          glyphs: new Uint16Array(ids),
          positions: new Float32Array(ids.flatMap((_, i) => [i * 10, 0])),
        },
      ],
    });
  text.to("abc", shape([1, 2, 3]), 0, 20);
  const first = text.current.glyphs[0],
    second = text.current.glyphs[1];
  text.to("adc", shape([1, 4, 3]), 100, 40);
  assert.equal(text.current.glyphs[0], first);
  assert.equal(first.x.x, 0);
  assert.equal(first.x.target, 100);
  assert.equal(text.outgoing[0], second);
  assert.equal(second.opacity.target, 0);
  assert.equal(text.current.glyphs[1].opacity.x, 0);
  text.tick(0.3);
  assert.equal(text.outgoing.length, 0);
});
test("Canvas invalid and malformed URL inputs fail at the routing boundary", async () => {
  const { locationState } = await load("data.js");
  const state = locationState({
    hash: "#/@all/pixiv?page=NaN&pageSize=-1&mediaType=unsupported",
  });
  assert.equal(state.page, 1);
  assert.equal(state.pageSize, 48);
  assert.equal(state.mediaType, "all");
  assert.equal(locationState({ hash: "#/missing/example" }).invalid, true);
  assert.equal(locationState({ hash: "#/@all/%XX" }).platform, "");
});
test("Canvas thousand-page band is bounded and continuous at a slot boundary", async () => {
  const { virtualBand } = await load("motion.js"),
    a = virtualBand(399.9, 310),
    b = virtualBand(400.1, 310);
  assert.ok(a.length < 20 && b.length < 20);
  assert.ok(
    Math.abs(
      a.find((x) => x.page === 15).x - b.find((x) => x.page === 15).x - 0.2,
    ) < 1e-6,
  );
});
test("Canvas layer semantics protect popup, tag arrows, pager and jump input from covers", () => {
  const fs = require("node:fs"),
    path = require("node:path"),
    css = fs.readFileSync(
      path.resolve(__dirname, "../../public/gallery/style.css"),
      "utf8",
    );
  assert.match(css, /#popup\s*\{\s*z-index:\s*20/);
  assert.match(css, /tags-/);
  assert.match(css, /new-content/);
  assert.match(css, /#jump-input\s*\{[^}]*z-index:\s*5/);
});

test("Canvas empty-platform aggregates normalize at the API boundary", async () => {
  const { normalizePlatforms, formatCount, listParameters } =
    await load("data.js");
  assert.deepEqual(
    normalizePlatforms([{ id: "pixiv" }, { id: "X", works: 5161 }]),
    [
      { id: "pixiv", works: 0 },
      { id: "X", works: 5161 },
    ],
  );
  assert.equal(formatCount(5161), "5,161");
  assert.equal(formatCount(0), "0");
  const s = {
    platform: "pixiv",
    kind: "authors",
    q: "MP",
    tag: "synthetic",
    mediaType: "all",
    sort: "name_asc",
    page: 1,
    pageSize: 1,
  };
  const parameters = listParameters(s, { hideEmpty: true });
  assert.deepEqual(parameters, {
    platform: "pixiv",
    q: "MP",
    sort: "name_asc",
    page: 1,
    pageSize: 1,
  });
  assert.equal(
    listParameters({ ...s, kind: "works" }, { hideEmpty: true }).hideEmpty,
    1,
  );
});
test("Canvas pager shrinks for few pages without changing the slot spacing", async () => {
  const { pageGeometry } = await load("data.js");
  assert.deepEqual(pageGeometry(3, 34, 600), { step: 37, width: 108 });
  assert.deepEqual(pageGeometry(1080, 34, 600), { step: 37, width: 310 });
});
test("Canvas dates are stable ISO calendar labels", async () => {
  const { formatDate } = await load("data.js");
  assert.equal(formatDate(Date.UTC(2021, 1, 15)), "2021-02-15");
  assert.equal(formatDate(null), "");
});
test("Canvas invalid query has its own clearable state", async () => {
  const { locationState } = await load("data.js");
  assert.equal(
    locationState({ hash: "#/@all/pixiv?sort=unsupported" }).invalidFilter,
    true,
  );
  assert.equal(
    locationState({ hash: "#/@all/pixiv?sort=date_desc" }).invalidFilter,
    false,
  );
});
test("Canvas emoji detection includes joined sequences, flags and keycaps but not ordinary digits", async () => {
  const { hasEmoji } = await load("paint.js");
  for (const text of ["🎨", "👩‍💻", "🇨🇳", "1️⃣", "☀️"])
    assert.equal(hasEmoji(text), true);
  for (const text of ["画廊", "123", "MP03"])
    assert.equal(hasEmoji(text), false);
});
test("Canvas shared glyph identity includes the font, not just font-local IDs", async () => {
  const { SharedText } = await load("motion.js"),
    text = new SharedText();
  const shape = (family) => ({
    width: 13,
    runs: [
      {
        family,
        glyphs: new Uint16Array([12]),
        positions: new Float32Array([0, 0]),
      },
    ],
  });
  text.to("🎨", shape("ui"), 0, 20);
  const old = text.current.glyphs[0];
  text.to("🎨", shape("emoji"), 0, 20);
  assert.notEqual(text.current.glyphs[0], old);
  assert.equal(text.current.glyphs[0].family, "emoji");
  assert.equal(text.outgoing[0], old);
});
test("Canvas v1.2 image background contrast meets 4.5 at 50% fading over black and white", async () => {
  const { themes, t } = await load("tokens.js");
  const rgb = (s) =>
      s
        .slice(1)
        .match(/../g)
        .map((n) => parseInt(n, 16)),
    lum = (c) =>
      c
        .map((v) =>
          (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
        )
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  for (const theme of Object.values(themes))
    for (const image of [0, 255]) {
      const background = rgb(theme.bg).map(
          (v) => v * t.dimMin + image * (1 - t.dimMin),
        ),
        glass = background.map(
          (v, i) =>
            theme.glass[i] * t.imageGlassAlpha + v * (1 - t.imageGlassAlpha),
        ),
        a = lum(rgb(theme.faint)),
        b = lum(glass);
      assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5);
    }
});
