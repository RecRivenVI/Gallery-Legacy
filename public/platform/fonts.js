// The host supplies licensed original files. No font binary is bundled here.
export const scriptFamilies = [
  ["misansarabic", /\p{Script=Arabic}/u],
  ["misansdevanagari", /\p{Script=Devanagari}/u],
  ["misansgujarati", /\p{Script=Gujarati}/u],
  ["misansgurmukhi", /\p{Script=Gurmukhi}/u],
  ["misansthai", /\p{Script=Thai}/u],
  ["misanslao", /\p{Script=Lao}/u],
  ["misansmyanmar", /\p{Script=Myanmar}/u],
  ["misanskhmer", /\p{Script=Khmer}/u],
  ["misanstibetan", /\p{Script=Tibetan}/u],
  [
    "misans",
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
  ],
];
export function scriptFamily(text) {
  return scriptFamilies.find(([, re]) => re.test(text))?.[0] || "misanslatin";
}
export function originalFont(family, weight = "Regular") {
  const files = family?.files || [];
  const staticFiles = files.filter(
    (f) => /\.ttf$/i.test(f.name) && !/\bVF\b/i.test(f.name),
  );
  return (
    files.find((f) =>
      new RegExp("[- ]" + weight + "\\.ttf$", "i").test(f.name),
    ) ||
    staticFiles.find((f) => /[- ]Regular\.ttf$/i.test(f.name)) ||
    staticFiles.find(
      (f) =>
        !/[- ](?:Thin|ExtraLight|Light|Normal|Medium|Demibold|Semibold|Bold|Heavy)\.ttf$/i.test(
          f.name,
        ),
    ) ||
    staticFiles[0] ||
    files.find((f) => /\.ttf$/i.test(f.name))
  );
}
export async function miSansManifest() {
  const base = await globalThis.galleryHost?.resourceBase?.();
  const response = await fetch(
    base
      ? new URL("/frontend/assets/canvas/misans/manifest.json", base)
      : "/frontend/assets/canvas/misans/manifest.json",
  );
  if (!response.ok) throw Error("字体无法读取");
  const manifest = await response.json();
  if (base)
    for (const family of manifest.families)
      for (const file of family.files) file.url = new URL(file.url, base).href;
  return manifest;
}
export async function installNativeMiSans(manifest) {
  for (const family of manifest.families) {
    const variable = family.files.find((f) => /VF.*\.ttf$/i.test(f.name));
    const files = variable
      ? [variable]
      : family.files.filter((f) => /\.ttf$/i.test(f.name));
    for (const file of files) {
      const weights = {
        Thin: 100,
        ExtraLight: 200,
        Light: 300,
        Normal: 350,
        Regular: 400,
        Medium: 500,
        Demibold: 550,
        Semibold: 600,
        Bold: 700,
        Heavy: 900,
      };
      const style = Object.entries(weights).find(([name]) =>
        new RegExp("[- ]" + name + "\\.ttf$", "i").test(file.name),
      );
      const face = new FontFace(family.name, `url("${file.url}")`, {
        weight: variable ? "100 900" : String(style?.[1] || 400),
        display: "swap",
      });
      document.fonts.add(face);
    }
  }
  document.documentElement.style.setProperty(
    "--gallery-font",
    [...manifest.families]
      .sort(
        (a, z) =>
          (["misans", "misanslatin", "misanstc", "misansl3"].indexOf(a.key) < 0
            ? 4
            : ["misans", "misanslatin", "misanstc", "misansl3"].indexOf(
                a.key,
              )) -
          (["misans", "misanslatin", "misanstc", "misansl3"].indexOf(z.key) < 0
            ? 4
            : ["misans", "misanslatin", "misanstc", "misansl3"].indexOf(z.key)),
      )
      .map((f) => JSON.stringify(f.name))
      .join(",") + ",system-ui,sans-serif",
  );
  await document.fonts.load('400 13px "MiSans"', "画廊");
}
export async function loadCanvasMiSans(ck, provider, changed) {
  const manifest = await miSansManifest(),
    faces = {},
    pending = new Map();
  const weights = {
    regular: "Regular",
    ui: "Medium",
    bold: "Semibold",
    heavy: "Bold",
    mono: "Regular",
    outfit: "Regular",
  };
  async function load(key, weight) {
    const name = key + "-" + weight;
    if (faces[name]) return;
    if (!pending.has(name))
      pending.set(
        name,
        (async () => {
          const family = manifest.families.find((f) => f.key === key),
            file = originalFont(family, weights[weight]);
          if (!file) return;
          const r = await fetch(file.url);
          if (!r.ok) throw Error("字体无法读取");
          const bytes = await r.arrayBuffer(),
            face = ck.Typeface.MakeFreeTypeFaceFromData(bytes);
          if (!face) throw Error("字体无法显示");
          provider.registerFont(bytes, name);
          faces[name] = face;
          changed?.();
        })(),
      );
    return pending.get(name);
  }
  await Promise.all([
    load("misans", "regular"),
    load("misans", "ui"),
    load("misans", "bold"),
    load("misanslatin", "regular"),
    load("misanslatin", "ui"),
    load("misanslatin", "bold"),
    installNativeMiSans(manifest),
  ]);
  for (const name of Object.keys(weights))
    faces[name] = faces["misans-" + name] || faces["misans-regular"];
  const ensure = (text, weight = "regular") => {
    const keys = new Set(
      [
        ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
          String(text),
        ),
      ].map((s) => scriptFamily(s.segment)),
    );
    if (/[\u{20000}-\u{323af}]/u.test(text)) keys.add("misansl3");
    const work = [...keys].filter((key) => !faces[key + "-" + weight]);
    if (work.length)
      Promise.all(work.map((key) => load(key, weight))).catch(() => {});
  };
  return { faces, manifest, ensure };
}
