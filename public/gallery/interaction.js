// Product presentation rules. No source identity or filesystem order changes.
export const aspectRatios = {
  square: ["1:1", 1],
  landscape: ["4:3", 4 / 3],
  portrait: ["3:4", 3 / 4],
  wide: ["16:9", 16 / 9],
  tall: ["9:16", 9 / 16],
};
export function cardColumns(width, size, touch = false, portrait = false) {
  if (!size) return 1;
  const target = touch
    ? [0, 110, 145, 185, 250, 360][size]
    : [0, 140, 180, 220, 280, 360][size];
  return Math.max(
    1,
    Math.min(
      touch && portrait ? 4 : Infinity,
      Math.floor((width + 8) / (target + 8)),
    ),
  );
}
export function boundedPan(iw, ih, area, zoom, pan) {
  const fit = Math.min(area.w / iw, area.h / ih) * zoom;
  const limitX = Math.max(0, (iw * fit - area.w) / 2),
    limitY = Math.max(0, (ih * fit - area.h) / 2);
  return {
    x: Math.max(-limitX, Math.min(limitX, pan.x)) || 0,
    y: Math.max(-limitY, Math.min(limitY, pan.y)) || 0,
  };
}
export function anchoredPan(area, from, to, pan, anchor) {
  const ratio = to / from;
  return {
    x: (anchor.x - area.x - area.w / 2) * (1 - ratio) + pan.x * ratio,
    y: (anchor.y - area.y - area.h / 2) * (1 - ratio) + pan.y * ratio,
  };
}
export function viewportAnchor(tiles, scroll, top = 104) {
  const rows = [...tiles.values()].filter((x) => !x.leaving);
  const tile = rows.find((x) => x.box.y.target + x.box.h.target > scroll + top);
  return tile
    ? { key: tile.work.key, offset: tile.box.y.target - scroll }
    : null;
}
export function restoredScroll(anchor, tiles, fallback = 0) {
  const tile = anchor && tiles.get(anchor.key);
  return Math.max(0, tile ? tile.box.y.target - anchor.offset : fallback);
}
export function dragScroll(target, options) {
  let drag = null;
  target.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || e.target.closest("input,textarea,video"))
      return;
    const r = options.area();
    if (
      !r ||
      e.clientX < r.x ||
      e.clientX > r.x + r.w ||
      e.clientY < r.y ||
      e.clientY > r.y + r.h
    )
      return;
    drag = {
      id: e.pointerId,
      point: options.horizontal ? e.clientX : e.clientY,
      value: options.read(),
      moved: false,
    };
  });
  target.addEventListener(
    "pointermove",
    (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const delta = (options.horizontal ? e.clientX : e.clientY) - drag.point;
      if (Math.abs(delta) < 8 && !drag.moved) return;
      drag.moved = true;
      e.preventDefault();
      options.write(drag.value - delta);
    },
    { passive: false },
  );
  target.addEventListener("pointerup", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    if (drag.moved)
      target.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
        },
        { capture: true, once: true },
      );
    drag = null;
  });
  target.addEventListener("pointercancel", () => {
    drag = null;
  });
}
export function subtitleCandidates(media) {
  if (!media?.url || (media.type !== "video" && media.kind !== "video"))
    return [];
  const base = media.url
    .replace(/\/media\//, "/subtitles/")
    .replace(/\/file-media\?/, "/file-subtitles?");
  if (base === media.url) return [];
  return [
    ["zh-CN", "中文"],
    ["en-US", "English"],
  ].map(([language, label]) => ({
    language,
    label,
    url: base + (base.includes("?") ? "&" : "?") + "lang=" + language,
  }));
}
