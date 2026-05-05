"use strict";
const fs = require("node:fs"),
  http = require("node:http"),
  path = require("node:path"),
  os = require("node:os");
const { WebSocketServer } = require("ws");
const { CatalogReader } = require("../catalog/reader.js");
const { QueryIndex } = require("../search/query.js");
const { createMediaService } = require("../media/service.js");
const { query, encodeCursor, identifier, bad } = require("./input.js");
const protocol = require("../../protocol/protocol.json");
const frontend = path.resolve(__dirname, "../../frontend");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
function localAddress(ip) {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    Object.values(os.networkInterfaces())
      .flat()
      .some((x) => x && x.address === ip)
  );
}
function createRuntimeServer({ config, generation, status, onScan }) {
  const reader = new CatalogReader(
    generation.catalogPath,
    generation.generationId,
    config.sources,
  );
  let index, media, counts, platformStats;
  try {
    index = new QueryIndex(generation.searchIndexPath, {
      workCount: generation.catalogFacts.workCount,
      catalogSize: generation.catalogFacts.sizeBytes,
      catalogMtimeMs: generation.catalogFacts.mtimeMs,
      catalogSha256: generation.catalogFacts.sha256,
    });
    counts = reader.stats();
    platformStats = reader.platformStats();
    media = createMediaService(reader, config);
  } catch (error) {
    reader.close();
    index?.close();
    throw error;
  }
  const sockets = new Set();
  let wss, timer;
  function send(res, code, data) {
    const text = JSON.stringify(
      { protocolVersion: 1, generationId: generation.generationId, ...data },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
    );
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(text);
  }
  function state() {
    return {
      ...status(),
      counts,
      platforms: config.platforms.map((p) => ({
        id: p.id,
        family: p.family,
        adapterVersion: p.adapterVersion,
        ...platformStats.find((s) => s.id === p.id),
      })),
    };
  }
  function boundary(req) {
    const expected = new URL(config.url).host;
    const hosts = new Set([expected]);
    if (config.mode === "local") hosts.add("localhost:" + config.port);
    if (!hosts.has(req.headers.host)) bad("HOST_FORBIDDEN", 403);
    const origin = req.headers.origin;
    if (
      origin &&
      origin !== config.url &&
      !(config.mode === "local" && origin === "http://localhost:" + config.port)
    )
      bad("ORIGIN_FORBIDDEN", 403);
  }
  async function body(req) {
    let text = "",
      size = 0;
    await new Promise((resolve, reject) => {
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 4096) text += chunk;
      });
      req.once("end", resolve);
      req.once("error", () =>
        reject(
          Object.assign(new Error("Request body incomplete"), {
            code: "INVALID_BODY",
            status: 400,
          }),
        ),
      );
    });
    if (size > 4096) bad("BODY_TOO_LARGE", 413);
    try {
      return JSON.parse(text);
    } catch {
      bad("INVALID_JSON");
    }
  }
  function page(kind, params) {
    const q = query(params, kind, generation.generationId);
    q.offset = q.cursor ? 0 : (q.page - 1) * q.pageSize;
    const execute = (position) =>
      kind === "authors"
        ? index.authorPage({ ...q, cursor: position })
        : kind === "tags"
          ? index.tagPage({ ...q, cursor: position })
          : index.workPage({ ...q, cursor: position });
    const result = execute(q.cursor || null);
    const items =
      kind === "authors"
        ? reader.authors(result.rows.map((r) => r.author_id))
        : kind === "tags"
          ? result.rows.map((r) => ({
              id: String(r.tag_id),
              label: r.display_value,
              workCount: Number(r.work_count),
            }))
          : reader.works(
              result.rows.map((r) => r.work_id),
              q.mediaType,
            );
    return {
      items,
      total: result.total,
      page: q.page,
      pageSize: q.pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / q.pageSize)),
      cursor: encodeCursor(result.nextCursor, q.key),
      mode: result.mode || kind,
    };
  }
  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(async () => {
        boundary(req);
        const u = new URL(req.url, config.url);
        if (u.pathname.startsWith("/api/")) {
          if (u.pathname === "/api/v1/health" && req.method === "GET")
            return send(res, 200, {
              data: {
                ready: true,
                instanceId: config.instanceId,
                schemaVersion: 4,
                searchVersion: generation.searchFacts.indexVersion,
              },
            });
          if (u.pathname === "/api/v1/status" && req.method === "GET")
            return send(res, 200, {
              data: {
                ...state(),
                localControl: localAddress(req.socket.remoteAddress),
              },
            });
          if (u.pathname === "/api/v1/platforms" && req.method === "GET")
            return send(res, 200, { data: { items: state().platforms } });
          if (u.pathname === "/api/v1/generations" && req.method === "GET")
            return send(res, 200, {
              data: { items: status().generations || [] },
            });
          const resource = /^\/api\/v1\/(works|authors|tags)$/.exec(u.pathname);
          if (resource && req.method === "GET")
            return send(res, 200, { data: page(resource[1], u.searchParams) });
          const work = /^\/api\/v1\/works\/([^/]+)$/.exec(u.pathname);
          if (work && req.method === "GET") {
            if (
              u.searchParams.has("g") &&
              u.searchParams.get("g") !== generation.generationId
            )
              bad("GENERATION_CHANGED", 409);
            const found = reader.work(identifier(work[1]));
            if (!found) bad("WORK_NOT_FOUND", 404);
            return send(res, 200, { data: found });
          }
          const file = /^\/api\/v1\/(media|thumbnails)\/([^/]+)$/.exec(
            u.pathname,
          );
          if (file && ["GET", "HEAD"].includes(req.method)) {
            if (u.searchParams.get("g") !== generation.generationId)
              bad("GENERATION_CHANGED", 409);
            return media.serve(
              req,
              res,
              identifier(file[2]),
              file[1] === "thumbnails",
            );
          }
          if (u.pathname === "/api/v1/scans" && req.method === "POST") {
            if (!localAddress(req.socket.remoteAddress))
              bad("LOCAL_CONTROL_REQUIRED", 403);
            const input = await body(req);
            if (input?.confirmReadOnly !== true)
              bad("READ_ONLY_CONFIRMATION_REQUIRED");
            await onScan();
            return send(res, 202, { data: { accepted: true } });
          }
          bad("ENDPOINT_NOT_FOUND", 404);
        }
        if (req.method !== "GET" && req.method !== "HEAD")
          bad("METHOD_NOT_ALLOWED", 405);
        let target;
        if (u.pathname === "/") target = path.join(frontend, "index.html");
        else if (u.pathname === "/manage")
          target = path.join(frontend, "manager/index.html");
        else if (u.pathname === "/protocol/protocol.json")
          target = path.resolve(__dirname, "../../protocol/protocol.json");
        else if (u.pathname.startsWith("/frontend/")) {
          const rel = decodeURIComponent(u.pathname.slice(10));
          target = path.resolve(frontend, rel);
          if (!target.startsWith(frontend + path.sep)) bad("NOT_FOUND", 404);
        } else bad("NOT_FOUND", 404);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile())
          bad("NOT_FOUND", 404);
        const bytes = fs.readFileSync(target);
        res.writeHead(200, {
          "Content-Type":
            mime[path.extname(target)] || "application/octet-stream",
          "Content-Length": bytes.length,
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(req.method === "HEAD" ? undefined : bytes);
      })
      .catch((error) => {
        if (res.headersSent) return res.destroy();
        if (error instanceof URIError) {
          error.status = 400;
          error.code = "INVALID_URL";
        }
        const code =
          error.status && /^[A-Za-z0-9_]{1,64}$/.test(error.code || "")
            ? error.code
            : "REQUEST_FAILED";
        send(res, error.status || 500, {
          error: {
            code,
            message: error.status ? code : "Request could not be completed",
          },
        });
      });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    try {
      boundary(req);
      if (new URL(req.url, config.url).pathname !== "/api/v1/events")
        return socket.destroy();
      wss.handleUpgrade(req, socket, head, (client) => {
        wss.emit("connection", client, req);
        client.send(
          JSON.stringify({ protocolVersion: 1, type: "status", data: state() }),
        );
      });
    } catch {
      socket.destroy();
    }
  });
  timer = setInterval(() => {
    if (!wss.clients.size) return;
    const payload = JSON.stringify({
      protocolVersion: 1,
      type: "status",
      data: state(),
    });
    for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
  }, 1500);
  timer.unref();
  return {
    reader,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, resolve);
      });
      return { url: config.url };
    },
    async close() {
      clearInterval(timer);
      for (const c of wss.clients) c.terminate();
      wss.close();
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => {
        if (server.listening) server.close(resolve);
        else resolve();
      });
      await media.close();
      reader.close();
      index.close();
    },
  };
}
module.exports = { createRuntimeServer, localAddress };
