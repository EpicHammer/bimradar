#!/usr/bin/env node
/* BimRadar iOS launch screens — the dark app background with the white Bim
mark centred, one PNG per common iPhone size. Kills the white flash when the
installed PWA opens. Zero npm dependencies (same hand-rolled rasteriser + PNG
encoder as gen_icons.js).

Usage: node gen_splash.js [outDir]   (default: repo root next to this script) */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = process.argv[2] || path.join(__dirname, '..');
const BG = [13, 15, 18, 255];        // --bg dark #0d0f12
const WHITE = [255, 255, 255, 255];
const BLACK = [13, 15, 18, 255];     // cutouts in background colour

// (portrait CSS-px sizes × device pixel ratio) for the common iPhone panel set
const SIZES = [
  [1290, 2796, 3], [1179, 2556, 3], [1170, 2532, 3], [1284, 2778, 3],
  [1125, 2436, 3], [1242, 2688, 3], [828, 1792, 2], [750, 1334, 2]
];

function canvas(W, H, fillCol) {
  const px = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    px[i * 4] = fillCol[0]; px[i * 4 + 1] = fillCol[1]; px[i * 4 + 2] = fillCol[2]; px[i * 4 + 3] = fillCol[3];
  }
  return { W, H, px };
}
function fill(c, test, color, x0, y0, x1, y1) {
  const xa = Math.max(0, Math.floor(x0)), xb = Math.min(c.W - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0)), yb = Math.min(c.H - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
    if (test(x + 0.5, y + 0.5)) {
      const o = (y * c.W + x) * 4;
      c.px[o] = color[0]; c.px[o + 1] = color[1]; c.px[o + 2] = color[2]; c.px[o + 3] = color[3];
    }
  }
}
function roundedRect(c, box, r, color) {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hw = (x1 - x0) / 2, hh = (y1 - y0) / 2;
  const rr = Math.min(r, hw, hh);
  fill(c, (x, y) => {
    const dx = Math.max(Math.abs(x - cx) - (hw - rr), 0);
    const dy = Math.max(Math.abs(y - cy) - (hh - rr), 0);
    return dx * dx + dy * dy <= rr * rr;
  }, color, x0, y0, x1, y1);
}
function ellipse(c, box, color) {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  fill(c, (x, y) => {
    const nx = (x - cx) / rx, ny = (y - cy) / ry;
    return nx * nx + ny * ny <= 1;
  }, color, x0, y0, x1, y1);
}
function drawTram(c, cx, cy, h) {
  const w = h * 0.56;
  const x0 = cx - w / 2, y0 = cy - h / 2, x1 = cx + w / 2, y1 = cy + h / 2;
  roundedRect(c, [x0, y0, x1, y1], h * 0.22, WHITE);
  const m = w * 0.15;
  roundedRect(c, [x0 + m, y0 + h * 0.15, x1 - m, y0 + h * 0.44], h * 0.09, BLACK);
  const sy = y0 + h * 0.53;
  roundedRect(c, [x0 + m, sy, x1 - m, sy + h * 0.045], h * 0.02, BLACK);
  const lr = h * 0.055, ly = y1 - h * 0.15;
  for (const lx of [x0 + w * 0.30, x1 - w * 0.30]) ellipse(c, [lx - lr, ly - lr, lx + lr, ly + lr], BLACK);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(c) {
  const { W, H, px } = c;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

for (const [W, H] of SIZES) {
  const c = canvas(W, H, BG);
  drawTram(c, W / 2, H / 2, Math.round(W * 0.30));
  const file = path.join(OUT, `splash-${W}x${H}.png`);
  fs.writeFileSync(file, encodePNG(c));
  console.log('wrote', file);
}
