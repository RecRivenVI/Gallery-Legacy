"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  zlib = require("node:zlib"),
  cp = require("node:child_process");
const {
  ROOT,
  REPO,
  OUTPUT,
  PORTS,
  assertOwned,
  assertConfig,
  environment,
} = require("./paths.cjs");
const platforms = require(
  path.join(REPO, "src/library/platforms.js"),
).PLATFORM_REGISTRY.map((p) => p.id);
const seed = 20260930,
  manifest = [],
  failures = [];
const glyphs = {
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  5: ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  6: ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  9: ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  "/": ["00001", "00001", "00010", "00100", "01000", "10000", "10000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  let offset = 0;
  const local = [],
    central = [];
  for (const [name, data] of entries) {
    const filename = Buffer.from(name),
      h = Buffer.alloc(30),
      c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc(data), 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(filename.length, 26);
    local.push(h, filename, data);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc(data), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(filename.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, filename);
    offset += h.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function chunk(type, data) {
  const t = Buffer.from(type),
    len = Buffer.alloc(4),
    sum = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  sum.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, sum]);
}
function png(id, width, height, format = "PNG", page = 1, variant = 0) {
  const data = Buffer.alloc((width * 3 + 1) * height);
  let n =
    seed + id.split("").reduce((a, c) => a + c.charCodeAt(0), 0) + variant * 97;
  const palette = [
    [24, 116, 191],
    [184, 67, 93],
    [64, 154, 122],
    [166, 107, 26],
    [103, 75, 175],
    [42, 143, 158],
  ][n % 6];
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      n ^= n << 13;
      n ^= n >>> 17;
      n ^= n << 5;
      const noise = (n >>> 0) % 9;
      const shape =
        (x / width - 0.3) ** 2 + (y / height - 0.35) ** 2 < 0.09 ||
        (x + y + variant * 8) % Math.max(12, Math.floor(width / 5)) < 4;
      for (let c = 0; c < 3; c++)
        data[row + 1 + x * 3 + c] = Math.min(
          255,
          palette[c] +
            Math.round((35 * x) / width + (20 * y) / height) +
            noise +
            (shape ? 35 : 0),
        );
    }
  }
  const fill = (x, y, w, h, rgb) => {
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) {
        const at = yy * (width * 3 + 1) + 1 + xx * 3;
        data[at] = rgb[0];
        data[at + 1] = rgb[1];
        data[at + 2] = rgb[2];
      }
  };
  const text = (str, x, y, s) => {
    for (let k = 0; k < str.length; k++) {
      const g = glyphs[str[k]] || glyphs[" "];
      g.forEach((r, yy) => {
        for (let xx = 0; xx < 5; xx++)
          if (r[xx] === "1")
            fill(x + k * 6 * s + xx * s, y + yy * s, s, s, [255, 255, 255]);
      });
    }
  };
  const s = Math.max(
      1,
      Math.floor(
        Math.min(Math.min(width, height) / (id.length * 6 + 12), height / 18),
      ),
    ),
    tw = id.length * 6 * s;
  fill(
    Math.floor((width - tw) / 2) - s,
    Math.floor(height / 2) - 5 * s,
    tw + 2 * s,
    10 * s,
    [18, 24, 35],
  );
  text(id, Math.floor((width - tw) / 2), Math.floor(height / 2) - 3 * s, s);
  const corner = `${width}X${height} ${format.toUpperCase()} P${page}`;
  const cs = Math.max(
    1,
    Math.min(
      Math.floor(width / (corner.length * 6 + 4)),
      Math.floor(height / 55),
    ),
  );
  text(corner, 2, Math.max(0, height - 8 * cs - 2), cs);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(data, { level: 3 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function write(file, content) {
  assertOwned(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function meta(id, i = 0, extra = {}) {
  return {
    id,
    title: `${id} 抽象练习 / Abstract Study`,
    date: `${2020 + (i % 7)}-${String(1 + (i % 12)).padStart(2, "0")}-15T12:00:00Z`,
    user: {
      id: "demo-author",
      name: "雾格工坊 / Studio Nimbus",
      account: "synthetic-studio",
    },
    tags: ["合成热门", `色域${i % 6}`],
    caption: "<p>本地生成的几何构图，仅用于产品设计演示。</p>",
    ...extra,
  };
}
function work(
  platform,
  author,
  name,
  metadata,
  id,
  width = 256,
  height = 192,
  pages = 1,
) {
  const dir = path.join(ROOT, "full/sources", platform, author, name);
  fs.mkdirSync(assertOwned(dir), { recursive: true });
  if (metadata !== undefined)
    write(
      path.join(dir, "metadata.json"),
      typeof metadata === "string"
        ? metadata
        : JSON.stringify(metadata, null, 2),
    );
  for (let p = 1; p <= pages; p++)
    write(path.join(dir, `${p}.png`), png(id, width, height, "PNG", p, p));
  manifest.push({
    id,
    kind: "work",
    platform,
    author,
    directory: name,
    width,
    height,
    pages,
    files: Array.from({ length: pages }, (_, i) => `${i + 1}.png`),
  });
  return dir;
}
function tool(name, args) {
  const result = cp.spawnSync(name, args, {
    env: environment(),
    windowsHide: true,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 1048576,
  });
  if (result.status !== 0) throw new Error("LOCAL_CONVERSION_FAILED:" + name);
}
function generate() {
  if (fs.existsSync(ROOT))
    throw new Error(
      "DEMO_ROOT_EXISTS: preserve or choose a new run root explicitly",
    );
  for (const dir of ["host/temp", "host/profile", "host/local", "host/roaming"])
    fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
  for (const kind of ["full", "empty"]) {
    const sources = Object.fromEntries(
      platforms.map((p) => [p, path.join(ROOT, kind, "sources", p)]),
    );
    for (const p of Object.values(sources))
      fs.mkdirSync(p, { recursive: true });
    const instanceRoot = path.join(ROOT, kind, "instance"),
      files = path.join(ROOT, kind, "files");
    fs.mkdirSync(instanceRoot, { recursive: true });
    fs.mkdirSync(files, { recursive: true });
    const config = assertConfig({
      instanceRoot,
      deployment: "staging",
      mode: "local",
      listenAddress: "127.0.0.1",
      port: PORTS[kind],
      sources,
      fileBrowserRoots: [
        { id: "demo-files", name: "合成文件浏览", path: files },
      ],
      retention: { enabled: false, staleAfterMs: 86400000 },
      shortLinks: { demo: "/#/@all/pixiv" },
    });
    write(
      path.join(instanceRoot, "config.json"),
      JSON.stringify(config, null, 2),
    );
  }
  for (let i = 1; i <= 5100; i++) {
    const id = "A" + String(i).padStart(6, "0");
    work(
      "pixiv",
      i <= 1200
        ? "demo-prolific"
        : `demo-studio-${String(1 + Math.floor((i - 1201) / 130)).padStart(2, "0")}`,
      id,
      meta(id, i),
      id,
      i % 3 === 0 ? 160 : 240,
      i % 3 === 0 ? 240 : 160,
    );
    if (i % 500 === 0)
      console.log(JSON.stringify({ generated: i, synthetic: true }));
  }
  const specs = [
    ["S0001", 64, 48, {}],
    ["S0002", 960, 540, {}],
    ["S0003", 540, 960, {}],
    ["S0004", 640, 640, {}],
    ["S0005", 480, 4800, {}],
    ["S0006", 3200, 400, {}],
    ["S0007", 6000, 4000, {}],
    ["S0008", 640, 400, { title: null }],
    [
      "S0009",
      640,
      400,
      { title: "S0009 " + "超长合成标题 / Long title ".repeat(20) },
    ],
    [
      "S0010",
      640,
      400,
      { title: "S0010 雾格・抽象画 / ひかり / Abstract 🧪✨" },
    ],
    ["S0011", 640, 400, { title: "S0011 تجربة هندسية مجردة אבג" }],
    ["S0012", 640, 400, { title: "S0012 🙂🌈🧩" }],
    [
      "S0013",
      640,
      400,
      {
        title: "S0013 <b>&\"' Plain text",
        caption:
          '<p>安全合成正文 &amp; &lt;文字&gt;</p><p>分行与<a href="http://127.0.0.1:18221/">本机链接</a></p>' +
          "<p>长文本，换行与混合语言。 Synthetic paragraph.</p>".repeat(35),
      },
    ],
    ["S0015", 640, 400, { tags: [] }],
    ["S0016", 640, 400, { tags: ["孤星合成"] }],
    [
      "S0017",
      640,
      400,
      {
        tags: Array.from({ length: 120 }, (_, i) => "标签-" + i).concat(
          "超长标签".repeat(12),
        ),
      },
    ],
    ["S0018", 640, 400, { user: null }],
    ["S0019", 640, 400, { date: "not-a-date" }],
    ["S0020", 640, 400, { x_restrict: 1, tags: ["R-18", "合成热门"] }],
    ["S0021", 640, 400, { illust_ai_type: 2 }],
    ["S0024", 640, 400, { title: "S0024 仅标题包含 R-18", tags: ["普通合成"] }],
    ["S0025", 640, 400, { title: "S0025 短词鱼猫", caption: "<p>鱼猫</p>" }],
  ];
  for (const [id, w, h, extra] of specs)
    work(
      "pixiv",
      "demo-special",
      id,
      meta(id, 0, { date: "2035-01-01T00:00:00Z", ...extra }),
      id,
      w,
      h,
    );
  for (const [id, pages] of [
    ["MP01", 1],
    ["MP03", 3],
    ["MP48", 48],
    ["MP240", 240],
  ])
    work(
      "pixiv",
      "demo-pages",
      id,
      meta(id, 0, { date: "2034-01-01T00:00:00Z" }),
      id,
      256,
      192,
      pages,
    );
  for (const [id, metadata] of [
    ["ERR-META-MISSING", undefined],
    ["ERR-META-MALFORMED", "{"],
    ["ERR-META-NONOBJECT", "[]"],
    ["ERR-META-ZERO", ""],
  ])
    work("pixiv", "demo-errors", id, metadata, id);
  for (let i = 1; i <= 3; i++)
    work(
      "pixiv",
      "demo-collision",
      "COLL-" + i,
      meta("same-source-id", i),
      `COLL-${i}`,
    );
  work(
    "pixiv",
    "demo-collision",
    "COLL-LONG",
    meta("900719925474099312345678901234567890", 1),
    "COLL-LONG",
  );
  for (const platform of platforms.filter(
    (p) => !["pixiv", "Venera"].includes(p),
  ))
    for (let i = 1; i <= 6; i++) {
      const id =
        "P" + platforms.indexOf(platform) + "-" + String(i).padStart(2, "0");
      const m = {
        ...meta(id, i),
        publishedDatetime: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
        content: "人工平台正文",
        text: "人工平台正文",
        user: {
          id: "demo-" + i,
          userId: "demo-" + i,
          name: "合成平台工坊 " + i,
          nickname: "合成平台工坊 " + i,
          creatorId: "demo-" + i,
        },
        hasAdultContent: i === 2,
        feeRequired: i === 3 ? 100 : 0,
        isRestricted: i === 4,
      };
      work(platform, "demo-platform-" + i, id, m, id, 320, 240);
    }
  for (let book = 1; book <= 2; book++)
    for (let chapter = 1; chapter <= 3; chapter++)
      work(
        "Venera",
        "Demo Book " + book,
        "Chapter " + chapter,
        undefined,
        `V${book}-${chapter}`,
        320,
        480,
        chapter === 2 ? 12 : 3,
      );
  const formats = [
    "avif",
    "bmp",
    "gif",
    "ico",
    "jpeg",
    "jpg",
    "png",
    "svg",
    "tif",
    "tiff",
    "webp",
  ];
  for (const ext of formats) {
    const id = "FIMG-" + ext.toUpperCase(),
      dir = work(
        "pixiv",
        "demo-formats",
        id,
        meta(id, 0, { date: "2033-01-01T00:00:00Z" }),
        id,
        320,
        240,
      );
    const base = path.join(dir, "1.png"),
      dest = path.join(dir, "sample." + ext);
    try {
      write(
        base,
        png(id, ext === "ico" ? 128 : 320, ext === "ico" ? 128 : 240, ext),
      );
      if (ext === "svg")
        write(
          dest,
          `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><defs><linearGradient id="g"><stop stop-color="#237eaf"/><stop offset="1" stop-color="#dd628e"/></linearGradient></defs><rect width="320" height="240" fill="url(#g)"/><circle cx="90" cy="70" r="45" fill="#edcc78"/><rect x="12" y="90" width="296" height="65" fill="#172236"/><text x="160" y="132" text-anchor="middle" fill="white" font-size="25" font-family="sans-serif">${id}</text><text x="5" y="225" fill="white" font-size="12">320X240 SVG P1</text></svg>`,
        );
      else if (ext !== "png") tool("magick", [base, dest]);
      manifest.at(-1).format = ext;
      manifest.at(-1).files.push(path.basename(dest));
    } catch (e) {
      failures.push({ id, code: e.message });
    }
  }
  const animated = work(
    "pixiv",
    "demo-formats",
    "ANIM-GIF",
    meta("ANIM-GIF"),
    "ANIM-GIF",
    320,
    240,
  );
  for (const ext of ["gif", "webp"])
    try {
      write(path.join(animated, "1.png"), png("ANIM-GIF", 320, 240, ext, 1));
      write(
        path.join(animated, "2.png"),
        png("ANIM-GIF", 320, 240, ext, 2, 17),
      );
      tool("magick", [
        "-delay",
        "40",
        path.join(animated, "1.png"),
        path.join(animated, "2.png"),
        "-loop",
        "0",
        path.join(animated, "animation." + ext),
      ]);
    } catch (e) {
      failures.push({ id: "ANIM-" + ext, code: e.message });
    }
  const codecs = {
    avi: ["mpeg4"],
    m4v: ["libx264"],
    mkv: ["libx264"],
    mov: ["libx264"],
    mp4: ["libx264"],
    ogv: ["libtheora"],
    webm: ["libvpx-vp9"],
  };
  for (const [ext, [codec]] of Object.entries(codecs)) {
    const id = "FVID-" + ext.toUpperCase(),
      dir = work(
        "pixiv",
        "demo-video",
        id,
        meta(id, 0, { date: "2036-01-01T00:00:00Z" }),
        id,
        320,
        240,
      );
    const source = path.join(dir, "1.png"),
      dest = path.join(dir, "clip." + ext);
    try {
      write(source, png(id, 320, 240, ext));
      tool("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-loop",
        "1",
        "-i",
        source,
        "-vf",
        "scale=320:240",
        "-t",
        "3",
        "-r",
        "12",
        "-an",
        "-c:v",
        codec,
        "-pix_fmt",
        "yuv420p",
        ...(ext === "m4v" ? ["-f", "mp4"] : []),
        "-y",
        dest,
      ]);
      fs.unlinkSync(source);
      manifest.at(-1).files = ["clip." + ext];
      manifest.at(-1).format = ext;
      if (ext === "webm")
        write(
          path.join(dir, "clip.zh.vtt"),
          "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nFVID-WEBM 合成字幕\n",
        );
    } catch (e) {
      failures.push({ id, code: e.message });
    }
  }
  const cover = work(
    "pixiv",
    "demo-presentation",
    "COVER-ONLY",
    meta("COVER-ONLY"),
    "COVER-ONLY",
  );
  fs.renameSync(path.join(cover, "1.png"), path.join(cover, "cover.png"));
  const keep = work(
    "pixiv",
    "demo-presentation",
    "COVER-NOCOVER",
    meta("COVER-NOCOVER"),
    "COVER-NOCOVER",
  );
  write(path.join(keep, ".nocover"), "");
  const archive = work(
    "pixiv",
    "demo-formats",
    "S0014",
    meta("S0014", 0, {
      frames: [
        { file: "frame-1.png", delay: 80 },
        { file: "frame-2.png", delay: 120 },
      ],
    }),
    "S0014",
  );
  write(
    path.join(archive, "frames.zip"),
    zip([
      ["frame-1.png", png("S0014", 320, 240, "PNG", 1)],
      ["frame-2.png", png("S0014", 320, 240, "PNG", 2, 5)],
    ]),
  );
  const preview = work(
    "Gank",
    "demo-preview",
    "COVER-PREVIEW",
    {
      id: "COVER-PREVIEW",
      title: "合成预览展示",
      content: "合成预览；特定外站声明条件仅在代码报告中说明",
      user: { id: "demo-preview", nickname: "合成预览工坊" },
    },
    "COVER-PREVIEW",
  );
  write(path.join(preview, "preview.png"), png("COVER-PREVIEW", 320, 240));
  for (let i = 1; i <= 3; i++) {
    const duplicate = work(
      "pixiv",
      "demo-duplicates",
      "DUP-" + i,
      meta("DUP-" + i),
      "DUP-1",
      320,
      240,
    );
    manifest.at(-1).id = "DUP-" + i;
    if (i === 2)
      tool("magick", [
        path.join(duplicate, "1.png"),
        "-resize",
        "160x120",
        path.join(duplicate, "variant.png"),
      ]);
    if (i === 3)
      tool("magick", [
        path.join(duplicate, "1.png"),
        "-crop",
        "240x180+40+30",
        path.join(duplicate, "variant.png"),
      ]);
  }
  const bad = work(
    "pixiv",
    "demo-errors",
    "BAD-FILES",
    meta("BAD-FILES"),
    "BAD-FILES",
  );
  write(path.join(bad, "zero.png"), Buffer.alloc(0));
  write(path.join(bad, "truncated.jpg"), Buffer.from([255, 216, 255]));
  write(path.join(bad, "wrong.jpg"), "Not a picture - synthetic bytes");
  write(path.join(bad, "extra.txt"), "Synthetic unsupported attachment");
  write(
    path.join(bad, "deep/Unicode space/嵌套 图.png"),
    png("PATH-01", 320, 240),
  );
  write(path.join(ROOT, "full/files/Empty/.keep"), "");
  for (const name of ["1", "2", "10"])
    write(
      path.join(ROOT, "full/files/Natural pages", name + ".png"),
      png("FILE-" + name, 320, 240, "PNG", Number(name)),
    );
  write(
    path.join(ROOT, "full/files/Unicode 空格/深层/diagram.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="240"><rect width="300" height="240" fill="#467ea5"/><text x="20" y="120" fill="white" font-size="35">PATH-02</text><text x="5" y="220" fill="white">300X240 SVG P1</text></svg>',
  );
  write(
    path.join(ROOT, "full/files/unsupported.zip"),
    "Synthetic invalid archive; not actual media",
  );
  write(
    path.join(ROOT, "full/files/.hidden.png"),
    png("PATH-HIDDEN", 320, 240),
  );
  const deep = path.join(
    ROOT,
    "full/files",
    ...Array.from({ length: 7 }, (_, i) => "long-synthetic-directory-" + i),
  );
  write(path.join(deep, "long-name.png"), png("PATH-LONG", 320, 240));
  try {
    fs.symlinkSync(
      path.join(ROOT, "full/files/Natural pages"),
      path.join(ROOT, "full/files/link-internal"),
      "junction",
    );
    fs.symlinkSync(
      path.join(ROOT, "full/files/nonexistent"),
      path.join(ROOT, "full/files/link-broken"),
      "junction",
    );
  } catch (e) {
    failures.push({ id: "LINK", code: e.code });
  }
  const missing = work(
    "pixiv",
    "demo-faults",
    "MISSING-01",
    meta("MISSING-01"),
    "MISSING-01",
  );
  fs.mkdirSync(path.join(ROOT, "full/sources/pixiv/demo-empty-author"), {
    recursive: true,
  });
  const sampleDir = path.join(OUTPUT, "sandbox/samples");
  fs.mkdirSync(sampleDir, { recursive: true });
  const chosen = [
    ...specs.map((x) => x[0]).slice(0, 13),
    "MP03",
    "MP48",
    "FIMG-SVG",
    "FVID-WEBM",
    "S0020",
    "COLL-1",
    "MISSING-01",
  ];
  for (const id of chosen) {
    const item = manifest.find((x) => x.id === id);
    const source = path.join(
      ROOT,
      "full/sources",
      item.platform,
      item.author,
      item.directory,
      item.files[0],
    );
    if (id === "FVID-WEBM")
      tool("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        source,
        "-frames:v",
        "1",
        "-vf",
        "scale=320:240:force_original_aspect_ratio=decrease",
        "-y",
        path.join(sampleDir, id + ".png"),
      ]);
    else
      tool("magick", [
        source + "[0]",
        "-thumbnail",
        "320x240>",
        path.join(sampleDir, id + ".png"),
      ]);
  }
  fs.writeFileSync(
    path.join(OUTPUT, "sandbox/assets.json"),
    JSON.stringify(
      {
        seed,
        synthetic: true,
        works: manifest.length,
        assets: manifest,
        failures,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      state: "GENERATED",
      seed,
      works: manifest.length,
      failures,
      samples: chosen.length,
    }),
  );
}
if (require.main === module) generate();
module.exports = { png, write, meta, generate };
