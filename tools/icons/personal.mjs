// Generates only the additional Fluent resource from unmodified official SVGs.
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../.."),
  lock = JSON.parse(
    fs.readFileSync(
      path.join(import.meta.dirname, "personal.lock.json"),
      "utf8",
    ),
  );
const icons = Object.fromEntries(
  lock.icons.map(({ name, file }) => {
    const svg = fs.readFileSync(
      path.join(root, "third_party/fluent_personal", file),
      "utf8",
    );
    return [
      name,
      [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]),
    ];
  }),
);
fs.writeFileSync(
  path.join(root, "ui/src/wasmJsMain/resources/fluent-personal.json"),
  JSON.stringify(icons) + "\n",
);
