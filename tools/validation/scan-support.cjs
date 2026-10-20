"use strict";
const path = require("node:path"),
  { spawn } = require("node:child_process");
function scan(
  config,
  {
    delay = 0,
    onProgress = null,
    cancelAt = 0,
    mode = "full",
    platformIds = null,
    authorDirectoryName = null,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.GALLERY_GO_ACCEPTANCE_EXE,
      [
        "--config",
        path.join(config.instanceRoot, "go-scan.json"),
        "--mode",
        mode,
        ...(platformIds ? ["--platforms", platformIds.join(",")] : []),
        ...(authorDirectoryName ? ["--author", authorDirectoryName] : []),
        ...(delay ? ["--synthetic-delay-ms", String(delay)] : []),
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let pending = "",
      error = "",
      states = [],
      cancelled = false;
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let at;
      while ((at = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        if (!line) continue;
        const value = JSON.parse(line);
        states.push(value);
        onProgress?.(value, child);
        if (cancelAt && !cancelled && value.counts.worksCommitted >= cancelAt) {
          cancelled = true;
          child.stdin.write("cancel\n");
        }
      }
    });
    child.stderr.on("data", (c) => (error += c));
    child.once("error", reject);
    child.once("exit", (code) =>
      resolve({ code, error, states, last: states.at(-1) }),
    );
  });
}
module.exports = { scan };
