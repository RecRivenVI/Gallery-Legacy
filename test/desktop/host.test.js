"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

// The scene uses actual Electron/Go identities and an explicit synthetic root.
// It cannot default to a user's instance or activate their desktop.
test(
  "manager-owned service, hide/quit and four-page operations",
  {
    skip:
      !process.env.GALLERY_NATIVE_LOADER ||
      !process.env.GALLERY_LIFECYCLE_EVIDENCE,
  },
  async () => {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.resolve("tools/validation/manager-browser.mjs")],
        {
          env: process.env,
          stdio: "inherit",
          windowsHide: true,
        },
      );
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0);
  },
);
