"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs");
const { prepare, testRoot } = require("./prepare.cjs");
const { fullScan } = require("../../src/indexing/runner.cjs");
const { spawn } = require("node:child_process");
test(
  "scanner cancels when its owning control pipe closes",
  { timeout: 30000 },
  async () => {
    const demo = await prepare(
      path.join(testRoot, "GalleryGoControl-" + Date.now()),
    );
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.env.GALLERY_GO_ACCEPTANCE_EXE,
        [
          "--config",
          path.join(demo.config.instanceRoot, "go-scan.json"),
          "--synthetic-delay-ms",
          "20",
        ],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      let text = "",
        closed = false;
      child.stdout.on("data", (chunk) => {
        text += chunk.toString();
        if (!closed && text.includes("\n")) {
          closed = true;
          child.stdin.end();
        }
      });
      child.stderr.on("data", () => {});
      child.once("error", reject);
      child.once("close", (code) =>
        resolve({ code, last: JSON.parse(text.trim().split("\n").at(-1)) }),
      );
    });
    assert.notEqual(result.code, 0);
    assert.equal(result.last.state, "CANCELLED");
  },
);
test(
  "formal dispatcher runs Go live full and unchanged incremental scans",
  { timeout: 120000 },
  async () => {
    const demo = await prepare(
      path.join(testRoot, "GalleryGoDispatch-" + Date.now()),
    );
    const previous = process.env.GALLERY_SCANNER;
    process.env.GALLERY_SCANNER = process.env.GALLERY_GO_ACCEPTANCE_EXE;
    try {
      const full = await fullScan(demo.config, {
        confirmReadOnly: true,
        mode: "full",
      });
      assert.equal(full.scanner, "go");
      assert.equal(full.catalog.workCount, 71);
      assert.equal(full.catalog.mediaCount, 284);
      const next = await fullScan(demo.config, {
        confirmReadOnly: true,
        mode: "incremental",
      });
      assert.equal(next.counts.worksReused, 71);
      assert.equal(next.counts.metadataReads, 0);
      assert.equal(next.counts.worksCommitted, 0);
      const status = JSON.parse(fs.readFileSync(demo.config.scanStatusPath));
      assert.equal(status.state, "READY");
      assert.equal(status.running, false);
      assert.equal(status.reusedWorks, 71);
      assert.equal(
        fs.existsSync(path.join(demo.config.stateRoot, "scan.lock")),
        false,
      );
    } finally {
      if (previous === undefined) delete process.env.GALLERY_SCANNER;
      else process.env.GALLERY_SCANNER = previous;
    }
  },
);
