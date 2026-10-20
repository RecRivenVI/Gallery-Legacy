"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
const { FILETIME_EPOCH } = require("../../src/indexing/inventory.js");
function inventory(root) {
  const rows = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name),
        stat = fs.lstatSync(absolute, { bigint: true });
      rows.push({
        type: stat.isDirectory() ? "folder" : "file",
        path: directory,
        name: entry.name,
        size: stat.isDirectory() ? "" : stat.size.toString(),
        date_modified: (stat.mtimeNs / 100n + FILETIME_EPOCH).toString(),
      });
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(absolute);
    }
  }
  visit(root);
  return rows;
}
async function everythingServer(t, roots, { port = 0 } = {}) {
  const controls = {
    requests: [],
    status: 200,
    transform: null,
    truncate: false,
    delay: 0,
    snapshot: null,
  };
  const allowed = new Set(
    Object.values(roots).map((root) => path.resolve(root)),
  );
  const server = http.createServer(async (req, res) => {
    const query = new URL(req.url, "http://127.0.0.1").searchParams;
    const search = query.get("search");
    if (!search?.startsWith('path:"') || !search.endsWith('"')) {
      res.writeHead(400).end();
      return;
    }
    const root = path.resolve(search.slice(6, -1));
    if (!allowed.has(root)) {
      res.writeHead(403).end();
      return;
    }
    controls.requests.push({
      root,
      paginated: query.has("count") || query.has("offset"),
    });
    const original = controls.snapshot?.[root] || inventory(root);
    const rows = controls.transform
      ? controls.transform(
          original.map((row) => ({ ...row })),
          root,
        )
      : original;
    if (controls.delay)
      await new Promise((resolve) => setTimeout(resolve, controls.delay));
    if (res.destroyed) return;
    res.writeHead(controls.status, { "Content-Type": "application/json" });
    const json = JSON.stringify({
      totalResults: controls.matchTransformedTotal
        ? rows.length
        : original.length,
      results: rows,
    });
    res.end(controls.truncate ? json.slice(0, -10) : json);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { controls, endpoint: `http://127.0.0.1:${server.address().port}/` };
}
module.exports = { inventory, everythingServer };
