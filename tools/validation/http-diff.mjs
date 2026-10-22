import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, "../..");
const reference = process.env.GALLERY_NODE_REFERENCE_ROOT;
if (!reference || path.resolve(reference) === repo)
  throw Error("FROZEN_NODE_REFERENCE_REQUIRED");
function compare(golden) {
  const out = path.dirname(golden);
  const captured = JSON.parse(fs.readFileSync(golden));
  if (!captured.access?.[0]?.requests?.some((r) => r.flush)) {
    captured.access = captureAccess(out);
    fs.writeFileSync(golden, JSON.stringify(captured, null, 2));
  }
  if (!captured.order) {
    const { compareNatural } = require(
      path.join(reference, "src/media/order.js"),
    );
    const input = [
      "10.png",
      "01.png",
      "2.png",
      "1.png",
      "😀.png",
      "\uE000.png",
      "A.png",
      "a.png",
      "中10.png",
      "中2.png",
      "x999999999999999999999999.png",
      "x1000000000000000000000000.png",
    ];
    captured.order = { input, expected: [...input].sort(compareNatural) };
    fs.writeFileSync(golden, JSON.stringify(captured, null, 2));
  }
  for (const c of captured.cases) {
    const cache = path.join(path.dirname(c.configFile), "cache");
    if (fs.existsSync(cache))
      fs.renameSync(cache, cache + "-before-" + Date.now());
  }
  const run = spawnSync(
    process.execPath,
    [
      path.join(repo, "tools/go/run.cjs"),
      "test",
      ...(process.argv.includes("--race") ? ["-race"] : []),
      "-count=1",
      "-timeout=4m",
      "./internal/httpservice",
      "./internal/reading",
      "./internal/fileview",
      "-run",
      "TestFrozen|TestCancelledSearchAndPaging",
      "-v",
    ],
    {
      cwd: repo,
      env: { ...process.env, GALLERY_HTTP_GOLDEN: golden },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  const log = (run.stdout || "") + (run.stderr || "");
  const stamp = Date.now();
  fs.writeFileSync(path.join(out, `go-test-${stamp}.log`), log);
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(
      {
        conclusion: "有差异",
        matched: run.status === 0,
        reference,
        requests: captured.cases.reduce((n, c) => n + c.requests.length, 0),
        instances: captured.cases.length,
        exitCode: run.status,
        knownDifferences: [
          "malformed path escape: Go net/http HTTP 400 without protocol envelope",
          "protocol.json: whitespace and byte length only",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    log
      .split("\n")
      .filter(
        (s) =>
          s.startsWith("--- FAIL") ||
          s.startsWith("FAIL") ||
          s.startsWith("ok ") ||
          s.includes("data race"),
      )
      .join("\n"),
  );
  console.log(out);
  process.exitCode = run.status ?? 1;
}
function captureAccess(out) {
  const { createAccessMonitor } = require(
    path.join(reference, "src/server/access.js"),
  );
  const now = Date.UTC(2026, 9, 22, 4, 0, 0),
    instanceId = "synthetic-http";
  const idFor = (ip) =>
    crypto
      .createHash("sha256")
      .update(instanceId + "\0" + ip)
      .digest("hex")
      .slice(0, 16);
  const rows = [];
  for (const name of ["fresh", "blocked", "disabled", "local-cannot-block"]) {
    const ip = name === "local-cannot-block" ? "127.0.0.1" : "192.0.2.2";
    const saved =
      name === "fresh"
        ? null
        : {
            version: 1,
            instanceId,
            enabled: name !== "disabled",
            clients: [
              {
                id: idFor(ip),
                address: ip,
                agent: "Browser",
                blocked: true,
                requests: 2,
                errors: 1,
                bytes: 20,
                lastSeenAtMs: now,
                days: {},
              },
            ],
            events: [],
          };
    const dir = fs.mkdtempSync(path.join(out, "AccessNode-")),
      file = path.join(dir, "access-history.json");
    if (saved) fs.writeFileSync(file, JSON.stringify(saved));
    const monitor = createAccessMonitor(
      instanceId,
      (address) => address === "127.0.0.1",
      { file, now: () => now },
    );
    const requests = [];
    for (const [index, url] of [
      "/api/v1/status?secret=not-retained",
      "/api/v1/media/1",
    ].entries()) {
      const request = {
        ip,
        method: "GET",
        path: url,
        agent: index ? "Venera" : "Mozilla",
        status: index ? 404 : 200,
        bytes: 10,
        flush: index === 1,
      };
      const req = {
        socket: { remoteAddress: ip },
        headers: { "user-agent": request.agent },
        method: request.method,
        url,
      };
      const res = new EventEmitter();
      res.statusCode = request.status;
      res.getHeader = (key) =>
        key === "content-length" ? request.bytes : undefined;
      const allowed = monitor.begin(req, res);
      if (request.flush) monitor.flush();
      res.emit("finish");
      res.emit("close");
      requests.push({ ...request, allowed });
    }
    monitor.close();
    const expected = JSON.parse(fs.readFileSync(file));
    for (const e of expected.events) e.elapsedMs = 0;
    rows.push({ name, now, saved, requests, expected });
  }
  return rows;
}
async function extend(golden) {
  const captured = JSON.parse(fs.readFileSync(golden));
  const { normalizeRuntimeConfig } = require(
    path.join(reference, "src/instance/config.js"),
  );
  const { resolveActiveGeneration } = require(
    path.join(reference, "src/publication/generations.js"),
  );
  const { createRuntimeServer } = require(
    path.join(reference, "src/server/http.js"),
  );
  for (const c of captured.cases) {
    const config = normalizeRuntimeConfig(
      JSON.parse(fs.readFileSync(c.configFile)),
    );
    const generation =
      c.name === "Empty" ? null : resolveActiveGeneration(config.instanceRoot);
    const host = createRuntimeServer({
      config,
      generation,
      status: () => c.status,
    });
    await host.start();
    try {
      for (const p of [
        "/api/v1/works/",
        "/api/v1/media/",
        "/frontend/%FF",
        "/api/db-posts?platformPath=%2Fp%2F%25FF",
      ]) {
        if (!c.requests.some((r) => r.path === p)) {
          const item = { path: p };
          c.requests.push({ ...item, expected: await request(config, item) });
        }
      }
    } finally {
      await host.close();
    }
  }
  fs.writeFileSync(golden, JSON.stringify(captured, null, 2));
}
if (process.env.GALLERY_HTTP_REPLAY) {
  await extend(process.env.GALLERY_HTTP_REPLAY);
  compare(process.env.GALLERY_HTTP_REPLAY);
  process.exit(process.exitCode);
}
const root = process.env.GALLERY_TEST_ROOT;
if (!root) throw Error("ISOLATED_ROOT_REQUIRED");
fs.mkdirSync(root, { recursive: true });
const out = fs.mkdtempSync(path.join(root, "Public-"));
const { prepare } = require("./prepare.cjs");
const { freePort } = require("../../test/support/runtime.js");
const cfg = require(path.join(reference, "src/instance/config.js"));
const generations = require(
  path.join(reference, "src/publication/generations.js"),
);
const live = require(path.join(reference, "src/catalog/live.js"));
const { createRuntimeServer } = require(
  path.join(reference, "src/server/http.js"),
);
const WS = require(path.join(reference, "node_modules/ws"));
const { image } = require("../demo/image.cjs");
function tool(name, args) {
  const r = spawnSync(name, args, { windowsHide: true, encoding: "utf8" });
  if (r.status !== 0) throw Error(`${name}: ${r.error || r.stderr}`);
}
const input = await prepare(path.join(out, "Input"), {
  port: await freePort(),
});
const fileRoot = path.join(out, "Files");
fs.mkdirSync(path.join(fileRoot, "nested 中文"), { recursive: true });
for (const name of [
  "2.png",
  "10.png",
  "01.png",
  "1.png",
  "中 文&~'😀.png",
  "ΟΣ.png",
  "\uE000.png",
  "😀.png",
  ".hidden.png",
])
  fs.writeFileSync(path.join(fileRoot, name), image(name.length));
fs.writeFileSync(path.join(fileRoot, "nested 中文", "page.png"), image(4));
fs.writeFileSync(path.join(fileRoot, "ignored.txt"), "synthetic unsupported");
fs.writeFileSync(path.join(fileRoot, "empty.png"), "");
fs.writeFileSync(path.join(fileRoot, "bad.png"), "synthetic invalid image");
fs.writeFileSync(
  path.join(fileRoot, "vector.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>',
);
tool("magick", [
  path.join(fileRoot, "1.png"),
  path.join(fileRoot, "still.jpg"),
]);
tool("magick", [
  "-delay",
  "10",
  path.join(fileRoot, "1.png"),
  path.join(fileRoot, "2.png"),
  "-loop",
  "0",
  path.join(fileRoot, "motion.gif"),
]);
tool("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=64x48:d=0.3",
  "-an",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  path.join(fileRoot, "clip.mp4"),
]);
fs.writeFileSync(
  path.join(fileRoot, "clip.zh-CN.vtt"),
  "WEBVTT\n\n00:00.000 --> 00:00.200\n合成字幕\n",
);
// The same source file identity is used by the library and file-browser routes.
const firstWork = fs.readdirSync(
  path.join(input.config.sources.pixiv, "700"),
)[0];
const workDir = path.join(input.config.sources.pixiv, "700", firstWork);
fs.copyFileSync(
  path.join(fileRoot, "clip.mp4"),
  path.join(workDir, "clip.mp4"),
);
fs.copyFileSync(
  path.join(fileRoot, "clip.zh-CN.vtt"),
  path.join(workDir, "clip.zh-CN.vtt"),
);
const cases = [];
function request(config, c) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      config.url + c.path,
      { method: c.method || "GET", headers: c.headers || {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const bytes = Buffer.concat(chunks),
            headers = {};
          for (const k of [
            "content-type",
            "content-length",
            "cache-control",
            "accept-ranges",
            "content-range",
            "content-security-policy",
            "x-content-type-options",
            "x-robots-tag",
            "x-gallery-thumbnail",
            "access-control-allow-origin",
            "access-control-allow-methods",
            "access-control-allow-headers",
            "vary",
            "location",
            "cross-origin-opener-policy",
            "cross-origin-embedder-policy",
            "cross-origin-resource-policy",
          ])
            if (res.headers[k] !== undefined) headers[k] = res.headers[k];
          resolve({
            status: res.statusCode,
            headers,
            ...(headers["content-type"]?.startsWith("application/json") &&
            bytes.length
              ? { json: JSON.parse(bytes) }
              : {
                  hash: crypto.createHash("sha256").update(bytes).digest("hex"),
                }),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(c.body);
  });
}
async function events(config) {
  return new Promise((resolve, reject) => {
    const ws = new WS(config.url.replace("http:", "ws:") + "/api/v1/events"),
      frames = [];
    ws.on("message", (b) => {
      frames.push(JSON.parse(b));
      if (frames.length === 2) ws.close();
    });
    ws.on("close", () => resolve(frames));
    ws.on("error", reject);
  });
}
for (const name of ["Empty", "Static", "Live"]) {
  const instanceRoot = path.join(out, name);
  fs.mkdirSync(instanceRoot);
  const raw = {
    instanceRoot,
    port: await freePort(),
    liveUpdates: name === "Live",
    sources: input.config.sources,
    fileBrowserRoots: [
      { id: "files", name: "合成文件", path: fileRoot },
      {
        id: "parent",
        name: "合成上层",
        path: path.join(out, "Input", "sources"),
      },
    ],
    shortLinks: { demo: "/#/f/files" },
  };
  if (name !== "Empty") {
    await generations.buildGeneration({
      instanceRoot,
      generationId: "first",
      catalogOptions: { platformRoots: input.config.sources },
    });
    generations.publishGeneration(instanceRoot, "first");
  }
  const config = cfg.normalizeRuntimeConfig(raw);
  cfg.ensureLayout(config);
  const generation =
    name === "Empty" ? null : generations.resolveActiveGeneration(instanceRoot);
  if (name === "Live") await live.ensureLive(config, generation);
  const configFile = path.join(instanceRoot, "config.json");
  fs.writeFileSync(configFile, JSON.stringify(raw));
  const status = { state: "READY", generations: [] };
  const browser = require(
    path.join(reference, "src/library/file-browser.js"),
  ).createFileBrowser(config);
  const { thumbnailCacheKey } = require(
    path.join(reference, "src/media/thumbnails.js"),
  );
  const cacheKeys = ["1.png", "clip.mp4", "ΟΣ.png", "中 文&~'😀.png"].map(
    (p) => ({
      root: "files",
      path: p,
      key: thumbnailCacheKey(browser.mediaFile("files", p)),
    }),
  );
  const host = createRuntimeServer({
    config,
    generation,
    status: () => status,
  });
  await host.start();
  const requests = [];
  const add = async (c) => {
    const expected = await request(config, c);
    requests.push({ ...c, expected });
    return expected.json;
  };
  try {
    for (const p of [
      "health",
      "status",
      "platforms",
      "file-roots",
      "generations",
      "works",
      "authors",
      "tags",
      "works?pageSize=2",
      "works?q=没有结果",
      "works?page=0",
      "works?platform=unknown",
      "missing",
    ])
      await add({ path: "/api/v1/" + p });
    for (const method of ["HEAD", "POST", "DELETE"])
      await add({ path: "/api/v1/works", method });
    await add({
      path: "/api/v1/status",
      headers: { Host: "forbidden.invalid" },
    });
    await add({
      path: "/api/v1/status",
      headers: { Origin: "http://forbidden.invalid" },
    });
    await add({
      path: "/api/v1/status",
      headers: {
        Origin:
          config.allowedOrigins.find((o) => o !== config.url) ||
          config.allowedOrigins[0],
      },
    });
    for (const m of ["GET", "HEAD", "POST"])
      await add({
        path: "/api/v1/status",
        method: "OPTIONS",
        headers: { "Access-Control-Request-Method": m },
      });
    for (const body of [
      "{}",
      '{"confirmReadOnly":true}',
      "null",
      "{bad",
      " ".repeat(4097),
    ])
      await add({ path: "/api/v1/scans", method: "POST", body });
    for (const suffix of [
      "",
      "&order=desc",
      "&mediaType=image&pageSize=2&page=2",
      "&mediaType=video",
      "&page=9007199254740991",
      "&pageSize=501",
      "&page=NaN",
      "&page=1e20",
      "&page=0x10",
      "&page=0b10",
      "&page=1_0",
      "&order=wrong",
      "&path=nested+%E4%B8%AD%E6%96%87",
      "&path=..",
      "&path=trailing.",
      "&path=missing",
      "&path=1.png",
    ])
      await add({ path: "/api/v1/files?root=files" + suffix });
    await add({ path: "/api/v1/files?root=parent&path=pixiv" });
    await add({ path: "/api/v1/files?root=missing" });
    for (const suffix of [
      "q=page",
      "q=%E4%B8%AD",
      "q=PNG&order=desc",
      "q=",
      "q=x&pageSize=201",
      "q=%00",
      "q=1&page=9007199254740991",
      "q=1&page=1e20",
      "q=1&page=0x10",
      "q=1&page=1_0",
    ])
      await add({ path: "/api/v1/file-search?root=files&" + suffix });
    for (const file of [
      "1.png",
      "still.jpg",
      "motion.gif",
      "vector.svg",
      "clip.mp4",
      "empty.png",
      "missing.png",
      "ignored.txt",
    ]) {
      for (const method of ["GET", "HEAD"])
        await add({
          path: "/api/v1/file-media?root=files&path=" + file,
          method,
        });
    }
    for (const range of [
      "bytes=0-3",
      "bytes=3-",
      "bytes=-3",
      "bytes=0-99999999999999999999999999999",
      "bytes=-999999999999999999999999",
      "bytes=999999999999999999999999-",
      "bytes=2-1",
      "bytes=-0",
      "bytes=",
      "bytes=0-1,3-4",
      "items=0-3",
    ])
      await add({
        path: "/api/v1/file-media?root=files&path=1.png",
        headers: { Range: range },
      });
    for (const file of ["1.png", "clip.mp4", "empty.png", "bad.png"]) {
      for (let n = 0; n < 2; n++)
        await add({ path: "/api/v1/file-thumbnails?root=files&path=" + file });
    }
    for (const suffix of [
      "path=clip.mp4&lang=zh-CN",
      "path=clip.mp4&lang=en-US",
      "path=clip.mp4&lang=ja",
      "path=1.png&lang=zh-CN",
    ])
      for (const method of ["GET", "HEAD"])
        await add({
          path: "/api/v1/file-subtitles?root=files&" + suffix,
          method,
        });
    const page = await request(config, { path: "/api/v1/works?pageSize=100" });
    let work = page.json.data.items[0];
    if (work) {
      work = (await add({ path: "/api/v1/works/" + work.id })).data;
      await add({ path: "/api/v1/works/" + work.id + "?g=stale" });
      for (const p of [work.stableId, "/p/pixiv/700", "/p/pixiv/missing"])
        for (const route of ["resolve", "chapters"])
          await add({
            path: "/api/v1/" + route + "?path=" + encodeURIComponent(p),
          });
      for (const media of work.media.slice(0, 1)) {
        for (const url of [
          media.url,
          media.url.replace(/g=[^&]+/, "g=old"),
          media.url.replace(/k=[^&]+/, "k=wrong"),
        ])
          await add({ path: url });
        await add({ path: media.thumbnailUrl });
        await add({ path: media.thumbnailUrl });
      }
      for (const route of ["db-entry", "list"])
        await add({
          path: "/api/" + route + "?p=" + encodeURIComponent(work.stableId),
        });
      for (const route of ["media", "thumbnail"])
        await add({
          path:
            "/api/" +
            route +
            "?p=" +
            encodeURIComponent(
              work.stableId + "/" + work.media[0].relativePath,
            ),
        });
      await add({
        path: "/api/v1/short-links",
        method: "POST",
        body: JSON.stringify({
          path: work.stableId,
          media: work.media[0].relativePath,
        }),
      });
    }
    for (const p of [
      "/api/v1/works/0",
      "/api/v1/works/9223372036854775807",
      "/api/v1/media/0",
      "/api/v1/media/999",
      "/api/v1/resolve?path=bad",
      "/api/db-authors?platform=pixiv",
      "/api/db-posts?platform=Venera",
      "/api/search?platform=pixiv&q=test",
      "/api/db-author-posts?platform=pixiv&authorId=700",
      "/api/list?p=/f/files",
      "/api/media?p=/f/files/1.png",
      "/api/db-entry?p=missing",
      "/api/db-posts?platformPath=%2Fp%2F%25xx",
    ])
      await add({ path: p });
    for (const body of [
      { path: "/f/files" },
      { path: "/f/files", media: "1.png" },
      { path: "/f/files", media: "../1.png" },
      { path: "invalid" },
      {},
    ]) {
      const json = await add({
        path: "/api/v1/short-links",
        method: "POST",
        body: JSON.stringify(body),
      });
      if (json.data) await add({ path: json.data.url });
    }
    await add({
      path: "/api/shorten",
      method: "POST",
      body: '{"path":"/f/files"}',
    });
    for (const p of [
      "/",
      "/manage",
      "/protocol/protocol.json",
      "/frontend/gallery/app.js",
      "/frontend/assets/canvas/vendor/canvaskit.js",
      "/frontend/%ZZ",
      "/frontend/..%2F..%2Fpackage.json",
      "/missing",
      "/robots.txt",
      "/venera-source.js",
      "/s/demo",
      "/s/missing",
    ])
      for (const method of ["GET", "HEAD"]) await add({ path: p, method });
    const frames = await events(config);
    cases.push({ name, configFile, requests, frames, status, cacheKeys });
  } finally {
    await host.close();
  }
}
const golden = path.join(out, "golden.json");
fs.writeFileSync(
  golden,
  JSON.stringify(
    {
      reference,
      frontend: path.join(reference, "public"),
      assets: path.join(reference, "resources"),
      cases,
    },
    null,
    2,
  ),
);
// The generated cache must be absent for Go's first request too. Move only owned
// derived data aside; keep it until the differential is recorded and reviewed.
for (const c of cases) {
  const cache = path.join(path.dirname(c.configFile), "cache");
  if (fs.existsSync(cache)) fs.renameSync(cache, cache + "-node-oracle");
}
compare(golden);
