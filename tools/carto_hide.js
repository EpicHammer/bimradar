#!/usr/bin/env node
/* BimRadar: which CARTO building extrusions to hide under the 3D landmarks,
and which innocent buildings to draw back.        node tools/carto_hide.js

WHY THIS EXISTS. The hand-built landmarks (three.js) sit where CARTO's own
basemap already extrudes the same buildings; CARTO's grey copies must go.
CARTO's feature ids look like OSM ids, but they are GROUP ids: CARTO merges
every building in a z14 tile with identical render_height / min_height /
colour into ONE feature carrying one member's id. Hiding an id therefore hides
the whole group - one Neue Technik id also removed 125 ordinary 19 m buildings
in Geidorf, the LKH Chirurgie shares its id with 44 m blocks a kilometre away.
MapLibre filters work per feature, not per ring, so a group can't be split.

So: hide every group that owns a landmark part, and draw the group's OTHER
buildings back ourselves (a fill-extrusion layer with CARTO's exact geometry
and paint - indistinguishable). If CARTO ever regroups, the worst case is an
identical duplicate, not a hole in the city.

INPUT  index.html: every landmark part polygon registered in LMK_OCC (local
       metres around each landmark's lng/lat), plus SEED ids below.
OUTPUT carto_hide.json: { ids: [...], restore: GeoJSON FeatureCollection }.
Re-run after adding or moving a landmark. Zero dependencies (Node >= 18). */
'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'carto_hide.json');
const TILES = 'https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt';
const Z = 14;
// the app's whole live-vehicle area (PROXY_RECT) plus a margin: hidden ids act everywhere
const BBOX = { minLon: 15.28, maxLon: 15.62, minLat: 46.96, maxLat: 47.17 };
// Hand-curated ids from before this tool (parts whose CARTO rings don't sit
// inside a registered polygon: Murinsel pavilions, Burg member ways, ...).
// A seed id's rings count as landmark only within SEED_REACH m of a landmark part.
const SEED = [122074496,23786584,1445223691,1445223692,1445223693,82754770,189669884,189671729,189671731,189671732,189671733,189671734,
  189671735,189671736,189671737,189671738,189671739,189671740,189671741,189671742,189673812,189673813,189673814,189673815,189674865,
  189674866,189674867,190442413,190442414,86174340,385927810,1445223695,38163212,588711028,588711029,588711030,98928218,86174338,
  84579393,84579409,29714926,29714804,29714669,163983629,29715115,30168156,984935018,84579396,85081251,82226336,29983017,29983018,
  4399927,8143951,75042781,1039587147,171711442,1039587145,81631019,444511608,27561430,121500989,85220561,85220602,85220632,217654998,
  180107499,179416834,180107500,193651723,192602324,192602325,192602326,192602327,354342549,354636665,354354006,2395973,
  585330090, 588660663, 588660660, 588660662];   // Franziskaner + Stadtpfarr towers, Opera roof pyramids (2026-10)
const SEED_REACH = 40;
const MAX_RESTORE = 400;          // a bigger group is never hidden: fix the model instead (warned below)

// ---------------- landmark polygons from index.html ----------------
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
// evaluate the LMK_OCC.push(...) block; any constant it names is looked up in
// the script and evaluated on demand (literals only - arrays of numbers/objects)
const declOf = name => {
  const m = script.match(new RegExp('const ' + name + ' = ([\\[{])'));
  if (!m) throw new Error('no literal const ' + name);
  const open = m[1], close = open === '[' ? ']' : '}', st = m.index + m[0].length - 1; let d = 0;
  for (let k = st; k < script.length; k++) { if (script[k] === open) d++; else if (script[k] === close && --d === 0) return script.slice(st, k + 1); }
};
const ctx = vm.createContext({});
const regStart = script.indexOf('LMK_OCC.push(');
const regEnd = script.indexOf('\n            );', regStart);
const reg = 'LMK_OCC.push(' + script.slice(regStart + 'LMK_OCC.push('.length, regEnd) + ');';
let LMK;
for (let tries = 0; ; tries++) {
  try { LMK = vm.runInContext('(() => { const LMK_OCC = []; ' + reg + ' return LMK_OCC; })()', ctx); break; }
  catch (e) {
    const m = /^(\w+) is not defined/.exec(e.message);
    if (!m || tries > 400) throw e;
    vm.runInContext('var ' + m[1] + ' = ' + declOf(m[1]).replace(/\/\/[^\n]*/g, '') + ';', ctx);
  }
}
const parts = [];                                   // world-coordinate rings
for (const L of LMK) {
  const kx = 111320 * Math.cos(L.lat * Math.PI / 180);
  for (const p of L.polys) parts.push({ name: L.name, h: +p.h || 0, ring: p.p.map(([E, N]) => [L.lng + E / kx, L.lat + N / 110540]) });
}
const inRing = (x, y, R) => { let c = false; for (let i = 0, j = R.length - 1; i < R.length; j = i++) { const [xi, yi] = R[i], [xj, yj] = R[j]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c; } return c; };
const distM = (lng, lat, R) => {                    // metres from a point to a ring's edges
  const kx = 111320 * Math.cos(lat * Math.PI / 180); let b = Infinity;
  for (let i = 0, j = R.length - 1; i < R.length; j = i++) {
    const ax = (R[j][0] - lng) * kx, ay = (R[j][1] - lat) * 110540, bx = (R[i][0] - lng) * kx - ax, by = (R[i][1] - lat) * 110540 - ay;
    const L2 = bx * bx + by * by || 1, t = Math.max(0, Math.min(1, (-ax * bx - ay * by) / L2));
    b = Math.min(b, Math.hypot(ax + bx * t, ay + by * t));
  }
  return b;
};
const partAt = (lng, lat) => parts.find(p => inRing(lng, lat, p.ring));
const nearPart = (lng, lat, m) => parts.some(p => inRing(lng, lat, p.ring) || distM(lng, lat, p.ring) < m);

// ---------------- minimal MVT reader ----------------
function pbf(buf) {
  let p = 0;
  const varint = () => { let r = 0, s = 0, b; do { b = buf[p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  return { get pos() { return p; }, set pos(v) { p = v; }, end: buf.length, varint,
    field() { const k = varint(); return [k >> 3, k & 7]; },
    bytes() { const l = varint(); const s = buf.subarray(p, p + l); p += l; return s; },
    skip(t) { if (t === 0) varint(); else if (t === 1) p += 8; else if (t === 2) p += varint(); else if (t === 5) p += 4; } };
}
function layers(buf) {
  const r = pbf(buf), out = [];
  while (r.pos < r.end) {
    const [f, t] = r.field();
    if (f !== 3) { r.skip(t); continue; }
    const lb = r.bytes(), q = pbf(lb), L = { name: '', keys: [], vals: [], feats: [], extent: 4096 };
    while (q.pos < q.end) {
      const [g, u] = q.field();
      if (g === 1) L.name = q.bytes().toString(); else if (g === 3) L.keys.push(q.bytes().toString());
      else if (g === 4) L.vals.push(value(q.bytes())); else if (g === 5) L.extent = q.varint();
      else if (g === 2) L.feats.push(q.bytes()); else q.skip(u);
    }
    out.push(L);
  }
  return out;
}
function value(buf) {
  const r = pbf(buf); let v = null;
  while (r.pos < r.end) {
    const [f, t] = r.field();
    if (f === 1) v = r.bytes().toString(); else if (f === 2) { v = buf.readFloatLE(r.pos); r.pos += 4; }
    else if (f === 3) { v = buf.readDoubleLE(r.pos); r.pos += 8; } else if (f === 4 || f === 5) v = r.varint();
    else if (f === 6) { const z = r.varint(); v = (z >> 1) ^ -(z & 1); } else if (f === 7) v = !!r.varint(); else r.skip(t);
  }
  return v;
}
function feature(L, buf) {
  const r = pbf(buf), F = { id: null, props: {}, rings: [] };
  while (r.pos < r.end) {
    const [f, t] = r.field();
    if (f === 1) F.id = r.varint();
    else if (f === 2) { const len = r.varint(), e = r.pos + len; while (r.pos < e) { const k = r.varint(), v = r.varint(); F.props[L.keys[k]] = L.vals[v]; } }
    else if (f === 4) {
      const len = r.varint(), e = r.pos + len; let x = 0, y = 0, ring = null;
      while (r.pos < e) {
        const c = r.varint(), cmd = c & 7, n = c >> 3;
        for (let i = 0; i < n && (cmd === 1 || cmd === 2); i++) {
          const dx = r.varint(), dy = r.varint(); x += (dx >> 1) ^ -(dx & 1); y += (dy >> 1) ^ -(dy & 1);
          if (cmd === 1) { ring = [[x, y]]; F.rings.push(ring); } else ring.push([x, y]);
        }
      }
    } else r.skip(t);
  }
  return F;
}
// Sutherland-Hodgman against the tile square: tiles carry a buffer, so the same
// building appears in two neighbouring tiles; clipping to the exact tile makes
// the pieces meet edge to edge instead of overlapping (overlap = darker patch).
function clipSquare(ring, ext) {
  let pts = ring;
  const edges = [[p => p[0] >= 0, (a, b) => { const t = -a[0] / (b[0] - a[0]); return [0, a[1] + t * (b[1] - a[1])]; }],
                 [p => p[0] <= ext, (a, b) => { const t = (ext - a[0]) / (b[0] - a[0]); return [ext, a[1] + t * (b[1] - a[1])]; }],
                 [p => p[1] >= 0, (a, b) => { const t = -a[1] / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), 0]; }],
                 [p => p[1] <= ext, (a, b) => { const t = (ext - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), ext]; }]];
  for (const [inside, cut] of edges) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (inside(a)) { out.push(a); if (!inside(b)) out.push(cut(a, b)); } else if (inside(b)) out.push(cut(a, b));
    }
    pts = out; if (pts.length < 3) return [];
  }
  return pts;
}

// ---------------- scan ----------------
(async () => {
  const tx = lng => Math.floor((lng + 180) / 360 * 2 ** Z);
  const ty = lat => { const s = Math.sin(lat * Math.PI / 180); return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** Z); };
  const list = [];
  for (let x = tx(BBOX.minLon); x <= tx(BBOX.maxLon); x++) for (let y = ty(BBOX.maxLat); y <= ty(BBOX.minLat); y++) list.push([x, y]);
  const rings = [];                                  // { id, h, min, lng, lat, geo }
  let done = 0;
  const work = async ([x, y]) => {
    let buf = null;
    for (let attempt = 0; attempt < 3 && !buf; attempt++) {
      try { const r = await fetch(TILES.replace('{z}', Z).replace('{x}', x).replace('{y}', y), { signal: AbortSignal.timeout(30000) });
        if (r.ok) buf = Buffer.from(await r.arrayBuffer()); } catch (e) {}
    }
    if (!buf) throw new Error('tile ' + x + '/' + y + ' failed');
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    const L = layers(buf).find(l => l.name === 'building');
    if (L) for (const fb of L.feats) {
      const F = feature(L, fb);
      for (const ring of F.rings) {
        let A = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) A += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
        if (A <= 0 || ring.length < 4) continue;       // MVT (y down): exterior rings positive, holes negative
        const c = clipSquare(ring.slice(0, ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? -1 : undefined), L.extent);
        if (c.length < 3) continue;
        const geo = c.map(([a, b]) => { const lng = (x + a / L.extent) / 2 ** Z * 360 - 180, n = Math.PI - 2 * Math.PI * (y + b / L.extent) / 2 ** Z;
          return [+lng.toFixed(6), +(180 / Math.PI * Math.atan(Math.sinh(n))).toFixed(6)]; });
        let cx = 0, cy = 0; geo.forEach(p => { cx += p[0]; cy += p[1]; }); cx /= geo.length; cy /= geo.length;
        rings.push({ id: F.id, h: F.props.render_height, min: F.props.render_min_height || 0, colour: F.props.colour, hide3d: F.props.hide_3d, lng: cx, lat: cy, geo });
      }
    }
    if (++done % 20 === 0) process.stderr.write('  tiles ' + done + '/' + list.length + '\n');
  };
  for (let i = 0; i < list.length; i += 8) await Promise.all(list.slice(i, i + 8).map(work));

  // a ring is LANDMARK if its centre sits in a registered part, or (seed ids
  // only) within SEED_REACH m of one; everything else is somebody's house
  const seed = new Set(SEED);
  const isLandmark = r => !!partAt(r.lng, r.lat) || (seed.has(r.id) && nearPart(r.lng, r.lat, SEED_REACH));
  // ...but a landmark ring only MATTERS if it pokes out of our model: taller
  // than the part it stands in, or reaching > 1 m outside the landmark's parts.
  // (The three.js layer draws over CARTO, so anything inside is invisible.)
  const pokes = r => {
    const inside = parts.filter(p => inRing(r.lng, r.lat, p.ring));
    const top = Math.max(0, ...inside.map(p => p.h));
    if (r.h > top - 0.3) return true;
    const mine = parts.filter(p => p.name === (inside[0] || {}).name);
    return r.geo.some(([x, y]) => !mine.some(p => inRing(x, y, p.ring) || distM(x, y, p.ring) < 1));
  };
  const cost = new Map();                             // id -> innocent buildings it would take along
  for (const r of rings) if (!isLandmark(r)) cost.set(r.id, (cost.get(r.id) || 0) + 1);
  const hide = new Set(seed), skipped = new Map();
  for (const r of rings) {
    if (hide.has(r.id) || !isLandmark(r) || !pokes(r)) continue;
    if ((cost.get(r.id) || 0) > MAX_RESTORE) { (skipped.get(r.id) || skipped.set(r.id, []).get(r.id)).push(r); continue; }
    hide.add(r.id);
  }
  for (const [id, rs] of skipped) if (!hide.has(id)) for (const r of rs) {
    const p = partAt(r.lng, r.lat);
    console.warn('NOT hidden (group of ' + cost.get(id) + '): id ' + id + ' ' + r.h + ' m in ' + (p ? p.name + ' part h ' + p.h : '?') +
      ' @ ' + r.lat.toFixed(6) + ',' + r.lng.toFixed(6) + ' -> taller than our part: raise the model; else a neighbour overlapping its outline (fine)');
  }
  const restore = [];
  for (const r of rings) {
    if (!hide.has(r.id) || isLandmark(r)) continue;
    // property-filtered buildings stay hidden anyway (Uhrturm colours etc.)
    if (r.hide3d === true) continue;
    restore.push({ type: 'Feature', properties: { render_height: r.h, render_min_height: r.min },
      geometry: { type: 'Polygon', coordinates: [[...r.geo, r.geo[0]]] } });
  }
  const out = { generated: new Date().toISOString().slice(0, 10), source: 'carto.streets v1 z' + Z,
    note: 'written by tools/carto_hide.js - do not edit', ids: [...hide].sort((a, b) => a - b),
    restore: { type: 'FeatureCollection', features: restore } };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('tiles', list.length, '| rings', rings.length, '| landmark parts', parts.length,
    '| hidden ids', hide.size, '| buildings drawn back', restore.length, '|', (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');
  if (process.argv.includes('--stats')) {           // which ids cost the most drawn-back buildings
    const per = new Map();
    for (const r of rings) if (hide.has(r.id) && !isLandmark(r)) per.set(r.id, (per.get(r.id) || 0) + 1);
    for (const [id, n] of [...per].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
      const own = rings.filter(r => r.id === id && isLandmark(r));
      console.log(String(id).padEnd(12), String(n).padStart(6), seed.has(id) ? 'seed' : '    ',
        own.length + ' landmark rings:', [...new Set(own.map(r => (partAt(r.lng, r.lat) || { name: '(seed reach)' }).name))].join(', '));
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
