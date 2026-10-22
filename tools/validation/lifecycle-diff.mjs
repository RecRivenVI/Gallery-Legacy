import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, "../..");
const root = process.env.GALLERY_TEST_ROOT;
const reference = process.env.GALLERY_NODE_REFERENCE_ROOT;
const output = process.env.GALLERY_LIFECYCLE_EVIDENCE;
if (!root || !reference || !output || path.resolve(reference) === repo)
  throw Error("explicit synthetic root, frozen Node and evidence required");
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(output, { recursive: true });
const work = fs.mkdtempSync(path.join(root, "Lifecycle-"));
const { prepare } = require("./prepare.cjs");
const input = await prepare(path.join(work, "Input"));
// Non-work entries must remain visible in inspection findings, not become works.
fs.writeFileSync(
  path.join(input.config.sources.pixiv, "ignored.txt"),
  "synthetic non-work entry",
);
fs.writeFileSync(
  path.join(input.config.sources.pixiv, "700", "ignored.txt"),
  "synthetic author entry",
);
const { freePort } = require("../../test/support/runtime.js");
const frozenControl = require(path.join(reference, "src/runtime/control.js"));
const ownership = require(path.join(reference, "src/instance/ownership.js"));
const { normalizeRuntimeConfig, ensureLayout } = require(
  path.join(reference, "src/instance/config.js"),
);
const assets =
  process.env.GALLERY_ASSETS_ROOT || path.join(reference, "resources");
const observations = [];
function command(program, args, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GALLERY_ASSETS_ROOT: assets },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}
async function pipe(c, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(ownership.pipeName(c));
    let text = "";
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (b) => (text += b));
    socket.once("end", () => resolve(JSON.parse(text)));
    socket.once("error", reject);
  });
}
for (const kind of ["Node"]) {
  const instanceRoot = path.join(work, kind);
  const raw = {
    instanceRoot,
    sources: input.config.sources,
    port: await freePort(),
    liveUpdates: true,
    retention: { enabled: false },
  };
  const c = normalizeRuntimeConfig(raw);
  ensureLayout(c);
  const file = path.join(instanceRoot, "config.json");
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
  const prefix = [path.join(reference, "bin/gallery.cjs")];
  const program = process.execPath;
  const args = (...commands) => [...prefix, ...commands, "--config", file];
  const invoke = async (commands, value) => {
    const result = await command(
      program,
      args(...commands),
      value === undefined ? "" : JSON.stringify(value),
    );
    if (result.code !== 0)
      throw Object.assign(Error(result.stderr), { code: result.stderr.trim() });
    return JSON.parse(result.stdout);
  };
  const failure = async (commands, value) => {
    const r = await command(
      program,
      args(...commands),
      JSON.stringify(value || {}),
    );
    assert.notEqual(r.code, 0);
    return r.stderr.trim();
  };
  let started = false;
  try {
    const connection = await invoke(["connection"]);
    assert.equal(connection.instanceId, c.instanceId);
    const ready = await invoke(["start"]);
    started = true;
    assert.equal(ready.state, "READY");
    const again = await invoke(["start"]);
    assert.equal(again.pid, ready.pid);
    // Preserve the frozen Node reference; manager-bound behavior is checked separately.
    const verified = await frozenControl.control(c, "status");
    assert.equal(verified.pid, ready.pid);
    const duplicate = await failure(["serve"]);
    assert.equal(duplicate, "INSTANCE_IN_USE");
    const record = JSON.parse(
      fs.readFileSync(path.join(c.stateRoot, "runtime.lock")),
    );
    const denied = [];
    for (const req of [
      { ...record, token: "wrong", operation: "stop" },
      { ...record, instanceId: "another-instance", operation: "stop" },
      { ...record, operation: "invalid" },
    ])
      denied.push((await pipe(c, req)).code);
    assert.deepEqual(denied, [
      "CONTROL_FORBIDDEN",
      "CONTROL_FORBIDDEN",
      "CONTROL_OPERATION_INVALID",
    ]);
    await invoke(["control", "manager", "--manager-pid", String(process.pid)]);
    assert.equal((await invoke(["status"])).managerPid, process.pid);
    await invoke(["control", "manager"]);
    assert.equal((await invoke(["status"])).managerPid, null);
    const invalid = [];
    for (const value of [
      {},
      { confirmReadOnly: true, mode: "unknown" },
      { confirmReadOnly: true, platformIds: [] },
      { confirmReadOnly: true, platformIds: ["pixiv", "pixiv"] },
      {
        confirmReadOnly: true,
        platformId: "pixiv",
        authorDirectoryName: "../escape",
      },
    ])
      invalid.push(await failure(["manage", "scan.start"], value));
    assert.deepEqual(invalid, [
      "READ_ONLY_CONFIRMATION_REQUIRED",
      "SCAN_MODE_INVALID",
      "SCAN_PLATFORM_INVALID",
      "SCAN_PLATFORM_INVALID",
      "AUTHOR_DIRECTORY_INVALID",
    ]);
    const first = await invoke(["manage", "scan.start"], {
      confirmReadOnly: true,
      mode: "full",
    });
    assert(first.started);
    let scan;
    const deadline = Date.now() + 120000;
    do {
      scan = await invoke(["manage", "scan.status"]);
      if (!scan.running) break;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < deadline);
    assert.equal(scan.state, "READY", JSON.stringify(scan));
    assert.equal(scan.counts.worksCommitted, 71);
    const response = await fetch(c.url + "/api/v1/status");
    const status = await response.json();
    assert.equal(status.data.counts.works, 71);
    assert.equal(status.data.counts.media, 284);
    const config = await invoke(["manage", "config.read"]);
    const stale = await failure(["manage", "config.save"], {
      confirm: true,
      revision: "wrong",
      value: config.value,
    });
    assert.equal(stale, "CONFIG_REVISION_CHANGED");
    const stopped = await invoke(["stop"]);
    started = false;
    assert.equal(stopped.state, "STOPPED");
    await invoke(["start"]);
    started = true;
    assert.equal((await invoke(["status"])).counts.works, 71);
    observations.push({
      kind,
      connection: true,
      duplicate,
      denied,
      invalid,
      works: scan.counts.worksCommitted,
      media: status.data.counts.media,
      serviceReopened: true,
      configurationConflict: stale,
    });
  } finally {
    if (started) await invoke(["stop"]);
  }
}

fs.writeFileSync(
  path.join(output, "lifecycle-minimal.json"),
  JSON.stringify(
    {
      conclusion: "冻结 Node 参考",
      scope:
        "reference protocol and data; independent survival is superseded by 101",
      input: work,
      observations,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({ conclusion: "冻结 Node 参考", work, observations }),
);
