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
async function acquireOwnership(config, kind = "runtime") {
  if (!["runtime", "scan"].includes(kind))
    throw new TypeError("Unsupported ownership scope");
  const identity = processIdentity(process.pid),
    token = crypto.randomUUID();
  const name = crypto
    .createHash("sha256")
    .update(path.resolve(config.instanceRoot).toLowerCase() + "/" + kind)
    .digest("hex")
    .slice(0, 32);
  const guard = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    guard.once("error", () =>
      reject(
        Object.assign(new Error("Instance already owned"), {
          code: "INSTANCE_IN_USE",
        }),
      ),
    );
    guard.listen("\\\\.\\pipe\\gallery-" + name, resolve);
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
        });
      recovered = true;
    }
    writeJson(file, { kind, identity, token });
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
      try {
        const current = readJson(file);
        if (current?.token === token) fs.unlinkSync(file);
      } finally {
        await new Promise((resolve) => guard.close(resolve));
      }
    },
  };
}
module.exports = { alive, processIdentity, sameIdentity, acquireOwnership };
