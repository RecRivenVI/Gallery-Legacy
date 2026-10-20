import { Paint } from "./paint.js";
import {
  Spring,
  Fade,
  bounds,
  readBounds,
  targetBounds,
  tickBounds,
} from "./motion.js";
import { t, themes } from "./tokens.js";
import { request as api } from "../platform/api.js";
import { wrapWords, originalProgress } from "./content-layout.js";
import {
  anchoredPan,
  boundedPan,
  dragScroll,
  subtitleCandidates,
} from "./interaction.js";

const clamp = (v, a, z) => Math.max(a, Math.min(z, v));
const box = (x, y, w, h) => ({ x, y, w, h });
export function imageFit(iw, ih, area, zoom = 1, pan = { x: 0, y: 0 }) {
  const k = Math.min(area.w / iw, area.h / ih) * zoom;
  return box(
    area.x + (area.w - iw * k) / 2 + pan.x,
    area.y + (area.h - ih * k) / 2 + pan.y,
    iw * k,
    ih * k,
  );
}
export function coverCrop(iw, ih, aspect = 1) {
  const w = Math.min(iw, ih * aspect),
    h = w / aspect;
  return box((iw - w) / 2, (ih - h) / 2, w, h);
}
export function viewerGeometry(
  width,
  height,
  split,
  info,
  chrome,
  mobile = width < 700,
) {
  const x = (width / 2) * Number(split),
    w = width - x;
  const top = 50 * chrome,
    bottom = 64 * chrome;
  const details = 240 * (1 - Number(split)) * info * chrome;
  return {
    x,
    w,
    top,
    bottom,
    details,
    mobile,
    stage: box(x, top, w - (mobile ? 0 : details), height - top - bottom),
    info: mobile
      ? box(
          x,
          height - bottom - Math.min(420, height * 0.6) * info * chrome,
          w,
          Math.min(420, height * 0.6) * info * chrome,
        )
      : box(width - details, top, details, height - top - bottom),
  };
}
export function gestureResult(start, end, zoom) {
  if (zoom > 1.01) return "pan";
  if (
    Math.abs(end.x - start.x) > 45 &&
    Math.abs(end.x - start.x) > Math.abs(end.y - start.y)
  )
    return end.x < start.x ? "next" : "previous";
  return Math.hypot(end.x - start.x, end.y - start.y) < 8 ? "tap" : "none";
}

export function viewerFeedbackArea(geometry, detailsOpen) {
  const stage = geometry.stage;
  return geometry.mobile && detailsOpen
    ? {
        ...stage,
        h: Math.max(0, Math.min(stage.y + stage.h, geometry.info.y) - stage.y),
      }
    : stage;
}

export class Viewer {
  constructor(ck, faces, provider, host) {
    this.host = host;
    this.canvas = document.createElement("canvas");
    this.canvas.id = "viewer-canvas";
    this.canvas.dataset.overlay = "1";
    this.canvas.setAttribute("aria-hidden", "true");
    document.body.append(this.canvas);
    this.p = new Paint(ck, this.canvas, faces, provider);
    this.p.ensureEmoji = host.ensureEmoji;
    this.p.ensureFonts = host.ensureFonts;
    this.root = document.createElement("section");
    this.root.id = "viewer";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "看大图");
    this.root.innerHTML =
      '<img id="viewer-hit" alt="图片" tabindex="0" draggable="false"><video id="viewer-video" controls playsinline hidden></video><input id="viewer-zoom" type="range" min="0.1" max="8" step="0.05" aria-label="缩放" hidden><div id="viewer-copy" role="status" class="sr-only"></div>';
    document.body.append(this.root);
    this.hit = this.root.querySelector("#viewer-hit");
    this.video = this.root.querySelector("video");
    this.range = this.root.querySelector("input");
    this.range.oninput = () => this.setZoom(Number(this.range.value));
    this.buttons = new Map();
    this.images = new Map();
    this.inflight = new Map();
    this.info = new Spring(1);
    this.chrome = new Spring(
      localStorage.getItem("gallery_viewer_hidden") === "1" ? 0 : 1,
    );
    this.alpha = new Fade(0);
    this.full = new Spring(1);
    this.progress = new Spring(0);
    this.pageFade = new Fade(1);
    this.thumbErrors = new Map();
    this.zoom = new Spring(1);
    this.panX = new Spring(0);
    this.panY = new Spring(0);
    this.direction = new Spring(0);
    this.thumbs = new Spring(0);
    this.arrows = new Fade(1);
    this.infoScroll = 0;
    this.pointers = new Map();
    this.hit.addEventListener("pointerdown", (e) => this.pointerDown(e));
    this.hit.addEventListener("pointermove", (e) => this.pointerMove(e));
    this.hit.addEventListener("pointerup", (e) => this.pointerUp(e));
    this.hit.addEventListener("pointercancel", () => {
      this.pointers.clear();
      this.pinch = this.drag = null;
      this.direction.to(0);
      clearTimeout(this.tapTimer);
      this.host.request();
    });
    this.hit.addEventListener("dblclick", (e) => {
      e.preventDefault();
      this.doubleTap();
    });
    this.hit.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setZoom(this.zoom.target * (e.deltaY < 0 ? 1.15 : 1 / 1.15), {
          x: e.clientX,
          y: e.clientY,
        });
      },
      { passive: false },
    );
    this.root.addEventListener("pointermove", (e) => {
      if (!this.geometry) return;
      const a = this.geometry.stage;
      this.arrows.to(
        e.clientX < a.x + 200 || e.clientX > a.x + a.w - 200 ? 1 : 0,
      );
      host.request();
    });
    this.root.addEventListener("pointerleave", () => {
      this.arrows.to(0);
      host.request();
    });
    this.root.addEventListener(
      "wheel",
      (e) => {
        const strip = this.thumbStrip;
        if (
          strip &&
          e.clientX >= strip.x &&
          e.clientX <= strip.x + strip.w &&
          e.clientY >= strip.y &&
          e.clientY <= strip.y + strip.h
        ) {
          e.preventDefault();
          e.stopPropagation();
          this.scrollThumbs(e.deltaX || e.deltaY);
          return;
        }
        const r = this.geometry?.info;
        if (
          r &&
          this.info.target &&
          e.clientX >= r.x &&
          e.clientX <= r.x + r.w &&
          e.clientY >= r.y &&
          e.clientY < r.y + r.h
        ) {
          e.preventDefault();
          e.stopPropagation();
          this.infoScroll = clamp(
            this.infoScroll + e.deltaY,
            0,
            this.infoMax || 0,
          );
          host.request();
        }
      },
      { passive: false },
    );
    dragScroll(this.root, {
      area: () =>
        this.info.target && this.chrome.target ? this.geometry?.info : null,
      read: () => this.infoScroll,
      write: (value) => {
        this.infoScroll = clamp(value, 0, this.infoMax || 0);
        host.request();
      },
    });
    dragScroll(this.root, {
      area: () => (this.chrome.target ? this.thumbStrip : null),
      horizontal: true,
      read: () => this.thumbs.target,
      write: (value) => {
        this.thumbs.to(clamp(value, this.thumbMin, this.thumbMax));
        host.request();
      },
    });
    this.root.addEventListener("keydown", (e) => this.key(e));
    this.canvas.hidden = true;
  }
  async image(url) {
    if (!url) return null;
    if (this.images.has(url)) return this.images.get(url);
    if (!this.inflight.has(url))
      this.inflight.set(
        url,
        (async () => {
          const r = await fetch(url);
          if (!r.ok) throw Error("图片没有响应");
          const bytes = await r.arrayBuffer(),
            codec = this.p.ck.MakeAnimatedImageFromEncoded(bytes),
            animated = codec && codec.getFrameCount() > 1;
          const img = animated
            ? codec.makeImageAtCurrentFrame()
            : this.p.ck.MakeImageFromEncoded(bytes);
          if (!animated) codec?.delete();
          if (!img) throw Error("图片无法读取");
          const value = {
            img,
            blur: this.p.bake(img),
            codec: animated ? codec : null,
            elapsed: 0,
            repeats: 0,
            finished: false,
          };
          this.images.set(url, value);
          for (const [key, old] of this.images) {
            const originalCount = [...this.images.keys()].filter(
              (k) =>
                !k.includes("/thumbnails/") && !k.includes("/file-thumbnails?"),
            ).length;
            if (this.images.size <= 48 && originalCount <= 4) break;
            if (
              [this.original, this.preview, this.previousImage, value].includes(
                old,
              )
            )
              continue;
            if (
              this.images.size <= 48 &&
              (key.includes("/thumbnails/") ||
                key.includes("/file-thumbnails?"))
            )
              continue;
            old.img.delete();
            old.blur.delete();
            old.codec?.delete();
            this.images.delete(key);
          }
          return value;
        })().finally(() => this.inflight.delete(url)),
      );
    return this.inflight.get(url);
  }
  async open(work, page = 0, split = false, remember = true) {
    const previouslyOpen = this.opened || this.closing;
    this.video.pause();
    this.video.hidden = true;
    this.origin =
      this.host.card(work.key || work.stableId) ||
      box(innerWidth / 2 - 40, innerHeight / 2 - 40, 80, 80);
    if (!previouslyOpen) this.returnFocus = document.activeElement;
    this.openToken = Symbol();
    const openToken = this.openToken;
    this.loadToken = Symbol();
    this.media = [];
    this.detail = null;
    this.neighbors = null;
    this.work = work;
    this.page = page;
    this.split =
      split && innerWidth >= 1280 && !matchMedia("(pointer:coarse)").matches;
    this.infoScroll = 0;
    this.opened = true;
    this.closing = false;
    this.status = "loading";
    if (!previouslyOpen) {
      this.frameBox = null;
      this.cropBox = null;
      this.preview = this.original = null;
    }
    this.alpha.to(1);
    this.progress.to(1);
    this.full.to(this.split ? 0 : 1);
    this.root.hidden = this.canvas.hidden = false;
    this.root.setAttribute("aria-modal", String(!this.split));
    this.chrome.to(
      localStorage.getItem("gallery_viewer_hidden") === "1" ? 0 : 1,
    );
    this.host.selected(work, this.split);
    this.host.request();
    if (remember) this.host.historyOpen(work);
    this.root.querySelector("#viewer-hit").focus({ preventScroll: true });
    try {
      const result = work.isFile
        ? { item: { ...work, media: [work.cover] } }
        : await api("resolve", { path: work.stableId });
      if (openToken !== this.openToken || this.work !== work || !this.opened)
        return;
      this.detail = result.item;
      this.authorDetail = null;
      if (!work.isFile) {
        this.authorDetail = (
          await api("resolve", {
            path: work.stableId.slice(0, work.stableId.lastIndexOf("/")),
          })
        ).item;
        if (openToken !== this.openToken || this.work !== work || !this.opened)
          return;
        // Author portraits never use artwork. Optional display is a neutral placeholder.
      }
      this.media = (result.item.media || []).filter(
        (m) => m.defaultVisible !== false,
      );
      this.page = clamp(page, 0, Math.max(0, this.media.length - 1));
      this.neighbors = await this.host.neighbors(work);
      if (openToken !== this.openToken || this.work !== work || !this.opened)
        return;
      this.coverFirst =
        result.item.cover?.relativePath === this.media[0]?.relativePath;
      if (!previouslyOpen && !this.coverFirst && page === 0) {
        this.origin = this.host.fanOrigin?.(work) || this.origin;
        this.frameBox = null;
        this.cropBox = null;
      }
      const thumb = this.media[this.page]?.thumbnailUrl;
      if (thumb) {
        try {
          this.preview = await this.image(thumb);
        } catch {
          this.preview = null;
        }
      }
      if (openToken !== this.openToken || !this.opened) return;
      this.firstAt = performance.now();
      this.arrows.to(1);
      setTimeout(() => {
        this.arrows.to(0);
        this.host.request();
      }, 1800);
      this.loadPage();
    } catch (e) {
      if (openToken === this.openToken && this.work === work) {
        this.status = "error";
        this.reason = e.message;
        this.host.request();
      }
    }
  }
  async loadPage() {
    const media = this.media?.[this.page],
      token = (this.loadToken = Symbol());
    this.status = "loading";
    this.original = null;
    this.video.pause();
    this.loadingAt = performance.now();
    setTimeout(() => {
      if (token === this.loadToken && this.status === "loading")
        this.host.request();
    }, t.viewerLoadDelay);
    if (media?.type === "image") this.hit.src = media.url;
    this.video.hidden = true;
    this.zoom.to(1);
    this.panX.to(0);
    this.panY.to(0);
    if (!media) {
      this.status = "empty";
      this.host.request();
      return;
    }
    this.image(media.thumbnailUrl)
      .then((v) => {
        if (token === this.loadToken) {
          this.preview = v;
          this.host.request();
        }
      })
      .catch((e) => {
        if (token === this.loadToken) this.previewError = e.message;
      });
    if (media.type === "video" || media.kind === "video") {
      this.video.replaceChildren();
      this.video.src = media.url;
      for (const subtitle of media.subtitles || subtitleCandidates(media)) {
        const available = await fetch(subtitle.url, { method: "HEAD" })
          .then((r) => r.ok)
          .catch(() => false);
        if (token !== this.loadToken) return;
        if (!available) continue;
        const track = document.createElement("track");
        track.kind = "subtitles";
        track.src = subtitle.url;
        track.label = subtitle.label || "字幕";
        track.srclang = subtitle.language || "zh";
        this.video.append(track);
      }
      this.video.onloadedmetadata = () => {
        if (token === this.loadToken) {
          this.status = "ready";
          this.host.request();
        }
      };
      this.video.onerror = () => {
        if (token === this.loadToken) {
          this.status = "error";
          this.reason = "视频无法播放";
          this.host.request();
        }
      };
      this.video.load();
    } else
      try {
        const original = await this.image(media.url);
        if (token !== this.loadToken) return;
        this.original = original;
        this.status = "ready";
        this.pageFade.x = 0;
        this.pageFade.to(1);
      } catch (e) {
        if (token === this.loadToken) {
          this.status = "error";
          this.reason = e.message;
        }
      }
    this.host.request();
  }
  close(back = true) {
    if (!this.opened) return;
    this.closing = true;
    this.opened = false;
    this.openToken = Symbol();
    this.loadToken = Symbol();
    this.pendingDirections = [];
    this.origin =
      this.host.card(this.work.key || this.work.stableId) ||
      box(innerWidth / 2 - 40, innerHeight / 2 - 40, 80, 80);
    this.progress.to(0);
    this.alpha.to(0);
    this.video.pause();
    this.video.hidden = true;
    this.host.selected(null, false);
    if (back) this.host.historyClose();
    this.host.request();
    requestAnimationFrame(() => {
      if (!this.opened && this.returnFocus?.isConnected)
        this.returnFocus.focus({ preventScroll: true });
    });
  }
  setZoom(value, anchor = null) {
    const next = clamp(value, 0.1, 8),
      image = this.original?.img || this.preview?.img,
      area = this.geometry?.stage;
    this.zoom.to(next);
    if (image && area) {
      const pan = anchoredPan(
        area,
        this.zoom.x,
        next,
        { x: this.panX.x, y: this.panY.x },
        anchor || { x: area.x + area.w / 2, y: area.y + area.h / 2 },
      );
      const safe = boundedPan(image.width(), image.height(), area, next, pan);
      this.panX.to(safe.x);
      this.panY.to(safe.y);
    }
    this.host.request();
  }
  toggleHidden() {
    this.chrome.to(this.chrome.target ? 0 : 1);
    localStorage.setItem(
      "gallery_viewer_hidden",
      this.chrome.target ? "0" : "1",
    );
    this.host.request();
  }
  doubleTap() {
    if (this.split) {
      this.split = false;
      this.full.to(1);
      this.host.selected(this.work, false);
    } else this.setZoom(this.zoom.target > 1 ? 1 : 2);
    this.host.request();
  }
  flip(direction) {
    if (!this.media?.length || this.switchingWork) return;
    if (this.page + direction < 0 || this.page + direction >= this.media.length)
      return this.changeWork(direction);
    this.previousImage = this.original || this.preview;
    this.page += direction;
    this.direction.x += direction * Math.min(innerWidth * 0.25, 240);
    this.direction.to(0);
    this.loadPage();
    this.host.request();
  }
  async changeWork(direction) {
    (this.pendingDirections ||= []).push(direction);
    if (this.switchingWork) return;
    this.switchingWork = true;
    try {
      while (this.opened && this.pendingDirections.length) {
        const step = this.pendingDirections.shift(),
          token = this.openToken,
          work = this.work;
        const next = await this.host.adjacent(work, step);
        if (token !== this.openToken || !this.opened) break;
        if (!next) continue;
        this.previousImage = this.original || this.preview;
        this.direction.x += step * 80;
        this.direction.to(0);
        await this.host.align(next);
        if (token !== this.openToken || !this.opened) break;
        this.host.historyReplace(next);
        await this.open(next, 0, this.split, false);
      }
    } catch (e) {
      if (this.opened) {
        this.status = "error";
        this.reason = e.message;
        this.host.request();
      }
    } finally {
      this.switchingWork = false;
      this.pendingDirections = [];
    }
  }
  scrollThumbs(delta) {
    this.thumbs.to(
      clamp(this.thumbs.target + delta, this.thumbMin, this.thumbMax),
    );
    this.host.request();
  }
  key(e) {
    if (
      !this.opened ||
      (["INPUT", "TEXTAREA", "VIDEO"].includes(e.target.tagName) &&
        !["Escape", "Tab"].includes(e.key))
    )
      return;
    const action = {
      ArrowLeft: () => (e.shiftKey ? this.changeWork(-1) : this.flip(-1)),
      ArrowRight: () => (e.shiftKey ? this.changeWork(1) : this.flip(1)),
      Escape: () => this.close(),
      "+": () => this.setZoom(this.zoom.target * 1.25),
      "=": () => this.setZoom(this.zoom.target * 1.25),
      "-": () => this.setZoom(this.zoom.target / 1.25),
      0: () => this.setZoom(1),
      i: () => {
        this.info.to(this.info.target ? 0 : 1);
      },
      h: () => this.toggleHidden(),
    }[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (action) {
      e.preventDefault();
      e.stopPropagation();
      action();
      this.host.request();
    }
    if (e.key === "Tab" && !this.split) {
      const list = [
          ...this.root.querySelectorAll(
            'button:not([hidden]):not([disabled]),a:not([hidden]),input:not([hidden]),[tabindex="0"]',
          ),
        ].filter(
          (el) => !el.hidden && !el.disabled && el.getClientRects().length,
        ),
        i = list.indexOf(document.activeElement);
      if ((e.shiftKey && i <= 0) || (!e.shiftKey && i === list.length - 1)) {
        e.preventDefault();
        list[e.shiftKey ? list.length - 1 : 0]?.focus();
      }
    }
  }
  pointerDown(e) {
    this.hit.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    clearTimeout(this.tapTimer);
    if (this.pointers.size === 1)
      this.drag = {
        x: e.clientX,
        y: e.clientY,
        px: this.panX.x,
        py: this.panY.x,
        time: performance.now(),
      };
    if (this.pointers.size === 2) {
      const [a, z] = [...this.pointers.values()];
      this.pinch = {
        distance: Math.hypot(a.x - z.x, a.y - z.y),
        zoom: this.zoom.x,
        pan: { x: this.panX.x, y: this.panY.x },
        anchor: { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 },
      };
    }
  }
  pointerMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2 && this.pinch) {
      const [a, z] = [...this.pointers.values()];
      const value =
        (this.pinch.zoom * Math.hypot(a.x - z.x, a.y - z.y)) /
        Math.max(1, this.pinch.distance);
      const next = clamp(value, 0.1, 8),
        area = this.geometry?.stage,
        image = this.original?.img || this.preview?.img;
      this.zoom.x = this.zoom.target = next;
      if (area && image) {
        const pan = anchoredPan(
          area,
          this.pinch.zoom,
          next,
          this.pinch.pan,
          this.pinch.anchor,
        );
        pan.x += (a.x + z.x) / 2 - this.pinch.anchor.x;
        pan.y += (a.y + z.y) / 2 - this.pinch.anchor.y;
        const safe = boundedPan(image.width(), image.height(), area, next, pan);
        this.panX.x = this.panX.target = safe.x;
        this.panY.x = this.panY.target = safe.y;
      }
    } else if (this.drag) {
      if (this.zoom.x > 1.01) {
        const image = this.original?.img || this.preview?.img;
        const pan = {
          x: this.drag.px + e.clientX - this.drag.x,
          y: this.drag.py + e.clientY - this.drag.y,
        };
        const safe =
          image && this.geometry
            ? boundedPan(
                image.width(),
                image.height(),
                this.geometry.stage,
                this.zoom.x,
                pan,
              )
            : pan;
        this.panX.x = this.panX.target = safe.x;
        this.panY.x = this.panY.target = safe.y;
      } else this.direction.x = this.direction.target = e.clientX - this.drag.x;
    }
    this.host.request();
  }
  pointerUp(e) {
    const wasPinch = !!this.pinch;
    this.pointers.delete(e.pointerId);
    if (wasPinch) {
      this.pinch = null;
      this.setZoom(this.zoom.x);
      this.drag = null;
      this.pointers.clear();
      return;
    }
    if (!this.drag) return;
    const result = gestureResult(
      this.drag,
      { x: e.clientX, y: e.clientY },
      this.zoom.x,
    );
    this.direction.to(0);
    if (result === "next") this.flip(1);
    if (result === "previous") this.flip(-1);
    if (result === "tap") {
      if (performance.now() - (this.lastTap || 0) < 300) {
        clearTimeout(this.tapTimer);
        if (e.pointerType !== "mouse") this.doubleTap();
      } else this.tapTimer = setTimeout(() => this.toggleHidden(), 300);
      this.lastTap = performance.now();
    }
    this.drag = null;
    this.host.request();
  }
  button(
    id,
    label,
    rect,
    action,
    icon,
    selected = false,
    disabled = false,
    href = null,
    drawText = true,
  ) {
    let el = this.buttons.get(id);
    if (!el) {
      el = document.createElement(href ? "a" : "button");
      el.className = "bridge";
      el.dataset.viewer = id;
      if (!href) el.type = "button";
      this.root.append(el);
      this.buttons.set(id, el);
      el.onpointerdown = () => {
        this.host.state.keyboard = false;
      };
      el.onfocus = el.onblur = () => this.host.request();
      el.onmouseenter = () => {
        this.hover = id;
        this.host.request();
      };
      el.onmouseleave = () => {
        this.hover = null;
        this.host.request();
      };
    }
    el.viewerSeen = true;
    el.hidden = false;
    el.disabled = disabled;
    el.textContent = label;
    el.setAttribute("aria-label", label);
    if (href) {
      el.href = href;
      el.download = "";
    }
    el.onclick = action;
    Object.assign(el.style, {
      left: rect.x + "px",
      top: rect.y + "px",
      width: rect.w + "px",
      height: rect.h + "px",
    });
    if (selected) this.p.rr(rect, 4, this.p.colors.on);
    if (this.hover === id) this.p.rr(rect, 4, this.p.colors.tint);
    if (icon)
      this.p.icon(
        icon,
        rect.x + (rect.w - 22) / 2,
        rect.y + (rect.h - 22) / 2,
        this.p.colors.fg,
        disabled ? 0.35 : 1,
      );
    else if (drawText)
      this.p.text(
        label === "放大" ? "+" : label === "缩小" ? "−" : label,
        rect.x +
          (rect.w -
            this.p.shape(
              label === "放大" ? "+" : label === "缩小" ? "−" : label,
              13,
            ).width) /
            2,
        rect.y + rect.h / 2 + 4,
        13,
        this.p.colors.fg,
        disabled ? 0.35 : 1,
      );
    if (this.host.state.keyboard && document.activeElement === el)
      this.p.focus(rect, 4);
    return el;
  }
  copy(value) {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        this.root.querySelector("#viewer-copy").textContent = "已复制";
      })
      .catch(() => {
        this.root.querySelector("#viewer-copy").textContent =
          "复制失败：浏览器没有允许复制，请手动复制地址";
      });
  }
  drawUI(g, back) {
    const p = this.p,
      entrance = this.progress.x,
      y =
        innerHeight -
        64 * this.chrome.x * clamp((entrance - 0.08) / 0.92, 0, 1),
      info = this.detail;
    const top = box(g.x, -50 * (1 - this.chrome.x * entrance), g.w, 50);
    p.glass(top, 0, back);
    this.button(
      "close",
      "关闭",
      box(g.x + 8, top.y + 8, 34, 34),
      () => this.close(),
      "close",
    );
    let x = innerWidth - 42;
    if (!this.split) {
      this.button(
        "info",
        "详情栏",
        box(x, top.y + 8, 34, 34),
        () => {
          this.info.to(this.info.target ? 0 : 1);
          this.host.request();
        },
        "panel-right",
        !!this.info.target,
      );
      x -= 42;
    } else {
      this.button(
        "expand",
        "看大图",
        box(x, top.y + 8, 34, 34),
        () => this.doubleTap(),
        "expand",
      );
      x -= 42;
    }
    this.button(
      "link",
      "复制链接",
      box(x, top.y + 8, 34, 34),
      () => this.copy(location.href),
      "link",
    );
    x -= 42;
    this.button(
      "download",
      "下载",
      box(x, top.y + 8, 34, 34),
      null,
      "download",
      false,
      !this.media?.length,
      this.media?.[this.page]?.url || "#",
    );
    p.glass(box(g.x, y, g.w, 64), 0, back);
    if (!g.mobile)
      p.text(
        `${this.page + 1} / ${this.media?.length || 0}`,
        g.x + 16,
        y + 37,
        13,
      );
    const left = g.x + (g.mobile ? 8 : 100),
      right = innerWidth - (g.mobile ? 8 : 268),
      center = g.x + g.w / 2;
    const strip = box(left, y + 8, Math.max(0, right - left), 48),
      sequence = [];
    for (const n of this.neighbors?.before || [])
      sequence.push({ work: n, media: n.cover, neighbor: true });
    (this.media || []).forEach((m, page) => sequence.push({ media: m, page }));
    for (const n of this.neighbors?.after || [])
      sequence.push({ work: n, media: n.cover, neighbor: true });
    const current = sequence.findIndex((v) => v.page === this.page);
    this.thumbStrip = strip;
    this.thumbMin = -left;
    this.thumbMax = Math.max(this.thumbMin, sequence.length * 56 - 8 - right);
    const thumbKey = `${this.work.stableId}:${this.page}:${left}:${right}`;
    if (this.thumbKey !== thumbKey) {
      this.thumbKey = thumbKey;
      this.thumbs.to(
        clamp(current * 56 + 24 - center, this.thumbMin, this.thumbMax),
      );
    }
    p.clipped(() => {
      p.c.saveLayer();
      sequence.forEach((v, i) => {
        const r = box(i * 56 - this.thumbs.x, y + 8, 48, 48);
        if (r.x + 48 < left - 112 || r.x > right + 112) return;
        const img = this.images.get(v.media?.thumbnailUrl);
        if (img) p.imageClip(img.img, r, 3, v.neighbor ? 0.5 : 1);
        else {
          p.rr(r, 3, p.colors.field);
          if (!this.thumbErrors.has(v.media?.thumbnailUrl))
            this.image(v.media?.thumbnailUrl)
              .then(() => this.host.request())
              .catch((e) => {
                this.thumbErrors.set(v.media?.thumbnailUrl, e.message);
              });
        }
        if (v.page === this.page)
          p.outline(box(r.x - 2, r.y - 2, 52, 52), 4, p.colors.fg, 2);
        if (v.neighbor || sequence[i - 1]?.neighbor)
          p.rect(box(r.x - 5, y + 12, 1, 40), p.colors.div);
        if (r.x >= left && r.x + 48 <= right)
          this.button(
            "thumb-" + i,
            v.neighbor ? "打开相邻作品" : `第 ${v.page + 1} 页`,
            r,
            () => {
              if (v.neighbor) {
                this.host.align(v.work).then(() => {
                  this.host.historyReplace(v.work);
                  return this.open(v.work, 0, this.split, false);
                });
              } else {
                this.page = v.page;
                this.direction.x = 60;
                this.direction.to(0);
                this.loadPage();
              }
            },
            null,
            false,
            false,
            null,
            false,
          );
      });
      p.edges(strip, 1, 1);
      p.c.restore();
    }, strip);
    this.button(
      "thumb-left",
      "向左滚动",
      box(left, y + 15, 24, 34),
      () => this.scrollThumbs(-strip.w * 0.7),
      "left",
      false,
      this.thumbs.target <= this.thumbMin,
    );
    this.button(
      "thumb-right",
      "向右滚动",
      box(right - 24, y + 15, 24, 34),
      () => this.scrollThumbs(strip.w * 0.7),
      "right",
      false,
      this.thumbs.target >= this.thumbMax,
    );
    if (!g.mobile) {
      const z = innerWidth - 256;
      p.group(box(z, y + 15, 248, 34), p.colors.field);
      this.button(
        "fit",
        "适应",
        box(z + 3, y + 18, 44, 28),
        () => this.setZoom(1),
        null,
        this.zoom.target === 1,
      );
      this.button("actual", "100%", box(z + 50, y + 18, 48, 28), () => {
        const image = this.original?.img || this.preview?.img;
        if (image)
          this.setZoom(
            1 / Math.min(g.stage.w / image.width(), g.stage.h / image.height()),
          );
      });
      this.button("minus", "缩小", box(z + 101, y + 18, 28, 28), () =>
        this.setZoom(this.zoom.target / 1.25),
      );
      this.button("plus", "放大", box(z + 217, y + 18, 28, 28), () =>
        this.setZoom(this.zoom.target * 1.25),
      );
      this.range.hidden = !this.chrome.target;
      this.rangeSeen = true;
      Object.assign(this.range.style, {
        left: z + 135 + "px",
        top: y + 17 + "px",
        width: "76px",
        height: "30px",
      });
      this.range.value = this.zoom.target;
    }
    if (!this.split && this.info.x > 0.001 && this.chrome.x > 0.001 && info) {
      const r = g.info;
      p.glass(r, g.mobile ? 12 : 0, back);
      let yy = r.y + 28 - this.infoScroll;
      const text = (value, size = 13, color = p.colors.fg, bold = false) => {
        const lines = this.wrap(String(value || ""), r.w - 32, size);
        for (const line of lines) {
          p.text(line, r.x + 16, yy, size, color, 1, bold ? "bold" : "regular");
          yy += size + 7;
        }
        yy += 8;
      };
      p.clipped(
        () => {
          text(info.title, 16, p.colors.fg, true);
          const author =
              this.authorDetail?.name ||
              info.authorName ||
              info.sourceAuthorId ||
              "",
            avatar = !this.host.state.prefs.hideAuthorAvatar;
          if (author) {
            if (avatar) {
              p.rr(box(r.x + 16, yy - 14, 28, 28), 14, p.colors.field);
              p.icon("author", r.x + 19, yy - 11, p.colors.muted);
            }
            p.fadeText(
              author,
              r.x + (avatar ? 52 : 16),
              yy,
              r.w - (avatar ? 68 : 32),
              13,
              p.colors.fg,
            );
            if (this.authorDetail?.handle || this.authorDetail?.sourceAuthorId)
              p.fadeText(
                this.authorDetail.handle || this.authorDetail.sourceAuthorId,
                r.x + (avatar ? 52 : 16),
                yy + 18,
                r.w - (avatar ? 68 : 32),
                11,
                p.colors.muted,
              );
            this.button(
              "author",
              author,
              box(r.x + 8, yy - 14, r.w - 16, 44),
              () => {
                this.close();
                this.host.author(this.work);
              },
              null,
              false,
              false,
              null,
              false,
            );
          }
          yy += author ? 52 : 0;
          text(
            [
              info.platformId,
              info.publishedAtMs
                ? new Date(info.publishedAtMs).toISOString().slice(0, 10)
                : "",
              `${this.media?.length || 0} 页`,
            ]
              .filter(Boolean)
              .join(" · "),
            12,
            p.colors.muted,
          );
          const allPages = box(r.x + 16, yy - 14, r.w - 32, 28);
          p.rr(allPages, t.controlRadius, p.colors.tag);
          this.button(
            "all-pages",
            `查看全部 ${this.media?.length || 0} 页`,
            allPages,
            () => {
              this.close(false);
              this.host.pages(this.work);
            },
          );
          yy += 36;
          if (info.sourceUrl) {
            const source = this.button(
              "source",
              "来源",
              box(r.x + 8, yy - 14, r.w - 16, 28),
              null,
              null,
              false,
              false,
              info.sourceUrl,
            );
            source.removeAttribute("download");
            source.target = "_blank";
            source.rel = "noreferrer";
            yy += 36;
          }
          const path = info.relativePath || this.work.stableId;
          p.fadeText(path, r.x + 16, yy, r.w - 32, 12, p.colors.muted);
          const pathButton = this.button(
            "path",
            "复制位置",
            box(r.x + 8, yy - 15, r.w - 16, 28),
            () => this.copy(path),
            null,
            false,
            false,
            null,
            false,
          );
          pathButton.title = "点击复制";
          yy += 36;
          let tx = r.x + 16;
          for (const [i, tag] of (info.tags || []).entries()) {
            const width = Math.min(r.w - 32, p.shape(tag.label, 12).width + 14);
            if (tx + width > r.x + r.w - 16) {
              yy += 28;
              tx = r.x + 16;
            }
            const tagBox = box(tx, yy - 15, width, 22);
            p.rr(tagBox, 4, p.colors.tag);
            this.button(
              "tag-" + i,
              tag.label,
              tagBox,
              () => {
                this.close(false);
                this.host.tag(tag.label);
              },
              null,
              false,
              false,
              null,
              false,
            );
            p.fadeText(tag.label, tx + 7, yy, width - 14, 12, p.colors.fg2);
            tx += width + 4;
          }
          let body =
            info.description?.text || info.description || info.body || "";
          if (info.description?.format === "html")
            body = new DOMParser().parseFromString(body, "text/html").body
              .textContent;
          yy += 36;
          let linkIndex = 0;
          for (const line of this.wrap(String(body), r.w - 32, 13)) {
            let xx = r.x + 16;
            for (const part of line.split(/(https?:\/\/[^\s]+)/g)) {
              const width = p.shape(part, 13).width;
              p.text(part, xx, yy, 13, p.colors.fg2);
              if (/^https?:\/\//.test(part)) {
                const link = this.button(
                  "body-link-" + linkIndex++,
                  part,
                  box(xx, yy - 14, Math.min(width, r.x + r.w - 16 - xx), 22),
                  null,
                  null,
                  false,
                  false,
                  part,
                  false,
                );
                link.removeAttribute("download");
                link.target = "_blank";
                link.rel = "noreferrer";
              }
              xx += width;
            }
            yy += 20;
          }
          yy += 8;
          this.infoMax = Math.max(0, yy + this.infoScroll - (r.y + r.h - 52));
        },
        box(r.x, r.y, r.w, Math.max(0, r.h - 52)),
      );
      for (const [id, el] of this.buttons)
        if (
          id === "author" ||
          id === "all-pages" ||
          id === "source" ||
          id === "path" ||
          id.startsWith("tag-") ||
          id.startsWith("body-link-")
        ) {
          const top = parseFloat(el.style.top),
            bottom = top + parseFloat(el.style.height);
          el.hidden = top < r.y || bottom > r.y + r.h - 52;
        }
      const background = box(r.x + 16, r.y + r.h - 42, r.w - 32, 28);
      p.rr(background, t.controlRadius, p.colors.tag);
      this.button("background", "设为背景", background, () =>
        this.host.background(this.media[this.page]?.thumbnailUrl, {
          work: this.work.stableId,
          media: this.media[this.page]?.relativePath,
        }),
      );
    }
    if (!this.chrome.target) {
      for (const el of this.buttons.values()) {
        el.hidden = true;
      }
      this.range.hidden = true;
    }
  }
  wrap(value, width, size) {
    return wrapWords(value, width, (text) => this.p.shape(text, size).width);
  }
  tick(dt, reduced) {
    for (const s of [
      this.info,
      this.chrome,
      this.full,
      this.progress,
      this.zoom,
      this.panX,
      this.panY,
      this.direction,
      this.thumbs,
    ])
      s.tick(dt, reduced);
    this.alpha.tick(dt);
    this.arrows.tick(dt);
    this.pageFade.tick(dt);
    const animated = this.original;
    if (this.opened && animated?.codec && !animated.finished) {
      animated.elapsed += dt * 1000;
      if (
        animated.elapsed >= Math.max(20, animated.codec.currentFrameDuration())
      ) {
        animated.elapsed = 0;
        if (animated.codec.decodeNextFrame() < 0) {
          const repeat = animated.codec.getRepetitionCount();
          if (repeat >= 0 && animated.repeats++ >= repeat)
            animated.finished = true;
          else animated.codec.reset();
        }
        if (!animated.finished) {
          const frame = animated.codec.makeImageAtCurrentFrame();
          if (frame) {
            animated.img.delete();
            animated.img = frame;
          }
        }
      }
    }
    if (this.frameBox) tickBounds(this.frameBox, dt, reduced);
    if (this.cropBox) tickBounds(this.cropBox, dt, reduced);
    if (this.closing && !this.progress.active && this.alpha.x === 0) {
      this.closing = false;
      this.root.hidden = this.canvas.hidden = true;
    }
  }
  get active() {
    return (
      !!(this.opened || this.closing) &&
      ((this.opened && this.original?.codec && !this.original.finished) ||
        [
          this.info,
          this.chrome,
          this.full,
          this.progress,
          this.zoom,
          this.panX,
          this.panY,
          this.direction,
          this.thumbs,
        ].some((s) => s.active) ||
        this.alpha.time < this.alpha.duration ||
        this.arrows.time < this.arrows.duration ||
        this.pageFade.time < this.pageFade.duration ||
        (this.frameBox && Object.values(this.frameBox).some((s) => s.active)) ||
        (this.cropBox && Object.values(this.cropBox).some((s) => s.active)) ||
        (this.status === "loading" &&
          performance.now() - this.loadingAt >= t.viewerLoadDelay))
    );
  }
  draw() {
    if (!this.opened && !this.closing) return;
    const p = this.p;
    if (p.w !== innerWidth || p.h !== innerHeight) p.resize();
    const g = (this.geometry = viewerGeometry(
      innerWidth,
      innerHeight,
      1 - this.full.x,
      this.info.x * clamp((this.progress.x - 0.16) / 0.84, 0, 1),
      this.chrome.x,
    ));
    for (const el of this.buttons.values()) el.viewerSeen = false;
    this.rangeSeen = false;
    p.begin({ ...themes[this.host.state.theme] });
    p.rect(box(g.x, 0, g.w, innerHeight), t.stage || "#0C0C0D", this.alpha.x);
    const image = this.original || this.preview;
    if (image && this.progress.x > 0.99 && !this.closing) {
      const safe = boundedPan(
        image.img.width(),
        image.img.height(),
        g.stage,
        this.zoom.target,
        { x: this.panX.target, y: this.panY.target },
      );
      this.panX.to(safe.x);
      this.panY.to(safe.y);
    }
    if (this.previousImage && this.pageFade.x < 1) {
      const prev = this.previousImage.img,
        fit = imageFit(prev.width(), prev.height(), g.stage);
      p.clipped(
        () =>
          p.image(
            prev,
            { ...fit, x: fit.x - this.direction.x },
            1 - this.pageFade.x,
          ),
        g.stage,
      );
    }
    if (image) {
      p.clipped(
        () => p.image(image.blur, g.stage, 0.35 * this.alpha.x),
        g.stage,
      );
      const fit = imageFit(
        image.img.width(),
        image.img.height(),
        g.stage,
        this.zoom.x,
        { x: this.panX.x, y: this.panY.x },
      );
      const crop = coverCrop(
          image.img.width(),
          image.img.height(),
          this.origin.w / this.origin.h,
        ),
        u = this.progress.x;
      const target = this.closing
        ? this.origin
        : { ...fit, x: fit.x + this.direction.x };
      this.frameBox ||= bounds(
        this.origin.x,
        this.origin.y,
        this.origin.w,
        this.origin.h,
        6,
      );
      targetBounds(this.frameBox, { ...target, r: this.closing ? 6 : 0 });
      this.cropBox ||= bounds(crop.x, crop.y, crop.w, crop.h, 0);
      targetBounds(
        this.cropBox,
        this.closing ? crop : box(0, 0, image.img.width(), image.img.height()),
      );
      p.clipped(
        () =>
          p.imageMorph(
            image.img,
            readBounds(this.frameBox),
            readBounds(this.cropBox),
            this.frameBox.r.x,
            (this.closing && !this.coverFirst ? u : 1) *
              (this.previousImage ? this.pageFade.x : 1),
          ),
        g.stage,
      );
    }
    const video =
      this.media?.[this.page]?.type === "video" ||
      this.media?.[this.page]?.kind === "video";
    this.video.hidden = !video || !this.opened || this.status !== "ready";
    if (!this.video.hidden)
      Object.assign(this.video.style, {
        left: g.stage.x + "px",
        top: g.stage.y + "px",
        width: g.stage.w + "px",
        height: g.stage.h + "px",
      });
    this.hit.hidden = video;
    Object.assign(this.hit.style, {
      left: g.stage.x + "px",
      top: g.stage.y + "px",
      width: g.stage.w + "px",
      height: g.stage.h + "px",
    });
    const feedback = viewerFeedbackArea(
      g,
      this.info.x > 0.001 && this.chrome.x > 0.001,
    );
    const loading =
      this.status === "loading" &&
      originalProgress(feedback, performance.now() - this.loadingAt);
    if (loading) p.rect(loading, themes.dark.fg2, 0.65);
    const back = p.snapshot();
    const ui = p.layer(() => {
      if (this.status === "error" || this.status === "empty") {
        const label =
          this.status === "error"
            ? "加载失败：" + this.reason
            : "这个作品没有图片或视频";
        const panel = box(
          feedback.x +
            (feedback.w -
              Math.min(t.viewerErrorWidth, feedback.w - t.pad * 2)) /
              2,
          feedback.y + feedback.h / 2 - t.viewerErrorHeight / 2,
          Math.min(t.viewerErrorWidth, feedback.w - t.pad * 2),
          t.viewerErrorHeight,
        );
        p.glass(panel, t.popRadius, back);
        p.fadeText(
          label,
          panel.x + 16,
          panel.y + 32,
          panel.w - 32,
          14,
          p.colors.fg2,
        );
        if (this.status === "error") {
          const retry = box(panel.x + (panel.w - 80) / 2, panel.y + 54, 80, 34);
          p.rr(retry, t.controlRadius, p.colors.tag);
          this.button("retry", "重试", retry, () =>
            this.media ? this.loadPage() : this.open(this.work),
          );
        }
      }
      this.drawUI(g, back);
      if (
        this.chrome.target &&
        !(g.mobile && this.info.x > 0.001) &&
        this.arrows.x > 0.01
      )
        for (const [d, x] of [
          [-1, g.stage.x + 12],
          [1, g.stage.x + g.stage.w - 46],
        ]) {
          const r = box(x, g.stage.y + (g.stage.h - 34) / 2, 34, 34);
          p.glass(r, 17, back, this.arrows.x);
          const el = this.button(
            d < 0 ? "previous-page" : "next-page",
            d < 0 ? "上一页" : "下一页",
            r,
            () => this.flip(d),
            d < 0 ? "left" : "right",
          );
          if (video) {
            el.classList.add("video-arrow");
            el.style.opacity = String(this.arrows.x);
          } else el.classList.remove("video-arrow");
        }
    });
    for (const el of this.buttons.values())
      if (!el.viewerSeen) el.hidden = true;
    if (!this.rangeSeen) this.range.hidden = true;
    const theme = this.host.state.theme;
    if (this.drawnTheme && this.drawnTheme !== theme) {
      this.themeOld?.delete();
      this.themeOld = this.lastUI;
      this.lastUI = null;
      this.themeFade = new Fade(0, 0.3);
      this.themeFade.to(1);
    }
    this.drawnTheme = theme;
    this.themeFade?.tick(this.host.dt || 0.016);
    p.composite(ui);
    if (this.themeOld) {
      p.composite(this.themeOld, 1 - this.themeFade.x);
      if (this.themeFade.x === 1) {
        this.themeOld.delete();
        this.themeOld = null;
      }
    }
    this.lastUI?.delete();
    this.lastUI = ui;
    p.end();
    if (this.themeOld) this.host.request();
  }
}
