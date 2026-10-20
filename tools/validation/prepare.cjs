"use strict";
// Test-only empty database initialization and public corpus golden records.
// Actual extraction and every subsequent Catalog/Search write are performed by Go.
const fs = require("node:fs"),
  path = require("node:path");
const repo = path.resolve(__dirname, "../..");
const os = require("node:os");
const testRoot =
  process.env.GALLERY_TEST_ROOT || path.join(os.tmpdir(), "Gallery-Legacy");
const { PLATFORM_REGISTRY } = require(
  path.join(repo, "src/library/platforms.js"),
);
const { normalizeRuntimeConfig, ensureLayout } = require(
  path.join(repo, "src/instance/config.js"),
);
const { ensureLive } = require(path.join(repo, "src/catalog/live.js"));
const { adapterForPlatform } = require(
  path.join(repo, "src/metadata/index.js"),
);
const { metadataShapeForPlatform, shapePolicyForPlatform } = require(
  path.join(repo, "src/metadata/shape/index.js"),
);
const { image } = require(path.join(repo, "tools/demo/image.cjs"));
async function prepare(
  root,
  { productionSources = null, port = 18250, listingSource = "filesystem" } = {},
) {
  const { inside, noLinks } = require(
    path.join(repo, "src/library/io-paths.js"),
  );
  root = path.resolve(root);
  noLinks(root);
  if (!inside(testRoot, root)) throw Error("ISOLATED_ROOT_REQUIRED");
  if (fs.existsSync(root)) throw Error("NEW_INSTANCE_REQUIRED");
  if (port === 8081) throw Error("PRODUCTION_PORT_FORBIDDEN");
  if (listingSource !== "filesystem") throw Error("LISTING_SOURCE_INVALID");
  const sources =
    productionSources ||
    Object.fromEntries(
      PLATFORM_REGISTRY.map((p) => [p.id, path.join(root, "sources", p.id)]),
    );
  const instanceRoot = path.join(root, "instance");
  const raw = {
    instanceRoot,
    deployment: "staging",
    mode: "local",
    listenAddress: "127.0.0.1",
    port,
    sources,
    liveUpdates: true,
    fileBrowserRoots: [],
    shortLinks: {},
    retention: { enabled: false },
  };
  const config = normalizeRuntimeConfig(raw);
  ensureLayout(config);
  let count = 0;
  if (!productionSources) {
    const corpus = JSON.parse(
      fs.readFileSync(path.join(repo, "test/fixtures/metadata/corpus.json")),
    );
    for (const p of PLATFORM_REGISTRY) {
      const fixtures = corpus.cases.filter((c) => c.platformId === p.id);
      const cases = [
        ...fixtures.map((c) => ({
          raw: fs.readFileSync(
            path.join(repo, "test/fixtures/metadata", c.fixture),
            "utf8",
          ),
        })),
        { raw: "{broken" },
        { raw: "[]" },
        { raw: null },
        { raw: "{}" },
      ];
      for (const [i, c] of cases.entries()) {
        const author =
          p.id === "Pawchive"
            ? "patreon_700"
            : p.id === "Gank"
              ? "12345678-abcd-4abc-8abc-0123456789ab"
              : p.id === "Venera"
                ? "Synthetic book"
                : "700";
        const work =
          p.id === "Venera"
            ? `chapter-${i + 1}`
            : `2026-01-${String(i + 1).padStart(2, "0")}_00-00-00_${i < 2 ? "duplicate" : "item-" + i}`;
        const dir = path.join(sources[p.id], author, work);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "1.png"), image(count++));
        fs.writeFileSync(path.join(dir, "2.png"), image(count++));
        fs.writeFileSync(path.join(dir, "10.png"), image(count++));
        fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
        fs.writeFileSync(
          path.join(dir, "nested", "page.webp"),
          Buffer.from("synthetic eligible observed file"),
        );
        if (c.raw !== null)
          fs.writeFileSync(path.join(dir, "metadata.json"), c.raw);
        fs.writeFileSync(
          path.join(dir, "attachment.txt"),
          "synthetic non-media",
        );
      }
      fs.mkdirSync(path.join(sources[p.id], "empty-author"), {
        recursive: true,
      });
    }
  }
  fs.writeFileSync(
    path.join(instanceRoot, "config.json"),
    JSON.stringify(raw, null, 2) + "\n",
  );
  await ensureLive(config, null);
  const scan = {
    testOnly: true,
    instanceRoot,
    database: path.join(instanceRoot, "live/catalog.sqlite"),
    listingSource,
    sources,
    workers: 8,
    batchSize: 128,
    metadataLimit: 64 * 1024 * 1024,
  };
  fs.writeFileSync(
    path.join(instanceRoot, "go-scan.json"),
    JSON.stringify(scan, null, 2) + "\n",
  );
  return { config, scan, root, media: count };
}
function golden(target) {
  const corpus = JSON.parse(
      fs.readFileSync(path.join(repo, "test/fixtures/metadata/corpus.json")),
    ),
    cases = [];
  for (const c of [
    ...corpus.cases,
    { platformId: "Venera", name: "empty", raw: "{}" },
  ]) {
    const raw =
        c.raw ||
        fs.readFileSync(
          path.join(repo, "test/fixtures/metadata", c.fixture),
          "utf8",
        ),
      value = JSON.parse(raw);
    const author =
        c.platformId === "Pawchive"
          ? "patreon_700"
          : c.platformId === "Gank"
            ? "12345678-abcd-4abc-8abc-0123456789ab"
            : "700",
      work = "2026-01-01_00-00-00_duplicate";
    const result = adapterForPlatform(c.platformId).adapt({
      platformId: c.platformId,
      metadata: value,
      authorDirectoryName: author,
      workDirectoryName: work,
      metadataRelativePath: author + "\\" + work + "\\metadata.json",
    });
    cases.push({
      platform: c.platformId,
      name: c.name,
      author,
      work,
      raw,
      expected: result,
      shape: metadataShapeForPlatform(c.platformId, value).hash,
      policy: shapePolicyForPlatform(c.platformId),
    });
  }
  fs.writeFileSync(target, JSON.stringify(cases, null, 2) + "\n");
  return cases.length;
}
module.exports = { prepare, golden, repo, testRoot };
if (require.main === module) {
  const root = process.argv[2];
  prepare(root)
    .then((x) => {
      const n = golden(path.join(root, "golden.json"));
      console.log(
        JSON.stringify({
          prepared: true,
          synthetic: true,
          cases: n,
          root: x.root,
        }),
      );
    })
    .catch((e) => {
      console.error(e.code || e.message);
      process.exitCode = 1;
    });
}
