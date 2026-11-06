import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const destination = args[args.indexOf("--output") + 1];
if (!args.includes("--output") || !path.isAbsolute(destination))
  throw Error("Provide an absolute external --output directory");
const repository = path.resolve(import.meta.dirname, "../..");
if (!path.relative(repository, destination).startsWith(".."))
  throw Error("Font binaries must stay outside the repository");
const lockFile = path.join(import.meta.dirname, "misans.lock.json");
const source = "https://i02.appmifile.com/i18n/fonts/MiSans/vf/index.css";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function official(url) {
  const target = new URL(url);
  if (
    target.origin !== "https://i02.appmifile.com" ||
    !target.pathname.startsWith("/i18n/fonts/MiSans/vf/")
  )
    throw Error("Unexpected font source");
  const response = await fetch(target, {
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`Font download returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function latinPoints(block) {
  const value = /unicode-range\s*:\s*([^;}]*)/i.exec(block)?.[1] || "";
  const ranges = value.split(",").map((part) => {
    const [a, b = a] = part.trim().replace(/^U\+/i, "").split("-");
    return [parseInt(a, 16), parseInt(b, 16)];
  });
  return Array.from({ length: 95 }, (_, i) => i + 32).filter((cp) =>
    ranges.some(([a, b]) => cp >= a && cp <= b),
  );
}

async function pin() {
  try {
    await fs.access(lockFile);
    throw Error("Font version is already pinned");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.mkdir(destination, { recursive: true });
  const cssFile = path.join(destination, "index.css");
  let css;
  try {
    css = await fs.readFile(cssFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    css = await official(source);
    await fs.writeFile(cssFile, css, { flag: "wx" });
  }
  const files = new Map();
  const coverage = new Map();
  for (const block of css
    .toString("utf8")
    .matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const src = /url\(\s*['"]?([^'"\)]+)['"]?\s*\)/i.exec(block[1])?.[1];
    if (!src) continue;
    const url = new URL(src, source).href;
    const name = path.posix.basename(new URL(url).pathname);
    if (!/^\d+\.woff2$/.test(name)) throw Error("Unexpected font filename");
    if (files.has(name) && files.get(name).url !== url)
      throw Error("Font source name collision");
    files.set(name, { name, url });
    coverage.set(name, latinPoints(block[1]));
  }
  const latin = [],
    remaining = new Set(Array.from({ length: 95 }, (_, i) => i + 32));
  while (remaining.size) {
    const best = [...coverage].sort(
      (a, b) =>
        b[1].filter((cp) => remaining.has(cp)).length -
        a[1].filter((cp) => remaining.has(cp)).length,
    )[0];
    if (!best || !best[1].some((cp) => remaining.has(cp)))
      throw Error("Official Latin coverage is incomplete");
    latin.push(best[0]);
    best[1].forEach((cp) => remaining.delete(cp));
    coverage.delete(best[0]);
  }
  const rows = [...files.values()].sort(
    (a, b) => parseInt(a.name) - parseInt(b.name),
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < rows.length) {
        const row = rows[next++];
        const bytes = await official(row.url);
        await fs.writeFile(path.join(destination, row.name), bytes, {
          flag: "wx",
        });
        row.bytes = bytes.length;
        row.sha256 = sha256(bytes);
      }
    }),
  );
  const lock = {
    generatedBy:
      "node tools/fonts/acquire.mjs --pin --output <external-font-cache>",
    source,
    cssSha256: sha256(css),
    cssBytes: css.length,
    latin,
    files: rows,
  };
  await fs.writeFile(lockFile, JSON.stringify(lock, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      files: rows.length,
      bytes: rows.reduce((n, row) => n + row.bytes, 0),
      latin,
      cssSha256: lock.cssSha256,
    }),
  );
}

async function acquire() {
  const lock = JSON.parse(await fs.readFile(lockFile, "utf8"));
  await fs.mkdir(destination, { recursive: true });
  for (const row of [
    { name: "index.css", url: lock.source, sha256: lock.cssSha256 },
    ...lock.files,
  ]) {
    const file = path.join(destination, row.name);
    let bytes;
    try {
      bytes = await fs.readFile(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      bytes = await official(row.url);
      if (sha256(bytes) !== row.sha256)
        throw Error(`Official font version differs: ${row.name}`);
      await fs.writeFile(file, bytes, { flag: "wx" });
    }
    if (sha256(bytes) !== row.sha256)
      throw Error(`Cached font version differs: ${row.name}`);
  }
  console.log(
    `Official MiSans cache matches ${lock.files.length} pinned subsets`,
  );
}

await (args.includes("--pin") ? pin() : acquire());
