import { t } from "./tokens.js";
import { fluentIcons } from "../platform/fluent-icons.js";
import { scriptFamily } from "../platform/fonts.js";
import { cornerCurves, offsetCorner } from "./motion.js";
export const hasEmoji = (text) =>
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(text);
export class Paint {
  constructor(ck, canvas, faces, provider) {
    this.ck = ck;
    this.el = canvas;
    this.faces = faces;
    this.provider = provider;
    this.fonts = new Map();
    this.texts = new Map();
    this.paths = new Map();
    this.images = new Map();
    this.blurs = new Map();
    this.p = new ck.Paint();
    this.p.setAntiAlias(true);
    this.line = new ck.Paint();
    this.line.setAntiAlias(true);
    this.line.setStyle(ck.PaintStyle.Stroke);
    this.line.setStrokeCap(ck.StrokeCap.Round);
    this.imgPaint = new ck.Paint();
    this.imgPaint.setAntiAlias(true);
    this.mask = new ck.Paint();
    this.gl = ck.MakeWebGLContext(
      ck.GetWebGLContext(canvas, {
        majorVersion: 2,
        alpha: !!canvas.dataset.overlay,
      }),
    );
    if (!this.gl) throw Error("无法使用图形加速");
    this.resize();
    const s = t.saturation,
      r = 0.2126 * (1 - s),
      g = 0.7152 * (1 - s),
      b = 0.0722 * (1 - s);
    this.saturation = ck.ColorFilter.MakeMatrix([
      r + s,
      g,
      b,
      0,
      0,
      r,
      g + s,
      b,
      0,
      0,
      r,
      g,
      b + s,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
    ]);
    this.blur = ck.ImageFilter.MakeBlur(
      t.blur,
      t.blur,
      ck.TileMode.Clamp,
      null,
    );
  }
  resize() {
    for (const surface of this.layers || []) surface.delete();
    this.layers = [];
    this.w = innerWidth;
    this.h = innerHeight;
    this.dpr = devicePixelRatio;
    this.surface?.delete();
    this.screen?.delete();
    this.el.width = Math.round(this.w * this.dpr);
    this.el.height = Math.round(this.h * this.dpr);
    this.screen = this.ck.MakeOnScreenGLSurface(
      this.gl,
      this.el.width,
      this.el.height,
      this.ck.ColorSpace.SRGB,
    );
    this.surface = this.ck.MakeRenderTarget(
      this.gl,
      this.el.width,
      this.el.height,
    );
    if (!this.surface || !this.screen) throw Error("无法打开绘图区域");
    this.c = this.surface.getCanvas();
  }
  color(v, a = 1) {
    if (v instanceof Float32Array) {
      if (a === 1) return v;
      const c = new Float32Array(v);
      c[3] *= a;
      return c;
    }
    if (Array.isArray(v))
      return this.ck.Color(v[0], v[1], v[2], (v[3] ?? 1) * a);
    return this.ck.Color(
      parseInt(v.slice(1, 3), 16),
      parseInt(v.slice(3, 5), 16),
      parseInt(v.slice(5, 7), 16),
      a,
    );
  }
  fill(v, a = 1) {
    this.p.setColor(this.color(v, a));
    this.p.setBlendMode(this.ck.BlendMode.SrcOver);
    return this.p;
  }
  begin(colors) {
    this.colors = colors;
    this.surface
      .getCanvas()
      .clear(
        this.el.dataset.overlay ? this.ck.TRANSPARENT : this.color(colors.bg),
      );
    this.c.save();
    this.c.scale(this.dpr, this.dpr);
    this.temps = [];
    this.layerCursor = 0;
    this.blurInput = null;
    this.blurResult = null;
  }
  end() {
    this.c.restore();
    this.surface.flush();
    const image = this.surface.makeImageSnapshot(),
      c = this.screen.getCanvas(),
      paint = new this.ck.Paint();
    c.clear(this.ck.TRANSPARENT);
    c.drawImage(image, 0, 0, paint);
    this.screen.flush();
    this.presentations = (this.presentations || 0) + 1;
    paint.delete();
    image.delete();
    for (const x of this.temps) x.delete();
  }
  // UI is a separate transparent layer: theme transitions never recolour media.
  layer(draw) {
    const index = this.layerCursor++,
      surface = (this.layers[index] ||= this.ck.MakeRenderTarget(
        this.gl,
        this.el.width,
        this.el.height,
      )),
      previous = this.c;
    this.c = surface.getCanvas();
    this.c.clear(this.ck.TRANSPARENT);
    this.c.save();
    this.c.scale(this.dpr, this.dpr);
    try {
      draw();
    } finally {
      this.c.restore();
      this.c = previous;
    }
    surface.flush();
    const image = surface.makeImageSnapshot();
    return image;
  }
  composite(image, alpha = 1) {
    if (!image) return;
    this.imgPaint.setAlphaf(alpha);
    this.c.drawImageRect(
      image,
      this.ck.XYWHRect(0, 0, image.width(), image.height()),
      this.ck.XYWHRect(0, 0, this.w, this.h),
      this.imgPaint,
    );
  }
  imageMorph(img, box, crop, radius = 0, alpha = 1) {
    this.c.save();
    this.c.translate(box.x, box.y);
    this.c.clipPath(
      this.path(box.w, box.h, radius),
      this.ck.ClipOp.Intersect,
      true,
    );
    this.c.translate(-box.x, -box.y);
    this.imgPaint.setAlphaf(alpha);
    this.c.drawImageRect(
      img,
      this.ck.XYWHRect(crop.x, crop.y, crop.w, crop.h),
      this.ck.XYWHRect(box.x, box.y, box.w, box.h),
      this.imgPaint,
    );
    this.c.restore();
  }
  path(w, h, r) {
    const key = [w.toFixed(1), h.toFixed(1), r.toFixed(1)].join(":");
    if (this.paths.has(key)) return this.paths.get(key);
    const p = new this.ck.PathBuilder(),
      l = Math.min(r * 1.5, w / 2, h / 2),
      tr = [
        ([x, y]) => [w - y, x],
        ([x, y]) => [w - x, h - y],
        ([x, y]) => [y, h - x],
        ([x, y]) => [x, y],
      ];
    p.moveTo(l, 0);
    p.lineTo(w - l, 0);
    for (let k = 0; k < 4; k++) {
      for (const curve of cornerCurves(l)) {
        const a = tr[k](curve[1]),
          b = tr[k](curve[2]),
          d = tr[k](curve[3]);
        p.cubicTo(...a, ...b, ...d);
      }
      if (k === 0) p.lineTo(w, h - l);
      if (k === 1) p.lineTo(l, h);
      if (k === 2) p.lineTo(0, l);
    }
    p.close();
    const out = p.detachAndDelete();
    this.paths.set(key, out);
    if (this.paths.size > 1024) {
      const old = this.paths.keys().next().value;
      this.paths.get(old).delete();
      this.paths.delete(old);
    }
    return out;
  }
  rr(b, r, c, a = 1) {
    this.c.save();
    this.c.translate(b.x, b.y);
    this.c.drawPath(this.path(b.w, b.h, r), this.fill(c, a));
    this.c.restore();
  }
  rect(b, c, a = 1) {
    this.c.drawRect(this.ck.XYWHRect(b.x, b.y, b.w, b.h), this.fill(c, a));
  }
  outline(b, r, c, width = 1) {
    this.line.setColor(this.color(c));
    this.line.setStrokeWidth(width);
    this.c.save();
    this.c.translate(b.x, b.y);
    this.c.drawPath(this.path(b.w, b.h, r), this.line);
    this.c.restore();
  }
  group(b, c) {
    this.c.save();
    this.c.translate(b.x + t.groupPad, b.y + t.groupPad);
    this.line.setColor(this.color(c));
    this.line.setStrokeWidth(t.groupPad * 2);
    const p = this.path(
      b.w - 2 * t.groupPad,
      b.h - 2 * t.groupPad,
      t.innerRadius,
    );
    this.c.drawPath(p, this.line);
    this.c.drawPath(p, this.fill(c));
    this.c.restore();
  }
  focus(b, r) {
    const l = Math.min(r * 1.5, b.w / 2, b.h / 2),
      p = new this.ck.PathBuilder(),
      pts = offsetCorner(l, t.focusOffset),
      tr = [
        ([x, y]) => [b.x + b.w - y, b.y + x],
        ([x, y]) => [b.x + b.w - x, b.y + b.h - y],
        ([x, y]) => [b.x + y, b.y + b.h - x],
        ([x, y]) => [b.x + x, b.y + y],
      ];
    p.moveTo(b.x + l, b.y - t.focusOffset);
    p.lineTo(b.x + b.w - l, b.y - t.focusOffset);
    for (let k = 0; k < 4; k++) {
      for (const v of pts) p.lineTo(...tr[k](v));
      if (k === 0) p.lineTo(b.x + b.w + t.focusOffset, b.y + b.h - l);
      if (k === 1) p.lineTo(b.x + l, b.y + b.h + t.focusOffset);
      if (k === 2) p.lineTo(b.x - t.focusOffset, b.y + l);
    }
    p.close();
    const out = p.detachAndDelete();
    this.line.setColor(this.color(this.colors.fg));
    this.line.setStrokeWidth(t.focusWidth);
    this.c.drawPath(out, this.line);
    out.delete();
  }
  font(size, family = size <= t.subtitle ? "regular" : "ui") {
    const key = family + size.toFixed(2);
    if (!this.fonts.has(key)) {
      this.fonts.set(key, new this.ck.Font(this.faces[family], size));
      if (this.fonts.size > 256) {
        const old = this.fonts.keys().next().value;
        this.fonts.get(old).delete();
        this.fonts.delete(old);
      }
    }
    return this.fonts.get(key);
  }
  shape(str, size = 13, family = size <= t.subtitle ? "regular" : "ui") {
    const key = family + ":" + size + ":" + str;
    if (this.texts.has(key)) return this.texts.get(key);
    this.ensureFonts?.(str, family);
    const text = String(str),
      spans = [],
      utf8 = new TextEncoder();
    let offset = 0;
    for (const { segment } of new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(text)) {
      const preferred =
        hasEmoji(segment) && this.faces.emoji
          ? "emoji"
          : scriptFamily(segment) + "-" + family;
      let face = this.faces[preferred] ? preferred : family;
      // A supplementary ideograph falls back to MiSans L3, without guessing a glyph ID.
      if (
        !this.faces[face]?.getGlyphIDs(segment)?.some((id) => id > 0) &&
        this.faces["misansl3-" + family]
      )
        face = "misansl3-" + family;
      const length = utf8.encode(segment).length;
      const previous = spans.at(-1);
      if (previous?.family === face) {
        previous.text += segment;
        previous.end += length;
      } else
        spans.push({
          text: segment,
          family: face,
          offset,
          end: offset + length,
        });
      offset += length;
    }
    const build = this.ck.ParagraphBuilder.MakeFromFontProvider(
      new this.ck.ParagraphStyle({
        textDirection:
          /^[^\p{Letter}]*[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(text)
            ? this.ck.TextDirection.RTL
            : this.ck.TextDirection.LTR,
        textAlign: this.ck.TextAlign.Left,
        textStyle: new this.ck.TextStyle({
          fontFamilies: [family],
          fontSize: size,
          fontFeatures: [{ name: "tnum", value: 1 }],
        }),
        maxLines: 1,
      }),
      this.provider,
    );
    for (const span of spans) {
      build.pushStyle(
        new this.ck.TextStyle({ fontFamilies: [span.family], fontSize: size }),
      );
      build.addText(span.text);
      build.pop();
    }
    const p = build.build();
    p.layout(100000);
    const line = p.getShapedLines()[0],
      runs = [];
    for (const run of line?.runs || []) {
      let group = null;
      for (let i = 0; i < run.glyphs.length; i++) {
        const face =
          spans.find(
            (span) =>
              run.offsets[i] >= span.offset && run.offsets[i] < span.end,
          )?.family || family;
        if (group?.family !== face) {
          group = { family: face, glyphs: [], positions: [], offsets: [] };
          runs.push(group);
        }
        group.glyphs.push(run.glyphs[i]);
        group.positions.push(
          run.positions[i * 2],
          run.positions[i * 2 + 1] - line.baseline,
        );
        group.offsets.push(run.offsets[i]);
      }
    }
    for (const run of runs) {
      run.glyphs = new Uint16Array(run.glyphs);
      run.positions = new Float32Array(run.positions);
    }
    const out = { width: p.getMaxIntrinsicWidth(), size, runs };
    build.delete();
    p.delete();
    this.texts.set(key, out);
    if (this.texts.size > 4000)
      this.texts.delete(this.texts.keys().next().value);
    return out;
  }
  text(
    str,
    x,
    y,
    size = t.font,
    c = this.colors.fg,
    alpha = 1,
    family = size <= t.subtitle ? "regular" : "ui",
  ) {
    str = String(str);
    this.ensureEmoji?.(str);
    const s = this.shape(str, size, family);
    for (const run of s.runs)
      this.c.drawGlyphs(
        run.glyphs,
        run.positions,
        x,
        y,
        this.font(size, run.family || family),
        this.fill(c, alpha),
      );
    return s.width;
  }
  clipped(fn, b, radius = 0) {
    this.c.save();
    if (radius)
      this.c.clipRRect(
        this.ck.RRectXY(this.ck.XYWHRect(b.x, b.y, b.w, b.h), radius, radius),
        this.ck.ClipOp.Intersect,
        true,
      );
    else
      this.c.clipRect(
        this.ck.XYWHRect(b.x, b.y, b.w, b.h),
        this.ck.ClipOp.Intersect,
        true,
      );
    fn();
    this.c.restore();
  }
  fadeText(str, x, y, w, size, c, alpha = 1, family = "ui", offset = 0) {
    const s = this.shape(str, size, family),
      excess = Math.max(0, s.width - w);
    this.faded(
      () => this.text(str, x - offset, y, size, c, alpha, family),
      { x, y: y - size - 4, w, h: size + 8 },
      offset / 24,
      (excess - offset) / 24,
    );
  }
  // A destination-in mask needs an isolated layer only when an edge fades.
  faded(draw, area, left, right) {
    this.clipped(() => {
      const mask = left > 0 || right > 0;
      if (mask) this.c.saveLayer();
      draw();
      if (mask) {
        this.edges(area, left, right);
        this.c.restore();
      }
    }, area);
  }
  edges(b, left, right) {
    for (const [x, rev, a] of [
      [b.x, true, Math.max(0, left)],
      [b.x + b.w - 24, false, Math.max(0, right)],
    ]) {
      if (!a) continue;
      const faded = this.ck.Color(255, 255, 255, 1 - Math.min(1, a)),
        shader = this.ck.Shader.MakeLinearGradient(
          [x, 0],
          [x + 24, 0],
          rev ? [faded, this.ck.WHITE] : [this.ck.WHITE, faded],
          [0, 1],
          this.ck.TileMode.Clamp,
        );
      this.mask.setShader(shader);
      this.mask.setBlendMode(this.ck.BlendMode.DstIn);
      this.c.drawRect(this.ck.XYWHRect(x, b.y, 24, b.h), this.mask);
      shader.delete();
      this.mask.setShader(null);
    }
  }
  image(img, b, alpha = 1, mode = "cover") {
    const k = (mode === "cover" ? Math.max : Math.min)(
        b.w / img.width(),
        b.h / img.height(),
      ),
      w = img.width() * k,
      h = img.height() * k;
    this.imgPaint.setAlphaf(alpha);
    this.c.drawImageRect(
      img,
      this.ck.XYWHRect(0, 0, img.width(), img.height()),
      this.ck.XYWHRect(b.x + (b.w - w) / 2, b.y + (b.h - h) / 2, w, h),
      this.imgPaint,
    );
  }
  imageClip(img, b, r = 6, a = 1) {
    this.c.save();
    this.c.translate(b.x, b.y);
    this.c.clipPath(this.path(b.w, b.h, r), this.ck.ClipOp.Intersect, true);
    this.c.translate(-b.x, -b.y);
    this.image(img, b, a);
    this.c.restore();
  }
  bake(img, n = 96) {
    const s = this.surface.makeSurface({
        width: n,
        height: n,
        colorType: this.ck.ColorType.RGBA_8888,
        alphaType: this.ck.AlphaType.Premul,
        colorSpace: this.ck.ColorSpace.SRGB,
      }),
      p = new this.ck.Paint(),
      filter = this.ck.ImageFilter.MakeBlur(
        (t.blur * n) / 220,
        (t.blur * n) / 220,
        this.ck.TileMode.Clamp,
        null,
      ),
      k = Math.max(n / img.width(), n / img.height());
    p.setImageFilter(filter);
    p.setColorFilter(this.saturation);
    s.getCanvas().drawImageRect(
      img,
      this.ck.XYWHRect(0, 0, img.width(), img.height()),
      this.ck.XYWHRect(
        (n - img.width() * k) / 2,
        (n - img.height() * k) / 2,
        img.width() * k,
        img.height() * k,
      ),
      p,
    );
    s.flush();
    const out = s.makeImageSnapshot();
    p.delete();
    filter.delete();
    s.delete();
    return out;
  }
  snapshot() {
    if (this.dpr === 1) {
      const image = this.surface.makeImageSnapshot();
      this.temps.push(image);
      return image;
    }
    this.c.restore();
    const img = this.surface.makeImageSnapshot(),
      s = this.surface.makeSurface({
        width: this.w,
        height: this.h,
        colorType: this.ck.ColorType.RGBA_8888,
        alphaType: this.ck.AlphaType.Premul,
        colorSpace: this.ck.ColorSpace.SRGB,
      });
    this.imgPaint.setAlphaf(1);
    s.getCanvas().drawImageRect(
      img,
      this.ck.XYWHRect(0, 0, this.el.width, this.el.height),
      this.ck.XYWHRect(0, 0, this.w, this.h),
      this.imgPaint,
    );
    s.flush();
    const out = s.makeImageSnapshot();
    this.temps.push(img, s, out);
    this.c.save();
    this.c.scale(this.dpr, this.dpr);
    return out;
  }
  privateCard(image, work) {
    const n = t.defaultCardWidth,
      s = this.surface.makeSurface({
        width: n,
        height: n,
        colorType: this.ck.ColorType.RGBA_8888,
        alphaType: this.ck.AlphaType.Premul,
        colorSpace: this.ck.ColorSpace.SRGB,
      }),
      previous = this.c;
    try {
      this.c = s.getCanvas();
      this.c.clear(this.ck.TRANSPARENT);
      this.image(image, { x: 0, y: 0, w: n, h: n });
      let x = t.inset;
      const chip = (text, left, top) => {
        const width = this.shape(text, t.caption).width + t.chipPad * 2;
        this.rr(
          { x: left, y: top, w: width, h: t.chipHeight },
          t.tagRadius,
          t.chip,
        );
        this.text(
          text,
          left + t.chipPad,
          top + t.dividerInset,
          t.caption,
          t.white,
        );
        return width;
      };
      for (const tag of work.tags) {
        x += chip(tag.label, x, n - t.inset - t.chipHeight) + t.tagGap;
        if (x > n) break;
      }
      x = t.inset;
      for (const text of [
        work.flags?.adult ? "R-18" : null,
        work.flags?.aiGenerated ? "AI" : null,
      ].filter(Boolean))
        x += chip(text, x, t.inset) + t.tagGap;
      if (!work.isAuthor && work.counts.media > 1) {
        const text = String(work.counts.media),
          width = this.shape(text, t.caption).width + t.chipPad * 2;
        chip(text, n - t.inset - width, t.inset);
      }
      s.flush();
      const flat = s.makeImageSnapshot();
      try {
        return this.bake(flat);
      } finally {
        flat.delete();
      }
    } finally {
      this.c = previous;
      s.delete();
    }
  }
  hoverShadow(box, amount) {
    this.shadowFilter ??= this.ck.ImageFilter.MakeDropShadowOnly(
      0,
      t.hoverShadowOffset,
      t.hoverShadowBlur,
      t.hoverShadowBlur,
      this.color(t.black, t.hoverShadowOpacity),
      null,
    );
    this.shadowPaint ??= new this.ck.Paint();
    this.shadowPaint.setAntiAlias(true);
    this.shadowPaint.setAlphaf(amount);
    this.shadowPaint.setImageFilter(this.shadowFilter);
    this.c.save();
    this.c.translate(box.x, box.y);
    this.c.drawPath(this.path(box.w, box.h, t.card), this.shadowPaint);
    this.c.restore();
  }
  captureBackground(previous, current, mix) {
    const s = this.surface.makeSurface({
        width: this.w,
        height: this.h,
        colorType: this.ck.ColorType.RGBA_8888,
        alphaType: this.ck.AlphaType.Premul,
        colorSpace: this.ck.ColorSpace.SRGB,
      }),
      c = s.getCanvas();
    c.clear(this.color(this.colors.bg));
    for (const [image, alpha] of [
      [previous, 1 - mix],
      [current, mix],
    ])
      if (image) {
        const k = Math.max(this.w / image.width(), this.h / image.height()),
          w = image.width() * k,
          h = image.height() * k;
        this.imgPaint.setAlphaf(alpha);
        c.drawImageRect(
          image,
          this.ck.XYWHRect(0, 0, image.width(), image.height()),
          this.ck.XYWHRect((this.w - w) / 2, (this.h - h) / 2, w, h),
          this.imgPaint,
        );
      }
    s.flush();
    const image = s.makeImageSnapshot();
    s.delete();
    return image;
  }
  glass(b, r, back, alpha = 1) {
    this.c.save();
    this.c.translate(b.x, b.y);
    this.c.clipPath(this.path(b.w, b.h, r), this.ck.ClipOp.Intersect, true);
    this.c.translate(-b.x, -b.y);
    this.imgPaint.setImageFilter(this.blur);
    this.imgPaint.setColorFilter(this.saturation);
    this.imgPaint.setAlphaf(alpha);
    this.c.drawImage(back, 0, 0, this.imgPaint);
    this.imgPaint.setImageFilter(null);
    this.imgPaint.setColorFilter(null);
    this.c.restore();
    this.rr(b, r, this.colors.glass, alpha);
    this.outline(b, r, this.colors.edge);
  }
  dropdown(x, y, c, alpha = 1) {
    const builder = new this.ck.PathBuilder();
    builder.moveTo(x, y);
    builder.lineTo(x + t.dropdownWidth, y);
    builder.lineTo(x + t.dropdownWidth / 2, y + t.dropdownHeight);
    builder.close();
    const triangle = builder.detachAndDelete();
    this.c.drawPath(triangle, this.fill(c, alpha));
    triangle.delete();
  }
  icon(name, x, y, c = this.colors.fg, alpha = 1, size = 16) {
    this.fluentPaths ??= new Map();
    if (!this.fluentPaths.has(name))
      this.fluentPaths.set(
        name,
        (fluentIcons[name] || fluentIcons.close).map((d) =>
          this.ck.Path.MakeFromSVGString(d),
        ),
      );
    this.c.save();
    // Existing optical boxes stay put; drawings are compact, not hit targets.
    this.c.translate(x + (22 - size) / 2, y + (22 - size) / 2);
    this.c.scale(size / 20, size / 20);
    for (const path of this.fluentPaths.get(name))
      if (path) this.c.drawPath(path, this.fill(c, alpha));
    this.c.restore();
  }
}
