import { themes, t } from "../gallery/tokens.js";

// Native forms use the same palette and geometry as the Canvas gallery.
export function theme(mode) {
  const value = themes[mode === "light" ? "light" : "dark"];
  for (const [k, v] of Object.entries(value))
    document.documentElement.style.setProperty(
      "--" + ({ accentInk: "accent-ink" }[k] || k),
      Array.isArray(v) ? `rgba(${v.join(",")})` : v,
    );
  const pixels = {
    body: t.font,
    caption: t.caption,
    secondary: t.subtitle,
    title: t.pathFont,
    heading: t.heading,
    "panel-title": t.panelFont,
    control: t.control,
    "group-height": t.group,
    "group-pad": t.groupPad,
    "r-control": t.controlRadius,
    "r-inner": t.innerRadius,
    "r-panel": t.popRadius,
    "r-nav": t.navRadius,
    "focus-width": t.focusWidth,
    "focus-offset": t.focusOffset,
    sidebar: t.sidebar,
    header: t.header,
    blur: t.blur,
    "space-2": t.tagRadius,
    "space-4": t.inset,
    "space-8": t.gap,
    "space-12": t.smallPad,
    "space-16": t.pad,
    "space-24": t.blur,
    "field-label": t.thumb + t.doubleTextLine,
    "save-inset": t.sidebar + t.pad,
    "save-space": t.thumb + t.pad,
    "checkbox-size": t.pad,
    "log-height": t.panelWidth + t.icon,
    "dialog-width": t.sidebar * 2,
    "tool-width": t.largeCardWidth,
    "switch-width": t.switchWidth,
    "switch-height": t.switchHeight,
    "switch-knob": t.switchDiameter,
    "switch-travel": t.switchTravel,
  };
  for (const [key, value] of Object.entries(pixels))
    document.documentElement.style.setProperty("--" + key, value + "px");
  for (const [key, value] of Object.entries({
    "switch-knob-color": t.white,
    "switch-off": t.switchOffAlpha,
    "disabled-opacity": 0.35,
    "busy-opacity": 0.6,
    "panel-backdrop": "rgba(0,0,0,.33)",
    "fade-duration": t.fade + "s",
  }))
    document.documentElement.style.setProperty("--" + key, value);
  document.documentElement.style.colorScheme = mode;
}
