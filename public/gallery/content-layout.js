import { t } from "./tokens.js";
// Content layout rules shared by the gallery and its functional tests.
export function wrapWords(value, width, measure) {
  const lines = [];
  for (const paragraph of String(value).split("\n")) {
    let line = "";
    const segments = paragraph
      .split(/(https?:\/\/[^\s]+)/g)
      .flatMap((part) =>
        /^https?:\/\//.test(part)
          ? [part]
          : [
              ...new Intl.Segmenter(undefined, { granularity: "word" }).segment(
                part,
              ),
            ].map((s) => s.segment),
      );
    for (const segment of segments) {
      if (line.trim() && measure(line + segment) > width) {
        lines.push(line.trimEnd());
        line = segment.trimStart();
      } else line += segment;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
export function authorCollage(area, count) {
  const { x, y, w, h } = area,
    gap = t.collageGap;
  if (!count) return [];
  if (count === 1) return [area];
  if (count === 2)
    return [0, 1].map((i) => ({
      x: x + (i * (w + gap)) / 2,
      y,
      w: (w - gap) / 2,
      h,
    }));
  const left = ((w - gap) * 2) / 3,
    right = w - gap - left;
  return [
    { x, y, w: left, h },
    { x: x + left + gap, y, w: right, h: (h - gap) / 2 },
    { x: x + left + gap, y: y + (h + gap) / 2, w: right, h: (h - gap) / 2 },
  ];
}
export function originalProgress(area, elapsed) {
  if (elapsed < t.viewerLoadDelay) return null;
  const length = area.w * t.viewerProgressShare,
    phase =
      ((elapsed - t.viewerLoadDelay) % t.viewerProgressPeriod) /
      t.viewerProgressPeriod;
  const start = (area.w + length) * phase - length;
  return {
    x: area.x + Math.max(0, start),
    y: area.y + area.h - t.viewerProgressHeight,
    w: Math.max(0, Math.min(area.w, start + length) - Math.max(0, start)),
    h: t.viewerProgressHeight,
  };
}
