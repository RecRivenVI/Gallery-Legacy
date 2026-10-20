import { t } from "./tokens.js";
export class Spring {
  constructor(value, omega = t.omega) {
    this.x = value;
    this.v = 0;
    this.target = value;
    this.omega = omega;
  }
  to(target) {
    if (!Number.isFinite(target)) throw new TypeError("finite target required");
    this.target = target;
  }
  tick(dt, reduced = false) {
    if (!this.active) return false;
    if (reduced) {
      this.x = this.target;
      this.v = 0;
      return false;
    }
    const y = this.x - this.target,
      a = this.v + this.omega * y,
      e = Math.exp(-this.omega * dt);
    this.x = this.target + (y + a * dt) * e;
    this.v = (this.v - this.omega * a * dt) * e;
    if (Math.abs(this.x - this.target) < 0.0005 && Math.abs(this.v) < 0.0005) {
      this.x = this.target;
      this.v = 0;
      return false;
    }
    return true;
  }
  get active() {
    return this.x !== this.target || this.v !== 0;
  }
}
export class Fade {
  constructor(value = 0, duration = t.fade) {
    this.x = value;
    this.from = value;
    this.target = value;
    this.time = duration;
    this.duration = duration;
  }
  to(value) {
    if (this.target === value) return;
    this.from = this.x;
    this.target = value;
    this.time = 0;
  }
  tick(dt) {
    if (this.time >= this.duration) return false;
    this.time = Math.min(this.duration, this.time + dt);
    const t = this.time / this.duration;
    this.x = this.from + (this.target - this.from) * (1 - (1 - t) ** 3);
    return this.time < this.duration;
  }
}
// Position and velocity belong to each shaped glyph, rather than the enclosing
// title box. Changed strings cross-fade; surviving strings keep their springs.
export class SharedText {
  constructor() {
    this.current = null;
    this.previous = null;
    this.alpha = new Fade(1);
    this.outgoing = [];
  }
  to(text, shape, x, y) {
    const points = shape.runs.flatMap((run) =>
      Array.from(run.glyphs, (id, j) => ({
        id,
        family: run.family,
        x: x + run.positions[j * 2],
        y: y + run.positions[j * 2 + 1],
      })),
    );
    if (this.current?.text !== text || this.current?.shape !== shape) {
      const old = this.current?.glyphs || [],
        first = !this.current;
      const glyphs = points.map((point, i) => {
        const prev = old[i];
        if (prev?.id === point.id && prev.family === point.family) return prev;
        if (prev) {
          prev.opacity.to(0);
          this.outgoing.push(prev);
        }
        const g = {
          id: point.id,
          family: point.family,
          x: new Spring(prev?.x.x ?? point.x),
          y: new Spring(prev?.y.x ?? point.y),
          size: new Spring(shape.size || t.font),
          opacity: new Fade(first ? 1 : 0),
        };
        if (prev) {
          g.x.v = prev.x.v;
          g.y.v = prev.y.v;
        }
        g.opacity.to(1);
        return g;
      });
      for (const prev of old.slice(points.length)) {
        prev.opacity.to(0);
        this.outgoing.push(prev);
      }
      this.current = { text, shape, glyphs };
    }
    for (let i = 0; i < points.length; i++) {
      this.current.glyphs[i].x.to(points[i].x);
      this.current.glyphs[i].y.to(points[i].y);
      this.current.glyphs[i].size?.to(shape.size || t.font);
    }
  }
  tick(dt, reduced = false) {
    for (const group of [this.current?.glyphs || [], this.outgoing])
      for (const g of group) {
        g.x.tick(dt, reduced);
        g.y.tick(dt, reduced);
        g.size?.tick(dt, reduced);
        g.opacity.tick(dt);
      }
    if (this.outgoing.length)
      this.outgoing = this.outgoing.filter((g) => g.opacity.x > 0);
  }
  snap() {
    for (const g of [...(this.current?.glyphs || []), ...this.outgoing]) {
      g.x.x = g.x.target;
      g.y.x = g.y.target;
      g.x.v = g.y.v = 0;
      if (g.size) {
        g.size.x = g.size.target;
        g.size.v = 0;
      }
    }
  }
  get active() {
    return (
      this.outgoing.length > 0 ||
      this.current?.glyphs.some(
        (g) =>
          g.x.active ||
          g.y.active ||
          g.size?.active ||
          g.opacity.time < g.opacity.duration,
      )
    );
  }
}
export const bounds = (x, y, w, h, r = 6) => ({
  x: new Spring(x),
  y: new Spring(y),
  w: new Spring(w),
  h: new Spring(h),
  r: new Spring(r),
});
export function targetBounds(s, b) {
  for (const k of ["x", "y", "w", "h", "r"])
    if (b[k] !== undefined) s[k].to(b[k]);
}
export function tickBounds(s, dt, reduced) {
  for (const v of Object.values(s)) v.tick(dt, reduced);
}
export const readBounds = (s) =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.x]));
export function grid(width, sidebar, size, count, top = 104) {
  const left = sidebar + 8,
    available = width - left - 8,
    cols = Math.max(1, Math.floor((available + 8) / (size + 8))),
    w = (available - (cols - 1) * 8) / cols;
  return Array.from({ length: count }, (_, i) => ({
    x: left + (i % cols) * (w + 8),
    y: top + Math.floor(i / cols) * (w + 16 + 44),
    w,
    h: w,
    cols,
  }));
}
export function fitImage(iw, ih, area) {
  const scale = Math.min(area.w / iw, area.h / ih);
  return {
    cx: area.x + area.w / 2,
    cy: area.y + area.h / 2,
    scale,
    w: iw * scale,
    h: ih * scale,
  };
}
export function virtualBand(offset, width, count = 1080, step = 40) {
  const start = Math.max(0, Math.floor(offset / step) - 2),
    end = Math.min(count, start + Math.ceil(width / step) + 5);
  return Array.from({ length: end - start }, (_, i) => ({
    page: start + i + 1,
    x: (start + i) * step - offset,
  }));
}
export function cubic(a, b, c, d, t) {
  const u = 1 - t;
  return [
    u ** 3 * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t ** 3 * d[0],
    u ** 3 * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t ** 3 * d[1],
  ];
}
// Two C2 cubics per corner. Endpoint curvature is zero, so joins to straight
// edges are G2. L=1.5r is the design's corner length, not a circular arc.
export function cornerCurves(l) {
  return [
    [
      [0, l],
      [0, (2 * l) / 3],
      [0, l / 3],
      [l / 6, l / 6],
    ],
    [
      [l / 6, l / 6],
      [l / 3, 0],
      [(2 * l) / 3, 0],
      [l, 0],
    ],
  ];
}
export function offsetCorner(l, d, samples = 48) {
  return cornerCurves(l).flatMap((curve, n) =>
    Array.from({ length: samples + 1 }, (_, i) => {
      if (n && i === 0) return null;
      const t = i / samples,
        p = cubic(...curve, t),
        u = 1 - t;
      const dx =
        3 * u * u * (curve[1][0] - curve[0][0]) +
        6 * u * t * (curve[2][0] - curve[1][0]) +
        3 * t * t * (curve[3][0] - curve[2][0]);
      const dy =
        3 * u * u * (curve[1][1] - curve[0][1]) +
        6 * u * t * (curve[2][1] - curve[1][1]) +
        3 * t * t * (curve[3][1] - curve[2][1]);
      const mag = Math.hypot(dx, dy);
      return [p[0] + (dy / mag) * d, p[1] - (dx / mag) * d];
    }).filter(Boolean),
  );
}
