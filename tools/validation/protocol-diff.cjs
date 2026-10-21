"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  { spawnSync } = require("node:child_process");
const repo = path.resolve(__dirname, "../..");
const reference = process.env.GALLERY_NODE_REFERENCE_ROOT || repo;
const { query, encodeCursor } = require(
  path.join(reference, "src/server/input.js"),
);
const { PLATFORM_REGISTRY } = require(
  path.join(reference, "src/library/platforms.js"),
);
const contract = require(path.join(reference, "api/protocol.json"));
const root =
  process.env.GALLERY_TEST_ROOT || path.join(os.tmpdir(), "Gallery-Legacy");
const out = path.join(root, "Protocol-" + Date.now());
const cases = [];
function add(
  name,
  raw,
  kind = "works",
  revision = 7,
  generation = "fixed-epoch",
) {
  let expected;
  try {
    expected = {
      query: query(new URLSearchParams(raw), kind, generation, revision),
    };
  } catch (error) {
    expected = { code: error.code, status: error.status || 400 };
  }
  cases.push({ name, kind, raw, generation, revision, expected });
}
add("defaults", "");
for (const kind of ["works", "authors", "tags"]) {
  for (const platform of PLATFORM_REGISTRY)
    add(
      kind + "-" + platform.id,
      "platform=" + encodeURIComponent(platform.id),
      kind,
    );
  for (const raw of [
    "q=鱼猫",
    "q=🧪",
    "q=%FF%FF",
    "q=%E2%82",
    "q=percent%xyz",
    "q=a+b;c",
    "q=%3Cb%3E%26%22%27",
    "q=%E2%80%A8",
    "q=" + encodeURIComponent("a".repeat(256)),
    "q=" + encodeURIComponent("🧪".repeat(257)),
    "g=old",
    "rev=6",
    "page=0",
    "page=1000001",
    "page=1.1",
    "page=1e2",
    "page=0002",
    "pageSize=200",
    "pageSize=201",
    "unknown=1",
    "q=a&q=b",
    "q=%00",
  ])
    add(kind + "-" + raw, raw, kind);
}
for (const sort of contract.workSorts)
  add("works-sort-" + sort, "sort=" + sort);
for (const sort of contract.authorSorts)
  add("authors-sort-" + sort, "sort=" + sort, "authors");
for (const raw of [
  "author=9223372036854775807",
  "author=9223372036854775808",
  "author=0004",
  "author=0",
  "tag=",
  "tag=" + encodeURIComponent("🧪".repeat(257)),
  "hideEmpty=1",
  "hideEmpty=true",
  "mediaType=video",
  "mediaType=unknown",
  "sort=unknown",
])
  add(raw, raw);
add("static-revision-invalid", "rev=7", "works", null);
add("static-no-revision", "", "works", null);
for (const value of [
  "%E0%80%80",
  "%ED%A0%80",
  "%F0%90%80",
  "%F4%8F%BF",
  "%F4%90%80%80",
  "%C2%41",
  "%E2%82%41",
  "%E2%82%AC",
  "%00",
  "%E2%28%A1",
])
  add("utf8-" + value, "q=" + value);
for (const kind of ["works", "authors", "tags"]) {
  const q = query(new URLSearchParams(), kind, "fixed-epoch", 7);
  const field =
    kind === "works" ? "workId" : kind === "authors" ? "authorId" : "tagId";
  const position =
    kind === "tags"
      ? { tagId: 2n }
      : {
          value: kind === "works" ? 1234n : "中文<&\u2028",
          [field]: 9223372036854775807n,
        };
  const valid = encodeCursor(position, q.key, 7);
  add(kind + "-cursor-valid", "cursor=" + valid, kind);
  add(kind + "-cursor-revision", "rev=8&cursor=" + valid, kind);
  add(kind + "-cursor-context", "q=other&cursor=" + valid, kind);
  for (const data of [
    null,
    [],
    0,
    false,
    {},
    { v: 2, key: q.key, position },
    { v: 1, key: q.key, revision: 6, position },
    { v: 1, key: q.key, position: { [field]: "0" } },
    { v: 1, key: q.key, position: { [field]: "1", value: 123 } },
    {
      v: 1,
      key: q.key,
      position: { [field]: "1", value: "-9223372036854775809" },
    },
  ]) {
    const text = JSON.stringify(data, (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    add(
      kind + "-cursor-" + text,
      "cursor=" + Buffer.from(text).toString("base64url"),
      kind,
    );
  }
  for (const text of ["", "not-json", "{}garbage", "{} {}", "="])
    add(
      kind + "-cursor-malformed-" + text,
      "cursor=" + Buffer.from(text).toString("base64url"),
      kind,
    );
}
fs.mkdirSync(out, { recursive: true });
const golden = path.join(out, "node-golden.json");
fs.writeFileSync(
  golden,
  JSON.stringify(
    cases,
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
    "./internal/protocol/...",
  ],
  {
    cwd: repo,
    env: { ...process.env, GALLERY_PROTOCOL_GOLDEN: golden },
    encoding: "utf8",
    windowsHide: true,
  },
);
fs.writeFileSync(
  path.join(out, "go-test.log"),
  (result.stdout || "") + (result.stderr || ""),
);
fs.writeFileSync(
  path.join(out, "result.json"),
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
    ...JSON.parse(fs.readFileSync(path.join(out, "result.json"))),
  }),
);
process.exitCode = result.status === 0 ? 0 : 1;
