"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  { spawnSync } = require("node:child_process");
const repo = path.resolve(__dirname, "../.."),
  reference = process.env.GALLERY_NODE_REFERENCE_ROOT || repo;
const { prepare } = require("./prepare.cjs"),
  { fullScan } = require("../../src/indexing/runner.cjs"),
  { freePort } = require("../../test/support/runtime.js"),
  { image } = require("../demo/image.cjs");
const { CatalogReader } = require(
  path.join(reference, "src/catalog/reader.js"),
);
const { QueryIndex } = require(path.join(reference, "src/search/query.js"));
const { query, encodeCursor } = require(
  path.join(reference, "src/server/input.js"),
);
const { getLiveState } = require(path.join(reference, "src/catalog/live.js"));
const contract = require(path.join(reference, "api/protocol.json"));
const root =
  process.env.GALLERY_TEST_ROOT || path.join(os.tmpdir(), "Gallery-Legacy");
async function main() {
  const out = path.join(root, "Reader-" + Date.now());
  const demo = await prepare(path.join(out, "Input"), {
    port: await freePort(),
  });
  const special = path.join(
    demo.config.sources.pixiv,
    "合成 & '🧪",
    "测试 0003 & '🧪",
  );
  fs.mkdirSync(path.join(special, "nested"), { recursive: true });
  for (const [i, name] of [
    ".cover.png",
    "1.png",
    "02.png",
    "10.png",
    "nested/0002.png",
  ].entries())
    fs.writeFileSync(path.join(special, name), image(i));
  await fullScan(demo.config, { mode: "full", confirmReadOnly: true });
  const database = path.join(demo.config.instanceRoot, "live/catalog.sqlite"),
    epoch = "fixed-epoch";
  const reader = new CatalogReader(database, epoch, demo.config.sources, {
    live: true,
  });
  const staticFile = path.join(out, "static-catalog.sqlite");
  await reader.db.backup(staticFile);
  const liveCases = collectCases(
    reader,
    new QueryIndex(null, null, { db: reader.db, prefix: "live_" }),
    epoch,
    getLiveState(reader.db).revision,
  );
  const liveOK = compare(out, "live", database, epoch, null, liveCases);
  const Database = require(path.join(reference, "node_modules/better-sqlite3"));
  const db = new Database(staticFile);
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'live_%'",
      )
      .all();
    for (const { name } of tables)
      db.exec('DROP TABLE IF EXISTS "' + name + '"');
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  const search = path.join(out, "static-search.sqlite");
  require(path.join(reference, "src/search/build.js")).buildSearchIndex({
    catalogPath: staticFile,
    searchIndexPath: search,
  });
  const st = fs.statSync(staticFile);
  const facts = {
    workCount: liveCases.find((x) => x.operation === "stats").expected.works,
    catalogSize: st.size,
    catalogMtimeMs: st.mtimeMs,
    catalogSha256: require(
      path.join(reference, "src/catalog/file-hash.js"),
    ).hashDatabaseFile(staticFile),
  };
  const staticReader = new CatalogReader(
    staticFile,
    epoch,
    demo.config.sources,
  );
  const staticIndex = new QueryIndex(search, facts);
  let staticCases;
  try {
    staticIndex.bindUnreadableWorks(staticReader.unreadableWorkIds());
    staticCases = collectCases(staticReader, staticIndex, epoch, null);
  } finally {
    staticIndex.close();
  }
  const staticOK = compare(
    out,
    "static",
    staticFile,
    epoch,
    search,
    staticCases,
  );
  process.exitCode = liveOK && staticOK ? 0 : 1;
}
function collectCases(reader, index, epoch, revision) {
  const cases = [];
  function addPage(name, raw, kind = "works") {
    const q = query(new URLSearchParams(raw), kind, epoch, revision);
    const result =
      kind === "works"
        ? index.workPage({
            ...q,
            offset: q.cursor ? 0 : (q.page - 1) * q.pageSize,
          })
        : kind === "authors"
          ? index.authorPage({
              ...q,
              offset: q.cursor ? 0 : (q.page - 1) * q.pageSize,
            })
          : index.tagPage({
              ...q,
              offset: q.cursor ? 0 : (q.page - 1) * q.pageSize,
            });
    const items =
      kind === "works"
        ? reader.works(
            result.rows.map((r) => r.work_id),
            q.mediaType,
          )
        : kind === "authors"
          ? reader.authors(result.rows.map((r) => r.author_id))
          : result.rows.map((r) => ({
              id: String(r.tag_id),
              label: r.display_value,
              workCount: Number(r.work_count),
            }));
    const expected = {
      items,
      total: result.total,
      page: q.page,
      pageSize: q.pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / q.pageSize)),
      cursor: encodeCursor(result.nextCursor, q.key, q.revision),
      ...(revision === null ? {} : { revision }),
      mode: result.mode || kind,
    };
    cases.push({ name, operation: "page", kind, raw, revision, expected });
    return expected;
  }
  function add(name, operation, args = {}) {
    const methods = {
      stats: () => reader.stats(),
      platformStats: () => reader.platformStats(),
      works: () => reader.works(args.ids.map(BigInt), args.mediaType),
      work: () => reader.work(BigInt(args.id)),
      authors: () => reader.authors(args.ids.map(BigInt)),
      resolve: () => reader.resolvePublicPath(args.path),
      chapters: () => reader.chapters(args.path),
      mediaPath: () => reader.mediaAtPublicPath(args.path),
      identity: () => reader.mediaIdentity(BigInt(args.id)),
    };
    cases.push({ name, operation, ...args, expected: methods[operation]() });
  }
  try {
    add("totals", "stats");
    add("platform totals", "platformStats");
    add("empty works", "works", { ids: [], mediaType: "all" });
    const works = reader.db
        .prepare("SELECT work_id FROM works ORDER BY work_id")
        .all()
        .map((x) => String(x.work_id)),
      authors = reader.db
        .prepare("SELECT author_id FROM authors ORDER BY author_id")
        .all()
        .map((x) => String(x.author_id));
    for (const mediaType of ["all", "image", "video"])
      add("all works " + mediaType, "works", { ids: works, mediaType });
    add("requested order", "works", {
      ids: ["9223372036854775807", ...works.slice(0, 3).reverse()],
      mediaType: "all",
    });
    add("all authors", "authors", { ids: authors });
    add("missing author", "authors", { ids: ["9223372036854775807"] });
    for (const id of works) {
      add("work " + id, "work", { id });
      const w = reader.work(BigInt(id));
      add("resolve work " + id, "resolve", { path: w.stableId });
      add("chapters work " + id, "chapters", { path: w.stableId });
      for (const m of w.media) {
        add("media path " + m.id, "mediaPath", {
          path: w.stableId + "/" + m.relativePath,
        });
        add("identity " + m.id, "identity", { id: m.id });
      }
    }
    for (const a of reader.authors(authors.map(BigInt))) {
      add("resolve author " + a.id, "resolve", { path: a.stableId });
      add("chapters author " + a.id, "chapters", { path: a.stableId });
    }
    for (const value of [
      "/p/pixiv/../bad",
      "/p/pixiv//absolute",
      "/p/%zz/a",
      "/p/unknown/a",
      "/p/pixiv/no-work",
      "/p/pixiv/a\\..\\b",
    ]) {
      add("bad resolve " + value, "resolve", { path: value });
      add("bad media " + value, "mediaPath", { path: value });
    }
    add("missing work", "work", { id: "9223372036854775807" });
    for (const [kind, sorts] of [
      ["works", contract.workSorts],
      ["authors", contract.authorSorts],
      ["tags", [null]],
    ]) {
      for (const sort of sorts) {
        const base = sort ? "sort=" + sort : "";
        for (const suffix of [
          "",
          "&platform=pixiv",
          "&q=中文",
          "&q=synthetic",
          "&q=700",
          "&q=%3C%26%3E",
          "&q=🧪",
          "&q=no_match",
          "&q=ＡＢ",
          "&q=%22",
          "&q=%C2%85",
        ]) {
          addPage(kind + " " + base + suffix, base + suffix, kind);
        }
        const first = addPage(
          kind + " first " + sort,
          base + "&pageSize=2",
          kind,
        );
        if (first.cursor)
          addPage(
            kind + " next " + sort,
            base + "&pageSize=2&cursor=" + first.cursor,
            kind,
          );
        addPage(kind + " offset " + sort, base + "&pageSize=2&page=2", kind);
        if (kind === "works")
          for (const filter of ["image", "video"])
            addPage(
              kind + " " + sort + filter,
              base + "&mediaType=" + filter + "&hideEmpty=1",
              kind,
            );
      }
    }
  } finally {
    reader.close();
  }

  return cases;
}
function compare(out, label, database, epoch, search, cases) {
  const golden = path.join(out, label + "-node-golden.json");
  fs.writeFileSync(
    golden,
    JSON.stringify(
      { database, epoch, live: label === "live", search, cases },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) + "\n",
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(repo, "tools/go/run.cjs"),
      "test",
      ...(process.argv.includes("--race") ? ["-race"] : []),
      "-count=1",
      "./internal/reading/...",
    ],
    {
      cwd: repo,
      env: { ...process.env, GALLERY_READER_GOLDEN: golden },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  fs.writeFileSync(
    path.join(out, label + "-go-test.log"),
    (result.stdout || "") + (result.stderr || ""),
  );
  fs.writeFileSync(
    path.join(out, label + "-result.json"),
    JSON.stringify(
      {
        reference,
        cases: cases.length,
        exitCode: result.status,
        conclusion: result.status === 0 ? "一致" : "有差异",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      output: out,
      cases: cases.length,
      exitCode: result.status,
    }),
  );
  return result.status === 0;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
