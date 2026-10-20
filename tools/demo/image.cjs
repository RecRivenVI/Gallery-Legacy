"use strict";
const zlib = require("node:zlib");
function crc32(bytes) {
  let n = 0xffffffff;
  for (const b of bytes) {
    n ^= b;
    for (let j = 0; j < 8; j++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
}
function chunk(name, bytes) {
  const body = Buffer.concat([Buffer.from(name), bytes]);
  const size = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}
function image(seed) {
  const width = 96,
    height = 128,
    header = Buffer.alloc(13),
    pixels = Buffer.alloc(height * (1 + width * 3));
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      pixels[at] = (seed * 41 + x * 2) & 255;
      pixels[at + 1] = (seed * 67 + y) & 255;
      pixels[at + 2] = (seed * 23 + Math.floor((x + y) / 12) * 20) & 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
module.exports = { image };
