"use strict";
const { spawn } = require("node:child_process");
const readline = require("node:readline");

// The inherited pipe belongs to this manager. Closing it is a graceful quit,
// not a detached service launch or a process-name based termination.
class Backend {
  constructor(executable, args, env, instanceId) {
    this.sequence = 0;
    this.pending = new Map();
    this.child = spawn(executable, ["manager", ...args], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.failure = "HOST_REQUEST_FAILED";
    this.exited = new Promise((resolve, reject) => {
      this.child.once("error", (error) => {
        this.rejectAll(error);
        reject(error);
      });
      this.child.once("close", (code) => {
        const error = Object.assign(new Error(this.failure), {
          code: this.failure,
        });
        this.rejectAll(error);
        if (code === 0) resolve();
        else reject(error);
      });
    });
    // Exit failures are delivered by requests and close(), not unhandled events.
    this.exited.catch(() => {});
    this.child.stderr.on("data", (data) => {
      const code = data.toString().trim();
      if (/^[A-Z0-9_]{1,64}$/.test(code)) this.failure = code;
    });
    this.child.stdin.on("error", (error) => this.rejectAll(error));
    this.ready = new Promise((resolve, reject) => {
      this.pending.set(0, { resolve, reject });
    });
    readline
      .createInterface({ input: this.child.stdout })
      .on("line", (line) => {
        let reply;
        try {
          reply = JSON.parse(line);
        } catch {
          this.rejectAll(
            Object.assign(new Error("INVALID_RESPONSE"), {
              code: "INVALID_RESPONSE",
            }),
          );
          return;
        }
        if (reply.event === "manager-ready") {
          if (
            reply.pid !== this.child.pid ||
            reply.instanceId !== instanceId ||
            reply.manager?.pid !== process.pid ||
            reply.manager?.exe !== process.execPath.toLowerCase()
          ) {
            this.rejectAll(
              Object.assign(new Error("OWNER_MISMATCH"), {
                code: "OWNER_MISMATCH",
              }),
            );
            this.child.stdin.end();
            return;
          }
          this.pending.get(0)?.resolve();
          this.pending.delete(0);
          return;
        }
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id);
        if (reply.ok) pending.resolve(reply.data);
        else
          pending.reject(
            Object.assign(new Error(reply.code), { code: reply.code }),
          );
      });
  }
  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  async call(command, operation = "", input = {}) {
    await this.ready;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(
        JSON.stringify({ id, command, operation, input }) + "\n",
        (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }
  async close() {
    this.child.stdin.end();
    await this.exited;
  }
}
module.exports = { Backend };
