import readline from "node:readline";
import net from "node:net";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ownership = require(
  path.join(
    process.env.GALLERY_NODE_REFERENCE_ROOT,
    "src/instance/ownership.js",
  ),
);
export async function openManager(c, file) {
  const env = { ...process.env, GALLERY_INSTANCE_ID: c.instanceId };
  delete env.ELECTRON_RUN_AS_NODE;
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connected = new Promise((resolve) =>
    server.once("connection", resolve),
  );
  const child = spawn(
    require("electron"),
    [path.resolve(import.meta.dirname, "manager-client.cjs"), file],
    {
      env: { ...env, GALLERY_DRIVER_PORT: String(server.address().port) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let seq = 0,
    stderr = "",
    readyResolve;
  const ready = new Promise((r) => (readyResolve = r)),
    pending = new Map();
  child.stderr.on("data", (b) => (stderr += b));
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      for (const item of pending.values())
        item.reject(Error(`Manager exited ${code}: ${stderr}`));
      code === 0 ? resolve() : reject(Error(stderr));
    });
  });
  exited.catch(() => {});
  let socket;
  try {
    socket = await Promise.race([
      connected,
      exited.then(() => {
        throw Error(stderr);
      }),
    ]);
  } finally {
    server.close();
  }
  readline.createInterface({ input: socket }).on("line", (line) => {
    if (!line.trim()) return;
    const value = JSON.parse(line);
    if (value.event === "ready") {
      readyResolve(value);
      return;
    }
    const item = pending.get(value.id);
    pending.delete(value.id);
    if (value.ok) item.resolve(value.data);
    else item.reject(Object.assign(Error(value.code), { code: value.code }));
  });
  const id = await Promise.race([
    ready,
    exited.then(() => {
      throw Error("Early manager exit");
    }),
  ]);
  return {
    child,
    pid: id.pid,
    call(command, operation = "", input = {}) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        socket.write(JSON.stringify({ id, command, operation, input }) + "\n");
      });
    },
    async close() {
      socket.end();
      await exited;
      assert.equal(await ownership.processIdentity(id.pid), null);
    },
  };
}
