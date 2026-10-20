import { Paint, hasEmoji } from "./paint.js";
import {
  Spring,
  Fade,
  SharedText,
  bounds,
  readBounds,
  targetBounds,
  tickBounds,
} from "./motion.js";
import { t, themes, labels } from "./tokens.js";
import { property, attribute, style, intersects } from "./projection.js";
import { Viewer } from "./viewer.js";
import { authorCollage } from "./content-layout.js";
import { loadCanvasMiSans } from "../platform/fonts.js";
import {
  aspectRatios,
  cardColumns,
  viewportAnchor,
  restoredScroll,
  dragScroll,
} from "./interaction.js";
import { ScanWS } from "../platform/events.js";
import { createStreamUpdates } from "./stream-updates.js";
import {
  sources,
  rows,
  normalizeWork,
  pages,
  resultCount,
  tagOptions,
  locationState,
  hashFor,
  backgroundMedia,
  formatCount,
  formatDate,
  pageGeometry,
  connectionTime,
} from "./data.js";
const $ = (id) => document.getElementById(id),
  cv = $("scene"),
  controls = new Map(),
  tiles = new Map(),
  textures = new Map(),
  requests = new Map(),
  systemTheme = matchMedia("(prefers-color-scheme:dark)"),
  systemReduced = matchMedia("(prefers-reduced-motion:reduce)");
let pref = {};
try {
  pref = JSON.parse(localStorage.getItem("gallery_canvas_preferences") || "{}");
} catch {
  pref = {};
}
if (!pref || typeof pref !== "object" || Array.isArray(pref)) pref = {};
const sizes = [24, 48, 72, 96, 120];
if (!Number.isInteger(pref.size) || pref.size < 0 || pref.size > 5)
  pref.size = 3;
if (!sizes.includes(pref.pageSize)) pref.pageSize = 48;
pref.dim = Number.isFinite(pref.dim)
  ? Math.min(t.dimMax, Math.max(t.dimMin, pref.dim))
  : t.dimDefault;
const state = {
  query: locationState(location),
  sources: null,
  result: null,
  authors: new Map(),
  resultCounts: { works: null, authors: null },
  updatedAt: null,
  tagOptions: [],
  status: "loading",
  reason: "",
  theme: document.documentElement.dataset.theme,
  themeMode: localStorage.getItem("gallery_theme") || "system",
  themeFrom: null,
  themeFade: new Fade(1, 0.3),
  sidebar: new Spring(
    localStorage.getItem("gallery_canvas_sidebar") === "0" ? 50 : 240,
  ),
  sidebarText: new Fade(
    localStorage.getItem("gallery_canvas_sidebar") === "0" ? 0 : 1,
  ),
  scroll: new Spring(0),
  band: new Spring(0),
  panel: null,
  closingPanel: null,
  panelReturn: null,
  panelAlpha: new Fade(0),
  panelScale: new Spring(0.96),
  keyboard: false,
  hover: null,
  pressed: null,
  focus: null,
  prefs: {
    size: pref.size ?? 3,
    privacy: !!pref.privacy,
    hideEmpty: pref.hideEmpty !== false,
    hideAuthorAvatar: pref.hideAuthorAvatar !== false,
    aspect: Object.hasOwn(aspectRatios, pref.aspect) ? pref.aspect : "square",
    reduced: !!pref.reduced,
    pageSize: pref.pageSize || 48,
    background: null,
    dim: pref.dim ?? 0.66,
  },
  backgroundFade: new Fade(1, 0.3),
  backgroundSelection:
    pref.background?.work && pref.background?.media ? pref.background : null,
  newCount: 0,
  idleAt: performance.now(),
  fan: null,
  abort: null,
  splitArmed: false,
  selectedWork: null,
  gridWidth: new Spring(innerWidth),
  drawerProgress: new Spring(0),
};
let viewer,
  CK,
  p,
  fonts,
  running = false,
  frame = 0,
  elapsed = 0,
  pendingFocus = null,
  drag = null,
  originClock = 0;
const b = (x, y, w, h) => ({ x, y, w, h }),
  clamp = (v, min, max) => Math.max(min, Math.min(max, v)),
  reduced = () => state.prefs.reduced || systemReduced.matches;
function savePrefs() {
  localStorage.setItem(
    "gallery_canvas_preferences",
    JSON.stringify({ ...state.prefs, background: state.backgroundSelection }),
  );
}
function request() {
  if (!frame) {
    if (!running) originClock = performance.now();
    frame = requestAnimationFrame(render);
  }
}
function palette() {
  return Object.fromEntries(
    Object.entries(themes[state.theme]).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : value,
    ]),
  );
}
function setTheme(mode) {
  state.themeMode = mode;
  localStorage.setItem("gallery_theme", mode);
  const next =
    mode === "system" ? (systemTheme.matches ? "dark" : "light") : mode;
  if (next !== state.theme) {
    state.themeFrom = themes[state.theme];
    state.oldUI?.delete();
    state.oldUI = state.uiFrame;
    state.uiFrame = null;
    state.theme = next;
    state.themeFade = new Fade(0, t.themeFade);
    state.themeFade.to(1);
  }
  document.documentElement.dataset.theme = next;
  document.documentElement.style.setProperty("--fg", themes[next].fg);
  document.documentElement.style.setProperty("--bg", themes[next].bg);
  request();
}
function panel(kind) {
  const previous = state.panel || state.closingPanel;
  if (kind) {
    state.closingPanel = null;
    state.panel = kind;
    if (kind !== previous) state.panelScroll = 0;
    state.panelReturn = state.panelReturn || document.activeElement;
  } else {
    state.closingPanel = previous;
    state.panel = null;
  }
  state.panelAlpha.to(kind ? 1 : 0);
  state.panelScale.to(kind ? 1 : 0.96);
  $("panel-input")?.remove();
  $("tag-search")?.remove();
  $("popup").hidden = !kind;
  $("popup").setAttribute(
    "aria-label",
    kind === "settings"
      ? "设置"
      : kind === "tags"
        ? "标签"
        : kind === "background"
          ? "选择背景"
          : "排序",
  );
  $("semantics").inert = !!kind;
  // Input visibility is decided from its actual intersection with the panel.
  pendingFocus = kind
    ? kind === "settings"
      ? "theme-system"
      : kind === "sort"
        ? "sort:" + state.query.sort
        : kind === "tags"
          ? "tag:clear"
          : kind === "background"
            ? "bg:" +
              state.result?.items.find((w) => w.cover?.thumbnailUrl)?.key
            : null
    : null;
  if (!kind) {
    state.panelReturn?.focus();
    state.panelReturn = null;
  }
  if (kind === "tags") {
    state.tagQuery = "";
    state.tagScroll = 0;
    loadTags();
  }
  request();
}
async function loadTags(more = false) {
  const query = state.tagQuery || "",
    token = (state.tagRequest = Symbol());
  try {
    const data = await tagOptions(
      state.query.platform,
      query,
      more ? state.tagCursor : null,
    );
    if (token !== state.tagRequest || state.panel !== "tags") return;
    state.tagOptions = more ? [...state.tagOptions, ...data.items] : data.items;
    state.tagCursor = data.cursor;
    request();
  } catch {
    if (token === state.tagRequest && state.panel === "tags")
      panel("tag-error");
  }
}
function setBackground(url, selection = null) {
  const token = Symbol();
  state.backgroundRequest = token;
  const apply = () => {
    if (state.backgroundRequest !== token) return;
    const old = state.backgroundSnapshot,
      previous = old || textures.get(state.prefs.background)?.img;
    state.backgroundSnapshot = p.captureBackground(
      previous,
      textures.get(state.prefs.background)?.img,
      state.backgroundFade.x,
    );
    old?.delete();
    state.prefs.background = url;
    state.backgroundSelection =
      selection ||
      (url
        ? (() => {
            const work = state.result?.items.find(
              (w) => w.cover?.thumbnailUrl === url,
            );
            return work
              ? { work: work.stableId, media: work.cover.relativePath }
              : null;
          })()
        : null);
    state.backgroundFade = new Fade(0, t.themeFade);
    state.backgroundFade.to(1);
    savePrefs();
    request();
  };
  if (url && !textures.has(url))
    texture(url).then(apply, (error) => {
      state.backgroundError = error.message;
      request();
    });
  else apply();
}
function control(id, label, box, action, opt = {}) {
  if (state.drawingDrawer) state.drawerControls.add(id);
  let c = controls.get(id);
  if (!c) {
    const el = document.createElement(
      opt.element || (opt.href ? "a" : "button"),
    );
    el.className = "bridge";
    el.dataset.control = id;
    if (opt.element === "span") el.style.cursor = "default";
    if (el.tagName === "BUTTON") el.type = "button";
    el.addEventListener("click", (event) => {
      if (el.dataset.dragged === "1") {
        el.dataset.dragged = "0";
        event.preventDefault();
        return;
      }
      if (el.tagName !== "A" || c.action) {
        if (
          el.tagName === "A" &&
          (event.ctrlKey || event.metaKey || event.shiftKey)
        )
          return;
        event.preventDefault();
      }
      c.action?.();
    });
    el.addEventListener("pointerenter", () => {
      state.hover = id;
      if (id.startsWith("cover:")) hoverWork(id.slice("cover:".length));
      request();
    });
    el.addEventListener("pointerleave", () => {
      if (state.hover === id) state.hover = null;
      if (id.startsWith("cover:")) stopFan();
      request();
    });
    el.addEventListener("pointerdown", (event) => {
      state.keyboard = false;
      state.pressed = id;
      if (id.startsWith("cover:")) {
        if (event.pointerType === "touch")
          c.longPress = setTimeout(() => hoverWork(id.slice(6)), 450);
        drag = { y: event.clientY, scroll: state.scroll.x };
        el.setPointerCapture(event.pointerId);
      }
      request();
    });
    el.addEventListener("pointermove", (event) => {
      if (
        drag &&
        id.startsWith("cover:") &&
        Math.abs(event.clientY - drag.y) > t.gap
      ) {
        clearTimeout(c.longPress);
        el.dataset.dragged = "1";
        state.scroll.x = Math.max(0, drag.scroll + drag.y - event.clientY);
        state.scroll.target = state.scroll.x;
        stopFan();
        request();
      }
    });
    el.addEventListener("pointerup", () => {
      clearTimeout(c.longPress);
      drag = null;
      state.pressed = null;
      request();
    });
    el.addEventListener("pointercancel", () => {
      clearTimeout(c.longPress);
      drag = null;
      state.pressed = null;
      delete el.dataset.dragged;
      stopFan();
      request();
    });
    el.addEventListener("focus", () => {
      state.focus = id;
      if (opt.popup && state.panel === "settings" && state.panelMax) {
        const r = state.panelBox,
          top = parseFloat(el.style.top),
          bottom = top + parseFloat(el.style.height);
        state.panelScroll = clamp(
          (state.panelScroll || 0) +
            (top < r.y + 8
              ? top - r.y - 8
              : bottom > r.y + r.h - 8
                ? bottom - r.y - r.h + 8
                : 0),
          0,
          state.panelMax,
        );
      }
      request();
    });
    el.addEventListener("blur", () => {
      if (state.focus === id) state.focus = null;
      request();
    });
    c = {
      el,
      hover: new Fade(),
      press: new Fade(),
      selected: new Fade(),
      knob: new Spring(0),
      seen: false,
    };
    controls.set(id, c);
    (opt.popup
      ? $("popup")
      : id.startsWith("cover:") ||
          id.startsWith("author:") ||
          id.startsWith("title:") ||
          id.startsWith("tag:") ||
          id.startsWith("tags-")
        ? $("works")
        : $("navigation")
    ).append(el);
  }
  c.seen = true;
  c.action = action;
  c.tabStop = opt.tabStop !== false;
  property(c.el, "disabled", !!opt.disabled);
  if (opt.href) property(c.el, "href", opt.href);
  attribute(c.el, "aria-label", label);
  property(c.el, "textContent", label);
  style(c.el, {
    left: box.x + (state.controlOffsetX || 0) + "px",
    top: box.y + (opt.popup ? state.controlOffsetY || 0 : 0) + "px",
    width: box.w + "px",
    height: box.h + "px",
  });
  if (opt.selected !== undefined)
    attribute(c.el, "aria-pressed", String(opt.selected));
  if (opt.switch) {
    attribute(c.el, "role", "switch");
    attribute(c.el, "aria-checked", String(opt.selected));
    c.el.removeAttribute("aria-pressed");
  }
  if (opt.expanded !== undefined)
    attribute(c.el, "aria-expanded", String(opt.expanded));
  const alpha = opt.disabled ? 0.35 : (opt.alpha ?? 1),
    r = opt.radius ?? t.controlRadius,
    colors = p.colors;
  c.hover.to(state.hover === id && !opt.disabled ? 1 : 0);
  c.press.to(state.pressed === id && !opt.disabled ? 1 : 0);
  c.selected.to(opt.selected ? 1 : 0);
  c.knob.to(opt.selected ? 1 : 0);
  if (opt.primary) p.rr(box, r, colors.accent, alpha);
  else if (c.selected.x) p.rr(box, r, colors.on, c.selected.x * alpha);
  else if (opt.secondary) p.rr(box, r, colors.tag, alpha);
  p.rr(box, r, colors.tint, c.hover.x * alpha);
  p.rr(box, r, colors.press, c.press.x * alpha);
  if (opt.switch) {
    const track = b(
      box.x + t.inset,
      box.y + t.controlRadius,
      t.control,
      t.chipHeight,
    );
    p.rr(
      track,
      t.navRadius,
      opt.selected ? colors.ok : p.color(colors.fg, t.switchOffAlpha),
      alpha,
    );
    p.c.drawCircle(
      track.x + t.navRadius + t.dividerInset * c.knob.x,
      track.y + t.navRadius,
      t.switchKnob,
      p.fill(t.white, alpha),
    );
  } else if (opt.icon)
    p.icon(
      opt.icon,
      box.x + (box.w - t.iconBox) / 2,
      box.y + (box.h - t.iconBox) / 2,
      colors.fg,
      alpha,
    );
  else if (opt.drawText !== false) {
    const face = opt.selected ? "bold" : "ui",
      size = opt.size || t.font,
      displayLabel = opt.dropdown ? label.replace(/ ▾$/, "") : label,
      textWidth = p.shape(displayLabel, size, face).width,
      width = textWidth + (opt.dropdown ? t.gap + t.dropdownWidth : 0);
    p.text(
      displayLabel,
      box.x + (box.w - width) / 2,
      box.y + (box.h + size) / 2 - 2,
      size,
      opt.primary ? colors.accentInk : colors.fg,
      alpha,
      face,
    );
    if (opt.dropdown)
      p.dropdown(
        box.x + (box.w - width) / 2 + textWidth + t.gap,
        box.y + (box.h - t.dropdownHeight) / 2,
        colors.fg,
        alpha,
      );
  }
  if (state.keyboard && state.focus === id) p.focus(box, r);
}
function setQuery(change) {
  if (narrow()) {
    state.drawer = false;
    state.drawerProgress.to(0);
  }
  if (change.kind && !["pages", "author", "files"].includes(change.kind)) {
    change.path = `/${change.kind === "authors" ? "@authors" : "@all"}/${change.platform || state.query.platform}`;
  }
  state.pageDirection =
    change.page === undefined ? 0 : Math.sign(change.page - state.query.page);
  history.replaceState(
    {
      ...history.state,
      anchor: viewportAnchor(tiles, state.scroll.target, contentTop()),
      scroll: state.scroll.target,
    },
    "",
    location.href,
  );
  state.query = { ...state.query, ...change };
  if (Object.hasOwn(change, "q")) $("search").value = state.query.q;
  history.pushState({}, "", hashFor(state.query));
  routeHash = location.hash;
  load();
}
function openAuthor(work) {
  const path = work.isAuthor
    ? work.stableId
    : work.stableId.slice(0, work.stableId.lastIndexOf("/"));
  setQuery({
    kind: "author",
    path,
    platform: work.platformId || state.query.platform,
    page: 1,
    q: "",
    tag: "",
    sort: "date_desc",
  });
}
function reducedTransition() {
  if (!reduced() || !p) return;
  state.reducedFrame?.delete();
  state.reducedFrame = p.surface.makeImageSnapshot();
  state.reducedFade = new Fade(0, 0.18);
  state.reducedFade.to(1);
}
function setSize(size) {
  const anchor = viewportAnchor(tiles, state.scroll.target, contentTop());
  reducedTransition();
  $("size").value = size;
  state.prefs.size = size;
  savePrefs();
  layout();
  state.scroll.to(restoredScroll(anchor, tiles));
  request();
}
function layout() {
  if (!p || !state.result) return;
  const side = narrow() ? 0 : state.sidebar.target,
    start = side + t.gap,
    width = state.gridWidth.x - start - t.gap,
    size = t.sizes[state.prefs.size];
  const touch = matchMedia("(pointer:coarse)").matches || p.w < 700;
  const columns = cardColumns(width, state.prefs.size, touch, p.h > p.w);
  const w = (width - (columns - 1) * t.gap) / columns,
    h = w / aspectRatios[state.prefs.aspect][1];
  for (const [i, work] of state.result.items.entries()) {
    const rect = size
      ? b(
          start + (i % columns) * (w + t.gap),
          contentTop() +
            t.smallPad +
            Math.floor(i / columns) * (h + t.rowGap + t.platformPitch),
          w,
          h,
        )
      : b(
          start,
          contentTop() + t.smallPad + i * (t.thumb + t.rowGap),
          width,
          t.thumb,
        );
    let tile = tiles.get(work.key);
    if (!tile) {
      tile = {
        work,
        box: bounds(rect.x, rect.y, rect.w, rect.h),
        appear: new Fade(0),
        scale: new Spring(0.96),
        title: new SharedText(),
        author: new SharedText(),
        marquee: new Spring(0),
        authorMarquee: new Spring(0),
        tagOffset: new Spring(0),
        hoverAt: 0,
      };
      tile.enterAt = performance.now() + Math.min(t.maxStagger, i * t.smallPad);
      if (state.pageDirection)
        tile.box.x.x += state.pageDirection * t.fadeWidth;
      tiles.set(work.key, tile);
    }
    tile.work = work;
    tile.leaving = false;
    if (!tile.enterAt) {
      tile.appear.to(1);
      tile.scale.to(1);
    }
    const old = readBounds(tile.box),
      visible =
        (old.y - state.scroll.x < p.h &&
          old.y - state.scroll.x + old.h + t.platformPitch >
            t.header + t.toolbar) ||
        (rect.y - state.scroll.x < p.h &&
          rect.y - state.scroll.x + rect.h + t.platformPitch >
            t.header + t.toolbar);
    targetBounds(tile.box, rect);
    const tx = rect.x + (size ? 0 : t.thumb + t.gap),
      ty = rect.y + (size ? rect.h + t.textAdvance : t.thumb / 2 - t.groupPad);
    tile.title.to(work.title, p.shape(work.title, t.font, "ui"), tx, ty);
    tile.author.to(
      work.author,
      p.shape(work.author, t.subtitle, "regular"),
      tx,
      ty + t.textAdvance,
    );
    tile.shape = tile.title.current.shape;
    if (!visible) {
      for (const v of Object.values(tile.box)) {
        v.x = v.target;
        v.v = 0;
      }
      tile.title.snap();
      tile.author.snap();
    }
  }
  const keys = new Set(state.result.items.map((x) => x.key));
  for (const [key, tile] of tiles)
    if (!keys.has(key)) {
      tile.leaving = true;
      tile.appear.to(0);
      tile.scale.to(0.96);
    }
}
async function texture(url) {
  if (!url) return null;
  if (textures.has(url)) return textures.get(url);
  if (requests.has(url)) return requests.get(url);
  const pending = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw Error("图片无法读取");
    const bytes = await response.arrayBuffer(),
      img = CK.MakeImageFromEncoded(bytes);
    if (!img) throw Error("图片格式无法显示");
    const result = { url, img, blur: p.bake(img) };
    textures.set(url, result);
    if (textures.size > 180) {
      const key = textures.keys().next().value,
        text = textures.get(key);
      text.img.delete();
      text.blur.delete();
      text.private?.delete();
      textures.delete(key);
    }
    request();
    return result;
  })();
  requests.set(url, pending);
  try {
    return await pending;
  } finally {
    requests.delete(url);
  }
}
async function load({ restore = null } = {}) {
  state.abort?.abort();
  const abort = (state.abort = new AbortController());
  state.showPrevious =
    !!state.result?.items.length && state.resolvedPath === state.query.path;
  state.status = "loading";
  attribute($("works"), "aria-busy", "true");
  state.resultCounts = { works: null, authors: null };
  if (state.pageDirection && !state.showPrevious)
    for (const tile of tiles.values()) {
      tile.appear.to(0);
      tile.scale.to(0.96);
    }
  $("live").textContent = "";
  state.newCount = 0;
  if (!restore && !state.showPrevious) state.scroll.to(0);
  stopFan();
  request();
  try {
    if (state.query.invalid) {
      state.status = "invalid";
      state.showPrevious = false;
      attribute($("works"), "aria-busy", "false");
      request();
      return;
    }
    if (state.query.invalidFilter) {
      state.status = "filter-invalid";
      state.showPrevious = false;
      attribute($("works"), "aria-busy", "false");
      request();
      return;
    }
    let data = await rows(state.query, state.prefs, abort.signal);
    if (abort !== state.abort) return;
    if (data.totalPages > 0 && state.query.page > data.totalPages) {
      state.query.page = data.totalPages;
      history.replaceState({}, "", hashFor(state.query));
      routeHash = location.hash;
      data = await rows(state.query, state.prefs, abort.signal);
      if (abort !== state.abort) return;
    }
    state.result = data;
    state.resolvedPath = state.query.path;
    state.showPrevious = false;
    attribute($("works"), "aria-busy", "false");
    if (state.query.kind === "pages" && data.heading?.cover?.thumbnailUrl)
      texture(data.heading.cover.thumbnailUrl)
        .then(request)
        .catch(() => {});
    state.resultCounts[state.query.kind === "authors" ? "authors" : "works"] =
      data.total;
    state.status = data.items.length ? "populated" : "empty";
    if (!restore) state.scroll.to(0);
    $("live").textContent = data.items.length
      ? "已显示 " + data.items.length + " 个作品"
      : state.query.q || state.query.tag
        ? labels.emptyFiltered
        : state.query.kind === "files"
          ? labels.emptyFolder
          : labels.emptyPlatform;
    layout();
    if (restore) {
      const scroll = restoredScroll(restore.anchor, tiles, restore.scroll || 0);
      state.scroll.x = state.scroll.target = scroll;
    }
    request();
    if (["works", "authors"].includes(state.query.kind)) {
      const other = state.query.kind === "authors" ? "works" : "authors";
      resultCount(state.query, state.prefs, other).then(
        (n) => {
          if (abort !== state.abort) return;
          state.resultCounts[other] = n;
          request();
        },
        (error) => {
          state.authorCountError = error.code;
        },
      );
    }
    for (const work of data.items) {
      const url = work.cover?.thumbnailUrl || work.cover?.url;
      if (url)
        texture(url).catch((error) => {
          work.imageError = error.message;
          request();
        });
      for (const m of work.collage || [])
        texture(m.thumbnailUrl)
          .then(request)
          .catch(() => {});
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    state.showPrevious = false;
    attribute($("works"), "aria-busy", "false");
    state.status =
      error.status === 404
        ? "invalid"
        : error.code === "INVALID_QUERY"
          ? "filter-invalid"
          : "error";
    $("live").textContent = "加载失败";
    state.reason =
      error.status === 403
        ? "服务器拒绝了访问"
        : error.code === "INVALID_QUERY"
          ? labels.invalidFilter
          : "服务没有响应";
    request();
  }
}
async function hoverWork(key) {
  const tile = tiles.get(key);
  if (
    !tile ||
    tile.work.isAuthor ||
    tile.work.isFolder ||
    tile.work.counts.media < 2 ||
    state.prefs.privacy ||
    reduced()
  )
    return;
  tile.hoverAt = performance.now();
  state.fan = key;
  tile.fan ??= {
    photos: [],
    amount: new Spring(0),
    springs: [new Spring(0), new Spring(0), new Spring(0)],
    start: 0,
  };
  const fan = tile.fan,
    session = Symbol();
  fan.session = session;
  const start = () => {
    if (state.fan === key && fan.session === session) {
      fan.start = performance.now();
      fan.amount.to(1);
      request();
    }
  };
  if (fan.photos.length && fan.photos.every((url) => textures.has(url))) {
    setTimeout(start, t.fanDelay);
    return;
  }
  try {
    const media = await pages(tile.work);
    if (state.fan !== key || fan.session !== session) return;
    const list = media.slice(
      media[0]?.id === tile.work.cover?.id ? 1 : 0,
      media[0]?.id === tile.work.cover?.id ? 4 : 3,
    );
    const photos = await Promise.all(
      list.map((item) => texture(item.thumbnailUrl)),
    );
    if (state.fan !== key || fan.session !== session) return;
    fan.photos = photos.map((photo) => photo.url);
    setTimeout(
      start,
      Math.max(0, t.fanDelay - (performance.now() - tile.hoverAt)),
    );
  } catch (error) {
    tile.work.fanError = error.message;
  }
}
function stopFan() {
  const tile = tiles.get(state.fan);
  if (tile?.fan) {
    tile.fan.session = null;
    tile.fan.amount.to(0);
    tile.fan.start = 0;
    for (const s of tile.fan.springs) s.to(0);
  }
  state.fan = null;
  request();
}
function drawSharedText(text, area, size, color, alpha, offset = 0) {
  p.ensureEmoji(text.current?.text || "");
  p.faded(
    () => {
      const glyphs = [...(text.current?.glyphs || []), ...text.outgoing];
      const opaque = glyphs.filter((g) => g.opacity.x === 1);
      for (const key of new Set(
        opaque.map((g) => g.family + ":" + (g.size?.x ?? size).toFixed(2)),
      )) {
        const sameFace = opaque.filter(
            (g) => g.family + ":" + (g.size?.x ?? size).toFixed(2) === key,
          ),
          family = sameFace[0].family;
        p.c.drawGlyphs(
          new Uint16Array(sameFace.map((g) => g.id)),
          new Float32Array(
            sameFace.flatMap((g) => [g.x.x - offset, g.y.x - state.scroll.x]),
          ),
          0,
          0,
          p.font(sameFace[0].size?.x ?? size, family),
          p.fill(color, alpha),
        );
      }
      for (const g of glyphs)
        if (g.opacity.x > 0 && g.opacity.x < 1)
          p.c.drawGlyphs(
            new Uint16Array([g.id]),
            new Float32Array([g.x.x - offset, g.y.x - state.scroll.x]),
            0,
            0,
            p.font(g.size?.x ?? size, g.family),
            p.fill(color, alpha * g.opacity.x),
          );
    },
    area,
    offset / t.fadeWidth,
    (Math.max(0, (text.current?.shape.width || 0) - area.w) - offset) /
      t.fadeWidth,
  );
}
function drawTile(tile, pass = "all") {
  const raw = readBounds(tile.box),
    box = { ...raw, y: raw.y - state.scroll.x },
    list = state.prefs.size === 0;
  if (box.y + box.h + t.platformPitch < t.header + t.toolbar || box.y > p.h)
    return;
  const selected = state.selectedWork?.stableId === tile.work.stableId;
  const a =
      tile.appear.x *
      (selected && viewer?.opened && !viewer.split ? 1 - viewer.alpha.x : 1),
    scale = tile.scale.x,
    cover = tile.work.cover,
    url = cover?.thumbnailUrl || cover?.url,
    image = textures.get(url),
    photo = list ? b(box.x, box.y, t.thumb, t.thumb) : box;
  p.c.save();
  if (state.prefs.privacy) {
    p.cardPrivacyPaint ??= new CK.Paint();
    p.cardPrivacyFilter ??= CK.ImageFilter.MakeBlur(
      8,
      8,
      CK.TileMode.Decal,
      null,
    );
    p.cardPrivacyPaint.setImageFilter(p.cardPrivacyFilter);
    const region = b(box.x, box.y, box.w, box.h + (list ? 0 : t.platformPitch));
    p.c.clipRect(
      CK.XYWHRect(region.x, region.y, region.w, region.h),
      CK.ClipOp.Intersect,
      true,
    );
    p.c.saveLayer(p.cardPrivacyPaint);
  }
  p.c.save();
  p.c.translate(photo.x + photo.w / 2, photo.y + photo.h / 2);
  const hoverScale = 1 - 0.1 * (tile.fan?.amount.x || 0);
  p.c.scale(scale * hoverScale, scale * hoverScale);
  p.c.translate(-photo.x - photo.w / 2, -photo.y - photo.h / 2);
  if (pass !== "ui" && image) {
    if (tile.work.isAuthor && tile.work.collage?.length) {
      p.clipped(
        () => {
          const areas = authorCollage(
            photo,
            Math.min(3, tile.work.collage.length),
          );
          for (const [i, m] of tile.work.collage.slice(0, 3).entries()) {
            const image = textures.get(m.thumbnailUrl);
            if (image) p.imageClip(image.img, areas[i], 0, a);
          }
        },
        photo,
        t.card,
      );
    } else p.imageClip(image.img, photo, t.card, a);
  } else if (pass !== "ui") {
    p.rr(photo, t.card, p.colors.field, a);
    if (tile.work.isAuthor)
      p.icon(
        "author",
        photo.x + photo.w / 2 - 11,
        photo.y + photo.h / 2 - 11,
        p.colors.muted,
        a,
      );
    if (tile.work.isFolder)
      p.icon(
        "folder",
        photo.x + photo.w / 2 - t.caption,
        photo.y + photo.h / 2 - t.caption,
        p.colors.muted,
        a,
      );
    if (tile.work.imageError)
      p.text(
        "!",
        photo.x + photo.w / 2,
        photo.y + photo.h / 2,
        t.heading,
        p.colors.muted,
        a,
      );
  }
  if (pass === "art") {
    p.c.restore();
    if (state.prefs.privacy) p.c.restore();
    p.c.restore();
    return;
  }
  if (!list && image) {
    const chip = (text, x, y) => {
      const w = p.shape(text, t.caption).width + t.chipPad * 2,
        bb = b(x, y, w, t.chipHeight);
      p.c.save();
      p.c.translate(x, y);
      p.c.clipPath(
        p.path(w, t.chipHeight, t.tagRadius),
        CK.ClipOp.Intersect,
        true,
      );
      p.c.translate(-x, -y);
      p.image(image.blur, photo, a);
      p.c.restore();
      p.rr(bb, t.tagRadius, t.chip, a);
      p.outline(bb, t.tagRadius, t.chipStroke);
      p.text(text, x + t.chipPad, y + t.dividerInset, t.caption, t.white, a);
      return w;
    };
    const area = b(
        photo.x + t.inset,
        photo.y + photo.h - t.inset - t.chipHeight,
        photo.w - 2 * t.inset,
        t.chipHeight,
      ),
      total =
        tile.work.tags.reduce(
          (n, tag) =>
            n + p.shape(tag.label, t.caption).width + t.dividerInset + t.tagGap,
          0,
        ) - t.tagGap,
      max = Math.max(0, total - area.w);
    p.faded(
      () => {
        let x = area.x - tile.tagOffset.x;
        for (const tag of tile.work.tags) {
          const label = tag.label,
            w = p.shape(label, t.caption).width + t.dividerInset;
          chip(label, x, area.y);
          const left = Math.max(x, area.x),
            right = Math.min(x + w, area.x + area.w);
          if (right > left)
            control(
              "tag:" + tile.work.key + ":" + tag.id,
              label,
              b(left, area.y, right - left, t.chipHeight),
              () => setQuery({ tag: tag.label, page: 1 }),
              { alpha: 0, drawText: false },
            );
          x += w + t.tagGap;
        }
      },
      area,
      tile.tagOffset.x / t.fadeWidth,
      (max - tile.tagOffset.x) / t.fadeWidth,
    );
    if (
      max > 0 &&
      (state.hover?.includes(tile.work.key) ||
        (state.keyboard && state.focus?.includes(tile.work.key)))
    ) {
      if (tile.tagOffset.x > 1)
        control(
          "tags-left:" + tile.work.key,
          "向左滚动",
          b(area.x, area.y, t.chipHeight, t.chipHeight),
          () => {
            tile.tagOffset.to(
              Math.max(0, tile.tagOffset.target - t.scrollStep),
            );
            request();
          },
          { icon: "left", radius: 2 },
        );
      if (tile.tagOffset.x < max - 1)
        control(
          "tags-right:" + tile.work.key,
          "向右滚动",
          b(area.x + area.w - t.chipHeight, area.y, t.chipHeight, t.chipHeight),
          () => {
            tile.tagOffset.to(
              Math.min(max, tile.tagOffset.target + t.scrollStep),
            );
            request();
          },
          { icon: "right", radius: 2 },
        );
    }
    if (!tile.work.isAuthor && tile.work.counts.media > 1) {
      const txt = String(tile.work.counts.media),
        w = p.shape(txt, t.caption).width + t.dividerInset;
      chip(txt, photo.x + photo.w - t.inset - w, photo.y + t.inset);
    }
    if (cover?.type === "video") {
      const seconds =
        cover.durationMs == null ? null : Math.floor(cover.durationMs / 1000);
      const label =
        seconds == null
          ? "视频"
          : Math.floor(seconds / 60) +
            ":" +
            String(seconds % 60).padStart(2, "0");
      chip(label, photo.x + t.inset, photo.y + t.inset);
    }
    let bx = photo.x + t.inset + (cover?.type === "video" ? 50 : 0);
    for (const label of [
      tile.work.flags?.adult ? "R-18" : null,
      tile.work.flags?.aiGenerated ? "AI" : null,
    ].filter(Boolean))
      bx += chip(label, bx, photo.y + t.inset) + t.inset;
  }
  p.c.restore();
  const tx = list ? box.x + t.thumb + t.gap : box.x,
    ty = list
      ? box.y + t.thumb / 2 - t.groupPad
      : box.y + box.h + t.textAdvance,
    tw = list ? box.w * t.listTitleShare : box.w;
  drawSharedText(
    tile.title,
    b(tx, ty - t.pad, tw, t.fadeWidth),
    t.font,
    p.colors.fg,
    a,
    tile.marquee.x,
  );
  drawSharedText(
    tile.author,
    b(tx, ty + t.groupPad, tw, t.fadeWidth),
    t.subtitle,
    p.colors.muted,
    a,
    tile.authorMarquee.x,
  );
  control(
    "title:" + tile.work.key,
    tile.work.title,
    b(tx, ty - t.pad, tw, t.fadeWidth),
    null,
    { element: "span", tabStop: false, alpha: 0, drawText: false },
  );
  if (list) {
    const left = tx + tw + t.gap,
      right = box.x + box.w - t.pad - t.listDateWidth - t.gap,
      area = b(
        left,
        box.y + (t.thumb - t.iconBox) / 2,
        Math.max(0, right - left),
        t.iconBox,
      ),
      total =
        tile.work.tags.reduce(
          (n, tag) =>
            n +
            p.shape(tag.label, t.subtitle).width +
            t.dividerInset +
            t.tagGap,
          0,
        ) - t.tagGap,
      max = Math.max(0, total - area.w);
    p.clipped(() => {
      p.c.saveLayer();
      let x = left - tile.tagOffset.x;
      for (const tag of tile.work.tags) {
        const width = p.shape(tag.label, t.subtitle).width + t.dividerInset;
        p.rr(b(x, area.y, width, area.h), t.innerRadius, p.colors.tag, a);
        p.text(
          tag.label,
          x + t.chipPad,
          area.y + t.pad,
          t.subtitle,
          p.colors.fg2,
          a,
        );
        const hitLeft = Math.max(x, left),
          hitRight = Math.min(x + width, right);
        if (hitRight > hitLeft)
          control(
            "tag:" + tile.work.key + ":" + tag.id,
            tag.label,
            b(hitLeft, area.y, hitRight - hitLeft, area.h),
            () => setQuery({ tag: tag.label, page: 1 }),
            { alpha: 0, drawText: false },
          );
        x += width + t.tagGap;
      }
      p.edges(
        area,
        tile.tagOffset.x / t.fadeWidth,
        (max - tile.tagOffset.x) / t.fadeWidth,
      );
      p.c.restore();
    }, area);
    if (
      max > 0 &&
      (state.hover?.includes(tile.work.key) ||
        (state.keyboard && state.focus?.includes(tile.work.key)))
    ) {
      for (const [direction, enabled] of [
        ["left", tile.tagOffset.x > 1],
        ["right", tile.tagOffset.x < max - 1],
      ])
        if (enabled)
          control(
            "tags-" + direction + ":" + tile.work.key,
            direction === "left" ? "向左滚动" : "向右滚动",
            b(
              direction === "left" ? left : right - t.chipHeight,
              area.y,
              t.chipHeight,
              t.iconBox,
            ),
            () => {
              tile.tagOffset.to(
                clamp(
                  tile.tagOffset.target +
                    (direction === "left" ? -t.scrollStep : t.scrollStep),
                  0,
                  max,
                ),
              );
              request();
            },
            { icon: direction, radius: t.innerRadius },
          );
    }
    const date = formatDate(tile.work.publishedAtMs);
    p.text(
      date,
      box.x + box.w - t.pad - p.shape(date, t.subtitle).width,
      box.y + t.doubleTextLine,
      t.subtitle,
      p.colors.muted,
      a,
    );
  }
  if (viewer?.split && state.selectedWork?.key === tile.work.key)
    p.focus(photo, t.card);
  control(
    "cover:" + tile.work.key,
    "打开 " + tile.work.title,
    photo,
    () => {
      if (tile.work.isFolder)
        setQuery({ kind: "files", path: tile.work.stableId, page: 1 });
      else if (tile.work.isAuthor) openAuthor(tile.work);
      else viewer.open(tile.work, tile.work.pageIndex || 0, state.splitArmed);
    },
    {
      href: tile.work.stableId,
      alpha: 0,
      drawText: false,
    },
  );
  if (tile.work.author)
    control(
      "author:" + tile.work.key,
      tile.work.author,
      b(tx, ty + t.groupPad, tw, t.iconBox),
      () => {
        openAuthor(tile.work);
      },
      { alpha: 0, drawText: false },
    );
  if (state.prefs.privacy) p.c.restore();
  p.c.restore();
}
function drawFan() {
  if (state.prefs.privacy || reduced()) return;
  for (const tile of tiles.values())
    if (tile.fan?.amount.x) {
      const fan = tile.fan,
        z = readBounds(tile.box),
        r = { ...z, y: z.y - state.scroll.x };
      for (let i = 0; i < fan.photos.length; i++) {
        const [dx, dy, angle, k] = t.fan[i],
          img = textures.get(fan.photos[i]),
          amount = fan.springs[i].x;
        if (!img) continue;
        p.c.save();
        p.c.translate(
          r.x + r.w / 2 + dx * r.w * amount,
          r.y + r.h / 2 + dy * r.h * amount,
        );
        p.c.rotate(angle * amount, 0, 0);
        p.c.scale(1 + (k - 1) * amount, 1 + (k - 1) * amount);
        p.imageClip(
          img.img,
          b(-r.w / 2, -r.h / 2, r.w, r.h),
          t.card,
          tile.appear.x,
        );
        p.c.restore();
      }
      p.hoverShadow(r, fan.amount.x);
      drawTile(tile);
    }
}
function drawSidebar(side, back, textAlpha) {
  p.c.save();
  p.c.clipRect(CK.XYWHRect(0, 0, side, p.h), CK.ClipOp.Intersect, false);
  p.glass(b(0, 0, side, p.h), 0, back);
  control(
    "brand",
    state.sidebar.target === t.header ? "展开侧边栏" : "画廊",
    b(t.gap, t.gap, t.control, t.control),
    () => {
      if (state.sidebar.target === t.header) toggleSidebar();
    },
    { drawText: false },
  );
  const brandHover =
    state.sidebar.target === t.header ? controls.get("brand").hover.x : 0;
  p.icon(
    "gallery",
    t.dividerInset,
    t.dividerInset,
    p.colors.fg,
    1 - brandHover,
  );
  p.icon("menu", t.dividerInset, t.dividerInset, p.colors.fg, brandHover);
  if (textAlpha)
    p.text(
      "画廊",
      t.header - (1 - textAlpha) * t.pad,
      t.headerTextBaseline,
      t.heading,
      p.colors.fg,
      textAlpha,
      "bold",
    );
  if (side > t.collapsed)
    control(
      "collapse",
      "收起侧边栏",
      b(side - t.platformPitch, t.gap, t.control, t.control),
      toggleSidebar,
      {
        icon: "panel",
        alpha: textAlpha,
      },
    );
  p.rect(
    b(t.dividerInset, t.header, Math.max(t.iconBox, side - t.group), 1),
    p.colors.div,
  );
  p.text(
    "平台",
    t.pad,
    t.groupTitleBaseline,
    t.caption,
    p.colors.faint,
    textAlpha,
  );
  const glyph = ["p", "f", "G", "F", "P", "Pw", "X", "微", "V"];
  for (const [i, s] of (state.sources?.platforms || []).entries()) {
    const y = t.platformTop + i * t.platformPitch,
      box = b(t.gap, y, side - t.pad, t.control),
      selected = state.query.kind !== "files" && state.query.platform === s.id;
    control(
      "platform:" + s.id,
      s.id,
      box,
      () =>
        setQuery({ platform: s.id, kind: "works", page: 1, tag: "", q: "" }),
      { selected, drawText: false, radius: t.navRadius },
    );
    p.rr(
      b(t.pathFont, y + t.controlRadius, t.chipHeight, t.chipHeight),
      t.iconRadius,
      selected ? p.colors.fg : p.colors.tag,
    );
    p.text(
      glyph[i],
      t.textAdvance,
      y + t.iconBox,
      t.caption,
      selected ? p.colors.bg : p.colors.fg,
    );
    if (textAlpha) {
      p.text(
        s.id,
        46 - (1 - textAlpha) * t.pad,
        y + t.iconBox,
        t.font,
        p.colors.fg,
        textAlpha,
        selected ? "bold" : "ui",
      );
      p.text(
        formatCount(s.works),
        t.sidebar -
          t.pad -
          p.shape(formatCount(s.works), t.caption, "regular").width,
        y + t.iconBox,
        t.caption,
        p.colors.faint,
        textAlpha,
        "regular",
      );
    }
  }
  const fy =
    t.platformTop +
    (state.sources?.platforms.length || 9) * t.platformPitch +
    t.gap;
  p.rect(b(t.dividerInset, fy, side - t.group, 1), p.colors.div);
  p.text(
    "全部文件",
    t.pad,
    fy + t.fadeWidth,
    t.caption,
    p.colors.faint,
    textAlpha,
  );
  for (const [i, root] of (state.sources?.files || []).entries()) {
    const y = fy + t.doubleTextLine + i * t.platformPitch;
    control(
      "file:" + root.id,
      root.name,
      b(t.gap, y, side - t.pad, t.control),
      () =>
        setQuery({
          kind: "files",
          path: "/f/" + root.id,
          page: 1,
          q: "",
          tag: "",
          sort: "name_asc",
        }),
      {
        selected:
          state.query.kind === "files" &&
          state.query.path?.startsWith("/f/" + root.id),
        drawText: false,
        radius: t.navRadius,
      },
    );
    p.icon("folder", t.pathFont, y + t.card);
    p.fadeText(
      root.name,
      46 - (1 - textAlpha) * t.pad,
      y + t.iconBox,
      t.sidebar - t.settingGroupGap,
      t.font,
      p.colors.fg,
      textAlpha,
    );
  }
  p.rect(b(t.dividerInset, p.h - t.header, side - t.group, 1), p.colors.div);
  p.c.drawCircle(
    25,
    p.h - t.fadeWidth,
    t.inset,
    p.fill(
      state.connection === "offline" || state.status === "error"
        ? p.colors.err
        : state.connection === "connecting"
          ? p.colors.warn
          : p.colors.ok,
    ),
  );
  if (textAlpha)
    p.text(
      state.connection === "offline" || state.status === "error"
        ? "离线"
        : state.connection === "connecting"
          ? "正在重新连接（" + (state.retryIn || 3) + " 秒）"
          : state.updatedAt === null
            ? "已连接"
            : "已连接 · " + connectionTime(state.updatedAt),
      46,
      p.h - t.chipHeight,
      t.subtitle,
      p.colors.muted,
      textAlpha,
    );
  control(
    "connection",
    "重新连接",
    b(t.gap, p.h - t.platformPitch, side - t.pad, t.control),
    () => {
      ScanWS.reconnectNow();
      load();
    },
    {
      drawText: false,
      alpha: 0,
    },
  );
  p.c.restore();
}
function drawShell(back) {
  if (narrow()) {
    drawNarrowShell(back);
    return;
  }
  const side = state.sidebar.x;
  drawSidebar(side, back, state.sidebarText.x);
  p.glass(b(side, 0, p.w - side, t.header + t.toolbar), 0, back);
  const name = state.query.kind === "files" ? "" : state.query.platform,
    path =
      name + " / " + (state.query.kind === "authors" ? "作者" : "最新作品");
  const latin = /^[\x00-\x7f]+$/.test(name),
    width = p.text(
      name,
      side + t.smallPad,
      t.headerTextBaseline,
      t.pathFont,
      p.colors.fg,
      1,
      latin ? "outfit" : "bold",
    );
  p.fadeText(
    state.query.kind === "files"
      ? ""
      : " / " + (state.query.kind === "authors" ? "作者" : "最新作品"),
    side + t.smallPad + width,
    t.headerTextBaseline,
    Math.max(0, t.pathWidth - width),
    t.pathFont,
    p.colors.fg,
    1,
    "bold",
  );
  const sx = p.w > t.searchBreakpoint ? side + t.searchInset : side + t.gap,
    sw = Math.min(t.searchWidth, p.w - sx - t.controlTail),
    searchBox = b(sx, t.gap, sw, t.control);
  p.rr(searchBox, t.controlRadius, p.colors.field);
  p.outline(searchBox, t.controlRadius, p.colors.edge);
  p.icon("search", sx + t.card, t.dividerInset, p.colors.muted);
  p.text(
    "/",
    sx + sw - t.chipHeight,
    t.panelHeadingBaseline,
    t.subtitle,
    p.colors.faint,
  );
  state.searchBox = searchBox;
  style($("search-bridge"), {
    left: sx + "px",
    top: "8px",
    width: sw + "px",
  });
  if (state.keyboard && document.activeElement === $("search"))
    p.focus(searchBox, t.controlRadius);
  control(
    "settings",
    "设置",
    b(p.w - t.platformPitch, t.gap, t.control, t.control),
    () => panel(state.panel ? null : "settings"),
    { icon: "settings", expanded: state.panel === "settings" },
  );
  let x = side + t.gap;
  const kinds = [
      ["works", "作品", state.resultCounts.works],
      [
        "authors",
        "作者",
        state.query.tag || state.query.mediaType !== "all"
          ? null
          : state.resultCounts.authors,
      ],
    ],
    widths = kinds.map(
      ([, label, count]) =>
        p.shape(
          label + " " + (count === null ? "" : formatCount(count)),
          t.font,
        ).width + t.fadeWidth,
    ),
    groupWidth =
      widths.reduce((a, b) => a + b, 0) + t.groupPad * (widths.length + 1);
  if (state.query.kind !== "files") {
    p.group(b(x, t.header, groupWidth, t.control), p.colors.field);
    x += t.groupPad;
    for (let i = 0; i < kinds.length; i++) {
      const [kind, label, count] = kinds[i],
        full = label + (count === null ? "" : " " + formatCount(count));
      control(
        "kind:" + kind,
        full,
        b(x, t.toolbarControlTop, widths[i], t.group),
        () =>
          setQuery({
            kind,
            page: 1,
            sort: kind === "authors" ? "latest_desc" : "date_desc",
          }),
        {
          selected: state.query.kind === kind,
          radius: t.innerRadius,
          disabled: state.query.kind === "files",
          drawText: false,
        },
      );
      const textX = x + t.smallPad,
        labelWidth = p.text(
          label,
          textX,
          t.groupTitleBaseline,
          t.font,
          p.colors.fg,
          1,
          state.query.kind === kind ? "bold" : "ui",
        );
      if (count !== null)
        p.text(
          " " + formatCount(count),
          textX + labelWidth,
          t.groupTitleBaseline,
          t.font,
          p.colors.faint,
          1,
          "regular",
        );
      x += widths[i] + t.groupPad;
    }
    x += t.gap;
    const tagWidth =
      p.shape("标签 " + (state.query.tag || "全部"), t.font).width +
      t.gap +
      t.dropdownWidth +
      t.smallPad * 2;
    control(
      "tags",
      "标签 " + (state.query.tag || "全部") + " ▾",
      b(x, t.header, tagWidth, t.control),
      () => panel("tags"),
      { secondary: true, dropdown: true },
    );
    x += tagWidth + t.gap;
  }
  p.group(b(x, t.header, t.mediaGroupWidth, t.control), p.colors.field);
  x += t.groupPad;
  for (const [type, label] of [
    ["all", "全部"],
    ["image", "图片"],
    ["video", "视频"],
  ]) {
    control(
      "filter:" + type,
      label,
      b(x, t.toolbarControlTop, t.filterWidth, t.group),
      () => setQuery({ mediaType: type, page: 1 }),
      { selected: state.query.mediaType === type, radius: t.innerRadius },
    );
    x += t.filterPitch;
  }
  const sortX = Math.max(x + t.gap, p.w - t.trailingTools);
  const sortLabel =
      ((state.query.kind === "authors" ? labels.authorSorts : labels.workSorts)[
        state.query.sort
      ] || "最近更新") + " ▾",
    sortWidth =
      p.shape(sortLabel.replace(/ ▾$/, ""), t.font).width +
      t.gap +
      t.dropdownWidth +
      t.smallPad * 2;
  control(
    "sort",
    sortLabel,
    b(sortX, t.header, sortWidth, t.control),
    () => panel("sort"),
    { secondary: true, dropdown: true },
  );
  const sliderX = sortX + sortWidth + t.gap;
  state.sliderBox = b(sliderX, t.toolbarControlTop, t.sliderWidth, t.group);
  p.text(
    t.sizeLabels[state.prefs.size],
    sliderX + t.sizeLabelOffset,
    t.groupTitleBaseline,
    t.font,
    p.colors.muted,
  );
  const yy = 67,
    thumbX = sliderX + t.gap + (state.prefs.size / 5) * 102;
  p.rect(b(sliderX + t.gap, yy - 2, 102, t.inset), p.colors.muted);
  for (let i = 0; i < t.sizes.length; i++)
    p.c.drawCircle(
      sliderX + t.gap + (i * 102) / 5,
      yy,
      2,
      p.fill(p.colors.muted),
    );
  p.c.drawCircle(thumbX, yy, t.controlRadius, p.fill(p.colors.fg));
  style($("size-bridge"), {
    left: sliderX + "px",
    top: "53px",
    width: "118px",
  });
  if (state.keyboard && document.activeElement === $("size"))
    p.focus(state.sliderBox, t.innerRadius);
  if (p.w >= 1280 && !matchMedia("(pointer:coarse)").matches)
    control(
      "split",
      "分栏",
      b(p.w - t.platformPitch, t.header, t.control, t.control),
      () => {
        state.splitArmed = !state.splitArmed;
        if (!state.splitArmed && viewer?.split) viewer.close();
        request();
      },
      {
        icon: "panel",
        disabled: p.w < 1280,
        selected: state.splitArmed,
      },
    );
}
function narrow() {
  return p.w < 700 || (p.w < 1000 && p.h > p.w);
}
function contentTop() {
  return (
    t.headerCombined +
    (["author", "pages"].includes(state.query.kind) ? 64 : 0) +
    (state.query.q || state.query.tag || state.result?.incomplete ? 38 : 0)
  );
}
function drawPageHeader() {
  let yy = t.headerCombined + 8,
    x = narrow() ? 8 : state.sidebar.x + 8;
  const head = state.result?.heading;
  if (head) {
    const avatar =
        state.query.kind === "author" && !state.prefs.hideAuthorAvatar,
      textX = x + (avatar ? 64 : 8);
    if (avatar) {
      p.rr(b(x + 8, yy, 48, 48), 24, p.colors.field);
      p.icon("author", x + 21, yy + 13, p.colors.muted, 1, 20);
    }
    p.text(head.name || head.title, textX, yy + 22, 16, p.colors.fg, 1, "bold");
    p.text(
      [
        head.sourceAuthorId,
        head.workCount !== undefined
          ? formatCount(head.workCount) + " 个作品"
          : "",
        formatDate(head.latestUpdateMs || head.latestAtMs),
      ]
        .filter(Boolean)
        .join(" · "),
      textX,
      yy + 44,
      12,
      p.colors.muted,
    );
    if (head.sourceUrl)
      control("header-source", "来源", b(x + 300, yy, 60, 34), null, {
        href: head.sourceUrl,
      });
    yy += 64;
  }
  if (state.query.kind === "files" && !narrow()) {
    const parts = state.query.path.split("/").filter(Boolean);
    let xx = x;
    parts.slice(1).forEach((part, i) => {
      const label =
        i === 0
          ? state.sources.files.find((r) => r.id === part)?.name || part
          : decodeURIComponent(part);
      const w = Math.min(160, p.shape(label, 13).width + 20);
      control("crumb-" + i, label, b(xx, 10, w, 30), () =>
        setQuery({ path: "/f/" + parts.slice(1, i + 2).join("/"), page: 1 }),
      );
      xx += w + 8;
    });
  }
  for (const [id, label, change] of [
    ["keyword", state.query.q, { q: "", page: 1 }],
    [
      "tag",
      state.query.tag ? "标签：" + state.query.tag : "",
      { tag: "", page: 1 },
    ],
  ])
    if (label) {
      const width = Math.min(240, p.shape(label + " ×", 13).width + 24);
      control(
        "condition-" + id,
        label + " ×",
        b(x, yy, width, 28),
        () => setQuery(change),
        { secondary: true },
      );
      x += width + 8;
    }
  if (state.query.q || state.query.tag)
    p.text(
      formatCount(state.result?.total || 0) + " 个结果",
      x + 8,
      yy + 19,
      12,
      p.colors.faint,
    );
  if (state.result?.incomplete)
    p.text("结果不完整：部分目录无法读取", x, yy + 19, 13, p.colors.fg2);
}
function drawNarrowShell(back) {
  const w = p.w;
  p.glass(b(0, 0, w, t.headerCombined), 0, back);
  control(
    "drawer",
    "侧边栏",
    b(t.gap, t.gap, t.control, t.control),
    () => {
      state.drawer = !state.drawer;
      state.drawerProgress.to(state.drawer ? 1 : 0);
      request();
    },
    { icon: "panel" },
  );
  if (!state.mobileSearch) {
    p.fadeText(
      state.query.kind === "files"
        ? state.query.path.split("/").filter(Boolean).length > 2
          ? decodeURIComponent(
              state.query.path.split("/").filter(Boolean).at(-1),
            )
          : state.sources.files.find(
              (r) => r.id === state.query.path.split("/")[2],
            )?.name || "全部文件"
        : state.query.platform,
      t.header,
      t.headerTextBaseline,
      w - t.smallCardWidth,
      t.pathFont,
      p.colors.fg,
      1,
      "bold",
    );
    control(
      "search-open",
      "搜索",
      b(w - t.mobileSearchInset, t.gap, t.control, t.control),
      () => {
        state.mobileSearch = true;
        request();
        setTimeout(() => $("search").focus(), 0);
      },
      { icon: "search" },
    );
  }
  const inputWidth = w - 100;
  state.searchBox = b(t.header, t.gap, inputWidth, t.control);
  style($("search-bridge"), {
    left: "50px",
    top: "8px",
    width: inputWidth + "px",
    visibility: state.mobileSearch && !state.panel ? "visible" : "hidden",
  });
  if (state.mobileSearch) {
    p.rr(
      b(t.header, t.gap, inputWidth, t.control),
      t.controlRadius,
      p.colors.field,
    );
    p.icon("search", t.backgroundPreviewWidth, t.dividerInset, p.colors.muted);
  }
  style($("size-bridge"), { visibility: "hidden" });
  control(
    "settings",
    "设置",
    b(w - t.platformPitch, t.gap, t.control, t.control),
    () => panel(state.panel ? null : "settings"),
    { icon: "settings", expanded: !!state.panel },
  );
  state.toolbarScroll ??= new Spring(0);
  let x = t.gap - state.toolbarScroll.x;
  const items = [
    [
      "mobile-works",
      "作品",
      () => setQuery({ kind: "works", sort: "date_desc", page: 1 }),
      state.query.kind === "works",
    ],
    [
      "mobile-authors",
      "作者",
      () => setQuery({ kind: "authors", sort: "name_asc", page: 1 }),
      state.query.kind === "authors",
    ],
    ["mobile-tags", "标签", () => panel("tags")],
    [
      "mobile-all",
      "全部",
      () => setQuery({ mediaType: "all", page: 1 }),
      state.query.mediaType === "all",
    ],
    [
      "mobile-image",
      "图片",
      () => setQuery({ mediaType: "image", page: 1 }),
      state.query.mediaType === "image",
    ],
    [
      "mobile-video",
      "视频",
      () => setQuery({ mediaType: "video", page: 1 }),
      state.query.mediaType === "video",
    ],
    ["mobile-sort", "排序", () => panel("sort")],
    ["mobile-list", "列表", () => setSize(0), state.prefs.size === 0],
    ["mobile-small", "较小", () => setSize(2), state.prefs.size === 2],
    ["mobile-medium", "中", () => setSize(3), state.prefs.size === 3],
  ];
  p.clipped(
    () => {
      p.c.saveLayer();
      for (const [id, label, fn, selected] of items.filter(
        (item) =>
          state.query.kind !== "files" ||
          !["mobile-works", "mobile-authors", "mobile-tags"].includes(item[0]),
      )) {
        const width = p.shape(label, t.font).width + t.fadeWidth;
        control(id, label, b(x, t.toolbarControlTop, width, t.group), fn, {
          selected,
          radius: t.innerRadius,
          tabStop: x >= 0 && x + width <= w,
        });
        x += width + t.groupPad;
      }
      p.edges(
        b(0, t.header, w, t.platformPitch),
        state.toolbarScroll.x / t.fadeWidth,
        (x + state.toolbarScroll.x - w) / t.fadeWidth,
      );
      p.c.restore();
    },
    b(0, t.header, w, t.platformPitch),
  );
  const max = Math.max(0, x + state.toolbarScroll.x - w + t.gap);
  state.toolbarMax = max;
  if (state.toolbarScroll.x > 1)
    control(
      "toolbar-left",
      "向左滚动",
      b(0, t.toolbarControlTop, t.chipHeight, t.group),
      () => {
        state.toolbarScroll.to(
          Math.max(0, state.toolbarScroll.target - t.phoneCardWidth),
        );
        request();
      },
      { icon: "left", radius: t.innerRadius },
    );
  if (state.toolbarScroll.x < max - 1)
    control(
      "toolbar-right",
      "向右滚动",
      b(w - t.chipHeight, t.toolbarControlTop, t.chipHeight, t.group),
      () => {
        state.toolbarScroll.to(
          Math.min(max, state.toolbarScroll.target + t.phoneCardWidth),
        );
        request();
      },
      { icon: "right", radius: t.innerRadius },
    );
}
function drawDrawer(back) {
  if (narrow() && state.drawerProgress.x > 0.001) {
    p.rect(b(0, 0, p.w, p.h), t.black, 0.4 * state.drawerProgress.x);
    state.drawerControls = new Set();
    state.drawingDrawer = true;
    const dx = -240 * (1 - state.drawerProgress.x);
    p.c.save();
    p.c.translate(dx, 0);
    state.controlOffsetX = dx;
    drawSidebar(t.sidebar, back, 1);
    state.controlOffsetX = 0;
    p.c.restore();
    state.drawingDrawer = false;
  }
}

function toggleSidebar() {
  reducedTransition();
  if (narrow()) {
    state.drawer = false;
    state.drawerProgress.to(0);
    request();
    return;
  }
  const target = state.sidebar.target === 240 ? 50 : 240;
  state.sidebar.to(target);
  state.sidebarText.to(target === 240 ? 1 : 0);
  localStorage.setItem("gallery_canvas_sidebar", target === 240 ? "1" : "0");
  layout();
  request();
}
function drawPager(back) {
  if (state.status !== "populated" || state.result.totalPages <= 1) return;
  const total = state.result.totalPages,
    current = state.query.page,
    y = p.h - t.header;
  const go = (n) => setQuery({ page: clamp(n, 1, total) });
  if (narrow()) {
    const x = p.w / 2 - t.tagListTop;
    p.glass(b(x, y, t.mobilePagerWidth, t.control), t.controlRadius, back);
    control(
      "prev",
      "上一页",
      b(x + t.groupPad, y + t.groupPad, t.group, t.group),
      () => go(current - 1),
      {
        icon: "left",
        disabled: current === 1,
      },
    );
    control(
      "jump",
      current + " / " + total,
      b(x + t.control, y, t.headerCombined, t.control),
      () =>
        jumpInput(
          b(
            x + t.control,
            y,
            p.shape(String(current), t.font).width + t.gap,
            t.control,
          ),
        ),
    );
    control(
      "next",
      "下一页",
      b(x + t.mobileNextInset, y + t.groupPad, t.group, t.group),
      () => go(current + 1),
      { icon: "right", disabled: current === total },
    );
    return;
  }
  const digit = Math.max(
      t.control,
      p.shape(String(total), t.font).width + t.pad,
    ),
    geometry = pageGeometry(
      total,
      digit,
      p.w - state.sidebar.x - t.pagerMinimumChrome,
    ),
    step = geometry.step,
    bandWidth = geometry.width,
    mainWidth = bandWidth + t.pagerChrome,
    jumpWidth =
      p.shape("第 " + total + " / " + total + " 页", t.font).width +
      t.fadeWidth,
    all = mainWidth + t.gap + jumpWidth;
  const x = (p.w + state.sidebar.x - all) / 2;
  p.glass(b(x, y, mainWidth, t.control), t.controlRadius, back);
  p.glass(
    b(x + mainWidth + t.gap, y, jumpWidth, t.control),
    t.controlRadius,
    back,
  );
  control(
    "first",
    "第一页",
    b(x + t.groupPad, y + t.groupPad, t.group, t.group),
    () => go(1),
    {
      disabled: current === 1,
      icon: "first",
      radius: t.innerRadius,
    },
  );
  control(
    "prev",
    "上一页",
    b(x + t.control, y + t.groupPad, t.group, t.group),
    () => go(current - 1),
    {
      disabled: current === 1,
      icon: "left",
      radius: t.innerRadius,
    },
  );
  const left = x + t.pagerBandInset,
    maximum = Math.max(0, total * step - bandWidth);
  state.band.to(
    clamp((current - 1) * step - bandWidth / 2 + digit / 2, 0, maximum),
  );
  p.clipped(
    () => {
      p.c.saveLayer();
      const start = Math.max(0, Math.floor(state.band.x / step) - 1),
        end = Math.min(total, start + Math.ceil(bandWidth / step) + t.groupPad);
      for (let i = start; i < end; i++) {
        const px = left + i * step - state.band.x;
        control(
          "page-slot:" + (i - start),
          String(i + 1),
          b(px, y + t.groupPad, digit, t.group),
          () => go(i + 1),
          {
            selected: current === i + 1,
            radius: t.innerRadius,
            tabStop: px >= left && px + digit <= left + bandWidth,
          },
        );
      }
      p.edges(
        b(left, y, bandWidth, t.control),
        state.band.x / t.fadeWidth,
        (maximum - state.band.x) / t.fadeWidth,
      );
      p.c.restore();
    },
    b(left, y, bandWidth, t.control),
  );
  control(
    "next",
    "下一页",
    b(x + mainWidth - t.pagerNextInset, y + t.groupPad, t.group, t.group),
    () => go(current + 1),
    { disabled: current === total, icon: "right", radius: t.innerRadius },
  );
  control(
    "last",
    "最后一页",
    b(x + mainWidth - t.headerTextBaseline, y + t.groupPad, t.group, t.group),
    () => go(total),
    { disabled: current === total, icon: "last", radius: t.innerRadius },
  );
  const jumpBox = b(x + mainWidth + t.gap, y, jumpWidth, t.control),
    prefix = "第 ",
    suffix = " / " + total + " 页",
    numberWidth = p.shape(String(total), t.font).width + t.gap,
    prefixWidth = p.shape(prefix, t.font).width,
    suffixWidth = p.shape(suffix, t.font).width,
    textX =
      jumpBox.x + (jumpBox.w - prefixWidth - numberWidth - suffixWidth) / 2,
    numberBox = b(textX + prefixWidth, y, numberWidth, t.control),
    baseline = y + (t.control + t.font) / 2 - 2;
  p.text(prefix, textX, baseline, t.font);
  p.text(suffix, numberBox.x + numberWidth, baseline, t.font);
  if (!$("jump-input"))
    p.text(
      String(current),
      numberBox.x + (numberWidth - p.shape(String(current), t.font).width) / 2,
      baseline,
      t.font,
    );
  control("jump", "跳到指定页", numberBox, () => jumpInput(numberBox), {
    drawText: false,
  });
}
function jumpInput(box) {
  const previousInput = $("jump-input");
  if (previousInput) {
    previousInput.onblur = null;
    previousInput.remove();
  }
  const input = document.createElement("input");
  input.id = "jump-input";
  input.setAttribute("aria-label", "页码");
  input.inputMode = "numeric";
  input.value = state.query.page;
  document.body.append(input);
  Object.assign(input.style, {
    left: box.x + "px",
    top: box.y + (box.h - 28) / 2 + "px",
    width: box.w + "px",
    height: "28px",
  });
  const close = () => {
    input.onblur = null;
    input.remove();
    controls.get("jump")?.el.focus();
    request();
  };
  input.onkeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    if (e.key === "Enter" && !e.isComposing && /^\d+$/.test(input.value)) {
      e.preventDefault();
      e.stopPropagation();
      setQuery({
        page: clamp(Number(input.value), 1, state.result.totalPages),
      });
      close();
    }
  };
  input.onblur = () => {
    input.onblur = null;
    input.remove();
    request();
  };
  input.focus();
  input.select();
  request();
}
function panelRange(x, y, width, label, value, change) {
  if (!state.panel) return;
  let input = $("panel-input");
  if (!input) {
    input = document.createElement("input");
    input.id = "panel-input";
    input.type = "range";
    input.min = t.dimMin * 100;
    input.max = t.dimMax * 100;
    input.step = 1;
    input.onfocus = () => {
      const r = state.panelBox,
        bottom = parseFloat(input.style.top) + 34;
      if (r && bottom > r.y + r.h - 8) {
        state.panelScroll = clamp(
          (state.panelScroll || 0) + bottom - r.y - r.h + 8,
          0,
          state.panelMax || 0,
        );
        request();
      }
    };
    $("popup").append(input);
  }
  input.setAttribute("aria-label", label);
  if (document.activeElement !== input) input.value = Math.round(value * 100);
  input.oninput = () => change(Number(input.value) / 100);
  Object.assign(input.style, {
    left: x + "px",
    top: y + (state.controlOffsetY || 0) + "px",
    width: width + "px",
  });
}
function drawPanel(back) {
  if (state.panelAlpha.x === 0) return;
  const kind = state.panel || state.closingPanel;
  const width = Math.min(t.panelWidth, p.w - t.pad),
    x = p.w - width - t.gap,
    y = t.header,
    a = state.panelAlpha.x,
    box = b(
      x,
      y,
      width,
      kind === "settings"
        ? state.prefs.background
          ? t.settingsImageHeight + 154
          : 494
        : kind === "tags"
          ? Math.min(t.tagPanelMaxHeight, p.h - t.thumb)
          : kind === "background"
            ? t.searchWidth
            : t.menuHeight,
    );
  const contentHeight = box.h;
  box.h = Math.min(box.h, Math.max(120, p.h - y - t.gap));
  state.panelMax = kind === "settings" ? Math.max(0, contentHeight - box.h) : 0;
  state.panelScroll = clamp(state.panelScroll || 0, 0, state.panelMax);
  state.panelBox = box;
  style($("popup"), {
    clipPath: `inset(${box.y}px ${p.w - box.x - box.w}px ${p.h - box.y - box.h}px ${box.x}px)`,
  });
  p.c.save();
  p.c.translate(x + width, y);
  p.c.scale(state.panelScale.x, state.panelScale.x);
  p.c.translate(-x - width, -y);
  p.glass(box, t.popRadius, back, a);
  p.c.clipRect(
    p.ck.XYWHRect(box.x, box.y, box.w, box.h),
    p.ck.ClipOp.Intersect,
    true,
  );
  state.controlOffsetY = -(state.panelScroll || 0);
  p.c.translate(0, state.controlOffsetY);
  if (kind === "sort") {
    let yy = y + t.gap;
    for (const [key, label] of Object.entries(
      state.query.kind === "authors" ? labels.authorSorts : labels.workSorts,
    )) {
      control(
        "sort:" + key,
        label,
        b(x + t.gap, yy, width - t.pad, t.control),
        () => {
          setQuery({ sort: key, page: 1 });
          panel(null);
        },
        {
          selected: state.query.sort === key,
          radius: t.innerRadius,
          popup: true,
          alpha: a,
        },
      );
      yy += t.menuPitch;
    }
  }
  if (kind === "tags") {
    p.text(
      "标签",
      x + t.pad,
      y + t.panelHeadingBaseline,
      t.panelFont,
      p.colors.fg,
      a,
      "bold",
    );
    let input = $("tag-search");
    if (!input && state.panel === "tags") {
      input = document.createElement("input");
      input.id = "tag-search";
      input.type = "search";
      input.setAttribute("aria-label", "搜索标签");
      input.placeholder = "搜索标签";
      input.oninput = () => {
        state.tagQuery = input.value;
        state.tagScroll = 0;
        loadTags();
      };
      $("popup").append(input);
    }
    if (input)
      style(input, {
        left: x + 8 + "px",
        top: y + 40 + "px",
        width: width - 16 + "px",
      });
    const unique = [...state.tagOptions].sort(
      (a, z) =>
        Number(z.label === state.query.tag) -
        Number(a.label === state.query.tag),
    );
    control(
      "tag:clear",
      "全部",
      b(x + t.gap, y + 82, width - t.pad, t.control),
      () => {
        setQuery({ tag: "", page: 1 });
        panel(null);
      },
      { popup: true, selected: !state.query.tag, alpha: a, drawText: false },
    );
    p.text("全部", x + 16, y + 104, 13, p.colors.fg, a);
    const visible = Math.floor((box.h - 164) / 34);
    unique
      .slice(state.tagScroll || 0, (state.tagScroll || 0) + visible)
      .forEach((tag, i) => {
        const count = formatCount(tag.workCount || 0),
          countWidth = p.shape(count, 13).width;
        control(
          "tag:select:" + tag.id,
          tag.label + " · " + formatCount(tag.workCount || 0),
          b(x + t.gap, y + 120 + i * t.control, width - t.pad, t.control),
          () => {
            setQuery({ tag: tag.label, page: 1 });
            panel(null);
          },
          {
            popup: true,
            selected: state.query.tag === tag.label,
            alpha: a,
            drawText: false,
          },
        );
        p.fadeText(
          tag.label,
          x + 16,
          y + 142 + i * 34,
          width - 40 - countWidth,
          13,
          p.colors.fg,
          a,
        );
        p.text(
          count,
          x + width - 16 - countWidth,
          y + 142 + i * 34,
          13,
          p.colors.faint,
          a,
        );
      });
    if (state.tagCursor)
      control(
        "tags-more",
        "继续加载",
        b(x + 8, y + box.h - 42, width - 16, 34),
        () => loadTags(true),
        { popup: true, secondary: true },
      );
  }
  if (kind === "settings") {
    p.text("设置", x + t.pad, y + t.group, t.panelFont, p.colors.fg, a, "bold");
    const segments = (items, left, top, w) => {
      p.group(b(left, top, w, t.control), p.color(p.colors.field, a));
      const unit = (w - t.groupPad * (items.length + 1)) / items.length;
      items.forEach(([id, label, selected, action], i) =>
        control(
          id,
          label,
          b(
            left + t.groupPad + i * (unit + t.groupPad),
            top + t.groupPad,
            unit,
            t.group,
          ),
          action,
          { popup: true, selected, alpha: a, radius: t.innerRadius },
        ),
      );
    };
    segments(
      [
        ["system", "跟随系统"],
        ["dark", "深色"],
        ["light", "浅色"],
      ].map(([mode, label]) => [
        "theme-" + mode,
        label,
        state.themeMode === mode,
        () => setTheme(mode),
      ]),
      x + t.gap,
      y + t.platformPitch,
      width - t.pad,
    );
    let yy = y + 98;
    for (const [key, label] of [
      ["privacy", "隐私模糊"],
      ["hideEmpty", "隐藏没有可看内容的作品"],
      ["hideAuthorAvatar", "隐藏作者头像"],
      ["reduced", "减少动态效果"],
    ]) {
      p.text(label, x + t.pad, yy + t.iconBox, t.font, p.colors.fg, a);
      control(
        "pref:" + key,
        label,
        b(x + width - t.controlTail, yy, t.platformPitch, t.control),
        () => {
          state.prefs[key] = !state.prefs[key];
          savePrefs();
          if (key === "hideEmpty") load();
          request();
        },
        { popup: true, selected: state.prefs[key], switch: true, alpha: a },
      );
      yy += t.preferencePitch;
    }
    p.text("封面比例", x + t.pad, yy + t.iconBox, t.font, p.colors.fg, a);
    yy += t.control;
    segments(
      Object.entries(aspectRatios).map(([key, [label]]) => [
        "aspect:" + key,
        label,
        state.prefs.aspect === key,
        () => {
          const anchor = viewportAnchor(
            tiles,
            state.scroll.target,
            contentTop(),
          );
          state.prefs.aspect = key;
          savePrefs();
          layout();
          state.scroll.to(restoredScroll(anchor, tiles));
          request();
        },
      ]),
      x + t.gap,
      yy,
      width - t.pad,
    );
    yy += t.preferencePitch;
    p.text("每页数量", x + t.pad, yy + t.iconBox, t.font, p.colors.fg, a);
    yy += t.control;
    segments(
      sizes.map((n) => [
        "pageSize:" + n,
        String(n),
        state.query.pageSize === n,
        () => {
          state.prefs.pageSize = n;
          savePrefs();
          setQuery({ pageSize: n, page: 1 });
        },
      ]),
      x + t.gap,
      yy,
      width - t.pad,
    );
    yy += t.settingGroupGap;
    p.text("背景", x + t.pad, yy + t.iconBox, t.font, p.colors.fg, a);
    segments(
      [
        [
          "background:plain",
          "纯色",
          !state.prefs.background,
          () => setBackground(null),
        ],
        [
          "background:pick",
          "作品图片",
          !!state.prefs.background,
          () => panel("background"),
        ],
      ],
      x + t.backgroundModeWidth,
      yy,
      width - t.backgroundModeWidth - t.gap,
    );
    if (state.prefs.background) {
      yy += t.preferencePitch;
      const image = textures.get(state.prefs.background);
      if (image)
        p.imageClip(
          image.img,
          b(x + t.pad, yy, t.backgroundImageTop, t.backgroundImageTop),
          t.innerRadius,
          a,
        );
      control(
        "background:change",
        "更换…",
        b(
          x + t.pad + t.backgroundImageTop + t.gap,
          yy + t.chipPad,
          t.backgroundModeWidth,
          t.control,
        ),
        () => panel("background"),
        { popup: true, secondary: true, alpha: a },
      );
      yy += t.thumb;
      p.text("背景淡化", x + t.pad, yy + t.iconBox, t.font, p.colors.fg, a);
      panelRange(
        x + t.backgroundPickerPitch,
        yy,
        width - t.dimRightPadding - t.platformPitch,
        "背景淡化",
        state.prefs.dim,
        (value) => {
          state.prefs.dim = value;
          savePrefs();
          request();
        },
      );
      const percent = Math.round(state.prefs.dim * 100) + "%";
      p.text(
        percent,
        x + width - t.pad - p.shape(percent, t.font).width,
        yy + t.iconBox,
        t.font,
        p.colors.faint,
        a,
      );
    }
  }
  if (kind === "background") {
    control(
      "background:back",
      "返回设置",
      b(x + t.gap, y + t.gap, t.control, t.control),
      () => panel("settings"),
      { icon: "left", popup: true, alpha: a },
    );
    p.text(
      "选择背景",
      x + t.gap + t.control + t.gap,
      y + t.panelHeadingBaseline,
      t.panelFont,
      p.colors.fg,
      a,
      "bold",
    );
    state.result?.items
      .filter((w) => w.cover?.thumbnailUrl)
      .slice(0, 9)
      .forEach((work, i) => {
        const image = textures.get(work.cover?.thumbnailUrl);
        const selected =
          state.backgroundSelection?.work === work.stableId &&
          state.backgroundSelection?.media === work.cover.relativePath;
        if (image)
          p.imageClip(
            image.img,
            b(
              x + t.gap + (i % t.groupPad) * t.backgroundPickerPitch,
              y +
                t.backgroundImageTop +
                Math.floor(i / t.groupPad) * t.backgroundPickerPitch,
              t.backgroundPickerExtent,
              t.backgroundPickerExtent,
            ),
            t.card,
            a,
          );
        control(
          "bg:" + work.key,
          work.title,
          b(
            x + t.gap + (i % t.groupPad) * t.backgroundPickerPitch,
            y +
              t.backgroundImageTop +
              Math.floor(i / t.groupPad) * t.backgroundPickerPitch,
            t.backgroundPickerExtent,
            t.backgroundPickerExtent,
          ),
          () => {
            setBackground(work.cover.thumbnailUrl, {
              work: work.stableId,
              media: work.cover.relativePath,
            });
            panel("settings");
          },
          { popup: true, drawText: false, alpha: 0 },
        );
        if (selected)
          p.focus(
            b(
              x + t.gap + (i % t.groupPad) * t.backgroundPickerPitch,
              y +
                t.backgroundImageTop +
                Math.floor(i / t.groupPad) * t.backgroundPickerPitch,
              t.backgroundPickerExtent,
              t.backgroundPickerExtent,
            ),
            t.card,
          );
      });
  }
  if (kind === "tag-error") {
    p.text(
      "标签加载失败：服务没有响应",
      x + t.pad,
      y + t.panelHeadingBaseline,
      t.font,
      p.colors.fg,
      a,
    );
    control(
      "tags-retry",
      "重试",
      b(x + t.gap, y + t.backgroundImageTop, width - t.pad, t.control),
      () => panel("tags"),
      { popup: true, secondary: true, alpha: a },
    );
  }
  state.controlOffsetY = 0;
  p.c.restore();
}
function render(time) {
  frame = 0;
  running = true;
  const now = performance.now(),
    dt = originClock
      ? Math.min((now - originClock) / 1000, 0.1)
      : 1 / t.rowFooterPadding;
  originClock = now;
  elapsed += dt;
  state.scroll.tick(dt, reduced());
  if (
    state.newCount &&
    state.query.page === 1 &&
    now - state.idleAt > 2000 &&
    !state.panel &&
    !viewer?.opened
  ) {
    state.newCount = 0;
    load();
  }
  state.sidebar.tick(dt, reduced());
  state.drawerProgress.tick(dt, reduced());
  const gridMoving = state.gridWidth.active;
  state.gridWidth.tick(dt, reduced());
  if (gridMoving) layout();
  if (viewer) {
    viewer.host.dt = dt;
    viewer.tick(dt, reduced());
  }
  state.sidebarText.tick(dt);
  state.themeFade.tick(dt);
  state.panelAlpha.tick(dt);
  state.panelScale.tick(dt, reduced());
  state.backgroundFade.tick(dt);
  state.reducedFade?.tick(dt);
  state.band.tick(dt, reduced());
  state.toolbarScroll?.tick(dt, reduced());
  for (const c of controls.values()) {
    c.seen = false;
    c.hover.tick(dt);
    c.press.tick(dt);
    c.selected.tick(dt);
    c.knob.tick(dt, reduced());
  }
  for (const [key, tile] of tiles) {
    if (tile.fan) {
      const fan = tile.fan;
      fan.amount.tick(dt, reduced());
      for (let i = 0; i < fan.springs.length; i++) {
        if (fan.start && now - fan.start >= i * t.fanStagger)
          fan.springs[i].to(1);
        fan.springs[i].tick(dt, reduced());
      }
    }
    if (tile.enterAt && now >= tile.enterAt) {
      tile.appear.to(1);
      tile.scale.to(1);
      tile.enterAt = 0;
    }
    tickBounds(tile.box, dt, reduced());
    tile.appear.tick(dt);
    tile.scale.tick(dt, reduced());
    tile.marquee.lastVisualX = tile.marquee.x;
    tile.authorMarquee.lastVisualX = tile.authorMarquee.x;
    tile.marquee.tick(dt, reduced());
    tile.authorMarquee.tick(dt, reduced());
    tile.tagOffset.tick(dt, reduced());
    tile.title.tick(dt, reduced());
    tile.author.tick(dt, reduced());
    if (tile.leaving && tile.appear.x === 0) tiles.delete(key);
    const hovered =
      (state.hover?.includes(key) ||
        (state.keyboard && state.focus?.includes(key))) &&
      !reduced();
    for (const [motion, text, clock] of [
      [tile.marquee, tile.title, "marqueeAt"],
      [tile.authorMarquee, tile.author, "authorMarqueeAt"],
    ]) {
      const width =
          state.prefs.size === 0
            ? tile.box.w.x * t.listTitleShare
            : tile.box.w.x,
        excess = Math.max(0, (text.current?.shape.width || 0) - width);
      if (hovered && excess > 0) {
        tile[clock] ||= now;
        if (now - tile[clock] > t.marqueeDelay) {
          const duration = (excess / t.marqueeSpeed) * 1000,
            phase =
              ((now - tile[clock] - t.marqueeDelay) / (duration / 0.38) +
                0.12) %
              1,
            u =
              phase < 0.12
                ? 0
                : phase < 0.5
                  ? (phase - 0.12) / 0.38
                  : phase < 0.62
                    ? 1
                    : 1 - (phase - 0.62) / 0.38;
          const eased = u * u * (3 - 2 * u),
            old = motion.lastVisualX;
          motion.x = motion.target = excess * eased;
          motion.v = (motion.x - old) / Math.max(dt, 0.001);
        }
      } else {
        tile[clock] = 0;
        motion.to(0);
      }
    }
  }

  p.begin(palette());
  if (state.themeFrom && state.themeFade.x < 1)
    p.rect(b(0, 0, p.w, p.h), state.themeFrom.bg, 1 - state.themeFade.x);
  const previous = state.backgroundSnapshot,
    bg = textures.get(state.prefs.background);
  if (previous)
    p.image(previous, b(0, 0, p.w, p.h), 1 - state.backgroundFade.x);
  if (bg) p.image(bg.img, b(0, 0, p.w, p.h), state.backgroundFade.x);
  if (previous || bg) p.rect(b(0, 0, p.w, p.h), p.colors.bg, state.prefs.dim);
  if (state.backgroundFade.x === 1 && previous) {
    previous.delete();
    state.backgroundSnapshot = null;
  }
  if (bg) p.colors.glass[3] = t.imageGlassAlpha;
  if (state.status === "populated" || state.showPrevious)
    for (const tile of tiles.values()) drawTile(tile, "art");
  else if (state.status === "loading") {
    const side = narrow() ? 0 : state.sidebar.x,
      cols = Math.max(1, Math.floor((p.w - side) / t.defaultCardWidth));
    for (let i = 0; i < cols * 2; i++)
      p.rr(
        b(
          side + t.gap + (i % cols) * t.skeletonPitch,
          t.backgroundPickerExtent + Math.floor(i / cols) * t.skeletonRowPitch,
          t.defaultCardWidth,
          t.defaultCardWidth,
        ),
        t.card,
        p.colors.field,
        0.65 + 0.2 * Math.sin(elapsed * t.groupPad),
      );
  } else {
    // Status content uses the ordinary page surface, never a retained image's
    // dimming overlay. It also cannot inherit a stale full-frame transition.
    const contentSide = narrow() ? 0 : state.sidebar.x;
    p.rect(
      b(
        contentSide,
        t.headerCombined,
        p.w - contentSide,
        p.h - t.headerCombined,
      ),
      p.colors.bg,
    );
    const message =
      state.status === "invalid"
        ? "找不到这个作品，它可能已被移动或删除。"
        : state.status === "filter-invalid"
          ? labels.invalidFilter
          : state.status === "error"
            ? "加载失败：" + state.reason
            : state.query.q || state.query.tag
              ? labels.emptyFiltered
              : state.query.kind === "files"
                ? labels.emptyFolder
                : labels.emptyPlatform;
    p.text(
      message,
      (p.w + contentSide - p.shape(message, t.panelFont).width) / 2,
      p.h / 2,
      t.panelFont,
      p.colors.fg2,
      1,
      "regular",
    );
    if (state.status === "empty" && !state.query.q && !state.query.tag)
      p.c.save();
    if (state.status === "empty" && !state.query.q && !state.query.tag) {
      p.c.translate((p.w + contentSide - t.emptyIcon) / 2, p.h / 2 - t.thumb);
      p.c.scale(t.emptyIcon / t.iconBox, t.emptyIcon / t.iconBox);
      p.icon(
        state.query.kind === "files" ? "folder" : "gallery",
        0,
        0,
        p.colors.faint,
      );
      p.c.restore();
    }
    if (
      state.status === "invalid" ||
      state.status === "error" ||
      state.status === "filter-invalid" ||
      state.query.q ||
      state.query.tag
    )
      control(
        "retry",
        state.status === "invalid"
          ? "返回"
          : state.status === "error"
            ? labels.retry
            : labels.clear,
        b(
          (p.w + contentSide) / 2 - t.settingGroupGap,
          p.h / 2 + t.fadeWidth,
          t.emptyActionWidth,
          t.control,
        ),
        () =>
          state.status === "invalid"
            ? setQuery({
                invalid: false,
                kind: "works",
                path: "/@all/pixiv",
                platform: "pixiv",
                q: "",
                tag: "",
                page: 1,
              })
            : state.status === "error"
              ? load()
              : setQuery({
                  q: "",
                  tag: "",
                  mediaType: "all",
                  sort: "date_desc",
                  invalidFilter: false,
                  page: 1,
                }),
        { secondary: true },
      );
  }
  if (state.status === "populated") drawFan();
  const back = p.snapshot();
  state.uiFrame?.delete();
  state.uiFrame = null;
  const uiFrame = p.layer(() => {
    if (state.status === "populated" || state.showPrevious)
      for (const tile of tiles.values()) drawTile(tile, "ui");
    drawShell(back);
    drawPageHeader();
    drawPager(back);
    if (state.newCount && state.status === "populated" && !viewer?.opened) {
      const label =
          state.newCount > 0
            ? "有 " + state.newCount + " 个新作品 · 刷新"
            : "内容已更新 · 刷新",
        width = p.shape(label, t.font).width + t.fadeWidth,
        x = (p.w + (narrow() ? 0 : state.sidebar.x) - width) / 2;
      p.glass(
        b(x, t.backgroundPickerExtent, width, t.control),
        t.controlRadius,
        back,
      );
      control(
        "new-content",
        label,
        b(x, t.backgroundPickerExtent, width, t.control),
        () => {
          state.newCount = 0;
          load();
        },
        { drawText: true },
      );
    }
    if (state.panelAlpha.x > 0) {
      drawPanel(back);
    }
    drawDrawer(back);
  });
  p.composite(uiFrame);
  if (state.oldUI) p.composite(state.oldUI, 1 - state.themeFade.x);
  state.uiFrame?.delete();
  state.uiFrame =
    state.oldUI && state.themeFade.x < 1
      ? p.layer(() => {
          p.composite(uiFrame);
          p.composite(state.oldUI, 1 - state.themeFade.x);
        })
      : uiFrame;
  if (state.uiFrame !== uiFrame) uiFrame.delete();
  if (state.themeFade.x === 1 && state.oldUI) {
    state.oldUI.delete();
    state.oldUI = null;
  }
  for (const id of ["search-bridge", "size-bridge"]) {
    const el = $(id),
      rect = id === "search-bridge" ? state.searchBox : state.sliderBox,
      box = state.panelBox;
    const covered =
      state.panelAlpha.x > 0 && box && rect && intersects(rect, box);
    style(el, {
      visibility:
        covered ||
        state.drawer ||
        (viewer?.opened && !viewer.split) ||
        (narrow() && (id === "size-bridge" || !state.mobileSearch))
          ? "hidden"
          : "visible",
    });
    property(
      el,
      "inert",
      !!state.panel || !!state.drawer || !!(viewer?.opened && !viewer.split),
    );
  }
  if (state.reducedFrame) {
    p.image(state.reducedFrame, b(0, 0, p.w, p.h), 1 - state.reducedFade.x);
    if (state.reducedFade.x === 1) {
      state.reducedFrame.delete();
      state.reducedFrame = null;
    }
  }
  p.end();
  viewer?.draw();
  property(
    $("semantics"),
    "inert",
    !!state.panel || !!(viewer?.opened && !viewer.split),
  );
  property($("works"), "inert", state.status === "loading");
  if (state.metrics) {
    state.metrics.cpu.push(performance.now() - now);
    if (state.metrics.last)
      state.metrics.intervals.push(time - state.metrics.last);
    state.metrics.last = time;
  }
  for (const c of controls.values()) {
    property(
      c.el,
      "hidden",
      !!(!c.seen || (c.el.closest("#popup") && !state.panel)),
    );
    property(
      c.el,
      "inert",
      !!(state.drawer && !state.drawerControls?.has(c.el.dataset.control)),
    );
    property(
      c.el,
      "tabIndex",
      !c.el.hidden && c.tabStop && !c.el.inert ? 0 : -1,
    );
  }
  if (pendingFocus && controls.get(pendingFocus)?.seen) {
    controls.get(pendingFocus).el.focus();
    pendingFocus = null;
  }
  const moving =
    state.reducedFrame ||
    state.toolbarScroll?.active ||
    state.scroll.active ||
    state.gridWidth.active ||
    viewer?.active ||
    state.drawerProgress.active ||
    state.sidebar.active ||
    state.band.active ||
    state.panelScale.active ||
    state.themeFade.time < state.themeFade.duration ||
    state.panelAlpha.time < state.panelAlpha.duration ||
    state.backgroundFade.time < state.backgroundFade.duration ||
    [...tiles.values()].some(
      (x) =>
        Object.values(x.box).some((s) => s.active) ||
        x.scale.active ||
        x.appear.time < x.appear.duration ||
        x.enterAt ||
        x.marquee.active ||
        x.authorMarquee.active ||
        x.title.active ||
        x.author.active ||
        x.fan?.amount.active ||
        x.fan?.springs.some((s) => s.active) ||
        (!reduced() &&
          state.hover?.includes(x.work.key) &&
          (x.title.current.shape.width > x.box.w.x ||
            x.author.current.shape.width > x.box.w.x)),
    ) ||
    [...controls.values()].some(
      (x) =>
        x.hover.time < x.hover.duration ||
        x.press.time < x.press.duration ||
        x.selected.time < x.selected.duration ||
        x.knob.active,
    );
  if (state.panelAlpha.x === 0) state.closingPanel = null;
  if (moving || state.status === "loading" || state.metrics) request();
  running = false;
}
document.addEventListener(
  "pointerdown",
  (event) => {
    state.keyboard = false;
    state.idleAt = performance.now();
    if (state.panel && !event.target.closest("#popup")) panel(null);
    if (state.drawer && event.clientX > 240) {
      state.drawer = false;
      state.drawerProgress.to(0);
      event.preventDefault();
      document.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
        },
        { once: true, capture: true },
      );
      request();
    }
    request();
  },
  true,
);
document.addEventListener(
  "keydown",
  (event) => {
    if (
      [
        "Tab",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(event.key)
    )
      state.keyboard = true;
    state.idleAt = performance.now();
    if (viewer?.opened && (!viewer.split || event.target.closest("#viewer"))) {
      viewer.key(event);
      if (event.defaultPrevented) {
        request();
        return;
      }
    }
    if (event.key === "/" && !state.panel && event.target.tagName !== "INPUT") {
      event.preventDefault();
      $("search").focus();
    }
    if (event.key === "Escape" && state.panel)
      panel(state.panel === "background" ? "settings" : null);
    if (event.key === "Tab" && state.panel) {
      const items = [
          ...$("popup").querySelectorAll(
            "button:not([hidden]):not([disabled]),input",
          ),
        ],
        i = items.indexOf(document.activeElement);
      if (
        (!event.shiftKey && i === items.length - 1) ||
        (event.shiftKey && i === 0)
      ) {
        event.preventDefault();
        items[event.shiftKey ? items.length - 1 : 0].focus();
      }
    }
    request();
  },
  true,
);
dragScroll(document, {
  area: () => (state.panel === "settings" ? state.panelBox : null),
  read: () => state.panelScroll || 0,
  write: (value) => {
    state.panelScroll = clamp(value, 0, state.panelMax || 0);
    request();
  },
});
dragScroll(document, {
  area: () =>
    state.panel === "tags" && state.panelBox
      ? {
          ...state.panelBox,
          y: state.panelBox.y + 80,
          h: state.panelBox.h - 80,
        }
      : null,
  read: () => (state.tagScroll || 0) * 34,
  write: (value) => {
    state.tagScroll = clamp(
      Math.round(value / 34),
      0,
      Math.max(0, state.tagOptions.length - 8),
    );
    request();
  },
});
dragScroll(document, {
  area: () =>
    narrow() && !state.panel && !viewer?.opened ? b(0, 50, p.w, 42) : null,
  horizontal: true,
  read: () => state.toolbarScroll?.target || 0,
  write: (value) => {
    state.toolbarScroll?.to(clamp(value, 0, state.toolbarMax || 0));
    request();
  },
});
window.addEventListener(
  "wheel",
  (event) => {
    if (
      event.defaultPrevented ||
      event.target.closest("#viewer") ||
      event.target.tagName === "INPUT"
    )
      return;
    if (state.panel === "settings" && state.panelMax) {
      event.preventDefault();
      state.panelScroll = clamp(
        (state.panelScroll || 0) + event.deltaY,
        0,
        state.panelMax,
      );
      request();
      return;
    }
    if (state.panel === "tags") {
      event.preventDefault();
      state.tagScroll = clamp(
        (state.tagScroll || 0) + Math.sign(event.deltaY),
        0,
        Math.max(0, state.tagOptions.length - 8),
      );
      request();
      return;
    }
    if (state.panel) return;
    event.preventDefault();
    if (narrow() && event.clientY < 92) {
      state.toolbarScroll.to(
        clamp(
          state.toolbarScroll.target + event.deltaY + event.deltaX,
          0,
          state.toolbarMax,
        ),
      );
      request();
      return;
    }
    const max = Math.max(
      0,
      ...[...tiles.values()].map(
        (x) => x.box.y.target + x.box.h.target + 60 - p.h,
      ),
    );
    state.scroll.to(clamp(state.scroll.target + event.deltaY, 0, max));
    request();
  },
  { passive: false },
);
$("size").value = state.prefs.size;
$("size").oninput = (event) => setSize(Number(event.target.value));
$("search").value = state.query.q;
$("search").onkeydown = (event) => {
  if (event.key === "Enter" && !event.isComposing)
    setQuery({ q: event.target.value, page: 1 });
};
let routeHash = location.hash;
let routeSerial = 0;
async function restoreViewer() {
  const path = new URLSearchParams(location.hash.split("?")[1] || "").get(
    "view",
  );
  if (!path) {
    if (viewer?.opened) viewer.close(false);
    return;
  }
  if (viewer?.opened && viewer.work?.stableId === path) return;
  try {
    const found =
      state.result?.items.find((w) => w.stableId === path) ||
      normalizeWork(
        (
          await (
            await import("../platform/api.js")
          ).request("resolve", { path })
        ).item,
      );
    if (
      path ===
      new URLSearchParams(location.hash.split("?")[1] || "").get("view")
    )
      await viewer.open(found, 0, false, false);
  } catch {
    if (viewer?.opened) viewer.close(false);
    state.status = "invalid";
    request();
  }
}
const routeChanged = async () => {
  if (routeHash === location.hash) return;
  const token = ++routeSerial,
    next = locationState(location),
    changed = hashFor(next) !== hashFor(state.query);
  routeHash = location.hash;
  if (changed) {
    state.query = next;
    $("search").value = state.query.q;
    await load({ restore: history.state });
  } else if (!location.hash.includes("view=") && history.state?.anchor) {
    const scroll = restoredScroll(
      history.state.anchor,
      tiles,
      history.state.scroll || 0,
    );
    state.scroll.to(scroll);
  }
  if (token === routeSerial) await restoreViewer();
};
window.addEventListener("popstate", routeChanged);
window.addEventListener("hashchange", routeChanged);
window.addEventListener("resize", () => {
  const anchor = viewportAnchor(tiles, state.scroll.target, contentTop());
  p.resize();
  if (p.w < 1280 || matchMedia("(pointer:coarse)").matches) {
    state.splitArmed = false;
    if (viewer?.split) {
      viewer.split = false;
      viewer.full.to(1);
      viewer.root.setAttribute("aria-modal", "true");
    }
    state.gridWidth.to(p.w);
  } else state.gridWidth.to(viewer?.opened && viewer.split ? p.w / 2 : p.w);
  layout();
  state.scroll.to(restoredScroll(anchor, tiles));
  request();
});
systemTheme.addEventListener("change", () => {
  if (state.themeMode === "system") setTheme("system");
});
systemReduced.addEventListener("change", request);
window.addEventListener("gallery-content-changed", (event) => {
  state.newCount = Number(event.detail?.count) || -1;
  state.idleAt = performance.now();
  request();
});
window.addEventListener("gallery-generation-changed", () => {
  state.newCount ||= -1;
  state.idleAt = performance.now();
  request();
});
async function boot() {
  CK = await CanvasKitInit({
    locateFile: (file) => "/frontend/assets/canvas/vendor/" + file,
  });
  const provider = CK.TypefaceFontProvider.Make();
  const loadedFonts = await loadCanvasMiSans(CK, provider, () => {
    if (!p) return;
    for (const paint of [p, viewer?.p].filter(Boolean)) paint.texts.clear();
    layout();
    request();
  });
  fonts = loadedFonts.faces;
  p = new Paint(CK, cv, fonts, provider);
  p.ensureFonts = loadedFonts.ensure;
  let emojiRequest = null;
  p.ensureEmoji = (text) => {
    if (!hasEmoji(text) || fonts.emoji || emojiRequest) return;
    emojiRequest = (async () => {
      const response = await fetch(
        "/frontend/assets/canvas/fonts/noto-color-emoji.ttf",
      );
      if (!response.ok) throw Error("表情字体无法读取");
      const bytes = await response.arrayBuffer();
      const face = CK.Typeface.MakeFreeTypeFaceFromData(bytes);
      if (!face) throw Error("表情字体无法显示");
      fonts.emoji = face;
      provider.registerFont(bytes, "emoji");
      p.texts.clear();
      layout();
      request();
    })().catch((error) => {
      state.emojiError = error.message;
      $("live").textContent = error.message;
      request();
    });
  };
  viewer = new Viewer(CK, fonts, provider, {
    state,
    request,
    ensureEmoji: p.ensureEmoji,
    ensureFonts: p.ensureFonts,
    card: (key) => {
      const tile = tiles.get(key);
      if (!tile) return null;
      const r = readBounds(tile.box);
      return {
        ...r,
        y: r.y - state.scroll.x,
        w: state.prefs.size === 0 ? 64 : r.w,
        h: state.prefs.size === 0 ? 64 : r.h,
      };
    },
    fanOrigin: (work) => {
      const tile = tiles.get(work.key || work.stableId);
      if (!tile?.fan) return null;
      const r = readBounds(tile.box),
        s = tile.fan.springs[0].x;
      return {
        x: r.x - r.w * 0.19 * s + r.w * 0.1 * s,
        y: r.y - state.scroll.x - r.h * 0.1 * s + r.h * 0.1 * s,
        w: r.w * (1 - 0.2 * s),
        h: r.h * (1 - 0.2 * s),
      };
    },
    selected: (work, split) => {
      state.selectedWork = work;
      state.gridWidth.to(split ? p.w / 2 : p.w);
      layout();
      request();
    },
    neighbors: async (work) => {
      if (!["works", "author"].includes(state.query.kind))
        return { before: [], after: [] };
      const i = state.result.items.findIndex(
        (v) => v.key === work.key || v.stableId === work.stableId,
      );
      let before = state.result.items.slice(Math.max(0, i - 2), i),
        after = state.result.items.slice(i + 1, i + 3);
      if (before.length < 2 && state.query.page > 1)
        before = [
          ...(
            await rows(
              { ...state.query, page: state.query.page - 1 },
              state.prefs,
            )
          ).items.slice(-(2 - before.length)),
          ...before,
        ];
      if (after.length < 2 && state.query.page < state.result.totalPages)
        after = [
          ...after,
          ...(
            await rows(
              { ...state.query, page: state.query.page + 1 },
              state.prefs,
            )
          ).items.slice(0, 2 - after.length),
        ];
      return { before, after };
    },
    adjacent: async (work, direction) => {
      const i = state.result.items.findIndex(
          (v) => v.stableId === work.stableId,
        ),
        n = state.result.items[i + direction];
      if (n) return n;
      const next = state.query.page + direction;
      if (next < 1 || next > state.result.totalPages) return null;
      state.query.page = next;
      await load();
      return direction > 0 ? state.result.items[0] : state.result.items.at(-1);
    },
    align: async (work) => {
      if (!state.result.items.some((v) => v.stableId === work.stableId)) {
        for (const page of [state.query.page - 1, state.query.page + 1].filter(
          (v) => v > 0 && v <= state.result.totalPages,
        )) {
          const result = await rows({ ...state.query, page }, state.prefs);
          if (result.items.some((v) => v.stableId === work.stableId)) {
            state.query.page = page;
            await load();
            break;
          }
        }
      }
      const tile = tiles.get(work.key || work.stableId);
      if (tile) state.scroll.to(Math.max(0, tile.box.y.target - 104));
      request();
    },
    historyOpen: (work) => {
      history.replaceState(
        {
          ...history.state,
          anchor: viewportAnchor(tiles, state.scroll.target, contentTop()),
          scroll: state.scroll.target,
        },
        "",
        location.href,
      );
      const url = new URL(location.href);
      url.hash =
        hashFor(state.query) + "&view=" + encodeURIComponent(work.stableId);
      history.pushState({ viewer: true }, "", url);
      routeHash = location.hash;
    },
    historyReplace: (work) => {
      history.replaceState(
        { viewer: true },
        "",
        hashFor(state.query) + "&view=" + encodeURIComponent(work.stableId),
      );
      routeHash = location.hash;
    },
    historyClose: () => {
      if (history.state?.viewer) history.back();
      else {
        history.replaceState({}, "", hashFor(state.query));
        routeHash = location.hash;
      }
    },
    author: openAuthor,
    pages: (work) => setQuery({ kind: "pages", path: work.stableId, page: 1 }),
    tag: (tag) => setQuery({ kind: "works", tag, page: 1 }),
    background: setBackground,
  });
  state.sources = await sources();
  if (
    innerWidth >= 700 &&
    innerWidth < 1280 &&
    localStorage.getItem("gallery_canvas_sidebar") === null
  ) {
    state.sidebar.x = state.sidebar.target = 50;
    state.sidebarText.x = state.sidebarText.target = 0;
  }
  const streamUpdates = createStreamUpdates();
  ScanWS.onState((status, detail) => {
    state.connection = status;
    state.retryIn = detail.retryIn;
    request();
  });
  ScanWS.onStatus((status) => {
    const { changed, added } = streamUpdates.receive(
      status,
      state.query.platform,
    );
    if (changed && state.query.kind !== "files") {
      state.newCount =
        added > 0 ? Math.max(0, state.newCount) + added : state.newCount || -1;
      state.idleAt = performance.now();
      request();
    }
  });
  ScanWS.connect();
  state.updatedAt = state.sources.updatedAt;
  $("boot").remove();
  $("popup").setAttribute("role", "dialog");
  $("popup").setAttribute("aria-modal", "true");
  if (state.backgroundSelection)
    backgroundMedia(state.backgroundSelection)
      .then((url) => {
        state.prefs.background = url;
        return texture(url);
      })
      .catch((error) => {
        state.backgroundError = error.message;
        request();
      });
  if (
    !state.sources.platforms.some((x) => x.id === state.query.platform) &&
    state.query.kind !== "files"
  )
    state.query.invalid = true;
  await load();
  await restoreViewer();
  window.__galleryCanvas = {
    measure: async (action, ms = 3300) => {
      const metrics = { cpu: [], intervals: [], last: 0 };
      state.metrics = metrics;
      action();
      request();
      await new Promise((r) => setTimeout(r, ms));
      state.metrics = null;
      return metrics;
    },
    state,
    viewer,
    paint: p,
    tiles,
    controls,
    request,
    setBackground,
    setSize,
    load,
    setQuery,
    setTheme,
    panel,
    ready: true,
    notify: (count) => {
      state.newCount = count;
      state.idleAt = performance.now();
      request();
    },
    status: (value) => {
      state.status = value;
      state.reason = "服务没有响应";
      request();
    },
    debug: () => ({
      status: state.status,
      rows: state.result?.items.length,
      theme: state.theme,
      keyboard: state.keyboard,
      panel: state.panel,
      query: state.query,
    }),
  };
}
boot().catch((error) => {
  const boot = $("boot");
  boot.replaceChildren();
  const message = document.createElement("p");
  message.textContent = "加载失败：" + error.message;
  const retry = document.createElement("button");
  retry.textContent = "重试";
  retry.onclick = () => location.reload();
  boot.append(message, retry);
});
