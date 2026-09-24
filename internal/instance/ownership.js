"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  net = require("node:net"),
  crypto = require("node:crypto"),
  cp = require("node:child_process");
const { readJson, writeJson } = require("./files.js");
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw Object.assign(new Error("Invalid process ID"), {
      code: "OWNER_INVALID",
    });
  if (!alive(pid)) return null;
  if (process.platform !== "win32")
    throw Object.assign(new Error("Windows runtime required"), {
      code: "PLATFORM_UNSUPPORTED",
    });
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p -and $p.ExecutablePath){[pscustomobject]@{pid=$p.ProcessId;start=$p.CreationDate.ToUniversalTime().Ticks.ToString();exe=$p.ExecutablePath.ToLowerInvariant()}|ConvertTo-Json -Compress}`;
  try {
    const raw = cp
      .execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 10000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      )
      .trim();
    if (raw) return JSON.parse(raw);
    if (!alive(pid)) return null;
  } catch {
    if (!alive(pid)) return null;
  }
  throw Object.assign(new Error("Process owner cannot be verified"), {
    code: "OWNER_UNVERIFIABLE",
  });
}
function sameIdentity(a, b) {
  return (
    !!a && !!b && a.pid === b.pid && a.start === b.start && a.exe === b.exe
  );
}
// Status liveness checks must not block the HTTP event loop on a CIM process.
// Authority-changing operations still use the fresh synchronous identity above.
async function processIdentityAsync(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Object.assign(new Error("Invalid process ID"), {code:"OWNER_INVALID"});
  if (!alive(pid)) return null;
  if (process.platform !== "win32") throw Object.assign(new Error("Windows runtime required"), {code:"PLATFORM_UNSUPPORTED"});
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p -and $p.ExecutablePath){[pscustomobject]@{pid=$p.ProcessId;start=$p.CreationDate.ToUniversalTime().Ticks.ToString();exe=$p.ExecutablePath.ToLowerInvariant()}|ConvertTo-Json -Compress}`;
  try {
    const raw=await new Promise((resolve,reject)=>cp.execFile("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{encoding:"utf8",windowsHide:true,timeout:10000},(error,stdout)=>error?reject(error):resolve(stdout.trim())));
    if(raw)return JSON.parse(raw);
  } catch { /* A failed lookup is not proof of death. */ }
  if(!alive(pid))return null;
  throw Object.assign(new Error("Process owner cannot be verified"),{code:"OWNER_UNVERIFIABLE"});
}
function pipeName(config, kind = "runtime") {
  return "\\\\.\\pipe\\gallery-" + crypto.createHash("sha256")
    .update(path.resolve(config.instanceRoot).toLowerCase() + "/" + kind).digest("hex").slice(0, 32);
}
async function acquireOwnership(config, kind = "runtime", onRequest = null) {
  if (!["runtime", "scan", "scan-launch", "maintenance", "soak", "validation", "validation-launch", "manager-test"].includes(kind))
    throw new TypeError("Unsupported ownership scope");
  const identity = processIdentity(process.pid),
    token = crypto.randomUUID();
  const connections = new Set();
  const guard = net.createServer((socket) => {
    if (!onRequest) return socket.destroy();
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(10000, () => socket.destroy());
    let input = "", handled = false;
    socket.on("data", async (chunk) => {
      if (handled) return;
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > 4096) return socket.destroy();
      if (!input.includes("\n")) return;
      handled = true;
      try {
        const request = JSON.parse(input.trim());
        if (request.instanceId !== config.instanceId || request.token !== token) throw new Error("CONTROL_FORBIDDEN");
        const data = await onRequest(request);
        socket.end(JSON.stringify({ ok: true, instanceId: config.instanceId, identity, data }) + "\n");
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, code: /^[A-Z0-9_]{1,64}$/.test(error.code || "") ? error.code : "CONTROL_FORBIDDEN" }) + "\n");
      }
    });
  });
  await new Promise((resolve, reject) => {
    guard.once("error", (error) =>
      reject(
        Object.assign(new Error("Instance already owned"), {
          code: "INSTANCE_IN_USE",
          scope: kind,
          osCode: error.code,
          cause: error,
        }),
      ),
    );
    guard.listen(pipeName(config, kind), resolve);
  });
  const file = path.join(config.stateRoot, kind + ".lock");
  let recovered = false;
  try {
    const previous = readJson(file);
    if (previous) {
      if (!previous.identity || !previous.token)
        throw Object.assign(new Error("Unverifiable lock"), {
          code: "OWNER_UNVERIFIABLE",
        });
      const actual = processIdentity(previous.identity.pid);
      if (sameIdentity(actual, previous.identity))
        throw Object.assign(new Error("Live owner"), {
          code: "INSTANCE_IN_USE",
          scope: kind,
        });
      recovered = true;
    }
    writeJson(file, { kind, instanceId: config.instanceId, identity, token });
  } catch (e) {
    await new Promise((resolve) => guard.close(resolve));
    throw e;
  }
  let released = false;
  return {
    identity,
    recovered,
    async release() {
      if (released) return;
      released = true;
      // Keep the ownership record authoritative until the named pipe has
      // actually closed. Unlinking first exposes a Windows interval where the
      // lock file is absent but a new owner still cannot bind the pipe.
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => guard.close(resolve));
      const current = readJson(file);
      if (current?.token === token) fs.unlinkSync(file);
      // libuv reports server.close() before the Windows named-pipe teardown is
      // necessarily observable by a different process. Yield one check phase
      // before making release completion externally visible.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
module.exports = { alive, processIdentity, processIdentityAsync, sameIdentity, acquireOwnership, pipeName };
