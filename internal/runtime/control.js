"use strict";
const fs = require("node:fs"), path = require("node:path"), net = require("node:net"), cp = require("node:child_process");
const { readJson } = require("../instance/files.js");
const { ensureLayout } = require("../instance/config.js");
const { pipeName, processIdentity, sameIdentity } = require("../instance/ownership.js");
function fail(code) { throw Object.assign(new Error(code), { code }); }
function owner(config) {
  const lock = readJson(path.join(config.stateRoot, "runtime.lock"));
  if (!lock) return null;
  if (lock.instanceId !== config.instanceId || !lock.token || !lock.identity) fail("OWNER_UNVERIFIABLE");
  return sameIdentity(processIdentity(lock.identity.pid), lock.identity) ? lock : null;
}
async function control(config, operation, args = {}) {
  const lock = owner(config);
  if (!lock) fail("RUNTIME_OFFLINE");
  if(operation === "status"){
    const s=readJson(config.statusPath);
    if(s?.pid===lock.identity.pid && s.state==="STARTING")return {...s,localControl:true,pending:true};
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeName(config));
    const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error("Control timeout"), { code: "CONTROL_TIMEOUT" })); }, 15000);
    let input = "";
    socket.once("connect", () => socket.write(JSON.stringify({ ...args, operation, instanceId: config.instanceId, token: lock.token }) + "\n"));
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > 1048576) socket.destroy();
    });
    socket.once("error", () => { clearTimeout(timer); reject(Object.assign(new Error("Control unavailable"), { code: "CONTROL_UNAVAILABLE" })); });
    socket.once("end", () => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(input);
        if (!value.ok) fail(value.code || "CONTROL_FAILED");
        if (value.instanceId !== config.instanceId || !sameIdentity(value.identity, lock.identity)) fail("OWNER_MISMATCH");
        resolve(value.data);
      } catch (error) { reject(error); }
    });
  });
}
async function startRuntime(config, configPath, { executable = process.execPath, cli = path.resolve(__dirname, "../../cmd/gallery/main.js"), timeoutMs = 180000 } = {}) {
  if (owner(config)) return control(config, "status");
  ensureLayout(config);
  let child;
    child = cp.spawn(executable, [cli, "serve", "--config", configPath], {
      detached: true, windowsHide: true, stdio: "ignore",
      env: { ...process.env, TEMP: config.tempRoot, TMP: config.tempRoot },
    });
  let exited = false, spawnError = false;
  child.once("exit", () => { exited = true; });
  child.once("error", () => { spawnError = true; });
  child.unref();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 750));
    if (spawnError || exited) fail(readJson(config.statusPath)?.error?.code || "START_FAILED");
    const state = readJson(config.statusPath);
    if (state?.state === "READY" && state.pid === child.pid) return control(config, "status");
    if (state?.state === "FAILED" && state.pid === child.pid) fail(state.error?.code || "START_FAILED");
  }
  // Never kill a PID on timeout. A slow validation or an already-owned instance
  // can be diagnosed/reconnected without compromising process identity.
  const preparing=readJson(config.statusPath);
  const current=owner(config);
  if(preparing?.pid===child.pid && preparing.state==="STARTING" && current?.identity?.pid===child.pid)return {...preparing,pending:true};
  fail("START_TIMEOUT");
}
async function stopRuntime(config) {
  const current = owner(config);
  if (!current) return { state: "STOPPED" };
  await control(config, "stop");
  const start = Date.now();
  while (Date.now() - start < 30000) {
    await new Promise((r) => setTimeout(r, 250));
    const lock = readJson(path.join(config.stateRoot, "runtime.lock"));
    if (!lock) return { state: "STOPPED" };
    if (lock.token !== current.token) fail("OWNER_CHANGED");
  }
  fail("STOP_TIMEOUT");
}
module.exports = { control, startRuntime, stopRuntime, owner };
