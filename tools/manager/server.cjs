"use strict";
// Explicit test-only host. The production Runtime never imports this module.
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  crypto = require("node:crypto");
const {
  readRuntimeConfig,
  ensureLayout,
} = require("../../src/instance/config.js");
const { readJson, writeJson } = require("../../src/instance/files.js");
const { inside, noLinks } = require("../../src/library/io-paths.js");
const { acquireOwnership } = require("../../src/instance/ownership.js");
const { startRuntime, stopRuntime } = require("../../src/runtime/control.js");
const { manage } = require("../../src/runtime/management.js");
const METHODS = new Set([
  "status",
  "start",
  "stop",
  "restart",
  "scan",
  "admin",
  "openDirectory",
  "openFinding",
]);
const OPS = new Set([
  "live.reset",
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
  "cache.orphans",
  "cache.orphans.clear",
  "generations.list",
  "generation.validate",
  "generation.publish",
  "generation.rollback",
  "retention.plan",
  "retention.apply",
  "diagnostics.run",
  "scope.check",
  "scope.authors",
  "scan.start",
  "scan.status",
  "scan.cancel",
  "access.read",
  "access.clear",
  "access.block",
  "validation.checks",
  "validation.start",
  "validation.status",
  "validation.cancel",
  "validation.findings",
  "validation.export",
  "validation.purge",
  "validation.location",
]);
function fail(code, status = 400) {
  throw Object.assign(new Error(code), { code, status });
}
async function createManagerTestHost(
  configPath,
  {
    port = 18108,
    ui = "manager",
    validateConfig = null,
    pickerPath = null,
    assetsRoot = null,
    galleryUrl = null,
    control = null,
  } = {},
) {
  if (!["manager", "manager/candidate"].includes(ui)) fail("TEST_UI_INVALID");
  ui = "manager";
  const file = path.resolve(configPath),
    config = readRuntimeConfig(file);
  validateConfig?.(readJson(file));
  if (
    config.deployment !== "staging" ||
    config.port === 8081 ||
    port === 8081 ||
    !inside(config.instanceRoot, file) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    fail("TEST_INSTANCE_REQUIRED");
  if (galleryUrl !== null) {
    let target;
    try {
      target = new URL(galleryUrl);
    } catch {
      fail("TEST_GALLERY_URL_INVALID");
    }
    if (
      target.protocol !== "http:" ||
      target.hostname !== "127.0.0.1" ||
      !Number.isInteger(Number(target.port)) ||
      Number(target.port) < 1024 ||
      Number(target.port) > 65535 ||
      target.port === "8081" ||
      target.username ||
      target.password ||
      target.pathname !== "/" ||
      target.search ||
      target.hash
    )
      fail("TEST_GALLERY_URL_INVALID");
  }
  ensureLayout(config);
  const lease = await acquireOwnership(config, "manager-test");
  const token = crypto.randomBytes(32).toString("hex"),
    host = "127.0.0.1:" + port,
    url = "http://" + host;
  const root = path.resolve(__dirname, "../../public"),
    cookie = "gallery_test=" + token;
  let active = 0,
    configText = fs.readFileSync(file, "utf8"),
    cachedConfig = config;
  function currentConfig(revalidate) {
    noLinks(file);
    const text = fs.readFileSync(file, "utf8"),
      raw = JSON.parse(text);
    if (
      raw.deployment !== "staging" ||
      raw.port === 8081 ||
      (raw.instanceId && raw.instanceId !== config.instanceId)
    )
      fail("TEST_INSTANCE_REQUIRED", 403);
    if (revalidate || text !== configText) {
      const next = readRuntimeConfig(file);
      if (next.instanceId !== config.instanceId)
        fail("TEST_INSTANCE_REQUIRED", 403);
      validateConfig?.(raw);
      cachedConfig = next;
      configText = text;
    }
    return cachedConfig;
  }
  async function call(method, args) {
    if (!METHODS.has(method)) fail("TEST_METHOD_FORBIDDEN", 403);
    const readOnly =
      method === "status" ||
      (method === "admin" &&
        new Set([
          "scan.status",
          "config.read",
          "logs.list",
          "logs.read",
          "reports.list",
          "reports.read",
          "storage.read",
          "access.read",
          "validation.status",
          "validation.findings",
        ]).has(args[0]));
    const current = currentConfig(!readOnly);
    // Explicit experimental backend control; never used by the production host.
    // The same loopback/cookie/Origin/CSRF and method/operation checks still apply.
    if (control) {
      if (
        method === "admin" &&
        !OPS.has(args[0]) &&
        args[0] !== "access.configure"
      )
        fail("TEST_OPERATION_FORBIDDEN", 403);
      return control(method, args, current);
    }
    if (method === "status") {
      try {
        const response = await fetch(current.url + "/api/v1/status", {
            signal: AbortSignal.timeout(5000),
          }),
          value = await response.json();
        if (!response.ok || value.data?.instanceId !== config.instanceId)
          fail("INSTANCE_MISMATCH");
        return { ...value.data, localControl: true, testOnly: true };
      } catch {
        return {
          state: "STOPPED",
          deployment: "staging",
          testOnly: true,
          localControl: true,
          scan: await manage(file, "scan.status"),
        };
      }
    }
    if (method === "start") return startRuntime(current, file);
    if (method === "stop") return stopRuntime(current);
    if (method === "restart") {
      await stopRuntime(current);
      return startRuntime(current, file);
    }
    if (method === "scan")
      return manage(file, "scan.start", { confirmReadOnly: true });
    if (method === "admin") {
      if (!OPS.has(args[0]) && args[0] !== "access.configure")
        fail("TEST_OPERATION_FORBIDDEN", 403);
      if (
        ["config.save", "config.validate"].includes(args[0]) &&
        (args[1]?.value?.deployment !== "staging" ||
          args[1]?.value?.port === 8081)
      )
        fail("TEST_INSTANCE_REQUIRED", 403);
      if (["config.save", "config.validate"].includes(args[0]))
        validateConfig?.(args[1]?.value);
      return manage(file, args[0], args[1] || {});
    }
    if (method === "openFinding") {
      const found = await manage(file, "validation.location", {
        id: args[0],
        index: args[1],
      });
      return { ...found, nativeHostRequired: true };
    }
    return { nativeHostRequired: true };
  }
  const bridge = `const token=document.querySelector('meta[name="test-csrf"]').content;document.querySelector('meta[name="test-csrf"]').remove();async function call(method,...args){const r=await fetch('/test-control',{method:'POST',headers:{'Content-Type':'application/json','X-Gallery-Test':token},body:JSON.stringify({method,args})});const v=await r.json();if(!r.ok)throw Object.assign(new Error(v.code),{code:v.code});return v.data;}window.galleryHost={status:()=>call('status'),start:()=>call('start'),stop:()=>call('stop'),restart:()=>call('restart'),scan:()=>call('scan'),admin:(...a)=>call('admin',...a),openGallery:()=>window.open(${JSON.stringify(config.url)},'_blank'),openDirectory:async()=>({nativeHostRequired:true}),pickDirectory:async()=>prompt('测试浏览器：请输入本机目录绝对路径，或取消'),openFinding:async(id,index)=>{const r=await call('openFinding',id,index);alert('请在原生管理器定位文件。相对问题路径已显示在列表中。');return r;}};`;
  const candidateBridge = bridge
    .replace(
      /pickDirectory:async\(\)=>prompt\([^;]+?\),openFinding:/,
      "pickDirectory:async()=>window.reviewNative?.pickDirectory?.()??" +
        JSON.stringify(pickerPath) +
        ",openFinding:",
    )
    .replace(
      "alert('请在原生管理器定位文件。相对问题路径已显示在列表中。');",
      "window.reviewNative?.showItem?.(r.path);",
    )
    .replace(
      "openDirectory:async()=>({nativeHostRequired:true})",
      "openDirectory:async(kind)=>{await window.reviewNative?.openDirectory?.(kind);return {nativeHostRequired:!window.reviewNative};}",
    )
    .replace(
      "window.open(" + JSON.stringify(config.url),
      "window.open(" + JSON.stringify(galleryUrl || config.url),
    );
  function reply(res, status, value) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  }
  const server = http.createServer((req, res) => {
    void (async () => {
      if (
        req.socket.remoteAddress !== "127.0.0.1" ||
        req.headers.host !== host ||
        req.headers["x-forwarded-for"] ||
        req.headers.forwarded
      )
        fail("TEST_LOOPBACK_ONLY", 403);
      if (req.headers.origin && req.headers.origin !== url)
        fail("TEST_ORIGIN_FORBIDDEN", 403);
      const u = new URL(req.url, url);
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");
      if (u.pathname === "/test-control") {
        if (
          req.method !== "POST" ||
          req.headers.origin !== url ||
          req.headers["x-gallery-test"] !== token ||
          !String(req.headers.cookie || "")
            .split(/;\s*/)
            .includes(cookie) ||
          !String(req.headers["content-type"] || "").startsWith(
            "application/json",
          )
        )
          fail("TEST_AUTH_REQUIRED", 403);
        if (active >= 8) fail("TEST_BUSY", 429);
        active++;
        try {
          let input = "";
          for await (const chunk of req) {
            input += chunk;
            if (Buffer.byteLength(input) > 262144)
              fail("TEST_BODY_TOO_LARGE", 413);
          }
          let body;
          try {
            body = JSON.parse(input);
          } catch {
            fail("TEST_BODY_INVALID");
          }
          if (!Array.isArray(body.args) || body.args.length > 3)
            fail("TEST_BODY_INVALID");
          reply(res, 200, { data: await call(body.method, body.args) });
        } finally {
          active--;
        }
        return;
      }
      if (req.method !== "GET") fail("TEST_METHOD_FORBIDDEN", 405);
      if (u.pathname === "/") {
        let html = fs.readFileSync(path.join(root, ui, "index.html"), "utf8");
        html = html.replace(
          "<head>",
          '<head><base href="/frontend/' +
            ui +
            '/"><meta name="test-csrf" content="' +
            token +
            '"><script type="module" src="/test-host.js"></script>',
        );
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": cookie + "; HttpOnly; SameSite=Strict; Path=/",
        });
        return res.end(html);
      }
      if (
        !String(req.headers.cookie || "")
          .split(/;\s*/)
          .includes(cookie)
      )
        fail("TEST_AUTH_REQUIRED", 403);
      if (u.pathname === "/test-host.js") {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        return res.end(candidateBridge);
      }
      if (
        assetsRoot &&
        u.pathname.startsWith("/frontend/assets/canvas/fonts/")
      ) {
        const name = path.basename(u.pathname);
        if (
          !/^(gallery-(regular|medium|semibold|bold)|mono|outfit)\.ttf$/.test(
            name,
          )
        )
          fail("TEST_NOT_FOUND", 404);
        const font = path.resolve(assetsRoot, name);
        noLinks(font);
        res.writeHead(200, { "Content-Type": "font/ttf" });
        return res.end(fs.readFileSync(font));
      }
      if (
        assetsRoot &&
        u.pathname.startsWith("/frontend/assets/canvas/misans/")
      ) {
        const base = path.resolve(assetsRoot, "../misans"),
          relative = decodeURIComponent(
            u.pathname.slice("/frontend/assets/canvas/misans/".length),
          );
        if (
          relative !== "manifest.json" &&
          !/^files\/[a-zA-Z0-9._-]+\.(ttf|woff2)$/.test(relative)
        )
          fail("TEST_NOT_FOUND", 404);
        const font = path.resolve(base, relative);
        if (!inside(base, font)) fail("TEST_PATH_FORBIDDEN", 403);
        noLinks(font);
        if (!fs.existsSync(font)) fail("TEST_NOT_FOUND", 404);
        res.writeHead(200, {
          "Content-Type": relative.endsWith(".json")
            ? "application/json"
            : relative.endsWith(".woff2")
              ? "font/woff2"
              : "font/ttf",
        });
        return res.end(fs.readFileSync(font));
      }
      if (!u.pathname.startsWith("/frontend/")) fail("TEST_NOT_FOUND", 404);
      const target = path.resolve(
        root,
        decodeURIComponent(u.pathname.slice(10)),
      );
      if (!inside(root, target)) fail("TEST_PATH_FORBIDDEN", 403);
      noLinks(target);
      const ext = path.extname(target),
        mime = {
          ".js": "application/javascript",
          ".css": "text/css",
          ".html": "text/html",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        }[ext];
      if (!mime || !fs.existsSync(target)) fail("TEST_NOT_FOUND", 404);
      res.writeHead(200, { "Content-Type": mime });
      res.end(fs.readFileSync(target));
    })().catch((e) => {
      if (!res.headersSent)
        reply(res, e.status || 500, {
          code: /^[A-Z0-9_]{1,64}$/.test(e.code || "")
            ? e.code
            : "TEST_OPERATION_FAILED",
        });
      else res.destroy();
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (e) {
    await lease.release();
    throw e;
  }
  writeJson(path.join(config.stateRoot, "manager-test.json"), {
    pid: process.pid,
    port,
    startedAtMs: Date.now(),
    instanceId: config.instanceId,
  });
  return {
    url,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await lease.release();
    },
  };
}
if (require.main === module) {
  const at = process.argv.indexOf("--config"),
    pt = process.argv.indexOf("--port");
  if (at < 0) throw new Error("Explicit staging --config required");
  createManagerTestHost(process.argv[at + 1], {
    port: pt < 0 ? 18108 : Number(process.argv[pt + 1]),
  })
    .then((s) => {
      console.log(
        JSON.stringify({
          state: "READY",
          url: s.url,
          pid: process.pid,
          testOnly: true,
        }),
      );
      for (const signal of ["SIGINT", "SIGTERM"])
        process.on(signal, () => void s.close().then(() => process.exit()));
    })
    .catch((e) => {
      console.error(e.code || "TEST_START_FAILED");
      process.exitCode = 1;
    });
}
module.exports = { createManagerTestHost };
