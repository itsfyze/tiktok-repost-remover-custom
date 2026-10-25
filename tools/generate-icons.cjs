"use strict";
// Deterministic original icon, PNG encoded with Node built-ins. No downloads.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
function crc(buffer) {
  let n = 0xffffffff;
  for (const byte of buffer) { n ^= byte; for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); }
  return (n ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}
const folder = path.join(__dirname, "../icons"); fs.mkdirSync(folder, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + .5) / size, py = (y + .5) / size;
    const dx = px - .5, dy = py - .5, r = Math.hypot(dx, dy);
    const arc = r > .22 && r < .31 && !(dx > .06 && dy < -.06);
    const arrow = px > .62 && px < .83 && py > .14 && py < .36 && (px - .62) + (py - .14) < .24;
    const outside = Math.hypot(Math.max(Math.abs(dx) - .29, 0), Math.max(Math.abs(dy) - .29, 0)) > .18;
    const color = arc || arrow ? [239, 230, 255] : [107 + Math.round(45 * py), 63 + Math.round(35 * py), 202 + Math.round(35 * px)];
    const i = y * (size * 4 + 1) + 1 + x * 4; raw[i] = color[0]; raw[i + 1] = color[1]; raw[i + 2] = color[2]; raw[i + 3] = outside ? 0 : 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  fs.writeFileSync(path.join(folder, `icon${size}.png`), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
console.log("Created original 16/32/48/128px icons.");
