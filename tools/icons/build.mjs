import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const output = path.resolve(process.argv[2]);
const source = new URL(
  "../../ui/src/wasmJsMain/resources/app-icon.svg",
  import.meta.url,
);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
  await page.setContent(
    "<style>html,body{margin:0}svg{width:64px;height:64px}</style>" +
      fs.readFileSync(source, "utf8"),
  );
  const png = await page.locator("svg").screenshot({ omitBackground: true });
  fs.writeFileSync(path.join(output, "app-icon.png"), png);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 64;
  header[7] = 64;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  fs.writeFileSync(
    path.join(output, "app-icon.ico"),
    Buffer.concat([header, png]),
  );
} finally {
  await browser.close();
}
