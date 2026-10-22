"use strict";
// Thin native host: no Catalog, scan, or process-kill implementation.
// Go validates configuration; the owned session is the sole management channel.
const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Tray,
  Menu,
  dialog,
} = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { pathToFileURL } = require("node:url");
const { trustedPage } = require("./trusted-page.js");
const { promisify } = require("node:util");
const execute = promisify(require("node:child_process").execFile);
const productRoot = app.isPackaged
  ? path.join(process.resourcesPath, "runtime")
  : path.resolve(__dirname, "../..");
const runtimeExecutable =
  process.env.GALLERY_RUNTIME ||
  path.join(productRoot, "bin/gallery-runtime.exe");
const { Backend } = require("./backend.js");
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
let configArgs = [],
  connection = null,
  window,
  tray,
  quitting = false,
  action = false,
  failure = null,
  backend = null;
const managerFile = path.join(productRoot, "public/manager/index.html");
const managerUrl = pathToFileURL(managerFile).href;
const adminOperations = new Set([
  "config.read",
  "config.validate",
  "config.save",
  "config.backups",
  "config.backup.read",
  "logs.list",
  "logs.read",
  "logs.clear",
  "reports.list",
  "reports.read",
  "storage.read",
  "cache.clear",
  "generations.list",
  "generation.validate",
  "generation.publish",
  "generation.rollback",
  "retention.plan",
  "retention.apply",
  "diagnostics.run",
  "scope.check",
  "scan.status",
  "scan.cancel",
  "access.read",
  "access.clear",
  "access.block",
]);
for (const op of [
  "live.reset",
  "scan.start",
  "scope.authors",
  "validation.checks",
  "validation.start",
  "validation.status",
  "validation.cancel",
  "validation.findings",
  "validation.export",
  "validation.purge",
  "validation.location",
  "cache.orphans",
  "cache.orphans.clear",
  "access.configure",
])
  adminOperations.add(op);
async function admin(operation, input = {}) {
  if (
    !["locations", "scan.start"].includes(operation) &&
    !adminOperations.has(operation)
  )
    throw Object.assign(new Error("Not allowed"), {
      code: "MANAGEMENT_OPERATION_INVALID",
    });
  if (!backend)
    throw Object.assign(new Error("Offline"), { code: "RUNTIME_OFFLINE" });
  return backend.call("manage", operation, input);
}
async function openDirectory(kind) {
  const locations = await admin("locations");
  if (!["instance", "config", "logs", "reports", "cache"].includes(kind))
    throw new Error("LOCATION_FORBIDDEN");
  return shell.openPath(locations[kind]);
}
async function invoke(args) {
  if (args[0] !== "connection") {
    if (!backend)
      throw Object.assign(new Error("Offline"), { code: "RUNTIME_OFFLINE" });
    return backend.call(args[0]);
  }
  try {
    const result = await execute(
      runtimeExecutable,
      ["connection", ...configArgs],
      {
        windowsHide: true,
        env: childEnv,
        timeout: 210000,
        maxBuffer: 1048576,
      },
    );
    return JSON.parse(result.stdout);
  } catch (error) {
    const code = String(error.stderr || "").trim();
    throw Object.assign(new Error("Runtime operation failed"), {
      code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : "HOST_REQUEST_FAILED",
    });
  }
}
async function status() {
  if (!backend || !connection)
    return {
      state: "STOPPED",
      localControl: false,
      hostBusy: action,
      hostFailure: failure,
      scan: { state: "IDLE", running: false },
    };
  const value = await backend.call("status");
  return {
    ...value,
    localControl: true,
    hostBusy: action || value.state === "STARTING",
    hostFailure: failure,
  };
}
async function operate(command) {
  if (action) throw Object.assign(new Error("Busy"), { code: "HOST_BUSY" });
  action = true;
  failure = null;
  try {
    if (!connection) connection = await invoke(["connection"]);
    if (command === "scan")
      return await admin("scan.start", { confirmReadOnly: true });
    const result = await invoke([command]);
    if (["start", "restart"].includes(command))
      connection = await invoke(["connection"]);

    return result;
  } catch (error) {
    failure = error.code;
    throw error;
  } finally {
    action = false;
  }
}
function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (
      event.sender !== window?.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !trustedPage(event.senderFrame?.url, managerUrl)
    )
      return { ok: false, code: "HOST_CALL_FORBIDDEN" };
    try {
      return { ok: true, data: await handler(...args) };
    } catch (error) {
      return { ok: false, code: error.code || "HOST_REQUEST_FAILED" };
    }
  });
}
async function main() {
  try {
    const option = process.argv.indexOf("--config");
    let configPath =
      option >= 0 ? path.resolve(process.argv[option + 1]) : null;
    const pointer = path.join(
      path.dirname(process.execPath),
      "gallery.instance.json",
    );
    if (!configPath && app.isPackaged && fs.existsSync(pointer))
      configPath = JSON.parse(fs.readFileSync(pointer, "utf8")).configPath;
    if (configPath) configArgs = ["--config", path.resolve(configPath)];
    configArgs.push(
      "--frontend",
      path.join(productRoot, "public"),
      "--assets",
      process.env.GALLERY_ASSETS_ROOT || path.join(productRoot, "resources"),
    );
    connection = await invoke(["connection"]);
  } catch (error) {
    failure = error.code || "CONFIG_REQUIRED";
  }
  // Invalid source/instance config still gets an offline diagnostic window.
  // Never derive this fallback from the rejected private configuration.
  const failureRoot = path.join(
    process.env.LOCALAPPDATA || os.homedir(),
    "gallery-legacy",
    "desktop-failure",
  );
  const data = connection?.desktopDataRoot || failureRoot;
  const temp = connection?.tempRoot || path.join(failureRoot, "temp");
  for (const dir of [
    data,
    path.join(data, "session"),
    path.join(data, "crashes"),
    temp,
  ])
    fs.mkdirSync(dir, { recursive: true });
  app.setPath("userData", data);
  app.setPath("sessionData", path.join(data, "session"));
  app.setPath("crashDumps", path.join(data, "crashes"));
  app.setPath("temp", temp);
  app.setAppLogsPath(path.join(connection?.logsRoot || failureRoot, "desktop"));
  if (!app.requestSingleInstanceLock()) return app.quit();
  await app.whenReady();
  if (connection) {
    backend = new Backend(
      runtimeExecutable,
      configArgs,
      childEnv,
      connection.instanceId,
    );
    try {
      await backend.ready;
    } catch (error) {
      failure = error.code || "HOST_REQUEST_FAILED";
    }
  }
  const icon =
    process.env.GALLERY_ICON_PATH ||
    path.join(productRoot, "resources/app-icon.png");
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    icon,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!trustedPage(url, managerUrl)) event.preventDefault();
  });
  handle("host:status", status);
  handle("host:resource-base", () => connection?.url || null);
  handle("host:admin", admin);
  handle("host:directory", openDirectory);
  handle("host:open-finding", async (id, index) => {
    const r = await admin("validation.location", { id, index });
    shell.showItemInFolder(r.path);
    return { opened: true };
  });
  handle("host:pick-directory", async () => {
    const r = await dialog.showOpenDialog(window, {
      properties: ["openDirectory"],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  for (const command of ["start", "stop", "restart", "scan"])
    handle("host:" + command, () => operate(command));
  const openGallery = () => connection && shell.openExternal(connection.url);
  handle("host:open-gallery", openGallery);
  await window.loadFile(managerFile);
  window.show();
  tray = new Tray(icon);
  tray.setToolTip("Gallery");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Manager",
        click: () => {
          window.show();
          window.focus();
        },
      },
      { label: "Gallery", click: openGallery },
      {
        label: "启动本实例服务",
        click: () => void operate("start").catch(() => window.show()),
      },
      {
        label: "重启 / 应用已发布版本",
        click: () => void operate("restart").catch(() => window.show()),
      },
      {
        label: "实例目录",
        click: () => void openDirectory("instance").catch(() => window.show()),
      },
      {
        label: "日志目录",
        click: () => void openDirectory("logs").catch(() => window.show()),
      },
      {
        label: "关于 Gallery",
        click: () =>
          void dialog.showMessageBox(window, {
            type: "info",
            title: "Gallery",
            message: "Gallery " + app.getVersion(),
            detail: "固定九平台 · 文件系统权威 · 本机管理",
          }),
      },
      {
        label: "停止本实例服务",
        click: () => void operate("stop").catch(() => window.show()),
      },
      { label: "退出管理器", click: () => app.quit() },
    ]),
  );
  tray.on("double-click", () => {
    window.show();
    window.focus();
  });
  app.on("second-instance", () => {
    window.show();
    window.focus();
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (backend ? backend.close() : Promise.resolve())
      .catch((error) => {
        process.stderr.write((error.code || "HOST_REQUEST_FAILED") + "\n");
      })
      .finally(() => {
        tray?.destroy();
        app.quit();
      });
  });
  if (connection)
    void operate("start").catch(() => {
      window.show();
      window.focus();
    });
}
main().catch(() => {
  process.stderr.write("DESKTOP_START_FAILED\n");
  app.exit(1);
});
