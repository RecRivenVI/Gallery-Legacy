"use strict";
// Command-layer manager verification: actual Electron parent and product bridge.
// Window interaction is verified separately; this driver never activates one.
const { app } = require("electron");
const readline = require("node:readline");
const path = require("node:path");
const { Backend } = require("../../src/desktop/backend.js");
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    const backend = new Backend(
      process.env.GALLERY_RUNTIME_EXE,
      [
        "--config",
        process.argv.at(-1),
        "--frontend",
        path.resolve(__dirname, "../../public"),
        "--assets",
        process.env.GALLERY_ASSETS_ROOT,
      ],
      process.env,
      process.env.GALLERY_INSTANCE_ID,
    );
    await backend.ready;
    const socket = require("node:net").connect(
      Number(process.env.GALLERY_DRIVER_PORT),
      "127.0.0.1",
    );
    const lines = readline.createInterface({ input: socket });
    socket.write(
      JSON.stringify({ event: "ready", pid: backend.child.pid }) + "\n",
    );
    for await (const line of lines) {
      const request = JSON.parse(line);
      try {
        const data = await backend.call(
          request.command,
          request.operation,
          request.input,
        );
        socket.write(JSON.stringify({ id: request.id, ok: true, data }) + "\n");
      } catch (error) {
        socket.write(
          JSON.stringify({ id: request.id, ok: false, code: error.code }) +
            "\n",
        );
      }
    }
    await backend.close();
    app.quit();
  })
  .catch((error) => {
    process.stderr.write((error.code || error.message) + "\n");
    app.exit(1);
  });
