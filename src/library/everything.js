"use strict";

const http = require("node:http");

// Everything HTTP's small JSON envelope, decoded one row at a time. No full
// response.json(), whole-library array, or offset pagination.
function fail(code) {
  throw Object.assign(new Error(code), { code });
}
function normalizeEverythingConfig(value) {
  if (value === undefined || value === null) return null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "endpoint") ||
    (value.endpoint !== undefined &&
      (typeof value.endpoint !== "string" || !value.endpoint))
  )
    fail("EVERYTHING_CONFIG_INVALID");
  let url;
  try {
    url = new URL(value.endpoint || "http://127.0.0.1:54321/");
  } catch {
    fail("EVERYTHING_CONFIG_INVALID");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    fail("EVERYTHING_CONFIG_INVALID");
  return Object.freeze({ endpoint: url.href });
}

class InventoryDecoder {
  constructor() {
    this.state = "start";
    this.buffer = "";
    this.seen = new Set();
    this.key = null;
    this.scan = 0;
    this.quoted = false;
    this.escaped = false;
    this.depth = 0;
    this.total = null;
    this.rows = 0;
  }
  push(text, final = false) {
    this.buffer += text;
    const events = [];
    const consume = (count) => {
      this.buffer = this.buffer.slice(count);
      this.scan = 0;
    };
    for (;;) {
      if (!["key", "scalar", "row"].includes(this.state))
        this.buffer = this.buffer.trimStart();
      if (!this.buffer.length) break;
      const first = this.buffer[0];
      if (this.state === "start") {
        if (first !== "{") fail("EVERYTHING_JSON_INVALID");
        consume(1);
        this.state = "keyStart";
      } else if (this.state === "keyStart") {
        if (first !== '"') fail("EVERYTHING_JSON_INVALID");
        this.state = "key";
        this.scan = 1;
        this.escaped = false;
      } else if (this.state === "key") {
        let complete = false;
        while (this.scan < this.buffer.length) {
          const c = this.buffer[this.scan++];
          if (this.escaped) {
            this.escaped = false;
            continue;
          }
          if (c === "\\") this.escaped = true;
          else if (c === '"') {
            complete = true;
            break;
          }
        }
        if (!complete) break;
        try {
          this.key = JSON.parse(this.buffer.slice(0, this.scan));
        } catch {
          fail("EVERYTHING_JSON_INVALID");
        }
        if (
          !["totalResults", "results"].includes(this.key) ||
          this.seen.has(this.key)
        )
          fail("EVERYTHING_JSON_INVALID");
        this.seen.add(this.key);
        consume(this.scan);
        this.state = "colon";
      } else if (this.state === "colon") {
        if (first !== ":") fail("EVERYTHING_JSON_INVALID");
        consume(1);
        this.state = this.key === "results" ? "arrayStart" : "scalar";
      } else if (this.state === "scalar") {
        const end = this.buffer.search(/[,}]/);
        if (end < 0) break;
        const number = this.buffer.slice(0, end).trim();
        if (
          !/^(0|[1-9]\d*)$/.test(number) ||
          !Number.isSafeInteger(Number(number))
        )
          fail("EVERYTHING_JSON_INVALID");
        this.total = Number(number);
        consume(end);
        this.state = "memberEnd";
      } else if (this.state === "arrayStart") {
        if (first !== "[") fail("EVERYTHING_JSON_INVALID");
        consume(1);
        this.state = "rowStart";
      } else if (this.state === "rowStart") {
        if (first === "]") {
          consume(1);
          this.state = "memberEnd";
        } else {
          if (first !== "{") fail("EVERYTHING_JSON_INVALID");
          this.state = "row";
          this.depth = 0;
          this.quoted = false;
          this.escaped = false;
          this.scan = 0;
        }
      } else if (this.state === "row") {
        let complete = false;
        while (this.scan < this.buffer.length) {
          const c = this.buffer[this.scan++];
          if (this.scan > 262144) fail("EVERYTHING_ROW_TOO_LARGE");
          if (this.quoted) {
            if (this.escaped) this.escaped = false;
            else if (c === "\\") this.escaped = true;
            else if (c === '"') this.quoted = false;
          } else if (c === '"') this.quoted = true;
          else if (c === "{" || c === "[") this.depth++;
          else if (c === "}" || c === "]") {
            if (--this.depth === 0) {
              complete = true;
              break;
            }
          }
        }
        if (!complete) break;
        let row;
        try {
          row = JSON.parse(this.buffer.slice(0, this.scan));
        } catch {
          fail("EVERYTHING_JSON_INVALID");
        }
        events.push(row);
        this.rows++;
        consume(this.scan);
        this.state = "rowEnd";
      } else if (this.state === "rowEnd") {
        if (first === ",") {
          consume(1);
          this.state = "rowRequired";
        } else if (first === "]") {
          consume(1);
          this.state = "memberEnd";
        } else fail("EVERYTHING_JSON_INVALID");
      } else if (this.state === "rowRequired") {
        if (first !== "{") fail("EVERYTHING_JSON_INVALID");
        this.state = "rowStart";
      } else if (this.state === "memberEnd") {
        if (first === ",") {
          consume(1);
          this.state = "keyStart";
        } else if (first === "}") {
          consume(1);
          this.state = "done";
        } else fail("EVERYTHING_JSON_INVALID");
      } else fail("EVERYTHING_JSON_INVALID");
    }
    if (this.buffer.length > 262144) fail("EVERYTHING_ROW_TOO_LARGE");
    if (
      final &&
      (this.state !== "done" ||
        this.buffer.trim() ||
        this.seen.size !== 2 ||
        this.total !== this.rows)
    )
      fail("EVERYTHING_INVENTORY_INCOMPLETE");
    return events;
  }
}

async function readEverythingInventory({
  endpoint,
  root,
  onRows,
  checkCancelled = () => {},
  idleTimeoutMs = 300000,
}) {
  const url = new URL(normalizeEverythingConfig({ endpoint }).endpoint);
  const separator = require("node:path").sep;
  if (/["\x00-\x1f]/.test(root)) fail("EVERYTHING_ROOT_INVALID");
  for (const [name, value] of Object.entries({
    search: `path:"${root.replace(/[\\/]+$/, "")}${separator}"`,
    json: "1",
    path_column: "1",
    size_column: "1",
    date_modified_column: "1",
  }))
    url.searchParams.set(name, value);
  const controller = new AbortController();
  let cancelled = null,
    callbackError = null,
    timedOut = false;
  let timeout = null;
  async function waitForNetwork(read) {
    // Only bound a wait for headers or the next body chunk. Local decoding,
    // SQLite writes and consumer backpressure are not network inactivity.
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleTimeoutMs);
    timeout.unref();
    try {
      return await read();
    } finally {
      clearTimeout(timeout);
      timeout = null;
    }
  }
  const deliver = async (rows) => {
    try {
      await onRows(rows);
    } catch (error) {
      callbackError = error;
      throw error;
    }
  };
  const poll = setInterval(() => {
    try {
      checkCancelled();
    } catch (error) {
      cancelled = error;
      controller.abort();
    }
  }, 100);
  poll.unref();
  let request, response;
  try {
    checkCancelled();
    // Everything may close the socket while SQLite applies backpressure to a
    // large response. Node 22's bundled Fetch/Undici can assert in that socket
    // callback, outside this catch. IncomingMessage streams handle this without
    // an uncatchable parser assertion and keep buffering bounded.
    response = await waitForNetwork(
      () =>
        new Promise((resolve, reject) => {
          request = http.get(
            url,
            {
              signal: controller.signal,
              agent: false,
              highWaterMark: 65536,
              headers: { Accept: "application/json" },
            },
            (incoming) => {
              // Cover the short interval before the async iterator owns body errors.
              incoming.on("error", () => {});
              resolve(incoming);
            },
          );
          request.on("error", reject);
        }),
    );
    if (response.statusCode < 200 || response.statusCode >= 300)
      fail("EVERYTHING_HTTP_FAILED");
    if (!/^application\/json\b/i.test(response.headers["content-type"] || ""))
      fail("EVERYTHING_RESPONSE_INVALID");
    const decoder = new InventoryDecoder(),
      text = new TextDecoder("utf-8", { fatal: true });
    const body = response[Symbol.asyncIterator]();
    for (;;) {
      checkCancelled();
      const { value, done } = await waitForNetwork(() => body.next());
      if (done) break;
      checkCancelled();
      for (let offset = 0; offset < value.length; offset += 65536) {
        const rows = decoder.push(
          text.decode(value.subarray(offset, offset + 65536), { stream: true }),
        );
        if (rows.length) await deliver(rows);
        checkCancelled();
      }
    }
    if (!response.complete) fail("EVERYTHING_INVENTORY_INCOMPLETE");
    const rows = decoder.push(text.decode(), true);
    if (rows.length) await deliver(rows);
    return { entries: decoder.rows };
  } catch (error) {
    if (callbackError) throw callbackError;
    if (cancelled) throw cancelled;
    if (timedOut) fail("EVERYTHING_REQUEST_TIMEOUT");
    if (
      error.code?.startsWith("EVERYTHING_") ||
      error.code === "SCAN_CANCELLED"
    )
      throw error;
    fail("EVERYTHING_REQUEST_FAILED");
  } finally {
    clearInterval(poll);
    clearTimeout(timeout);
    controller.abort();
    response?.destroy();
    request?.destroy();
  }
}
module.exports = {
  InventoryDecoder,
  normalizeEverythingConfig,
  readEverythingInventory,
};
