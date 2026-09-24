"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createObservationProducer, ASYNC_IO } = require(
  "../../internal/library/scan-producer.js",
);
const { diskProfiles } = require("../../internal/library/disk-scheduler.js");
const { observePlatformTree } = require("../../internal/library/observer.js");
function fixture(t, count = 12) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-producer-"));
  t.after(() =>
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })
  );
  for (let i = 0; i < count; i++) {
    const w = path.join(root, "作者", "work-" + String(i).padStart(3, "0"));
    fs.mkdirSync(path.join(w, "nested"), { recursive: true });
    fs.writeFileSync(
      path.join(w, "metadata.json"),
      '\ufeff{ "text": "人工🧪" }\r\n',
    );
    for (let j = 0; j < 4; j++) {
      fs.writeFileSync(path.join(w, "nested", j + ".jpg"), "synthetic");
    }
  }
  return root;
}
const options = (root) => ({
  platformRoots: { pixiv: root },
  scopes: [{ platformId: "pixiv", authorDirectoryName: null }],
  concurrency: {
    disks: [{ letter: path.parse(root).root[0], disk: "test", type: "ssd" }],
    ssdIo: 4,
    workWindow: 3,
  },
});
test("disk budgets follow physical disk rather than platform or drive letter", async () => {
  const profiles = await diskProfiles({
    pixiv: "C:/library",
    X: "D:/library",
    Venera: "E:/books",
  }, {
    disks: [{ letter: "C", disk: "1", type: "ssd" }, {
      letter: "D",
      disk: "1",
      type: "ssd",
    }, { letter: "E", disk: "2", type: "hdd" }],
  });
  assert.equal(profiles.pixiv, profiles.X);
  assert.notEqual(profiles.pixiv, profiles.Venera);
  assert.equal(profiles.pixiv.ioLimit, 32);
  assert.equal(profiles.Venera.workWindow, 1);
  const unknown = await diskProfiles({ pixiv: "C:/unknown", X: "D:/unknown" }, {
    disks: [],
  });
  assert.equal(unknown.pixiv, unknown.X);
  assert.equal(unknown.pixiv.type, "unknown");
});
test("async producer overlaps bounded IO, preserves observation facts and never reads media bytes", async (t) => {
  const root = fixture(t),
    expected = observePlatformTree({
      platformId: "pixiv",
      observationRoot: root,
    });
  let active = 0, peak = 0, mediaReads = 0;
  const io = Object.fromEntries(
    Object.keys(ASYNC_IO).map((k) => [k, async (p) => {
      active++;
      peak = Math.max(peak, active);
      try {
        if (k === "readFile" && path.basename(p) !== "metadata.json") {
          mediaReads++;
        }
        await new Promise((r) => setTimeout(r, 2));
        return await ASYNC_IO[k](p);
      } finally {
        active--;
      }
    }]),
  );
  const events = [];
  for await (const e of createObservationProducer({ ...options(root), io })) {
    events.push(e);
  }
  assert.ok(peak > 1);
  assert.ok(peak <= 4);
  assert.equal(active, 0);
  assert.equal(mediaReads, 0);
  assert.deepEqual(
    events.filter((e) => e.type === "work").map((e) => e.work),
    expected.authors[0].works,
  );
  assert.equal(events.at(-1).observation.worksObserved, 12);
  assert.equal(events.at(-1).observation.authorsState, "complete");
});
test("consumer backpressure limits prefetch and early return drains IO", async (t) => {
  const root = fixture(t, 30);
  let reads = 0, active = 0;
  const io = {
    ...ASYNC_IO,
    readFile: async (p) => {
      reads++;
      active++;
      try {
        return await ASYNC_IO.readFile(p);
      } finally {
        active--;
      }
    },
  };
  const it = createObservationProducer({ ...options(root), io });
  let e;
  do {
    e = await it.next();
  } while (e.value.type !== "work");
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(reads <= 3, "only the configured work window may read ahead");
  await it.return();
  assert.equal(active, 0);
  const atReturn = reads;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reads, atReturn);
});
test("metadata reuse is offered only after complete recursive observation and avoids content reads", async (t) => {
  const root = fixture(t, 2);
  let reads = 0, probes = 0;
  const probeOrder = [];
  const io = {
    ...ASYNC_IO,
    readFile: async (file) => {
      reads++;
      return await ASYNC_IO.readFile(file);
    },
  };
  const events = [];
  for await (
    const event of createObservationProducer({
      ...options(root),
      io,
      preferredWorkKey: () => "work-001",
      metadataReuseProbe: (work) => {
        probes++;
        probeOrder.push(work.workDirectoryName);
        assert.equal(work.filesystemFilesState, "complete");
        assert.equal(work.filesystemFiles.length, 4);
        assert.equal(work.metadata.sourceText, null);
        return { metadataState: "valid", media: {} };
      },
    })
  ) events.push(event);
  const works = events.filter((event) => event.type === "work");
  assert.equal(probes, 2);
  assert.equal(probeOrder[0], "work-001");
  assert.equal(reads, 0);
  assert.ok(works.every((event) => event.work.metadataReuse));
  assert.ok(works.every((event) => event.work.metadata.sourceText === null));

  let incompleteProbes = 0;
  const incomplete = {
    ...ASYNC_IO,
    readdir: (file) =>
      file.endsWith("nested")
        ? Promise.reject(Object.assign(new Error("synthetic"), {
          code: "EACCES",
        }))
        : ASYNC_IO.readdir(file),
  };
  for await (
    const event of createObservationProducer({
      ...options(root),
      io: incomplete,
      metadataReuseProbe: () => {
        incompleteProbes++;
        return { metadataState: "valid", media: {} };
      },
    })
  ) {
    if (event.type === "work") assert.equal(event.work.metadataReuse, undefined);
  }
  assert.equal(incompleteProbes, 0);
});
test("nested failure prevents completeness; metadata race is not repaired; programmer errors throw", async (t) => {
  const root = fixture(t, 1);
  const io = {
    ...ASYNC_IO,
    readdir: (p) =>
      p.endsWith("nested")
        ? Promise.reject(
          Object.assign(new Error("synthetic"), { code: "EACCES" }),
        )
        : ASYNC_IO.readdir(p),
  };
  const events = [];
  for await (const e of createObservationProducer({ ...options(root), io })) {
    events.push(e);
  }
  assert.equal(
    events.find((e) => e.type === "work").work.filesystemFilesState,
    "incomplete",
  );
  assert.equal(events.at(-1).observation.authorsState, "incomplete");
  const racing = {
    ...ASYNC_IO,
    readFile: async (p) => {
      const b = await ASYNC_IO.readFile(p);
      fs.appendFileSync(p, " ");
      return b;
    },
  };
  const race = [];
  for await (
    const e of createObservationProducer({ ...options(root), io: racing })
  ) race.push(e);
  assert.equal(
    race.find((e) => e.type === "work").work.metadata.state,
    "unstable",
  );
  await assert.rejects(async () => {
    for await (
      const e of createObservationProducer({
        ...options(root),
        io: {
          ...ASYNC_IO,
          lstat: () => {
            throw new TypeError("programmer");
          },
        },
      })
    ) void e;
  }, TypeError);
});
test("scope never visits unrelated authors and cancellation is drained without publication", async (t) => {
  const root = fixture(t, 3);
  fs.mkdirSync(path.join(root, "unrelated"));
  let cancelled = false;
  const io = {
    ...ASYNC_IO,
    lstat: (p) => {
      assert.notEqual(path.basename(p), "unrelated");
      return ASYNC_IO.lstat(p);
    },
  };
  await assert.rejects(async () => {
    for await (
      const e of createObservationProducer({
        ...options(root),
        scopes: [{ platformId: "pixiv", authorDirectoryName: "作者" }],
        io,
        checkCancelled: () => {
          if (cancelled) {
            throw Object.assign(new Error("cancel"), {
              code: "SCAN_CANCELLED",
            });
          }
        },
      })
    ) if (e.type === "work") cancelled = true;
  }, { code: "SCAN_CANCELLED" });
});
test("work junctions cannot escape the observed tree", async (t) => {
  const root = fixture(t, 1),
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "outside.jpg"), "synthetic");
  fs.symlinkSync(
    outside,
    path.join(root, "作者", "work-000", "escape"),
    "junction",
  );
  const events = [];
  for await (const e of createObservationProducer(options(root))) {
    events.push(e);
  }
  const work = events.find((e) => e.type === "work").work;
  assert.equal(work.filesystemFilesState, "incomplete");
  assert.equal(
    work.filesystemFiles.some((f) => f.fileName === "outside.jpg"),
    false,
  );
  assert.equal(events.at(-1).topology.status, "TOPOLOGY_BLOCKED");
});
test("independent disks overlap while platforms on one HDD share a sequential stream", async (t) => {
  const first = fixture(t, 2),
    second = fixture(t, 2),
    roots = { pixiv: "X:\\synthetic", 微博: "Y:\\synthetic" };
  async function run(shared) {
    const active = new Map();
    let overlap = false;
    const io = Object.fromEntries(
      Object.keys(ASYNC_IO).map((k) => [k, async (p) => {
        const drive = p[0],
          real = path.join(
            drive === "X" ? first : second,
            path.win32.relative(roots[drive === "X" ? "pixiv" : "微博"], p),
          );
        active.set(drive, (active.get(drive) || 0) + 1);
        if ([...active.values()].filter(Boolean).length > 1) overlap = true;
        try {
          await new Promise((r) => setTimeout(r, 2));
          return await ASYNC_IO[k](real);
        } finally {
          active.set(drive, active.get(drive) - 1);
        }
      }]),
    );
    const events = [];
    for await (
      const e of createObservationProducer({
        platformRoots: roots,
        scopes: Object.keys(roots).map((platformId) => ({ platformId })),
        io,
        concurrency: {
          disks: [{ letter: "X", disk: "1", type: "hdd" }, {
            letter: "Y",
            disk: shared ? "1" : "2",
            type: "hdd",
          }],
        },
      })
    ) events.push(e);
    assert.equal(events.filter((e) => e.type === "work").length, 4);
    return overlap;
  }
  assert.equal(await run(false), true);
  assert.equal(await run(true), false);
});
