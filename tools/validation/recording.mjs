import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export async function recording(page, output, name, action) {
  const context = page.context();
  const root = path.join(output, "recording-frames", name);
  fs.mkdirSync(root, { recursive: true });
  const frames = [];
  const cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", async (f) => {
    const file = path.join(
      root,
      String(frames.length).padStart(5, "0") + ".jpg",
    );
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, time: f.metadata.timestamp });
    await cdp
      .send("Page.screencastFrameAck", { sessionId: f.sessionId })
      .catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 75,
    everyNthFrame: 1,
  });
  await page.waitForTimeout(100);
  await action();
  await page.waitForTimeout(300);
  await cdp.send("Page.stopScreencast");
  await cdp.detach();
  assert(frames.length > 1);
  const list = frames
    .map(
      (f, i) =>
        `file '${f.file.replaceAll("\\", "/")}'\nduration ${Math.min(0.2, Math.max(0.016, (frames[i + 1]?.time ?? f.time + 0.08) - f.time))}`,
    )
    .join("\n");
  const input = path.join(root, "frames.txt");
  fs.writeFileSync(input, list + "\n");
  const target = path.join(output, name + ".mp4");
  const run = spawnSync(
    process.env.GALLERY_FFMPEG || "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-n",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      input,
      "-t",
      "10",
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "26",
      "-pix_fmt",
      "yuv420p",
      target,
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr || String(run.error));
  return name + ".mp4";
}
