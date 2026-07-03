'use strict';
// One-off generator for the admin dashboard's PWA icons (no image-library dependency —
// builds raw PNGs by hand via zlib). Re-run only if the brand colors change.
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePNG(size, drawFn) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter type: None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = drawFn(x, y, size);
      raw[offset++] = r; raw[offset++] = g; raw[offset++] = b; raw[offset++] = a;
    }
  }
  const idat = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const C1 = hexToRgb('#054a3a'); // matches .topbar gradient in webhook.js
const C2 = hexToRgb('#075E54');

function drawIcon(x, y, size) {
  const t = (x + y) / (size * 2);
  const bg = [
    Math.round(C1[0] + (C2[0] - C1[0]) * t),
    Math.round(C1[1] + (C2[1] - C1[1]) * t),
    Math.round(C1[2] + (C2[2] - C1[2]) * t),
  ];

  const cx = size / 2, cy = size / 2;
  const dist = Math.hypot(x - cx, y - cy);
  const radius = size * 0.30; // kept inside the safe zone for maskable icons
  const edge = Math.max(1, size * 0.006);

  if (dist < radius - edge) return [255, 255, 255, 255];
  if (dist < radius + edge) {
    const a = 1 - (dist - (radius - edge)) / (edge * 2);
    return [
      Math.round(bg[0] + (255 - bg[0]) * a),
      Math.round(bg[1] + (255 - bg[1]) * a),
      Math.round(bg[2] + (255 - bg[2]) * a),
      255,
    ];
  }
  return [bg[0], bg[1], bg[2], 255];
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), makePNG(size, drawIcon));
}
fs.writeFileSync(path.join(outDir, 'apple-touch-icon.png'), makePNG(180, drawIcon));

console.log('[icons] Generated icon-192.png, icon-512.png, apple-touch-icon.png in', outDir);
