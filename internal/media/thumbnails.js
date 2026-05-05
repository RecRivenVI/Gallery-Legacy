"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const THUMBNAIL_CACHE_VERSION = 2;
const THUMBNAIL_CONTENT_TYPE = "image/webp";

function assertInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    const error = new Error(
      `Thumbnail cache path escapes root: ${resolvedTarget}`,
    );
    error.code = "RUNTIME_THUMBNAIL_PATH_OUTSIDE_ROOT";
    throw error;
  }
  return resolvedTarget;
}

function thumbnailCacheKey(resolved) {
  const identity = JSON.stringify([
    `v${THUMBNAIL_CACHE_VERSION}`,
    resolved.platformId,
    // Surrogate IDs can be reassigned by a new generation. Bind the physical file.
    path.resolve(resolved.candidateReal).toLowerCase(),
    resolved.work.work_id.toString(),
    resolved.media.media_id.toString(),
    resolved.media.relative_path_key,
    resolved.stat.size.toString(),
    resolved.stat.mtimeNs.toString(),
  ]);
  return crypto.createHash("sha256").update(identity, "utf8").digest("hex");
}

function runThumbnailProcess(
  command,
  args,
  timeoutMs,
  { tempRoot, signal } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
      signal,
      env: {
        ...process.env,
        ...(tempRoot
          ? { TEMP: tempRoot, TMP: tempRoot, MAGICK_TEMPORARY_PATH: tempRoot }
          : {}),
      },
    });
    let settled = false;
    let processError = null;
    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    }
    const timer = setTimeout(() => {
      const error = new Error(
        `Thumbnail generation timed out after ${timeoutMs}ms`,
      );
      error.code = "RUNTIME_THUMBNAIL_TIMEOUT";
      processError = error;
      child.kill();
    }, timeoutMs);
    child.once("error", (error) => {
      processError = error;
    });
    child.once("close", (code) => {
      if (processError) return finish(reject, processError);
      if (code === 0) return finish(resolve);
      const error = new Error(`Thumbnail generator exited with ${code}`);
      error.code = "RUNTIME_THUMBNAIL_GENERATION_FAILED";
      finish(reject, error);
    });
  });
}

function generateImageWebpThumbnail({
  sourcePath,
  destinationPath,
  timeoutMs = 20_000,
  tempRoot,
  signal,
}) {
  // Separate arguments are used throughout (never a shell command). The output
  // The destination path is constrained to the caller-provided cache root.
  return runThumbnailProcess(
    "magick",
    [
      `${sourcePath}[0]`,
      "-auto-orient",
      "-thumbnail",
      "512x512>",
      "-strip",
      "-quality",
      "82",
      `webp:${destinationPath}`,
    ],
    timeoutMs,
    { tempRoot, signal },
  );
}

function generateVideoWebpThumbnail({
  sourcePath,
  destinationPath,
  timeoutMs = 30_000,
  tempRoot,
  signal,
}) {
  return runThumbnailProcess(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      sourcePath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      "scale=512:512:force_original_aspect_ratio=decrease",
      "-an",
      "-c:v",
      "libwebp",
      "-quality",
      "82",
      "-f",
      "image2",
      destinationPath,
    ],
    timeoutMs,
    { tempRoot, signal },
  );
}

function generateWebpThumbnail(options) {
  if (options.mediaType === "video") return generateVideoWebpThumbnail(options);
  return generateImageWebpThumbnail(options);
}

function createThumbnailCache({
  root,
  cacheRoot,
  tempRoot = path.join(root || ".", "temp"),
  generator = generateWebpThumbnail,
  maxConcurrent = 4,
} = {}) {
  if (typeof root !== "string" || typeof cacheRoot !== "string")
    throw new TypeError("Thumbnail cache requires root and cacheRoot");
  if (typeof generator !== "function")
    throw new TypeError("Thumbnail generator must be a function");
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)
    throw new TypeError(
      "Thumbnail maxConcurrent must be a positive safe integer",
    );
  const resolvedRoot = path.resolve(root);
  const resolvedCacheRoot = assertInside(
    resolvedRoot,
    path.join(path.resolve(cacheRoot), "thumbnails"),
  );
  fs.mkdirSync(resolvedCacheRoot, { recursive: true });
  tempRoot = assertInside(resolvedRoot, tempRoot);
  fs.mkdirSync(tempRoot, { recursive: true });
  const controller = new AbortController();
  const inFlight = new Map();
  const queue = [];
  let active = 0;

  function pump() {
    while (
      !controller.signal.aborted &&
      active < maxConcurrent &&
      queue.length > 0
    ) {
      const next = queue.shift();
      active++;
      Promise.resolve()
        .then(next.task)
        .then(next.resolve, next.reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  function schedule(task) {
    if (controller.signal.aborted)
      return Promise.reject(new Error("Thumbnail service is closed"));
    return new Promise((resolve, reject) => {
      queue.push({ reject, resolve, task });
      pump();
    });
  }

  function validCachedFile(target) {
    try {
      const stat = fs.lstatSync(target, { bigint: true });
      return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0n;
    } catch {
      return false;
    }
  }

  async function generate(resolved, target) {
    const directory = assertInside(resolvedRoot, path.dirname(target));
    fs.mkdirSync(directory, { recursive: true });
    const temporary = assertInside(
      resolvedRoot,
      `${target}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      await generator({
        sourcePath: resolved.candidateReal,
        destinationPath: temporary,
        mediaType: resolved.media.filesystem_media_type,
        tempRoot,
        signal: controller.signal,
      });
      const outputStat = fs.lstatSync(temporary, { bigint: true });
      if (
        !outputStat.isFile() ||
        outputStat.isSymbolicLink() ||
        outputStat.size === 0n
      ) {
        const error = new Error(
          "Thumbnail generator did not create a regular non-empty file",
        );
        error.code = "RUNTIME_THUMBNAIL_OUTPUT_INVALID";
        throw error;
      }
      const after = fs.lstatSync(resolved.candidateReal, { bigint: true });
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.size !== resolved.stat.size ||
        after.mtimeNs !== resolved.stat.mtimeNs
      ) {
        const error = new Error(
          "Source media changed while thumbnail was generated",
        );
        error.code = "RUNTIME_THUMBNAIL_SOURCE_CHANGED";
        throw error;
      }
      if (validCachedFile(target)) fs.rmSync(temporary, { force: true });
      else fs.renameSync(temporary, target);
      return {
        path: target,
        contentType: THUMBNAIL_CONTENT_TYPE,
        cacheStatus: "generated",
      };
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        /* best-effort instance cleanup */
      }
      throw error;
    }
  }

  async function thumbnailFor(resolved) {
    const key = thumbnailCacheKey(resolved);
    const target = assertInside(
      resolvedRoot,
      path.join(resolvedCacheRoot, key.slice(0, 2), `${key}.webp`),
    );
    if (validCachedFile(target))
      return {
        path: target,
        contentType: THUMBNAIL_CONTENT_TYPE,
        cacheStatus: "hit",
      };
    if (!inFlight.has(target)) {
      const pending = schedule(() => generate(resolved, target)).finally(() =>
        inFlight.delete(target),
      );
      inFlight.set(target, pending);
    }
    return inFlight.get(target);
  }

  async function close() {
    controller.abort();
    for (const task of queue.splice(0))
      task.reject(new Error("Thumbnail service is closed"));
    await Promise.allSettled([...inFlight.values()]);
  }
  return Object.freeze({ cacheRoot: resolvedCacheRoot, thumbnailFor, close });
}

module.exports = {
  THUMBNAIL_CACHE_VERSION,
  createThumbnailCache,
  generateImageWebpThumbnail,
  generateVideoWebpThumbnail,
  generateWebpThumbnail,
  thumbnailCacheKey,
};
