"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const {
  InventoryDecoder,
  normalizeEverythingConfig,
  readEverythingInventory,
} = require("../../src/library/everything.js");
const { fixture } = require("../support/runtime.js");
const { everythingServer } = require("../support/everything.js");
const net = require("node:net"),
  { spawn } = require("node:child_process");

async function transport(t, respond) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => respond(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/`;
}

const responseHeaders =
  "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n";

test("inventory decoder handles fragmented escaped Unicode rows and reversed member order", () => {
  const expected = [
    {
      name: '中文 😀 \\ \" { }',
      size: "9007199254740993",
      date_modified: "132223104001234568",
    },
    { name: "two" },
  ];
  const json = JSON.stringify({ results: expected, totalResults: 2 });
  const decoder = new InventoryDecoder(),
    rows = [];
  for (const char of json) rows.push(...decoder.push(char));
  rows.push(...decoder.push("", true));
  assert.deepEqual(rows, expected);
});
test("inventory decoder rejects truncation, count mismatch, duplicate envelope keys and trailing data", () => {
  for (const json of [
    '{"totalResults":1,"results":[]}',
    '{"totalResults":0,"results":[',
    '{"totalResults":0,"totalResults":0,"results":[]}',
    '{"totalResults":0,"results":[]}x',
    '{"totalResults":1,"results":[{},]}',
    '{"results":[],}',
  ]) {
    assert.throws(() => new InventoryDecoder().push(json, true), /EVERYTHING_/);
  }
  assert.throws(
    () =>
      new InventoryDecoder().push('{"results":[{"name":"' + "x".repeat(262145)),
    /EVERYTHING_ROW_TOO_LARGE/,
  );
  assert.throws(
    () =>
      new InventoryDecoder().push(
        JSON.stringify({
          results: [{ name: "x".repeat(262145) }],
          totalResults: 1,
        }),
        true,
      ),
    /EVERYTHING_ROW_TOO_LARGE/,
  );
  assert.deepEqual(
    new InventoryDecoder().push('{"results":[],"totalResults":0}', true),
    [],
  );
});
test("Everything configuration is explicit loopback HTTP without credentials or redirects", () => {
  assert.equal(normalizeEverythingConfig(undefined), null);
  assert.equal(
    normalizeEverythingConfig({}).endpoint,
    "http://127.0.0.1:54321/",
  );
  for (const endpoint of [false, 54321, "", {}])
    assert.throws(
      () => normalizeEverythingConfig({ endpoint }),
      /EVERYTHING_CONFIG_INVALID/,
    );
  for (const endpoint of [
    "http://localhost:54321/",
    "http://192.168.1.1/",
    "https://127.0.0.1/",
    "http://user:password@127.0.0.1/",
    "http://127.0.0.1/path",
    "http://127.0.0.1/?count=10",
  ]) {
    assert.throws(
      () => normalizeEverythingConfig({ endpoint }),
      /EVERYTHING_CONFIG_INVALID/,
    );
  }
});

test("HTTP callback errors are not masked as network errors and non-success responses fail closed", async (t) => {
  const f = await fixture(t),
    server = await everythingServer(t, f.bindings);
  const error = Object.assign(new Error("synthetic cache failure"), {
    code: "SQLITE_FULL",
  });
  await assert.rejects(
    readEverythingInventory({
      endpoint: server.endpoint,
      root: f.bindings.pixiv,
      onRows: () => {
        throw error;
      },
    }),
    (actual) => actual === error,
  );
  server.controls.status = 503;
  await assert.rejects(
    readEverythingInventory({
      endpoint: server.endpoint,
      root: f.bindings.pixiv,
      onRows: () => {},
    }),
    { code: "EVERYTHING_HTTP_FAILED" },
  );
});

test("inventory decoder releases each row batch instead of retaining a whole-library response", () => {
  const decoder = new InventoryDecoder();
  decoder.push('{"totalResults":12000,"results":[');
  for (let index = 0; index < 12000; index++) {
    const rows = decoder.push(
      (index ? "," : "") +
        JSON.stringify({
          name: "synthetic-" + index,
          size: "42",
          date_modified: "132223104000000000",
        }),
    );
    assert.equal(rows.length, 1);
    assert.equal(decoder.buffer.length, 0);
  }
  decoder.push("]}", true);
  assert.equal(decoder.rows, 12000);
  assert.equal(decoder.buffer.length, 0);
});
test("HTTP inventory uses one complete scoped request and can cancel a pending response", async (t) => {
  const f = await fixture(t),
    server = await everythingServer(t, f.bindings),
    rows = [];
  const result = await readEverythingInventory({
    endpoint: server.endpoint,
    root: f.bindings.pixiv,
    onRows: (chunk) => rows.push(...chunk),
  });
  assert.equal(rows.length, result.entries);
  assert.ok(rows.length > 6);
  assert.deepEqual(
    server.controls.requests.map((r) => r.paginated),
    [false],
  );
  server.controls.delay = 500;
  const start = Date.now();
  await assert.rejects(
    readEverythingInventory({
      endpoint: server.endpoint,
      root: f.bindings.pixiv,
      onRows: () => {},
      checkCancelled() {
        if (Date.now() - start > 100)
          throw Object.assign(new Error("cancelled"), {
            code: "SCAN_CANCELLED",
          });
      },
    }),
    { code: "SCAN_CANCELLED" },
  );
});

test(
  "close-delimited large HTTP inventory survives slow consumers without crashing the scan process",
  { timeout: 15000 },
  async (t) => {
    const count = 12000;
    const body = JSON.stringify({
      totalResults: count,
      results: Array.from({ length: count }, (_, i) => ({
        type: "file",
        path: "C:\\Synthetic",
        name: "synthetic-" + i + "-" + "x".repeat(80),
        size: "42",
        date_modified: "132223104000000000",
      })),
    });
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () =>
        socket.end(
          "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" +
            body,
        ),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    const endpoint = `http://127.0.0.1:${server.address().port}/`;
    // A transport assertion is uncatchable, so reproduce in a real child rather
    // than losing the test runner and masking which regression failed.
    const script = `const {readEverythingInventory}=require(${JSON.stringify(require.resolve("../../src/library/everything.js"))});let rows=0;
    readEverythingInventory({endpoint:${JSON.stringify(endpoint)},root:"C:/Synthetic",onRows:async batch=>{rows+=batch.length;await new Promise(r=>setTimeout(r,15));}})
      .then(v=>{console.log(JSON.stringify({entries:v.entries,rows}));}).catch(e=>{console.error(e.code);process.exitCode=1;});`;
    const child = spawn(process.execPath, ["-e", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { entries: count, rows: count });
  },
);

test(
  "premature HTTP body termination is catchable and never accepted as a complete inventory",
  { timeout: 5000 },
  async (t) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () =>
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{"totalResults":0,"results":[]}',
        ),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    await assert.rejects(
      readEverythingInventory({
        endpoint: `http://127.0.0.1:${server.address().port}/`,
        root: "C:/Synthetic",
        onRows() {},
      }),
      { code: "EVERYTHING_REQUEST_FAILED" },
    );
  },
);

test(
  "slow local consumers do not spend the Everything network idle timeout",
  { timeout: 10000 },
  async (t) => {
    const count = 1800;
    const body = JSON.stringify({
      totalResults: count,
      results: Array.from({ length: count }, (_, i) => ({
        type: "file",
        path: "C:/Synthetic",
        name: "sample-" + i + "x".repeat(100),
        size: "1",
        date_modified: "132223104000000000",
      })),
    });
    const endpoint = await transport(t, (socket) =>
      socket.end(responseHeaders + body),
    );
    let rows = 0,
      batches = 0;
    const started = Date.now();
    const result = await readEverythingInventory({
      endpoint,
      root: "C:/Synthetic",
      idleTimeoutMs: 150,
      onRows: async (batch) => {
        rows += batch.length;
        batches++;
        await new Promise((resolve) => setTimeout(resolve, 220));
      },
    });
    assert.deepEqual(result, { entries: count });
    assert.equal(rows, count);
    assert.ok(batches > 1);
    assert.ok(Date.now() - started > 150);
  },
);

test(
  "a progressing response can outlast the idle timeout and each network wait gets a fresh budget",
  { timeout: 5000 },
  async (t) => {
    const body = '{"totalResults":1,"results":[{"name":"synthetic"}]}';
    const endpoint = await transport(t, (socket) => {
      socket.write(responseHeaders);
      let offset = 0;
      const timer = setInterval(() => {
        if (socket.destroyed) return clearInterval(timer);
        socket.write(body.slice(offset, offset + 10));
        offset += 10;
        if (offset >= body.length) {
          clearInterval(timer);
          socket.end();
        }
      }, 70);
      socket.once("close", () => clearInterval(timer));
    });
    const rows = [],
      started = Date.now();
    const result = await readEverythingInventory({
      endpoint,
      root: "C:/Synthetic",
      idleTimeoutMs: 250,
      onRows: (batch) => rows.push(...batch),
    });
    assert.deepEqual(result, { entries: 1 });
    assert.deepEqual(rows, [{ name: "synthetic" }]);
    assert.ok(Date.now() - started > 250);
  },
);

test(
  "a stalled Everything connection still times out before response headers",
  { timeout: 5000 },
  async (t) => {
    const endpoint = await transport(t, () => {});
    await assert.rejects(
      readEverythingInventory({
        endpoint,
        root: "C:/Synthetic",
        idleTimeoutMs: 150,
        onRows() {},
      }),
      { code: "EVERYTHING_REQUEST_TIMEOUT" },
    );
  },
);

test(
  "a stalled response body still times out without accepting a partial inventory",
  { timeout: 5000 },
  async (t) => {
    const endpoint = await transport(t, (socket) =>
      socket.write(responseHeaders + '{"totalResults":1,"results":['),
    );
    let delivered = 0;
    await assert.rejects(
      readEverythingInventory({
        endpoint,
        root: "C:/Synthetic",
        idleTimeoutMs: 150,
        onRows: (rows) => (delivered += rows.length),
      }),
      { code: "EVERYTHING_REQUEST_TIMEOUT" },
    );
    assert.equal(delivered, 0);
  },
);

test(
  "cancellation is observed during consumer backpressure while its network timer is paused",
  { timeout: 5000 },
  async (t) => {
    const endpoint = await transport(t, (socket) =>
      socket.end(responseHeaders + '{"totalResults":1,"results":[{}]}'),
    );
    let consuming = false,
      cancellationChecks = 0;
    await assert.rejects(
      readEverythingInventory({
        endpoint,
        root: "C:/Synthetic",
        idleTimeoutMs: 150,
        onRows: async () => {
          consuming = true;
          await new Promise((resolve) => setTimeout(resolve, 220));
        },
        checkCancelled() {
          if (consuming) {
            cancellationChecks++;
            throw Object.assign(new Error("synthetic cancellation"), {
              code: "SCAN_CANCELLED",
            });
          }
        },
      }),
      { code: "SCAN_CANCELLED" },
    );
    assert.ok(cancellationChecks > 0);
  },
);

test(
  "a delayed local write failure retains its own error instead of becoming a request timeout",
  { timeout: 5000 },
  async (t) => {
    const endpoint = await transport(t, (socket) =>
      socket.end(responseHeaders + '{"totalResults":1,"results":[{}]}'),
    );
    const error = Object.assign(new Error("synthetic local failure"), {
      code: "SQLITE_FULL",
    });
    await assert.rejects(
      readEverythingInventory({
        endpoint,
        root: "C:/Synthetic",
        idleTimeoutMs: 150,
        onRows: async () => {
          await new Promise((resolve) => setTimeout(resolve, 220));
          throw error;
        },
      }),
      (actual) => actual === error,
    );
  },
);
