#!/usr/bin/env node
/* BimRadar PWA icons — monochrome, Trade-Republic style: a single clean white
Bim (tram) mark on pure black, with generous negative space. No colour, no
gradient. (Node port of the original PIL script — zero npm dependencies: shapes
are rasterised 4x supersampled into an RGBA buffer, box-downsampled for AA, and
encoded as PNG by hand on top of node:zlib.)

Usage: node gen_icons.js [outDir]   (default: /var/apps/eliashammer/bimradar/) */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = process.argv[2] || '/var/apps/eliashammer/bimradar/';
const BLACK = [0, 0, 0, 255];
const WHITE = [255, 255, 255, 255];

// ---------- tiny RGBA canvas ----------
function canvas(N) {
  return { N, px: new Uint8Array(N * N * 4) };
}
function fill(c, test, color, x0, y0, x1, y1) {
  // paint color over every pixel whose CENTER passes test(x, y)
  const xa = Math.max(0, Math.floor(x0)), xb = Math.min(c.N - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0)), yb = Math.min(c.N - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      if (test(x + 0.5, y + 0.5)) {
        const o = (y * c.N + x) * 4;
        c.px[o] = color[0]; c.px[o + 1] = color[1]; c.px[o + 2] = color[2]; c.px[o + 3] = color[3];
      }
    }
  }
}
function rect(c, box, color) {
  const [x0, y0, x1, y1] = box;
  fill(c, () => true, color, x0, y0, x1, y1);
}
function roundedRect(c, box, r, color) {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2, hh = (y1 - y0) / 2;
  const rr = Math.min(r, hw, hh);
  fill(c, (x, y) => {
    const dx = Math.max(Math.abs(x - cx) - (hw - rr), 0);
    const dy = Math.max(Math.abs(y - cy) - (hh - rr), 0);
    return dx * dx + dy * dy <= rr * rr;
  }, color, x0, y0, x1, y1);
}
function ellipse(c, box, color) {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  fill(c, (x, y) => {
    const nx = (x - cx) / rx, ny = (y - cy) / ry;
    return nx * nx + ny * ny <= 1;
  }, color, x0, y0, x1, y1);
}
function downsample(c, ss) {
  // straight box average of ss*ss blocks (safe here: white never borders transparency)
  const n = c.N / ss, out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const o = ((y * ss + sy) * c.N + x * ss + sx) * 4;
          acc[0] += c.px[o]; acc[1] += c.px[o + 1]; acc[2] += c.px[o + 2]; acc[3] += c.px[o + 3];
        }
      }
      const o = (y * n + x) * 4, k = ss * ss;
      out[o] = acc[0] / k; out[o + 1] = acc[1] / k; out[o + 2] = acc[2] / k; out[o + 3] = acc[3] / k;
    }
  }
  return { n, px: out };
}

// ---------- minimal PNG encoder (RGBA8) ----------
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
function encodePNG(img) {
  const { n, px } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  const raw = Buffer.alloc(n * (n * 4 + 1));          // each scanline prefixed by filter 0
  for (let y = 0; y < n; y++) {
    raw[y * (n * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * n * 4, n * 4).copy(raw, y * (n * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- the Bim mark ----------
function drawTram(c, cx, cy, h) {
  // Front-view Bim centered at (cx,cy), body height h. White body, black cutouts.
  const w = h * 0.56;
  const x0 = cx - w / 2, y0 = cy - h / 2, x1 = cx + w / 2, y1 = cy + h / 2;
  roundedRect(c, [x0, y0, x1, y1], h * 0.22, WHITE);                                  // solid white body
  const m = w * 0.15;
  roundedRect(c, [x0 + m, y0 + h * 0.15, x1 - m, y0 + h * 0.44], h * 0.09, BLACK);    // windshield cutout
  const sy = y0 + h * 0.53;
  roundedRect(c, [x0 + m, sy, x1 - m, sy + h * 0.045], h * 0.02, BLACK);              // waistline
  const lr = h * 0.055, ly = y1 - h * 0.15;
  for (const lx of [x0 + w * 0.30, x1 - w * 0.30]) {
    ellipse(c, [lx - lr, ly - lr, lx + lr, ly + lr], BLACK);                          // headlights
  }
}
function make(size, maskable = false, rounded = true) {
  const ss = 4, N = size * ss;
  const c = canvas(N);
  if (maskable) {
    rect(c, [0, 0, N, N], BLACK);                    // full-bleed for mask safe zone
    drawTram(c, N / 2, N / 2, N * 0.46);
  } else {
    if (rounded) roundedRect(c, [0, 0, N - 1, N - 1], N * 0.22, BLACK);
    else rect(c, [0, 0, N, N], BLACK);
    drawTram(c, N / 2, N / 2, N * 0.60);
  }
  return encodePNG(downsample(c, ss));
}

fs.writeFileSync(path.join(OUT, 'icon-192.png'), make(192));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), make(512));
fs.writeFileSync(path.join(OUT, 'icon-192-maskable.png'), make(192, true));
fs.writeFileSync(path.join(OUT, 'icon-512-maskable.png'), make(512, true));
fs.writeFileSync(path.join(OUT, 'icon-180.png'), make(180));
fs.writeFileSync(path.join(OUT, 'icon-32.png'), make(32));
console.log('monochrome icons written to', OUT);
