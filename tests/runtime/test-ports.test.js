"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { freePort } = require("../support/runtime.js");
test("synthetic HTTP fixtures reject Fetch-blocked ephemeral ports and release each reservation", async () => {
  const ports = [6000, 10080, 18123];
  let closed = 0;
  const port = await freePort({ createServer: () => {
    const value = ports.shift();
    return { once() {}, listen(_port, host, done) { assert.equal(host, "127.0.0.1"); done(); }, address() { return { port: value }; }, close(done) { closed++; done(); } };
  } });
  assert.equal(port, 18123); assert.equal(closed, 3);
  assert.equal(await freePort({ createServer: () => ({ once() {}, listen(_port, _host, done) { done(); }, address() { return { port: 3000 }; }, close(done) { done(); } }) }), 3000);
  await assert.rejects(freePort({ createServer: () => ({ once() {}, listen(_port, _host, done) { done(); }, address() { return { port: 6000 }; }, close(done) { done(); } }) }), /No browser-safe/);
});
