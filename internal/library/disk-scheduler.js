"use strict";
const path = require("node:path"), cp = require("node:child_process");

function createLimiter(limit, checkCancelled = () => {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) {
    throw new TypeError("Invalid IO concurrency");
  }
  let active = 0, peak = 0;
  const waiting = [];
  async function run(fn) {
    checkCancelled();
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    else active++;
    peak = Math.max(peak, active);
    try {
      checkCancelled();
      return await fn();
    } finally {
      if (waiting.length) waiting.shift()();
      else active--;
    }
  }
  return {
    run,
    stats: () => ({ active, peak, waiting: waiting.length, limit }),
  };
}

// Only topology/type is used; serial numbers and private roots never enter reports.
async function discoverDisks() {
  if (process.platform !== "win32") return [];
  const script =
    "$ErrorActionPreference='Stop'; $physical=@(Get-PhysicalDisk); $result=@(Get-Partition | Where-Object DriveLetter | ForEach-Object { $part=$_; $disk=$part | Get-Disk; $matches=@($physical | Where-Object { ($disk.UniqueId -and $_.UniqueId -eq $disk.UniqueId) -or ($disk.SerialNumber -and $_.SerialNumber -and $_.SerialNumber.Trim() -eq $disk.SerialNumber.Trim()) }); $kind='unknown'; if($disk.BusType -eq 'NVMe'){$kind='ssd'} elseif($matches.Count -eq 1){if($matches[0].MediaType -eq 'SSD'){$kind='ssd'} elseif($matches[0].MediaType -eq 'HDD'){$kind='hdd'}}; [pscustomobject]@{letter=[string]$part.DriveLetter;disk=[string]$disk.Number;type=$kind} }); ConvertTo-Json -Compress -InputObject $result";
  try {
    return await new Promise((resolve) =>
      cp.execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, encoding: "utf8", timeout: 10000 },
        (error, stdout) => {
          try {
            resolve(error ? [] : JSON.parse(stdout));
          } catch {
            resolve([]);
          }
        },
      )
    );
  } catch {
    return [];
  }
}

async function diskProfiles(
  roots,
  {
    disks = null,
    storageTypes = {},
    ssdIo = 32,
    hddIo = 2,
    unknownIo = 2,
    workWindow = 8,
  } = {},
) {
  const inventory = disks || await discoverDisks();
  const profiles = {}, groups = new Map();
  for (const [platformId, root] of Object.entries(roots)) {
    const drive = path.win32.parse(root).root.replaceAll("/", "\\");
    const matches = inventory.filter((d) =>
      drive.toLowerCase() === String(d.letter).toLowerCase() + ":\\"
    );
    const device = matches.length === 1 ? matches[0] : null;
    // Unknown mappings share one conservative budget rather than guessing disks.
    const key = device ? "disk-" + device.disk : "unknown";
    const kind = storageTypes[platformId] || device?.type || "unknown";
    if (!["ssd", "hdd", "unknown"].includes(kind)) {
      throw new TypeError("Invalid storage type");
    }
    let group = groups.get(key);
    if (group && group.type !== kind) group.type = "unknown";
    if (!group) {
      group = { id: key, type: kind };
      groups.set(key, group);
    }
    profiles[platformId] = group;
  }
  for (const group of groups.values()) {
    group.ioLimit = group.type === "ssd"
      ? ssdIo
      : group.type === "hdd"
      ? hddIo
      : unknownIo;
    group.workWindow = group.type === "ssd" ? workWindow : 1;
    if (
      !Number.isInteger(group.workWindow) || group.workWindow < 1 ||
      group.workWindow > 32
    ) throw new TypeError("Invalid work window");
  }
  return profiles;
}
module.exports = { createLimiter, diskProfiles };
