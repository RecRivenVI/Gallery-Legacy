"use strict";
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path");
const { WebSocket, WebSocketServer } = require("ws");
const {
  ROOT,
  REPO,
  PORTS,
  assertOwned,
  assertConfig,
} = require("../demo/paths.cjs");
async function createGalleryReviewHost({
  port,
  backend,
  configPath,
  validateConfig,
}) {
  if (
    ![port, backend].every(
      (p) => Number.isInteger(p) && p >= 1024 && p <= 65535 && p !== 8081,
    ) ||
    port === backend ||
    typeof validateConfig !== "function"
  )
    throw new Error("REVIEW_HOST_CONFIG_REQUIRED");
  const config = JSON.parse(fs.readFileSync(configPath));
  validateConfig(config);
  if (
    config.deployment !== "staging" ||
    config.mode !== "local" ||
    config.listenAddress !== "127.0.0.1" ||
    config.port !== backend
  )
    throw new Error("REVIEW_HOST_CONFIG_REJECTED");
  const { resourceFile } = require("../../src/server/resources.cjs");
  const mime = {
    ".js": "text/javascript; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".wasm": "application/wasm",
    ".ttf": "font/ttf",
    ".woff2": "font/woff2",
    ".json": "application/json",
    ".otf": "font/otf",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  };
  const server = http.createServer((req, res) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405);
      return res.end();
    }
    if (req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403);
      return res.end();
    }
    let url;
    try {
      url = new URL(req.url, `http://127.0.0.1:${port}`);
      decodeURIComponent(url.pathname);
    } catch (error) {
      res.writeHead(400);
      return res.end();
    }
    if (
      url.pathname.startsWith("/api/v1/") ||
      url.pathname.startsWith("/protocol/")
    ) {
      if (
        !/^\/(?:protocol\/|api\/v1\/(?:platforms|file-roots|works|authors|tags|resolve|files|file-search|file-media|file-thumbnails|file-subtitles|thumbnails|media|subtitles|status|health)(?:\/|\?|$))/.test(
          req.url,
        )
      ) {
        res.writeHead(403);
        return res.end();
      }
      const proxy = http.request(
        {
          host: "127.0.0.1",
          port: backend,
          path: req.url,
          method: req.method,
          headers: {
            host: `127.0.0.1:${backend}`,
            ...(req.headers.range ? { range: req.headers.range } : {}),
          },
        },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        },
      );
      proxy.on("error", () => {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: { code: "DEMO_SERVICE_UNAVAILABLE" } }),
        );
      });
      proxy.end();
      return;
    }
    if (
      url.pathname.startsWith("/p/") ||
      url.pathname.startsWith("/f/") ||
      url.pathname.startsWith("/#")
    ) {
      res.writeHead(302, {
        Location: `/#${url.pathname}${url.search}`,
      });
      return res.end();
    }
    let file;
    if (url.pathname.startsWith("/frontend/assets/canvas/")) {
      file = resourceFile(
        decodeURIComponent(
          url.pathname.slice("/frontend/assets/canvas/".length),
        ),
      );
    } else {
      const relative =
        url.pathname === "/"
          ? "public/gallery/index.html"
          : decodeURIComponent(url.pathname.slice(1)).replace(
              /^frontend\//,
              "public/",
            );
      if (
        !relative.startsWith("public/gallery/") &&
        !relative.startsWith("public/platform/")
      ) {
        res.writeHead(404);
        return res.end();
      }
      file = path.resolve(REPO, relative);
      if (!file.startsWith(path.join(REPO, "public") + path.sep)) {
        res.writeHead(403);
        return res.end();
      }
    }
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader(
      "Content-Type",
      mime[path.extname(file)] || "application/octet-stream",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'",
    );
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (
      req.headers.host !== `127.0.0.1:${port}` ||
      req.url !== "/api/v1/events"
    )
      return socket.destroy();
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(`ws://127.0.0.1:${backend}/api/v1/events`);
      upstream.on("message", (data) => {
        if (client.readyState === 1) client.send(data.toString());
      });
      upstream.on("error", () => client.close());
      upstream.on("close", () => client.close());
      client.on("close", () => upstream.close());
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
if (require.main === module) {
  const kind = process.argv.includes("--empty") ? "empty" : "full";
  createGalleryReviewHost({
    port: kind === "empty" ? 18227 : 18226,
    backend: PORTS[kind],
    configPath: path.join(ROOT, kind, "instance/config.json"),
    validateConfig: assertConfig,
  })
    .then((host) => {
      console.log(
        JSON.stringify({
          url: host.url,
          pid: process.pid,
          kind,
          synthetic: true,
        }),
      );
      for (const signal of ["SIGINT", "SIGTERM"])
        process.on(signal, () => void host.close().then(() => process.exit()));
    })
    .catch((error) => {
      console.error(error.code || "REVIEW_HOST_START_FAILED");
      process.exitCode = 1;
    });
}
module.exports = { createGalleryReviewHost };
