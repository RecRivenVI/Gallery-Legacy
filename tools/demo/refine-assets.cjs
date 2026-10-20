"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  cp = require("node:child_process");
const { ROOT, OUTPUT, assertOwned, environment } = require("./paths.cjs");
const { png } = require("./generate.cjs");
const inventory = JSON.parse(
  fs.readFileSync(path.join(OUTPUT, "sandbox/assets.json")),
);
function tool(cmd, args) {
  const p = cp.spawnSync(cmd, args, {
    env: environment(),
    windowsHide: true,
    timeout: 120000,
    stdio: "ignore",
  });
  if (p.status !== 0) throw new Error("DEMO_REFINEMENT_FAILED");
}
let count = 0;
for (const a of inventory.assets) {
  const dir = path.join(
    ROOT,
    "full/sources",
    a.platform,
    a.author,
    a.directory,
  );
  if (!fs.existsSync(dir)) continue;
  let width = a.width,
    height = a.height;
  if (a.format === "ico") width = height = 128;
  const id = a.id.startsWith("DUP-") ? "DUP-1" : a.id;
  for (const name of fs.readdirSync(dir)) {
    if (!/^(\d+|cover)\.png$/.test(name)) continue;
    const dest = assertOwned(path.join(dir, name));
    fs.writeFileSync(
      dest,
      png(
        id,
        width,
        height,
        a.format || "PNG",
        parseInt(name) || 1,
        parseInt(name) || 1,
      ),
    );
    count++;
  }
  if (
    a.id.startsWith("FIMG-") &&
    a.format &&
    !["png", "svg"].includes(a.format)
  )
    tool("magick", [
      path.join(dir, "1.png"),
      path.join(dir, "sample." + a.format),
    ]);
  if (a.id.startsWith("FVID-")) {
    const source = path.join(ROOT, "host/temp", a.id + ".png");
    fs.writeFileSync(assertOwned(source), png(a.id, 320, 240, a.format));
    const codecs = {
      avi: "mpeg4",
      m4v: "libx264",
      mkv: "libx264",
      mov: "libx264",
      mp4: "libx264",
      ogv: "libtheora",
      webm: "libvpx-vp9",
    };
    tool("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-loop",
      "1",
      "-i",
      source,
      "-t",
      "3",
      "-r",
      "12",
      "-an",
      "-c:v",
      codecs[a.format],
      "-pix_fmt",
      "yuv420p",
      ...(a.format === "m4v" ? ["-f", "mp4"] : []),
      "-y",
      path.join(dir, "clip." + a.format),
    ]);
  }
}
for (const sample of fs.readdirSync(path.join(OUTPUT, "sandbox/samples"))) {
  const id = path.basename(sample, ".png"),
    a = inventory.assets.find((a) => a.id === id);
  const dir = path.join(
      ROOT,
      "full/sources",
      a.platform,
      a.author,
      a.directory,
    ),
    input = path.join(dir, a.files[0]);
  if (id === "FVID-WEBM")
    tool("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      input,
      "-frames:v",
      "1",
      "-vf",
      "scale=320:240:force_original_aspect_ratio=decrease",
      "-y",
      path.join(OUTPUT, "sandbox/samples", sample),
    ]);
  else
    tool("magick", [
      input + "[0]",
      "-thumbnail",
      "320x240>",
      path.join(OUTPUT, "sandbox/samples", sample),
    ]);
}
console.log(
  JSON.stringify({
    refinedPngs: count,
    syntheticOnly: true,
    reason: "keep asset IDs inside center-crop safe area",
  }),
);
