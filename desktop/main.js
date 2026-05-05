"use strict";

// Native host only. All product operations use the versioned HTTP protocol.
const { app, BrowserWindow, ipcMain, shell, Tray, Menu } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const readline = require("node:readline");

const cli = path.resolve(__dirname, "../cmd/gallery/main.js");
const nodeExecutable = process.env.GALLERY_NODE || "node";
const option = process.argv.indexOf("--config");
const configArgs =
  option < 0 ? [] : ["--config", path.resolve(process.argv[option + 1])];
// Use Node's SQLite ABI, not Electron's different native-module ABI.
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
let connection,
  owned,
  window,
  tray,
  quitting = false;

function invokeConnection() {
  return JSON.parse(
    execFileSync(nodeExecutable, [cli, "connection", ...configArgs], {
      encoding: "utf8",
      windowsHide: true,
      env: childEnv,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
}
async function healthy() {
  try {
    const response = await fetch(connection.url + "/api/v1/health", {
      signal: AbortSignal.timeout(3000),
    });
    const value = await response.json();
    return (
      response.ok &&
      value.protocolVersion === 1 &&
      value.data?.ready === true &&
      value.data.instanceId === connection.instanceId
    );
  } catch {
    return false;
  }
}
async function startRuntime() {
  if (await healthy()) return;
  const child = spawn(nodeExecutable, [cli, "serve", "--host", ...configArgs], {
    env: {
      ...childEnv,
      TEMP: path.join(connection.instanceRoot, "temp"),
      TMP: path.join(connection.instanceRoot, "temp"),
    },
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  owned = child;
  await new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: child.stdout });
    const timeout = setTimeout(
      () => reject(new Error("Runtime startup timed out")),
      180000,
    );
    function fail() {
      clearTimeout(timeout);
      lines.close();
      reject(new Error("Runtime startup failed"));
    }
    child.once("error", fail);
    child.once("exit", fail);
    lines.on("line", (line) => {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (value.event === "ready") {
        clearTimeout(timeout);
        child.removeListener("error", fail);
        child.removeListener("exit", fail);
        lines.close();
        child.stdin.write(
          JSON.stringify({ type: "manager", pid: process.pid }) + "\n",
        );
        resolve();
      }
    });
  });
  child.once("exit", () => {
    if (owned === child) owned = null;
  });
}
async function stopOwned() {
  const child = owned;
  owned = null;
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
    }, 15000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin.on("error", () => {});
    child.stdin.end('{"type":"manager","pid":null}\n{"type":"stop"}\n');
  });
}
function trusted(event) {
  if (
    !window ||
    event.sender !== window.webContents ||
    !event.senderFrame?.url.startsWith(connection.url + "/manage")
  ) {
    throw new Error("HOST_CALL_FORBIDDEN");
  }
}
function handleHost(channel, handler) {
  ipcMain.handle(channel, async (event) => {
    try {
      trusted(event);
      await handler();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        code:
          error.message === "ATTACHED_RUNTIME_NOT_OWNED"
            ? "ATTACHED_RUNTIME_NOT_OWNED"
            : "HOST_REQUEST_FAILED",
      };
    }
  });
}
async function main() {
  connection = invokeConnection();
  const data = path.join(connection.instanceRoot, "desktop-data");
  for (const child of [
    data,
    path.join(data, "session"),
    path.join(data, "crashes"),
    path.join(connection.instanceRoot, "temp"),
  ])
    fs.mkdirSync(child, { recursive: true });
  app.setPath("userData", data);
  app.setPath("sessionData", path.join(data, "session"));
  app.setPath("crashDumps", path.join(data, "crashes"));
  app.setPath("temp", path.join(connection.instanceRoot, "temp"));
  app.setAppLogsPath(path.join(connection.instanceRoot, "logs", "desktop"));
  if (!app.requestSingleInstanceLock()) return app.quit();
  await app.whenReady();
  await startRuntime();
  window = new BrowserWindow({
    width: 1180,
    height: 830,
    show: false,
    icon: path.resolve(__dirname, "../frontend/assets/app-icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(connection.url + "/manage")) event.preventDefault();
  });
  handleHost("host:open-gallery", () => {
    return shell.openExternal(connection.url);
  });
  handleHost("host:restart", async () => {
    if (!owned) throw new Error("ATTACHED_RUNTIME_NOT_OWNED");
    await stopOwned();
    await startRuntime();
    await window.loadURL(connection.url + "/manage");
  });
  await window.loadURL(connection.url + "/manage");
  window.show();
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  tray = new Tray(path.resolve(__dirname, "../frontend/assets/app-icon.ico"));
  tray.setToolTip("Gallery");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Manager", click: () => window?.show() },
      { label: "Gallery", click: () => shell.openExternal(connection.url) },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("double-click", () => window?.show());
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void stopOwned().finally(() => {
      tray?.destroy();
      app.quit();
    });
  });
}
main().catch(async () => {
  process.stderr.write("DESKTOP_START_FAILED\n");
  await stopOwned();
  app.exit(1);
});
