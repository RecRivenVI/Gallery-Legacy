"use strict";
const fs = require("node:fs"),
  http = require("node:http"),
  path = require("node:path"),
  os = require("node:os");
const { WebSocketServer } = require("ws");
const { AsyncLocalStorage } = require("node:async_hooks");
const { openDataset } = require("./dataset.js");
const { createFileBrowser } = require("../library/file-browser.js");
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
  const requests = new AsyncLocalStorage();
  let current = openDataset(config, generation);
  const datasets = new Set([current]);
  const dataset = () => requests.getStore() || current;
  const read = fn => dataset().live ? dataset().live.db.transaction(fn)() : fn();
  const liveState = () => current.liveState();
  function release(data) {
    if (!data.retired || data.references || data.closing) return;
    data.closing = data.close().finally(() => datasets.delete(data));
    data.closing.catch(() => {});
  }
  const sockets = new Set();
  const access = require("./access.js").createAccessMonitor(config.instanceId, localAddress, { file: path.join(config.stateRoot,"access-history.json") });
  const fileBrowser = createFileBrowser(config);
  function attach(data) {
    data.shortLinks = require("./short-links.js").createShortLinks(config, data.reader, fileBrowser);
    data.legacyClient = require("./venera-compat.js").compatibility({ reader: data.reader, page, fileBrowser, media: data.media });
  }
  attach(current);
  let wss, timer;
  function send(res, code, data) {
    let revision=null;if(dataset().live)try{revision=dataset().liveState().revision;}catch{}
    const text = JSON.stringify(
      { protocolVersion: 1, generationId: dataset().epoch, ...(Number.isSafeInteger(revision) ? {revision} : {}), ...data },
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
  function state() { return read(() => {
    const d = dataset(), current = d.liveState();
    if(current && current.revision!==d.statsRevision){d.counts=d.reader.stats();d.platformStats=d.reader.platformStats();d.statsRevision=current.revision;}
    return {
      ...status(),
      ...(current ? {live:{...current,enabled:true}} : {}),
      libraryReady: !!d.generation,
      counts: d.counts,
      platforms: config.platforms.map((p) => ({
        id: p.id,
        family: p.family,
        adapterVersion: p.adapterVersion,
        ...d.platformStats.find((s) => s.id === p.id),
      })),
    };
  });
  }
  function boundary(req) {
    if (!config.allowedHosts.includes(String(req.headers.host || "").toLowerCase())) bad("HOST_FORBIDDEN", 403);
    const origin = req.headers.origin;
    if (
      origin &&
      !config.allowedOrigins.includes(origin)
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
    return read(() => {
    const q = query(params, kind, dataset().epoch, dataset().liveState()?.revision ?? null);
    q.offset = q.cursor ? 0 : (q.page - 1) * q.pageSize;
    const execute = (position) =>
      kind === "authors"
          ? dataset().index.authorPage({ ...q, cursor: position })
        : kind === "tags"
          ? dataset().index.tagPage({ ...q, cursor: position })
          : dataset().index.workPage({ ...q, cursor: position });
    const result = execute(q.cursor || null);
    const items =
      kind === "authors"
        ? dataset().reader.authors(result.rows.map((r) => r.author_id))
        : kind === "tags"
          ? result.rows.map((r) => ({
              id: String(r.tag_id),
              label: r.display_value,
              workCount: Number(r.work_count),
            }))
          : dataset().reader.works(
              result.rows.map((r) => r.work_id),
              q.mediaType,
            );
    return {
      items,
      total: result.total,
      page: q.page,
      pageSize: q.pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / q.pageSize)),
      cursor: encodeCursor(result.nextCursor, q.key, q.revision),
      ...(dataset().live ? {revision:q.revision} : {}),
      mode: result.mode || kind,
    };
    });
  }
  const server = http.createServer((req, res) => {
    const selected = current; selected.references++;
    let done = false;
    const finish = () => { if (!done) { done = true; selected.references--; release(selected); } };
    res.once("finish", finish); res.once("close", finish);
    requests.run(selected, () => {
    // Crawler guidance only, never an access-control or authentication boundary.
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    Promise.resolve()
      .then(async () => {
        if (!access.begin(req, res)) bad("CLIENT_BLOCKED", 403);
        boundary(req);
        if (req.headers.origin && req.headers.origin !== "http://" + req.headers.host) {
          res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
          res.setHeader("Vary", "Origin");
        }
        const u = new URL(req.url, config.url);
        if (req.method === "OPTIONS") {
          if (!["GET", "HEAD"].includes(req.headers["access-control-request-method"])) bad("METHOD_NOT_ALLOWED", 405);
          res.writeHead(204, { "Access-Control-Allow-Methods": "GET, HEAD", "Access-Control-Allow-Headers": "Range, cache-time" }); return res.end();
        }
        if (u.pathname.startsWith("/api/")) {
          if (["/api/shorten", "/api/v1/short-links"].includes(u.pathname) && req.method === "POST") {
            const input=await body(req),result = read(()=>dataset().shortLinks.create(input));
            if (u.pathname === "/api/shorten") {
              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
              return res.end(JSON.stringify(result));
            }
            return send(res, 200, { data: result });
          }
          if (!u.pathname.startsWith("/api/v1/") && await dataset().legacyClient(req, res, u)) return;
          if (u.pathname === "/api/v1/health" && req.method === "GET")
            return send(res, 200, {
              data: {
              ready: !!dataset().generation,
                instanceId: config.instanceId,
                schemaVersion: 4,
                searchVersion: dataset().generation?.searchFacts.indexVersion || require("../search/build.js").RUNTIME_SEARCH_INDEX_VERSION,
              },
            });
          if (u.pathname === "/api/v1/status" && req.method === "GET")
            return send(res, 200, {
              data: {
                ...state(),
                localControl: false,
              },
            });
          if (u.pathname === "/api/v1/platforms" && req.method === "GET")
            return send(res, 200, { data: { items: state().platforms } });
          if (u.pathname === "/api/v1/file-roots" && req.method === "GET")
            return send(res, 200, { data: { items: fileBrowser.roots() } });
          if (u.pathname === "/api/v1/file-search" && req.method === "GET") {
            const controller = new AbortController(); res.once("close", () => controller.abort());
            return send(res, 200, { data: await fileBrowser.search(u.searchParams.get("root"), u.searchParams.get("path") || "", {
              query: u.searchParams.get("q"), page: Number(u.searchParams.get("page") || 1), pageSize: Number(u.searchParams.get("pageSize") || 48),
              filter: u.searchParams.get("mediaType") || "all", order: u.searchParams.get("order") || "asc", signal: controller.signal,
            }) });
          }
          if (u.pathname === "/api/v1/files" && req.method === "GET")
            return send(res, 200, { data: fileBrowser.list(u.searchParams.get("root"), u.searchParams.get("path") || "", {
              page: Number(u.searchParams.get("page") || 1), pageSize: Number(u.searchParams.get("pageSize") || 100),
              filter: u.searchParams.get("mediaType") || "all", order: u.searchParams.get("order") || "asc",
            }) });
          if (["/api/v1/file-media", "/api/v1/file-thumbnails"].includes(u.pathname) && ["GET", "HEAD"].includes(req.method))
            return dataset().media.serveResolved(req, res, fileBrowser.mediaFile(u.searchParams.get("root"), u.searchParams.get("path") || ""), u.pathname.endsWith("file-thumbnails"));
          if (u.pathname === "/api/v1/file-subtitles" && ["GET", "HEAD"].includes(req.method))
            return dataset().media.serveSubtitle(req, res, fileBrowser.mediaFile(u.searchParams.get("root"), u.searchParams.get("path") || ""), u.searchParams.get("lang"));
          if (u.pathname === "/api/v1/resolve" && req.method === "GET") {
            return read(()=>{
            const resolved = dataset().reader.resolvePublicPath(u.searchParams.get("path"));
            if (!resolved) bad("WORK_NOT_FOUND", 404);
            return send(res, 200, { data: resolved });
            });
          }
          if (u.pathname === "/api/v1/chapters" && req.method === "GET") {
            return read(()=>{
            const items = dataset().reader.chapters(u.searchParams.get("path"));
            if (!items) bad("WORK_NOT_FOUND", 404);
            return send(res, 200, { data: { items } });
            });
          }
          if (u.pathname === "/api/v1/generations" && req.method === "GET")
            return send(res, 200, {
              data: { items: status().generations || [] },
            });
          const resource = /^\/api\/v1\/(works|authors|tags)$/.exec(u.pathname);
          if (resource && req.method === "GET")
            return read(()=>send(res, 200, { data: page(resource[1], u.searchParams) }));
          const work = /^\/api\/v1\/works\/([^/]+)$/.exec(u.pathname);
          if (work && req.method === "GET") {
            if (
              u.searchParams.has("g") &&
              u.searchParams.get("g") !== dataset().epoch
            )
              bad("GENERATION_CHANGED", 409);
            return read(()=>{
            const found = dataset().reader.work(identifier(work[1]));
            if (!found) bad("WORK_NOT_FOUND", 404);
            return send(res, 200, { data: found });
            });
          }
          const file = /^\/api\/v1\/(media|thumbnails|subtitles)\/([^/]+)$/.exec(
            u.pathname,
          );
          if (file && ["GET", "HEAD"].includes(req.method)) {
            let id = identifier(file[2]);
            if (u.searchParams.get("g") !== dataset().epoch) {
              const stable = u.searchParams.get("p");
              if (!stable || !(id = dataset().reader.mediaAtPublicPath(stable))) bad("GENERATION_CHANGED", 409);
              if (u.searchParams.get("k") !== dataset().reader.mediaIdentity(id)) bad("MEDIA_IDENTITY_CHANGED", 409);
            }
            if(dataset().live && u.searchParams.get("k")!==dataset().reader.mediaIdentity(id))bad("MEDIA_IDENTITY_CHANGED",409);
            if (file[1] === "subtitles") return dataset().media.serveSubtitle(req, res, dataset().media.resolve(id), u.searchParams.get("lang"));
            return dataset().media.serve(
              req,
              res,
              id,
              file[1] === "thumbnails",
            );
          }
          if (u.pathname === "/api/v1/scans" && req.method === "POST") {
            const input = await body(req);
            if (input?.confirmReadOnly !== true)
              bad("READ_ONLY_CONFIRMATION_REQUIRED");
            // A loopback proxy can forward public requests. Neither source IP nor
            // Host headers authorize management: use the authenticated local pipe.
            bad("LOCAL_CONTROL_REQUIRED", 403);
          }
          bad("ENDPOINT_NOT_FOUND", 404);
        }
        if (req.method !== "GET" && req.method !== "HEAD")
          bad("METHOD_NOT_ALLOWED", 405);
        if (u.pathname === "/venera-source.js") {
          const template = fs.readFileSync(path.join(frontend, "venera/source.js"), "utf8");
          const source = template.replaceAll("{{HOST_URL}}", config.publicUrl)
            .replace("{{PLATFORMS}}", encodeURIComponent(JSON.stringify(config.platforms.map((p) => p.id))));
          res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" });
          return res.end(req.method === "HEAD" ? undefined : source);
        }
        if (u.pathname.startsWith("/s/")) {
          const code = u.pathname.slice(3);
          const target = dataset().shortLinks.resolve(code);
          if (!target) bad("SHORT_LINK_NOT_FOUND", 404);
          res.writeHead(302, { Location: target, "Cache-Control": "no-store" }); return res.end();
        }
        if (u.pathname === "/robots.txt") {
          const text = "User-agent: *\nDisallow: /\n";
          res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": Buffer.byteLength(text),
            "Cache-Control": "no-cache",
          });
          return res.end(req.method === "HEAD" ? undefined : text);
        }
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
        let bytes = fs.readFileSync(target);
        if (u.pathname === "/manage") bytes = Buffer.from(bytes.toString("utf8").replace("<head>", '<head><base href="/frontend/manager/">'));
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
        try { client.send(JSON.stringify({ protocolVersion: 1, type: "status", data: state() })); } catch { client.close(1011); }
      });
    } catch {
      socket.destroy();
    }
  });
  timer = setInterval(() => {
    if (!wss.clients.size) return;
    let payload;try{payload = JSON.stringify({
      protocolVersion: 1,
      type: "status",
      data: state(),
    });}catch{return;}
    for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
  }, 1500);
  timer.unref();
  return {
    get reader() { return current.reader; },
    access,
    liveState,
    snapshotState: state,
    applyGeneration(generation) {
      const next = openDataset(config, generation);
      try { attach(next); } catch (error) { void next.close(); throw error; }
      const previous = current; datasets.add(next); current = next;
      previous.retired = true; release(previous);
    },
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, resolve);
      });
      return { url: config.url };
    },
    async close() {
      clearInterval(timer);
      access.close();
      for (const c of wss.clients) c.terminate();
      wss.close();
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => {
        if (server.listening) server.close(resolve);
        else resolve();
      });
      await Promise.all([...datasets].map(d => { d.retired = true; return d.closing || d.close(); }));
    },
  };
}
module.exports = { createRuntimeServer, localAddress };
