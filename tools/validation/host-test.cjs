"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  net = require("node:net");
const { prepare, repo, testRoot } = require("./prepare.cjs");
const { createAcceptanceHost } = require("./host.cjs");
async function testPorts() {
  const held = [];
  try {
    for (let i = 0; i < 3; i++) {
      const server = net.createServer();
      held.push(server);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    }
    return held.map((server) => server.address().port);
  } finally {
    await Promise.all(
      held
        .filter((server) => server.listening)
        .map(
          (server) =>
            new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
    );
  }
}
test(
  "unchanged Manager uses isolated Go scanner; control remains authenticated loopback",
  { timeout: 120000 },
  async (t) => {
    const root = path.join(testRoot, "GalleryGoHost-Test-") + Date.now();
    const [port, webPort, managerPort] = await testPorts();
    const listingSource = "filesystem";
    const demo = await prepare(root, { port, listingSource });
    const host = await createAcceptanceHost({
      configPath: path.join(demo.config.instanceRoot, "config.json"),
      exe: process.env.GALLERY_GO_ACCEPTANCE_EXE,
      webPort,
      managerPort,
      syntheticDelay: 80,
      cpuProfile: true,
    });
    t.after(() => host.close());
    const page = await fetch(host.manager),
      cookie = page.headers.get("set-cookie").split(";")[0],
      html = await page.text();
    assert.equal(page.status, 200);
    assert.ok(html.includes('base href="/frontend/manager/"'));
    const token = html.match(/name="test-csrf" content="([a-f0-9]+)"/)[1];
    const raw = await fetch(host.manager + "/test-control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(raw.status, 403);
    const invoke = async (method, ...args) => {
      const r = await fetch(host.manager + "/test-control", {
        method: "POST",
        headers: {
          Origin: host.manager,
          Cookie: cookie,
          "X-Gallery-Test": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ method, args }),
      });
      return { status: r.status, value: await r.json() };
    };
    assert.equal((await invoke("admin", "config.read")).status, 200);
    assert.equal(
      (await invoke("admin", "config.save", { value: { port: 8081 } })).status,
      500,
    );
    assert.equal(
      (await invoke("admin", "scan.start", { mode: "unknown" })).value.code,
      "SCAN_MODE_INVALID",
    );
    assert.equal(
      (
        await invoke("admin", "scan.start", {
          mode: "incremental",
          platformIds: ["pixiv"],
          authorDirectoryName: "../escape",
        })
      ).value.code,
      "AUTHOR_SCOPE_INVALID",
    );
    assert.equal(
      (await invoke("admin", "scan.start", { mode: "full" })).status,
      200,
    );
    assert.equal(
      (await invoke("admin", "scan.start", { mode: "full" })).value.code,
      "SCAN_IN_USE",
    );
    let progress;
    for (let i = 0; i < 300; i++) {
      progress = (await invoke("admin", "scan.status")).value.data;
      if (!progress.running) break;
      const r = await fetch(host.web + "/api/v1/status");
      assert.equal(r.status, 200);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(progress.state, "READY");
    assert.equal(progress.works, 71);
    assert.equal(progress.counts.nativeDirectoryReads, 169);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      (await invoke("admin", "scan.start", { mode: "incremental" })).status,
      200,
    );
    for (let i = 0; i < 300; i++) {
      progress = (await invoke("admin", "scan.status")).value.data;
      if (!progress.running) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(progress.state, "READY");
    assert.equal(progress.counts.worksReused, 71);
    assert.equal(progress.counts.metadataReads, 0);
    assert.equal(progress.counts.writeTransactions, 0);
    for (
      let i = 0;
      i < 100 &&
      (!fs
        .readdirSync(demo.config.stateRoot)
        .some((n) => /^scan-.*\.cpu$/.test(n)) ||
        fs
          .readdirSync(demo.config.stateRoot)
          .filter((n) => /^scan-.*\.cpu$/.test(n))
          .every(
            (n) => fs.statSync(path.join(demo.config.stateRoot, n)).size === 0,
          ));
      i++
    )
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      fs
        .readdirSync(demo.config.stateRoot)
        .some(
          (n) =>
            /^scan-.*\.cpu$/.test(n) &&
            fs.statSync(path.join(demo.config.stateRoot, n)).size > 0,
        ),
      "owned CPU profile must complete without capturing source contents",
    );
    const result = await (
      await fetch(host.web + "/api/v1/works?platform=Venera")
    ).json();
    assert.equal(result.data.total, 4);
    const detail = (
      await (
        await fetch(host.web + "/api/v1/works/" + result.data.items[0].id)
      ).json()
    ).data;
    assert.deepEqual(
      detail.media.slice(0, 3).map((m) => path.basename(m.relativePath)),
      ["1.png", "2.png", "10.png"],
    );
    const mediaURL = host.web + detail.media[0].url;
    assert.equal((await fetch(mediaURL, { method: "HEAD" })).status, 200);
    assert.equal(
      (await fetch(mediaURL, { headers: { Range: "bytes=0-3" } })).status,
      206,
    );
    const searched = await (
      await fetch(host.web + "/api/v1/works?q=" + encodeURIComponent("中"))
    ).json();
    assert.ok(searched.data.total > 0);
    const body = await (await fetch(host.web)).text();
    assert.ok(body.includes("canvas"));
    // Browser interaction is restricted to this synthetic instance, without capture.
    const browser = await require("playwright").chromium.launch({
      headless: true,
      args: ["--mute-audio"],
    });
    try {
      const page = await browser.newPage({
          viewport: { width: 1920, height: 1080 },
        }),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(host.manager);
      await page.waitForFunction(
        () => window.__managerCandidate?.state.status.state === "READY",
      );
      const gallery = await browser.newPage({
        viewport: { width: 1920, height: 1080 },
      });
      let queries = 0;
      gallery.on("request", (r) => {
        if (new URL(r.url()).pathname === "/api/v1/works") queries++;
      });
      await gallery.goto(host.web);
      await gallery.waitForFunction(() => window.__galleryCanvas?.ready);
      const beforeQueries = queries,
        keys = await gallery.evaluate(() =>
          __galleryCanvas.state.result.items.map((w) => w.key),
        );
      await page.locator("#full-start").click();
      await page
        .locator("#confirmation")
        .getByRole("button", { name: "开始", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          __managerCandidate.state.scan.running ||
          __managerCandidate.state.scan.state === "READY",
      );
      await page.waitForFunction(
        () =>
          __managerCandidate.state.scan.state === "READY" &&
          !__managerCandidate.state.scan.running,
        null,
        { timeout: 60000 },
      );
      assert.equal(
        await page.evaluate(() => __managerCandidate.state.scan.works),
        71,
      );
      await gallery.waitForFunction(() => __galleryCanvas.state.newCount !== 0);
      assert.deepEqual(
        await gallery.evaluate(() =>
          __galleryCanvas.state.result.items.map((w) => w.key),
        ),
        keys,
      );
      assert.equal(
        queries,
        beforeQueries,
        "scan must not reload the browsed Gallery list",
      );
      assert.deepEqual(errors, []);
      const previousStart = await page.evaluate(
        () => __managerCandidate.state.scan.startedAtMs,
      );
      await page.locator("#update-start").click();
      await page.waitForFunction(
        (start) => __managerCandidate.state.scan.startedAtMs > start,
        previousStart,
        { timeout: 60000 },
      );
      await page.waitForFunction(
        () =>
          __managerCandidate.state.scan.state === "READY" &&
          !__managerCandidate.state.scan.running,
        null,
        { timeout: 60000 },
      );
      assert.equal(
        await page.evaluate(
          () => __managerCandidate.state.scan.counts.worksReused,
        ),
        71,
      );
      assert.equal(
        await page.evaluate(
          () => __managerCandidate.state.scan.counts.metadataReads,
        ),
        0,
      );
      assert.equal(
        await page.evaluate(
          () => __managerCandidate.state.scan.counts.writeTransactions,
        ),
        0,
      );
      assert.equal(
        queries,
        beforeQueries,
        "unchanged incremental scan must not refresh Gallery results",
      );
    } finally {
      await browser.close();
    }
    assert.equal((await invoke("stop")).status, 200);
    assert.equal((await invoke("status")).value.data.state, "STOPPED");
    assert.equal((await invoke("start")).status, 200);
    assert.equal((await invoke("restart")).status, 200);
    const denied = await fetch(host.backend + "/api/v1/scans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmReadOnly: true }),
    });
    assert.equal(denied.status, 403);
    console.log(
      JSON.stringify({
        synthetic: true,
        unchangedUI: true,
        listingSource,
        goFullScan: true,
        works: 71,
        loopbackAuth: true,
        startStopRestart: true,
        naturalPageOrder: true,
        mediaHeadRange: true,
      }),
    );
  },
);
